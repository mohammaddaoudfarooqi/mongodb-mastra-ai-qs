import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient, type Db } from 'mongodb';
import { loadConfig, type Config } from '../../src/config';
import { seedRetail } from '../../src/ingestion/seed';
import { generateProducts, generateOrders, generatePromotions } from '../../src/ingestion/fixtures';

const hasEnv = !!process.env.MONGODB_URI && !!process.env.VOYAGE_API_KEY;

describe.skipIf(!hasEnv)('retail seed + data queries (Atlas integration)', () => {
  let client: MongoClient;
  let db: Db;
  let cfg: Config;

  beforeAll(async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    // Per-file DB isolation (see smoke-beats): own the retail collections so a
    // parallel file's cleanup cannot drop them mid-test. Never the demo DB.
    const baseDb = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';
    cfg = loadConfig({ ...process.env, MONGODB_DATABASE: `${baseDb}_data` } as any);
    client = new MongoClient(cfg.mongoUri);
    await client.connect();
    db = client.db(cfg.mongoDb);
    const products = generateProducts();
    await seedRetail(db, { products, orders: generateOrders(products), promotions: generatePromotions() });
  }, 60_000);

  afterAll(async () => {
    for (const c of ['products', 'orders', 'promotions']) await db?.collection(c).drop().catch(() => {});
    await client?.close();
  });

  it('seeds the catalog and an allow-listed find returns on-sale products', async () => {
    const count = await db.collection('products').countDocuments();
    // generateProducts() now loads the full catalog.json (~1505 products).
    expect(count).toBeGreaterThan(1000);
    const onSale = await db.collection('products').find({ on_sale: true }).limit(cfg.dataAgentLimit).toArray();
    expect(onSale.length).toBeGreaterThan(0);
    for (const p of onSale) expect(p.sale_price_usd).toBeLessThan(p.price_usd);
  }, 60_000);
});
