import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { loadConfig, type Config } from '../../src/config';
import { buildCartTools, provisionCartIndex, type CartLine } from '../../src/mastra/tools/cart';

// Faithful reproduction of the production "1 item survives after checkout" bug: under load, a
// bulk add fires many cartAdd calls near-simultaneously. Without a unique {userId,threadId}
// index, racing upserts each INSERT a separate cart doc, so the cart splits across documents and
// checkout (single findOne/deleteOne) only quotes/clears one. This test provisions the unique
// index (the fix) and asserts N concurrent distinct adds land in exactly ONE cart doc.
//
// Needs a real Atlas connection (unique-index enforcement + true concurrency); self-skips
// otherwise, matching tests/integration/order-workflow.integration.test.ts.
const hasEnv = !!process.env.MONGODB_URI;

describe.skipIf(!hasEnv)('carts unique index prevents split-cart under concurrent adds', () => {
  let client: MongoClient; let cfg: Config; let db: Db;
  const key = { userId: 'concurrency-test', threadId: 'concurrency-test:1' };
  let PRODUCT_IDS: string[] = [];

  beforeAll(async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    const baseDb = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';
    cfg = loadConfig({ ...process.env, MONGODB_DATABASE: `${baseDb}_cartrace` } as any);
    client = new MongoClient(cfg.mongoUri); await client.connect();
    db = client.db(cfg.mongoDb);
    await db.dropDatabase().catch(() => {});
    // Seed a handful of real products the cart resolver can look up by _id.
    PRODUCT_IDS = Array.from({ length: 8 }, (_, i) => `prod_race_${String(i).padStart(2, '0')}`);
    await db.collection('products').insertMany(PRODUCT_IDS.map((id, i) => ({
      _id: id as any, name: `Race Product ${i}`, category: 'kitchen',
      price_usd: 10 + i, sale_price_usd: null, on_sale: false, stock: 100,
    })));
    // Provision the unique index (the fix under test).
    await provisionCartIndex(db);
  }, 120_000);

  afterAll(async () => {
    await db?.dropDatabase().catch(() => {});
    await client?.close();
  });

  it('lands N concurrent distinct adds in exactly one cart document', async () => {
    // Grounding allows every seeded product; a high cap so the distinct-add guard never rejects.
    const turnProductIds = new Set(PRODUCT_IDS);
    const { cartAdd } = buildCartTools({ db, ...key, turnProductIds, maxDistinctAddsPerTurn: PRODUCT_IDS.length });

    // Fire all adds concurrently — the exact shape of the bulk-add turn that split the cart.
    const results = await Promise.all(
      PRODUCT_IDS.map(id => cartAdd.execute!({ line: { product_id: id, qty: 1 } } as any, {} as any)),
    );
    for (const r of results) expect((r as any).ok).toBe(true);

    // Exactly ONE cart doc for the key (the bug produced several).
    const docs = await db.collection('carts').find(key).toArray();
    expect(docs).toHaveLength(1);
    // And it holds every distinct product — nothing lost to a split sibling doc.
    const ids = ((docs[0].lines ?? []) as CartLine[]).map(l => l.product_id).sort();
    expect(ids).toEqual([...PRODUCT_IDS].sort());
  }, 120_000);

  it('enforces the unique index at the storage layer (a raw second insert is rejected)', async () => {
    await db.collection('carts').deleteMany(key);
    await db.collection('carts').insertOne({ ...key, lines: [], updated_at: new Date() } as any);
    await expect(
      db.collection('carts').insertOne({ ...key, lines: [], updated_at: new Date() } as any),
    ).rejects.toMatchObject({ code: 11000 });
  }, 120_000);
});
