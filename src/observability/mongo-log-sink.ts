import type { Collection, Db } from 'mongodb';
import type { LogRecord, LogSink } from './logger';

/**
 * A MongoDB-backed log sink: buffers structured log records and flushes them to a collection
 * in batches. Modeled on the reference retail app's agent-log engine (buffered, fail-open,
 * TTL-pruned) but dependency-free and adapted to this app's tiny logger.
 *
 * Design constraints:
 *  - NON-BLOCKING: `write` only enqueues; the actual insert happens on a timer or when the
 *    buffer fills, never on the caller's request path.
 *  - FAIL-OPEN: every Mongo error is swallowed (logged once to console.error, not re-emitted
 *    through `logger` to avoid a feedback loop). A logging outage must never break the app.
 *  - BOUNDED: the in-memory buffer is capped; on overflow the oldest records are dropped so a
 *    Mongo stall cannot grow memory without bound.
 *  - SELF-PRUNING: a TTL index on `ts` expires records after retentionDays.
 */
export interface MongoLogSinkOptions {
  db: Db;
  collection: string;
  retentionDays: number;
  /** Flush when this many records are buffered (default 50). */
  maxBatchSize?: number;
  /** Flush at least this often, ms (default 2000). */
  flushIntervalMs?: number;
  /** Hard cap on buffered records; overflow drops oldest (default 5000). */
  maxBufferSize?: number;
}

export interface MongoLogSink extends LogSink {
  /** Flush any buffered records now (used on shutdown / in tests). */
  flush: () => Promise<void>;
  /** Stop the timer and flush once (used on shutdown / in tests). */
  close: () => Promise<void>;
}

export function createMongoLogSink(opts: MongoLogSinkOptions): MongoLogSink {
  const col: Collection<LogRecord & { host?: string; pid?: number }> = opts.db.collection(opts.collection);
  const maxBatch = opts.maxBatchSize ?? 50;
  const flushMs = opts.flushIntervalMs ?? 2000;
  const maxBuffer = opts.maxBufferSize ?? 5000;
  const pid = process.pid;

  let buffer: LogRecord[] = [];
  let flushing = false;
  let indexEnsured = false;

  // Best-effort TTL index so the collection self-prunes. Runs once, fail-open.
  async function ensureIndex(): Promise<void> {
    if (indexEnsured) return;
    indexEnsured = true;
    try {
      await col.createIndex({ ts: 1 }, { expireAfterSeconds: opts.retentionDays * 24 * 60 * 60, name: 'app_logs_ts_ttl' });
    } catch (err) {
      // Never surface through `logger` (would recurse into this sink); console only.
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'app-log TTL index create failed', err: String(err) }));
    }
  }

  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      await ensureIndex();
      // Stamp pid so multi-container logs are distinguishable; ordered:false so one bad doc
      // doesn't drop the rest of the batch.
      await col.insertMany(batch.map(r => ({ ...r, pid })), { ordered: false });
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'app-log flush failed', dropped: batch.length, err: String(err) }));
      // Records are intentionally dropped on failure (fail-open) rather than retried
      // indefinitely — logging must not accumulate unbounded backpressure.
    } finally {
      flushing = false;
    }
  }

  // Periodic flush. unref() so this timer never keeps the process alive on shutdown.
  const timer = setInterval(() => { void flush(); }, flushMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    write(rec: LogRecord) {
      buffer.push(rec);
      if (buffer.length > maxBuffer) buffer.splice(0, buffer.length - maxBuffer); // drop oldest
      if (buffer.length >= maxBatch) void flush();
    },
    flush,
    async close() {
      clearInterval(timer);
      await flush();
    },
  };
}
