import { MongoDBVector } from '@mastra/mongodb';
import type { Config } from '../config';
import { logger } from '../observability/logger';

export const KNOWLEDGE_INDEX = 'knowledge_base';
/** Atlas Search (lexical) index name — must match the `$search` index used by the
 *  knowledge-search tool's lexical leg (`${KNOWLEDGE_INDEX}_search_index`). */
export const KNOWLEDGE_SEARCH_INDEX = `${KNOWLEDGE_INDEX}_search_index`;

export function createKnowledgeVector(cfg: Config): MongoDBVector {
  return new MongoDBVector({ id: 'knowledge', uri: cfg.mongoUri, dbName: cfg.mongoDb });
}

/**
 * Provision the knowledge_base indexes:
 *   - the $vectorSearch index (1024-dim cosine) for semantic retrieval, and
 *   - the Atlas $search (lexical) index the hybrid search's lexical leg needs.
 *
 * Without the lexical index, `knowledge-search.ts` catches the `$search` failure and
 * silently downgrades to vector-only — so the demo would claim "hybrid search" while the
 * lexical half is absent (reviewer finding #9). Creating it here keeps provisioning honest.
 * Idempotent: skips the lexical index if it already exists.
 */
export async function provisionKnowledgeIndex(v: MongoDBVector): Promise<void> {
  await v.createIndex({ indexName: KNOWLEDGE_INDEX, dimension: 1024, metric: 'cosine' });
  await v.waitForIndexReady({ indexName: KNOWLEDGE_INDEX });
  await provisionLexicalSearchIndex(v);
}

/**
 * Create the Atlas Search lexical index on the knowledge_base collection (dynamic mapping,
 * so it indexes `document` + all `metadata.*` fields the wildcard `$search` path queries).
 * Reaches the raw collection through the vector adapter's Mongo handle. Best-effort: logs
 * and returns on failure so a transient/permission issue doesn't abort the whole provision
 * (the vector index — the critical leg — is already created above).
 */
export async function provisionLexicalSearchIndex(v: MongoDBVector): Promise<void> {
  const col = (v as any).db?.collection?.(KNOWLEDGE_INDEX);
  if (!col?.createSearchIndex) {
    logger.warn('lexical search index skipped: collection handle unavailable', { index: KNOWLEDGE_SEARCH_INDEX });
    return;
  }
  try {
    // createSearchIndex requires the namespace to exist; a no-op createIndex materializes it.
    await col.createIndex({ _id: 1 }).catch(() => { /* namespace may already exist */ });
    const existing = await col.listSearchIndexes().toArray().catch(() => []);
    if (existing.some((i: any) => i.name === KNOWLEDGE_SEARCH_INDEX)) return;
    await col.createSearchIndex({
      name: KNOWLEDGE_SEARCH_INDEX,
      // Dynamic mapping indexes every field, matching the tool's `path: { wildcard: '*' }`.
      definition: { mappings: { dynamic: true } },
    });
    logger.info('lexical search index created', { index: KNOWLEDGE_SEARCH_INDEX });
  } catch (err) {
    logger.warn('lexical search index creation failed; hybrid search will run vector-only until it exists', {
      index: KNOWLEDGE_SEARCH_INDEX, err: String(err),
    });
  }
}
