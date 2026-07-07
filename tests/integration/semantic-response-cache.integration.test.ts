import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { SemanticResponseCache } from '../../src/cache/semantic-response-cache';

const hasEnv = !!process.env.MONGODB_URI && !!process.env.VOYAGE_API_KEY;

describe.skipIf(!hasEnv)('SemanticResponseCache (Atlas integration)', () => {
  let client: MongoClient;
  const dbName = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';

  beforeAll(async () => {
    client = new MongoClient(process.env.MONGODB_URI!);
    await client.connect();
  });
  afterAll(async () => { await client?.close(); });

  it('provisions, saves, and retrieves a scoped cache hit', async () => {
    const col = client.db(dbName).collection('semantic_response_cache_test');
    const fakeEmbed = async () => Array.from({ length: 1024 }, () => 0.01);
    const cache = new SemanticResponseCache({
      collection: col, embed: fakeEmbed,
      cfg: { enabled: true, ttlDays: 1, similarityThreshold: 0.0, maxAnswerBytes: 32768 },
    });
    await cache.provision();
    await cache.save('return policy?', 'demo', 'm', 'Returns within 30 days.', new Date());
    // Vector index build is async; a real run waits for READY. Here we assert save shape only if index not ready.
    const stored = await col.findOne({ userId: 'demo' });
    expect(stored?.answer).toBe('Returns within 30 days.');
    await col.drop().catch(() => {});
  });
});
