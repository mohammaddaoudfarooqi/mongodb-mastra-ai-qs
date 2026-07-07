import { MongoDBVector } from '@mastra/mongodb';
import type { Config } from '../config';

export const KNOWLEDGE_INDEX = 'knowledge_base';

export function createKnowledgeVector(cfg: Config): MongoDBVector {
  return new MongoDBVector({ id: 'knowledge', uri: cfg.mongoUri, dbName: cfg.mongoDb });
}

/** Create the knowledge_base vector + search indexes (1024-dim cosine) and wait for ready. */
export async function provisionKnowledgeIndex(v: MongoDBVector): Promise<void> {
  await v.createIndex({ indexName: KNOWLEDGE_INDEX, dimension: 1024, metric: 'cosine' });
  await v.waitForIndexReady({ indexName: KNOWLEDGE_INDEX });
}
