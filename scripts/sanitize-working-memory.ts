/**
 * One-time (idempotent) cleanup: sanitize existing resource-scoped working-memory docs.
 *
 * Before the write-boundary sanitizer existed, the model persisted volatile commerce state
 * (cart totals, item counts, invented store-availability claims) into the durable shopper
 * profile in `mastra_resources`. Those docs read back on later turns as fabricated current
 * state (the "25 items / $1,879.75" cart recited before any add). This script scrubs the
 * already-polluted docs using the SAME sanitizer the live write path now applies, so history
 * matches the new invariant. Safe to run repeatedly.
 *
 *   pnpm tsx scripts/sanitize-working-memory.ts          # apply
 *   pnpm tsx scripts/sanitize-working-memory.ts --dry    # preview only
 */
import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config';
import { logger } from '../src/observability/logger';
import { sanitizeWorkingMemory } from '../src/mastra/working-memory-sanitizer';

const RESOURCES_COLLECTION = 'mastra_resources';

async function main() {
  const dry = process.argv.includes('--dry');
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const cfg = loadConfig();
  const client = new MongoClient(cfg.mongoUri);
  try {
    await client.connect();
    const col = client.db(cfg.mongoDb).collection(RESOURCES_COLLECTION);
    const docs = await col.find({ workingMemory: { $type: 'string' } }).toArray();
    let changed = 0;
    for (const doc of docs) {
      const before = doc.workingMemory as string;
      const after = sanitizeWorkingMemory(before);
      if (after === before) continue;
      changed++;
      logger.info('sanitizing working memory', {
        resource: doc.id,
        removedChars: before.length - after.length,
      });
      if (!dry) {
        await col.updateOne({ _id: doc._id }, { $set: { workingMemory: after } });
      }
    }
    logger.info(dry ? 'dry run complete (no writes)' : 'sanitize complete', {
      scanned: docs.length,
      changed,
    });
  } finally {
    await client.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  logger.error('sanitize failed', { err: String(err) });
  process.exit(1);
});
