import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { loadConfig, type Config } from '../../src/config';
import { createApp } from '../../src/server/app';
import { createKnowledgeVector, provisionKnowledgeIndex } from '../../src/mastra/vector';
import { runSeed } from '../../src/ingestion/seed';

const hasEnv = !!process.env.MONGODB_URI && !!process.env.VOYAGE_API_KEY;

interface Collected { tokens: string; statuses: { phase: string; name: string }[]; correlationId: string | null; terminal: 'done' | 'error' | null; }
async function collectSse(res: Response): Promise<Collected> {
  const out: Collected = { tokens: '', statuses: [], correlationId: null, terminal: null };
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
    else if (event === 'correlation') out.correlationId = data;
    else if (event === 'status') { try { out.statuses.push(JSON.parse(data)); } catch { /* ignore */ } }
    else if (event === 'done') out.terminal = 'done';
    else if (event === 'error') out.terminal = 'error';
  }
  return out;
}
async function chat(app: ReturnType<typeof createApp>, message: string, threadId: string, userId = 'net'): Promise<Collected> {
  const res = await app.request('/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, user_id: userId, thread_id: threadId }),
  });
  return collectSse(res);
}

describe.skipIf(!hasEnv)('multi-agent routing (Atlas + LLM integration)', () => {
  let client: MongoClient; let cfg: Config; let app: ReturnType<typeof createApp>;
  let vector: ReturnType<typeof createKnowledgeVector>;

  beforeAll(async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    const baseDb = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';
    cfg = loadConfig({ ...process.env, MONGODB_DATABASE: `${baseDb}_network` } as any);
    client = new MongoClient(cfg.mongoUri); await client.connect();
    await client.db(cfg.mongoDb).dropDatabase().catch(() => {});
    vector = createKnowledgeVector(cfg);
    await provisionKnowledgeIndex(vector);
    // Seed KB text + retail (the full ~1505-product catalog) on the isolated _network DB so
    // both dataQuery and knowledgeSearch have data.
    await runSeed(cfg);
    app = createApp(cfg);
  }, 600_000);

  afterAll(async () => { await client?.close(); });

  it('routes a cart request to dealsAndCart and streams a grounded answer once', async () => {
    // Use a superlative ("biggest savings") to collapse the choice. A bare "an on-sale kitchen
    // product" is ambiguous at ~1505-product scale (76 kitchen items on sale), so the concierge
    // tends to list options and ask which to add — right behavior, but no deterministic cart line.
    // A few products tie for the biggest savings ($37.20), but they are value-identical (same
    // price → same sale price), so the added line's price/savings and the displayed subtotal are
    // deterministic even though the chosen _id may vary. Beat 6 uses the same phrasing.
    const r = await chat(app, 'Add the on-sale kitchen product with the biggest savings to my cart and show my total savings.', 'net:cart');
    expect(r.terminal).toBe('done');
    expect(r.correlationId).toBeTruthy();
    expect(r.tokens.trim().length).toBeGreaterThan(0);            // text surfaced through the router
    // exactly-once: the answer is not a doubled concatenation of itself
    const half = r.tokens.slice(0, Math.floor(r.tokens.length / 2)).trim();
    if (half.length > 20) expect(r.tokens.indexOf(half)).toBe(r.tokens.lastIndexOf(half));
    // a mutating tool ran somewhere in the delegated turn
    const cart = await app.request('/cart?user_id=net&thread_id=net:cart');
    const body = await cart.json() as any;
    expect(Array.isArray(body.lines)).toBe(true);
    expect(body.lines.length).toBeGreaterThan(0);
  }, 120_000);

  it('answers a knowledge request with grounded content, not a retrieval-failure hedge', async () => {
    // Regression: the knowledge path used to route through a sub-agent that returned empty
    // text, so the router hedged ("having trouble retrieving") even though knowledgeSearch
    // returned hits. The router now owns knowledgeSearch directly. Assert the reply is
    // grounded (names return-policy content) AND is not a false "cannot retrieve" hedge.
    const r = await chat(app, 'What is your return policy, and how long do refunds take?', 'net:kb');
    expect(r.terminal).toBe('done');
    expect(r.tokens.trim().length).toBeGreaterThan(0);
    expect(r.tokens.toLowerCase()).toMatch(/return|refund|day|receipt/);
    expect(r.tokens.toLowerCase()).not.toMatch(/having trouble retriev|unable to retriev|aren't coming through|not coming through/);
  }, 120_000);

  it('answers a recipe request (knowledge base) with the grounded recipe', async () => {
    // Recipe + loyalty were the beats that surfaced the empty-sub-agent-text bug; keep an
    // explicit guard so a future regression to the sub-agent path is caught.
    const r = await chat(app, 'Share a quick pasta recipe I can make tonight.', 'net:recipe');
    expect(r.terminal).toBe('done');
    expect(r.tokens.toLowerCase()).toMatch(/pasta|garlic|spaghetti|butter/);
    expect(r.tokens.toLowerCase()).not.toMatch(/having trouble retriev|unable to retriev|not coming through/);
  }, 120_000);
});
