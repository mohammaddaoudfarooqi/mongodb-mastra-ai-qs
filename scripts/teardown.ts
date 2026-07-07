import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { APP_OWNED_COLLECTIONS, confirmDestructive } from './lib';

async function main() {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  // Drops app-owned collections — gate on explicit confirmation + prod-name refusal.
  confirmDestructive(cfg, 'teardown (drop app-owned collections)', { requireConfirm: true });
  const client = new MongoClient(cfg.mongoUri);
  try {
    await client.connect();
    const db = client.db(cfg.mongoDb);
    const existing = new Set((await db.listCollections().toArray()).map(c => c.name));
    for (const name of APP_OWNED_COLLECTIONS) {
      if (existing.has(name)) {
        await db.collection(name).drop().catch(err => logger.warn('drop failed', { name, err: String(err) }));
        logger.info('dropped', { collection: name });
      }
    }
    logger.info('teardown complete (mastra_* tables left intact)');
  } finally {
    await client.close();
  }
}

main().then(() => process.exit(0)).catch(err => { logger.error('teardown failed', { err: String(err) }); process.exit(1); });
