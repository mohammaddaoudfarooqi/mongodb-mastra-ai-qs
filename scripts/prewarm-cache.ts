import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { SemanticResponseCache } from '../src/cache/semantic-response-cache';
import { getQueryEmbedder, getReranker } from '../src/mastra/embed';
import { createKnowledgeVector, KNOWLEDGE_INDEX } from '../src/mastra/vector';
import { runKnowledgeSearch } from '../src/mastra/tools/knowledge-search';
import { resolvePrewarmQueries, sleep } from './lib';

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  const vector = createKnowledgeVector(cfg);
  const embedder = getQueryEmbedder(cfg);
  const reranker = getReranker(cfg);
  try {
    await client.connect();
    const db = client.db(cfg.mongoDb);
    const cache = new SemanticResponseCache({
      collection: db.collection('semantic_response_cache'),
      embed: q => embedder.embedQuery(q),
      cfg: cfg.responseCache,
    });
    const col = db.collection(KNOWLEDGE_INDEX);
    let warmed = 0;
    for (const query of resolvePrewarmQueries(cfg)) {
      const hits = await runKnowledgeSearch(query, {
        embed: q => embedder.embedQuery(q),
        vectorSearch: async (vec, topK) =>
          (await vector.query({ indexName: KNOWLEDGE_INDEX, queryVector: vec, topK }))
            .map(r => ({ id: r.id, document: r.document, metadata: r.metadata })),
        lexicalSearch: async (q, topK) =>
          (await col.aggregate([
            { $search: { index: `${KNOWLEDGE_INDEX}_search_index`, text: { query: q, path: { wildcard: '*' } } } },
            { $limit: topK }, { $project: { _id: 1, document: 1, metadata: 1 } },
          ]).toArray()).map((r: any) => ({ id: r._id, document: r.document, metadata: r.metadata })),
        rerank: async (q, docs, topK) =>
          (await reranker.rerankDocuments(q, docs.map(d => d.document ?? ''), topK)).map(r => ({ index: r.index, score: r.score })),
      }, { rrfK: cfg.rrfK, topK: 5 });
      if (hits.length) {
        const answer = hits.map(h => h.document).join('\n\n');
        await cache.save(query, cfg.defaultUserId, cfg.llmModel, answer, new Date());
        warmed++;
        logger.info('prewarmed', { query, hits: hits.length });
      } else {
        logger.warn('prewarm skipped (no hits; is knowledge_base seeded?)', { query });
      }
      await sleep(250); // gentle pacing against Voyage rate limits
    }
    logger.info('prewarm complete', { warmed });
  } finally {
    await client.close();
    await (vector as any).disconnect?.().catch?.(() => {});
  }
}

main().then(() => process.exit(0)).catch(err => { logger.error('prewarm failed', { err: String(err) }); process.exit(1); });
