import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { loadConfig, type Config } from '../../src/config';
import { createApp } from '../../src/server/app';
import { createKnowledgeVector, provisionKnowledgeIndex } from '../../src/mastra/vector';
import { runSeed } from '../../src/ingestion/seed';
import { SemanticResponseCache } from '../../src/cache/semantic-response-cache';
import { getQueryEmbedder } from '../../src/mastra/embed';

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

async function chat(app: ReturnType<typeof createApp>, message: string, threadId: string, userId = 'ltm'): Promise<Collected> {
  const res = await app.request('/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, user_id: userId, thread_id: threadId }),
  });
  return collectSse(res);
}

describe.skipIf(!hasEnv)('cross-thread long-term memory (Atlas + LLM integration)', () => {
  let client: MongoClient; let cfg: Config; let app: ReturnType<typeof createApp>;
  let vector: ReturnType<typeof createKnowledgeVector>;

  beforeAll(async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    const baseDb = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';
    cfg = loadConfig({ ...process.env, MONGODB_DATABASE: `${baseDb}_ltm` } as any);
    client = new MongoClient(cfg.mongoUri); await client.connect();
    await client.db(cfg.mongoDb).dropDatabase().catch(() => {});
    vector = createKnowledgeVector(cfg);
    await provisionKnowledgeIndex(vector);
    // Provision the semantic_response_cache vectorSearch + TTL index (for TC-LTM-002).
    // This mirrors smoke-beats beforeAll; without it, cache lookup's $vectorSearch finds
    // no index and TC-LTM-002 can never hit.
    const cacheEmbedder = getQueryEmbedder(cfg);
    const cacheForProvision = new SemanticResponseCache({
      collection: client.db(cfg.mongoDb).collection('semantic_response_cache'),
      embed: q => cacheEmbedder.embedQuery(q),
      cfg: cfg.responseCache,
    });
    await cacheForProvision.provision();
    // Seed KB text + retail (full catalog) so recommendations have products.
    await runSeed(cfg);
    app = createApp(cfg);
  }, 600_000);

  afterAll(async () => { await client?.close(); });

  it('recalls a preference stored in one thread when asked in a different thread', async () => {
    const user = 'ltm-user';
    // Thread A: state a durable preference. The router records it in the shopper profile.
    const a = await chat(app, 'Remember that I prefer eco-friendly kitchen products.', 'ltm:a', user);
    expect(a.terminal).toBe('done');
    expect(a.tokens.trim().length).toBeGreaterThan(0);
    // Thread B (a DIFFERENT thread, SAME user): ask for a personalized recommendation.
    // The memory vector/profile write is eventually consistent, so poll a few times.
    let recalled = false;
    for (let i = 0; i < 8; i++) {
      const b = await chat(app, 'Based on what you know about me, what kitchen items would you recommend?', `ltm:b-${i}`, user);
      if (b.terminal === 'done' && /eco|sustainab|environ/i.test(b.tokens)) { recalled = true; break; }
      await new Promise(res => setTimeout(res, 3000));
    }
    expect(recalled, 'expected the eco-friendly preference stored in thread A to surface in thread B').toBe(true);
  }, 240_000);

  it('keeps a new-thread opener cache-eligible despite same-user history on another thread', async () => {
    const user = 'ltm-cacheuser';
    // Give this user history on thread A (so resource-wide history is non-empty).
    await chat(app, 'What is your return policy?', 'ltm:hist', user);
    const q = 'How long does shipping take?';
    // Seed the cache from a fresh thread opener.
    const seed = await chat(app, q, 'ltm:seed', user);
    expect(seed.terminal).toBe('done');
    expect(seed.tokens.trim().length).toBeGreaterThan(0);
    // A DIFFERENT new thread, same user: must be treated as an opener (priorCount===0) and
    // therefore served verbatim from the cache once the vector write is visible.
    let hit = false;
    for (let i = 0; i < 20; i++) {
      const r = await chat(app, q, `ltm:hit-${i}`, user);
      if (r.terminal === 'done' && r.tokens === seed.tokens) { hit = true; break; }
      await new Promise(res => setTimeout(res, 3000));
    }
    expect(hit, 'a new-thread opener for a user with other-thread history must remain cache-read-eligible').toBe(true);
  }, 240_000);
});
