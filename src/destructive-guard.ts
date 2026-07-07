import type { Config } from './config';
import { logger } from './observability/logger';

/**
 * Guard a destructive data operation (seed wipes collection contents; teardown drops them).
 * A mis-pointed `.env` could otherwise wipe the wrong database (reviewer finding #12). This:
 *   1. Echoes the exact target (host + database) so it is visible before anything is deleted.
 *   2. Refuses to run against a production-looking database name unless FORCE_DESTRUCTIVE=1.
 *   3. Requires explicit opt-in for the drop-heavy `teardown` via CONFIRM_DESTRUCTIVE=1.
 * `operation` labels the caller; `requireConfirm` gates the most destructive path (teardown).
 * Throws (aborting the script) when a guard fails.
 */
export function confirmDestructive(
  cfg: Config,
  operation: string,
  opts: { requireConfirm?: boolean } = {},
): void {
  // Redact credentials from the URI before logging the host.
  const host = cfg.mongoUri.replace(/\/\/[^@]*@/, '//');
  logger.warn(`destructive operation: ${operation}`, { database: cfg.mongoDb, host });

  const looksProd = /prod|production|live/i.test(cfg.mongoDb);
  if (looksProd && process.env.FORCE_DESTRUCTIVE !== '1') {
    throw new Error(
      `Refusing to ${operation}: database "${cfg.mongoDb}" looks like production. ` +
      `Set FORCE_DESTRUCTIVE=1 to override (be sure MONGODB_DATABASE is correct).`,
    );
  }
  if (opts.requireConfirm && process.env.CONFIRM_DESTRUCTIVE !== '1') {
    throw new Error(
      `Refusing to ${operation} on "${cfg.mongoDb}" without confirmation. ` +
      `Re-run with CONFIRM_DESTRUCTIVE=1 to proceed (this drops app-owned collections).`,
    );
  }
}
