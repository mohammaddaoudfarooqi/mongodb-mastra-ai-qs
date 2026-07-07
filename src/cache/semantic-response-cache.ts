import type { Collection } from 'mongodb';
import type { Config } from '../config';
import { logger } from '../observability/logger';
import { expiresAt, capToBytes } from './cache-decisions';

const VECTOR_INDEX = 'response_cache_vector_index';

export interface CacheDeps {
  collection: Collection;
  embed: (query: string) => Promise<number[]>;
  cfg: Config['responseCache'];
}

export class SemanticResponseCache {
  constructor(private deps: CacheDeps) {}

  /** Create the $vectorSearch index (userId+model as filter fields) and the TTL index. */
  async provision(): Promise<void> {
    const { collection } = this.deps;
    // Atlas rejects createSearchIndex on a collection that does not exist yet.
    // A regular createIndex implicitly creates the collection, so run the TTL index
    // first: it both materializes the namespace and sets up expiry. Idempotent.
    // TTL: reap when expiresAt passes.
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'response_cache_ttl' });

    const existing = await collection.listSearchIndexes().toArray().catch(() => []);
    if (!existing.some((i: any) => i.name === VECTOR_INDEX)) {
      await collection.createSearchIndex({
        name: VECTOR_INDEX,
        type: 'vectorSearch',
        definition: {
          fields: [
            { type: 'vector', path: 'queryEmbedding', numDimensions: 1024, similarity: 'cosine' },
            { type: 'filter', path: 'userId' },
            { type: 'filter', path: 'model' },
          ],
        },
      });
    }
  }

  async lookup(query: string, userId: string, model: string): Promise<{ answer: string; score: number } | null> {
    const queryEmbedding = await this.deps.embed(query);
    const results = await this.deps.collection.aggregate([
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: 'queryEmbedding',
          queryVector: queryEmbedding,
          numCandidates: 20,
          limit: 1,
          filter: { userId, model },
        },
      },
      { $set: { score: { $meta: 'vectorSearchScore' } } },
      { $project: { _id: 0, answer: 1, score: 1 } },
    ]).toArray();

    const best = results[0] as { answer: string; score: number } | undefined;
    if (best && best.score >= this.deps.cfg.similarityThreshold) {
      logger.counter('cache.hit');
      return { answer: best.answer, score: best.score };
    }
    logger.counter('cache.miss');
    logger.info('cache near-miss', { bestScore: best?.score ?? null, threshold: this.deps.cfg.similarityThreshold });
    return null;
  }

  async save(query: string, userId: string, model: string, answer: string, now: Date): Promise<void> {
    const capped = capToBytes(answer, this.deps.cfg.maxAnswerBytes);
    const queryEmbedding = await this.deps.embed(query);
    await this.deps.collection.insertOne({
      queryEmbedding, query, answer: capped, userId, model,
      expiresAt: expiresAt(now, this.deps.cfg.ttlDays),
    });
    logger.counter('cache.write');
  }
}
