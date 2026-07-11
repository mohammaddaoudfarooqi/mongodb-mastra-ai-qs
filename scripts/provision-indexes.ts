import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { createKnowledgeVector, provisionKnowledgeIndex } from '../src/mastra/vector';
import { SemanticResponseCache } from '../src/cache/semantic-response-cache';
import { getQueryEmbedder } from '../src/mastra/embed';
import { provisionCartIndex } from '../src/mastra/tools/cart';

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const vector = createKnowledgeVector(cfg);
  const client = new MongoClient(cfg.mongoUri);
  try {
    await client.connect();
    logger.info('provisioning knowledge_base index (vector + search)');
    await provisionKnowledgeIndex(vector);

    logger.info('provisioning semantic_response_cache (vectorSearch + TTL)');
    const embedder = getQueryEmbedder(cfg);
    const cache = new SemanticResponseCache({
      collection: client.db(cfg.mongoDb).collection('semantic_response_cache'),
      embed: q => embedder.embedQuery(q),
      cfg: cfg.responseCache,
    });
    await cache.provision();

    logger.info('provisioning carts unique {userId, threadId} index (dedupes first)');
    await provisionCartIndex(client.db(cfg.mongoDb));

    logger.info('provision complete');
  } finally {
    await client.close();
    await (vector as any).disconnect?.().catch?.(() => {});
  }
}

main().then(() => process.exit(0)).catch(err => { logger.error('provision failed', { err: String(err) }); process.exit(1); });
