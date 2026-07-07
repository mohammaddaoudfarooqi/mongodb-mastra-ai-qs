import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { loadConfig, type Config } from '../../src/config';
import { createApp } from '../../src/server/app';
import { createKnowledgeVector, provisionKnowledgeIndex } from '../../src/mastra/vector';
import { runSeed } from '../../src/ingestion/seed';

const hasEnv = !!process.env.MONGODB_URI && !!process.env.VOYAGE_API_KEY;

interface Collected {
  tokens: string;
  interrupt: { thread_id: string; action: { name: string; args: any; description: string }; allowed_decisions: string[] } | null;
  terminal: 'done' | 'error' | null;
}

async function collectSse(res: Response): Promise<Collected> {
  const out: Collected = { tokens: '', interrupt: null, terminal: null };
  const text = await res.text();
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue;
    let event = 'message'; const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (event === 'token') out.tokens += data;
    else if (event === 'interrupt') { try { out.interrupt = JSON.parse(data); } catch { /* ignore */ } }
    else if (event === 'done') out.terminal = 'done';
    else if (event === 'error') out.terminal = 'error';
  }
  return out;
}

async function chat(app: ReturnType<typeof createApp>, message: string, threadId: string, userId: string): Promise<Collected> {
  const res = await app.request('/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, user_id: userId, thread_id: threadId }),
  });
  return collectSse(res);
}

async function resume(app: ReturnType<typeof createApp>, threadId: string, decision: string): Promise<Collected> {
  const res = await app.request('/interrupts/resume', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ thread_id: threadId, decision }),
  });
  return collectSse(res);
}

describe.skipIf(!hasEnv)('order workflow HITL checkout (Atlas + LLM integration)', () => {
  let client: MongoClient; let cfg: Config; let app: ReturnType<typeof createApp>;
  let PRODUCT_ID: string; let START_STOCK: number;

  beforeAll(async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    const baseDb = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';
    cfg = loadConfig({ ...process.env, MONGODB_DATABASE: `${baseDb}_ord` } as any);
    client = new MongoClient(cfg.mongoUri); await client.connect();
    await client.db(cfg.mongoDb).dropDatabase().catch(() => {});
    const vector = createKnowledgeVector(cfg);
    await provisionKnowledgeIndex(vector);
    await runSeed(cfg);
    app = createApp(cfg);
    // Pick a real seeded product with stock to build carts from.
    const p = await client.db(cfg.mongoDb).collection('products').findOne({ stock: { $gt: 5 } });
    PRODUCT_ID = p!._id as unknown as string;
    START_STOCK = p!.stock as number;
  }, 600_000);

  afterAll(async () => { await client?.close(); });

  /** Seed a cart doc directly for a {userId, threadId}, qty 2 of PRODUCT_ID. */
  async function seedCart(userId: string, threadId: string, qty = 2) {
    const line = { product_id: PRODUCT_ID, name: 'Test Item', qty, unit_price_usd: 10, sale_price_usd: 8, applied_coupons: [], line_savings: 4 };
    await client.db(cfg.mongoDb).collection('carts').replaceOne(
      { userId, threadId }, { userId, threadId, lines: [line], updated_at: '2026-07-07T00:00:00.000Z' }, { upsert: true },
    );
  }

  /** Start checkout and assert the workflow suspended (interrupt fired). Retries a
   *  couple of times to absorb the router's tool-call non-determinism, so downstream
   *  resume assertions test the resume path, not whether the LLM decided to check out. */
  async function startCheckout(userId: string, threadId: string): Promise<Collected> {
    let last: Collected | null = null;
    for (let i = 0; i < 3; i++) {
      last = await chat(app, 'Buy my cart and check out now.', threadId, userId);
      if (last.interrupt?.action?.name === 'place_order') return last;
    }
    throw new Error(`checkout did not start; agent said: ${last?.tokens.slice(0, 200)}`);
  }

  // TC-ORD-I-001 (REQ-E-030): checkout suspends and emits an interrupt frame + done.
  it('emits an interrupt frame with the place_order action when checkout starts', async () => {
    // Asserts action.name deeply on purpose — that deep check is what caught the
    // step-keyed suspendPayload unwrap bug (see order-runner.unwrapSuspendPayload).
    const userId = 'ord-suspend'; const threadId = 'ord-suspend:t1';
    await seedCart(userId, threadId);
    const r = await startCheckout(userId, threadId);
    expect(r.interrupt!.action.name).toBe('place_order');
    expect(r.interrupt!.allowed_decisions).toContain('approve');
    expect(r.terminal).toBe('done'); // interrupt is non-terminal; done follows
  }, 300_000);

  // TC-ORD-I-002 (REQ-E-031/035): approve commits a transaction across 3 collections,
  // resuming a run suspended in a SEPARATE request.
  it('approve places the order, decrements stock, and clears the cart', async () => {
    const userId = 'ord-approve'; const threadId = 'ord-approve:t1';
    await seedCart(userId, threadId, 2);
    const started = await startCheckout(userId, threadId);
    expect(started.interrupt?.thread_id).toBe(threadId);

    const done = await resume(app, threadId, 'approve');
    expect(done.terminal).toBe('done');
    expect(done.tokens.toLowerCase()).toMatch(/order|placed/);

    const db = client.db(cfg.mongoDb);
    const orders = await db.collection('orders').find({ userId }).toArray();
    expect(orders.length).toBe(1);
    expect(orders[0].status).toBe('placed');
    const product = await db.collection('products').findOne({ _id: PRODUCT_ID as any });
    expect(product!.stock).toBe(START_STOCK - 2); // decremented by qty
    const cart = await db.collection('carts').findOne({ userId, threadId });
    expect(cart).toBeNull(); // cleared
  }, 300_000);

  // TC-ORD-I-003 (REQ-E-032): reject writes nothing.
  it('reject cancels with no writes to orders/products/carts', async () => {
    const userId = 'ord-reject'; const threadId = 'ord-reject:t1';
    await seedCart(userId, threadId, 1);
    const db = client.db(cfg.mongoDb);
    const before = (await db.collection('products').findOne({ _id: PRODUCT_ID as any }))!.stock;

    await startCheckout(userId, threadId);
    const done = await resume(app, threadId, 'reject');
    expect(done.terminal).toBe('done');

    expect(await db.collection('orders').countDocuments({ userId })).toBe(0);
    expect((await db.collection('products').findOne({ _id: PRODUCT_ID as any }))!.stock).toBe(before);
    expect(await db.collection('carts').findOne({ userId, threadId })).not.toBeNull();
  }, 300_000);

  // TC-ORD-I-004 (Premortem #6): a second approve does not place a second order.
  it('double-approve places exactly one order', async () => {
    const userId = 'ord-double'; const threadId = 'ord-double:t1';
    await seedCart(userId, threadId, 1);
    await startCheckout(userId, threadId);
    await resume(app, threadId, 'approve');
    const second = await resume(app, threadId, 'approve'); // run no longer suspended
    // The second resume must not create another order (it errors or no-ops).
    expect(await client.db(cfg.mongoDb).collection('orders').countDocuments({ userId })).toBe(1);
    expect(['done', 'error']).toContain(second.terminal);
  }, 300_000);
});
