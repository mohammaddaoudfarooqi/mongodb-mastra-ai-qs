import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { loadConfig, type Config } from '../../src/config';
import { createKnowledgeVector, provisionKnowledgeIndex, KNOWLEDGE_INDEX } from '../../src/mastra/vector';
import { embedAndUpsert, buildTextKnowledgeDocs } from '../../src/ingestion/seed';
import { getDocEmbedder, getQueryEmbedder, getReranker } from '../../src/mastra/embed';
import { runKnowledgeSearch } from '../../src/mastra/tools/knowledge-search';

const hasEnv = !!process.env.MONGODB_URI && !!process.env.VOYAGE_API_KEY;

describe.skipIf(!hasEnv)('multimodal ingestion + hybrid retrieval (Atlas integration)', () => {
  let client: MongoClient;
  let cfg: Config;
  let vector: ReturnType<typeof createKnowledgeVector>;

  beforeAll(async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    // Per-file DB isolation (see smoke-beats): own the knowledge_base namespace
    // so a parallel file's cleanup cannot drop it mid-test. Never the demo DB.
    const baseDb = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';
    cfg = loadConfig({ ...process.env, MONGODB_DATABASE: `${baseDb}_ingestion` } as any);
    client = new MongoClient(cfg.mongoUri);
    await client.connect();
    vector = createKnowledgeVector(cfg);
    await provisionKnowledgeIndex(vector); // creates + waits for vector & search indexes
  }, 120_000);

  afterAll(async () => {
    await client?.db(cfg.mongoDb).collection(KNOWLEDGE_INDEX).drop().catch(() => {});
    await client?.close();
    await (vector as any).disconnect?.().catch?.(() => {});
  });

  it('embeds text KB docs, then a hybrid query retrieves and reranks the right doc', async () => {
    const docs = buildTextKnowledgeDocs([
      { id: 'return-policy', title: 'Return Policy', source: 'knowledge', text: 'Items can be returned within 30 days for a full refund.' },
      { id: 'shipping', title: 'Shipping', source: 'knowledge', text: 'Standard shipping takes 3 to 5 business days.' },
    ]);
    const n = await embedAndUpsert(vector, getDocEmbedder(cfg), docs);
    expect(n).toBe(2);

    // Vector/search indexes are async; poll until the query returns something (bounded).
    const embedder = getQueryEmbedder(cfg);
    const reranker = getReranker(cfg);
    const col = client.db(cfg.mongoDb).collection(KNOWLEDGE_INDEX);
    const search = () => runKnowledgeSearch('how long do I have to return an item?', {
      embed: q => embedder.embedQuery(q),
      vectorSearch: async (vec, topK) =>
        (await vector.query({ indexName: KNOWLEDGE_INDEX, queryVector: vec, topK }))
          .map(r => ({ id: r.id, document: r.document, metadata: r.metadata })),
      lexicalSearch: async (q, topK) =>
        (await col.aggregate([
          { $search: { index: `${KNOWLEDGE_INDEX}_search_index`, text: { query: q, path: { wildcard: '*' } } } },
          { $limit: topK }, { $project: { _id: 1, document: 1, metadata: 1 } },
        ]).toArray()).map((r: any) => ({ id: r._id, document: r.document, metadata: r.metadata })),
      rerank: async (q, d, topK) =>
        (await reranker.rerankDocuments(q, d.map(x => x.document ?? ''), topK)).map(r => ({ index: r.index, score: r.score })),
    }, { rrfK: cfg.rrfK, topK: 3 });

    let hits: Awaited<ReturnType<typeof search>> = [];
    for (let i = 0; i < 30 && hits.length === 0; i++) {
      hits = await search();
      if (hits.length === 0) await new Promise(r => setTimeout(r, 2000));
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].document.toLowerCase()).toContain('return');
  }, 180_000);
});
