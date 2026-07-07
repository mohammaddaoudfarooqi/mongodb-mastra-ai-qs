import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import type { MongoDBVector } from '@mastra/mongodb';
import type { Config } from '../config';
import { logger } from '../observability/logger';
import { createKnowledgeVector, KNOWLEDGE_INDEX } from '../mastra/vector';
import { getDocEmbedder, buildDocContent, type DocEmbedder } from '../mastra/embed';
import {
  generateProducts, generateOrders, generatePromotions, TEXT_KNOWLEDGE, type TextKnowledgeDoc,
} from './fixtures';

export interface UpsertDoc { id: string; document: string; metadata: Record<string, unknown> }

export function buildTextKnowledgeDocs(docs: TextKnowledgeDoc[]): UpsertDoc[] {
  return docs.map(d => ({
    id: d.id,
    document: `${d.title}\n\n${d.text}`,
    metadata: { mediaType: 'text', source: d.source, title: d.title },
  }));
}

/** Pick a minimal Vector interface so tests can stub without a live connector. */
type UpsertVector = Pick<MongoDBVector, 'upsert'>;

export async function embedAndUpsert(
  vector: UpsertVector,
  embedder: DocEmbedder,
  docs: UpsertDoc[],
  batchSize = 32,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < docs.length; i += batchSize) {
    const batch = docs.slice(i, i + batchSize);
    const vectors = await embedder.embedDocuments(batch.map(d => buildDocContent(d.document)));
    await vector.upsert({
      indexName: KNOWLEDGE_INDEX,
      vectors,
      metadata: batch.map(d => d.metadata),
      ids: batch.map(d => d.id),
      documents: batch.map(d => d.document),
    });
    total += batch.length;
    logger.info('knowledge upsert batch', { from: i, size: batch.length });
  }
  return total;
}

export async function seedRetail(
  db: Db,
  data: { products: unknown[]; orders: unknown[]; promotions: unknown[] },
): Promise<void> {
  for (const [name, rows] of Object.entries(data) as [string, unknown[]][]) {
    const col = db.collection(name);
    await col.deleteMany({});
    if (rows.length) await col.insertMany(rows as any[]);
    logger.info('seeded collection', { collection: name, count: rows.length });
  }
}

export async function runSeed(cfg: Config): Promise<{ products: number; orders: number; promotions: number; knowledge: number }> {
  const client = new MongoClient(cfg.mongoUri);
  const vector = createKnowledgeVector(cfg);
  try {
    await client.connect();
    const db = client.db(cfg.mongoDb);
    const products = generateProducts();
    const orders = generateOrders(products);
    const promotions = generatePromotions();
    await seedRetail(db, { products, orders, promotions });

    const knowledge = await embedAndUpsert(vector, getDocEmbedder(cfg), buildTextKnowledgeDocs(TEXT_KNOWLEDGE));
    logger.info('seed complete', { products: products.length, orders: orders.length, promotions: promotions.length, knowledge });
    return { products: products.length, orders: orders.length, promotions: promotions.length, knowledge };
  } finally {
    await client.close();
    await (vector as any).disconnect?.().catch?.(() => {});
  }
}

// Entry point: `pnpm seed`
if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const { loadConfig } = await import('../config');
  runSeed(loadConfig())
    .then(r => { logger.info('seed done', r); process.exit(0); })
    .catch(err => { logger.error('seed failed', { err: String(err) }); process.exit(1); });
}
