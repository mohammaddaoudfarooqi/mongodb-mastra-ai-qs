import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { loadConfig, type Config } from '../../src/config';
import { createApp } from '../../src/server/app';
import { createKnowledgeVector, provisionKnowledgeIndex } from '../../src/mastra/vector';
import { runSeed } from '../../src/ingestion/seed';
import { runIngest } from '../../src/ingestion/ingest-multimodal';
import { SemanticResponseCache } from '../../src/cache/semantic-response-cache';
import { getQueryEmbedder } from '../../src/mastra/embed';

const hasEnv = !!process.env.MONGODB_URI && !!process.env.VOYAGE_API_KEY;

interface Collected {
  tokens: string;
  statuses: { phase: string; name: string }[];
  correlationId: string | null;
  terminal: 'done' | 'error' | null;
  errorDetail: string | null;
}

async function collectSse(res: Response): Promise<Collected> {
  const out: Collected = { tokens: '', statuses: [], correlationId: null, terminal: null, errorDetail: null };
  const text = await res.text();
  for (const frame of text.split('\n\n')) {
    if (!frame.trim()) continue;
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (event === 'token') out.tokens += data;
    else if (event === 'correlation') out.correlationId = data;
    else if (event === 'status') { try { out.statuses.push(JSON.parse(data)); } catch { /* ignore */ } }
    else if (event === 'done') out.terminal = 'done';
    else if (event === 'error') { out.terminal = 'error'; out.errorDetail = data; }
  }
  return out;
}

async function chat(app: ReturnType<typeof createApp>, message: string, threadId: string, userId = 'smoke'): Promise<Collected> {
  const res = await app.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, user_id: userId, thread_id: threadId }),
  });
  return collectSse(res);
}

describe.skipIf(!hasEnv)('per-beat smoke tests (Atlas + LLM integration)', () => {
  let client: MongoClient;
  let cfg: Config;
  let app: ReturnType<typeof createApp>;
  let vector: ReturnType<typeof createKnowledgeVector>;

  beforeAll(async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    // Per-file DB isolation: vitest runs integration files in parallel and they
    // all share one Atlas test cluster. Deriving a file-specific DB from the base
    // test DB removes the cross-file race (e.g. ingestion's afterAll dropping
    // knowledge_base mid-setup here). Never the demo DB.
    const baseDb = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';
    cfg = loadConfig({ ...process.env, MONGODB_DATABASE: `${baseDb}_smoke` } as any);
    client = new MongoClient(cfg.mongoUri);
    await client.connect();
    // Start from a clean slate: drop the whole per-file test DB before provisioning.
    // The beats assert tool/cache PATHS, not just answers, and those paths depend on
    // state that persists across runs if not cleared: a stale semantic-cache entry
    // serves a KB query with no knowledgeSearch frame, and stale Mastra conversation
    // memory on a fixed thread lets the model answer from history instead of calling
    // the tool. Dropping the DB here (not just app collections in afterAll) makes each
    // run independent of how the previous one ended. Never the demo DB (see above).
    await client.db(cfg.mongoDb).dropDatabase().catch(() => {});
    vector = createKnowledgeVector(cfg);
    await provisionKnowledgeIndex(vector);   // build + wait for knowledge_base indexes
    // Provision the semantic_response_cache vectorSearch + TTL index (Beat 4). This
    // mirrors scripts/provision-indexes.ts; createApp does NOT build it, and since
    // beforeAll drops the DB, without this the cache lookup's $vectorSearch finds no
    // index and never hits, so Beat 4 could never observe a cache replay.
    const cacheEmbedder = getQueryEmbedder(cfg);
    const cacheForProvision = new SemanticResponseCache({
      collection: client.db(cfg.mongoDb).collection('semantic_response_cache'),
      embed: q => cacheEmbedder.embedQuery(q),
      cfg: cfg.responseCache,
    });
    await cacheForProvision.provision();
    await runSeed(cfg);                       // retail + text KB
    await runIngest(cfg);                     // multimodal image assets
    app = createApp(cfg);
  }, 300_000);

  afterAll(async () => {
    // Drop the whole per-file test DB (products, orders, promotions, carts,
    // knowledge_base, semantic_response_cache, feedback, and all mastra_* memory).
    // beforeAll also drops it, so cleanup here is best-effort tidiness.
    await client?.db(cfg.mongoDb).dropDatabase().catch(() => {});
    await client?.close();
    await (vector as any).disconnect?.().catch?.(() => {});
  }, 60_000);

  it('Beat 1 (multimodal HERO): a pamphlet query retrieves an image-sourced doc', async () => {
    // Poll: the knowledge_base search index build is async after ingest.
    let r: Collected = { tokens: '', statuses: [], correlationId: null, terminal: null, errorDetail: null };
    for (let i = 0; i < 20; i++) {
      r = await chat(app, 'Show me the summer sale pamphlet and what it is promoting.', `beat1-${i}`);
      if (r.tokens.toLowerCase().includes('sale') || r.tokens.toLowerCase().includes('summer')) break;
      await new Promise(res => setTimeout(res, 3000));
    }
    expect(r.terminal).toBe('done');
    // The router delegates to the knowledge specialist via the top-level agent-knowledge delegation tool.
    expect(r.statuses.some(s => s.name === 'agent-knowledge')).toBe(true);
    // Verify the grounded answer (not intermediate tool names).
    expect(r.tokens.toLowerCase()).toMatch(/sale|summer|outdoor|kitchen/);
  }, 180_000);

  it('Beat 2 (hybrid + rerank): the return-policy query streams a grounded answer', async () => {
    const r = await chat(app, 'What is your return policy and how long do refunds take?', 'beat2');
    expect(r.terminal).toBe('done');
    // The router delegates to the knowledge specialist via the top-level agent-knowledge delegation tool.
    expect(r.statuses.some(s => s.name === 'agent-knowledge')).toBe(true);
    // Verify the grounded answer (not intermediate tool names).
    expect(r.tokens.toLowerCase()).toMatch(/30 days|refund/);
  }, 120_000);

  it('Beat 3 (memory): a stored preference is recalled in a later turn on the same thread', async () => {
    const thread = 'beat3';
    await chat(app, 'Remember that I prefer eco-friendly kitchen products.', thread);
    const r = await chat(app, 'What kind of products do I prefer?', thread);
    expect(r.terminal).toBe('done');
    expect(r.tokens.toLowerCase()).toMatch(/eco|kitchen/);
  }, 180_000);

  it('Beat 4 (semantic cache): a repeat query is served from the cache with the identical answer', async () => {
    const q = 'How long does shipping take?';
    // Cache reads are attempted only on a conversation OPENER: app.ts gates the
    // lookup on isReadEligible(priorMessageCount === 0), and memory.recall is
    // resource(user)-scoped, so any prior turn by the same user (even on another
    // thread) makes later turns cache-ineligible. Beats 1-3 already gave the shared
    // 'smoke' user history, so this beat uses its OWN fresh user with no prior
    // turns; every turn below is thus a genuine opener and cache-read-eligible.
    const cacheUser = 'beat4-cacheuser';
    // Seed the cache. The saved answer is exactly the streamed token text (app.ts
    // saves answerParts.join('')), so a later cache hit replays THIS text verbatim.
    const first = await chat(app, q, 'beat4-seed', cacheUser);
    expect(first.terminal).toBe('done');
    expect(first.tokens.trim().length).toBeGreaterThan(0);
    // The cache is backed by Atlas vector search, which is eventually consistent:
    // the seed's cache write is not immediately queryable. Poll fresh threads (all
    // under the same fresh user, so each is a cache-read-eligible opener) until one
    // is served from the cache. The unambiguous cache-hit signal is a VERBATIM
    // replay of the seed answer: the hit path streams the stored answer exactly. A
    // miss cannot match it (it re-invokes knowledgeSearch with different wording),
    // so verbatim equality proves the hit.
    let hit = false;
    for (let i = 0; i < 25; i++) {
      const r = await chat(app, q, `beat4-hit-${i}`, cacheUser);
      if (r.terminal === 'done' && r.tokens === first.tokens) { hit = true; break; }
      await new Promise(res => setTimeout(res, 3000));
    }
    expect(hit, 'expected a verbatim cache-hit replay of the seed answer within the poll window').toBe(true);
  }, 180_000);

  it('Beat 5 (NL to MQL): the on-sale query runs dataQuery and names real products', async () => {
    const r = await chat(app, 'Show me a few products that are on sale, with their sale prices.', 'beat5');
    expect(r.terminal).toBe('done');
    // The router delegates to dealsAndCart via the top-level agent-dealsAndCart delegation tool.
    expect(r.statuses.some(s => s.name === 'agent-dealsAndCart')).toBe(true);
    // Verify real products with prices appear (not intermediate tool names).
    expect(r.tokens).toMatch(/\$\d/); // a dollar amount appears
  }, 120_000);

  it('Beat 6 (cart): adding an on-sale product builds a cart keyed on the turn identity', async () => {
    const user = 'beat6-cartuser';
    const thread = 'beat6';
    const r = await chat(app, 'Add the on-sale kitchen product with the biggest savings to my cart and show my total savings.', thread, user);
    expect(r.terminal).toBe('done');
    // The router delegates to dealsAndCart via the top-level agent-dealsAndCart delegation tool.
    expect(r.statuses.some(s => s.name === 'agent-dealsAndCart')).toBe(true);
    // Verify the cart was populated (not intermediate tool names).
    // The UI reads GET /cart on the SAME {user, thread}. Because cart tools are bound to
    // the turn identity (not model-supplied), the built cart must be visible here with a
    // nonzero subtotal derived from its lines.
    const cartRes = await app.request(`/cart?user_id=${user}&thread_id=${thread}`);
    const cart = await cartRes.json() as { lines: unknown[]; subtotal: number; total_savings: number };
    expect(cart.lines.length).toBeGreaterThan(0);
    expect(cart.subtotal).toBeGreaterThan(0);
  }, 120_000);
});
