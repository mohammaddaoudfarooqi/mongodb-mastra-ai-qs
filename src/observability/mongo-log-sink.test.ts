import { describe, it, expect, vi } from 'vitest';
import type { Db } from 'mongodb';
import { createMongoLogSink } from './mongo-log-sink';
import type { LogRecord } from './logger';

const rec = (over: Partial<LogRecord> = {}): LogRecord => ({
  ts: new Date('2026-07-08T00:00:00Z'), level: 'info', msg: 'hi', ...over,
});

/** In-memory Mongo double capturing insertMany batches and createIndex calls. */
function stubDb() {
  const inserted: any[][] = [];
  const indexes: any[] = [];
  const col = {
    insertMany: vi.fn(async (docs: any[]) => { inserted.push(docs); return { insertedCount: docs.length }; }),
    createIndex: vi.fn(async (spec: any, opts: any) => { indexes.push({ spec, opts }); return 'idx'; }),
  };
  const db = { collection: () => col } as unknown as Db;
  return { db, col, inserted, indexes };
}

describe('createMongoLogSink', () => {
  it('buffers writes and flushes them as one batch to insertMany', async () => {
    const { db, col, inserted } = stubDb();
    const sink = createMongoLogSink({ db, collection: 'app_logs', retentionDays: 30, maxBatchSize: 10 });
    sink.write(rec({ msg: 'a' }));
    sink.write(rec({ msg: 'b' }));
    // Nothing written synchronously (non-blocking).
    expect(col.insertMany).not.toHaveBeenCalled();
    await sink.flush();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].map((d: any) => d.msg)).toEqual(['a', 'b']);
    // pid stamped on each record.
    expect(inserted[0][0].pid).toBe(process.pid);
    await sink.close();
  });

  it('auto-flushes when the batch size is reached', async () => {
    const { db, col } = stubDb();
    const sink = createMongoLogSink({ db, collection: 'app_logs', retentionDays: 30, maxBatchSize: 2 });
    sink.write(rec());
    sink.write(rec());          // hits maxBatchSize → triggers a flush
    await vi.waitFor(() => expect(col.insertMany).toHaveBeenCalledTimes(1));
    await sink.close();
  });

  it('creates a TTL index on ts using retentionDays', async () => {
    const { db, indexes } = stubDb();
    const sink = createMongoLogSink({ db, collection: 'app_logs', retentionDays: 7 });
    sink.write(rec());
    await sink.flush();
    expect(indexes).toHaveLength(1);
    expect(indexes[0].spec).toEqual({ ts: 1 });
    expect(indexes[0].opts.expireAfterSeconds).toBe(7 * 24 * 60 * 60);
    await sink.close();
  });

  it('is fail-open: a Mongo insert error is swallowed, never thrown', async () => {
    const { db, col } = stubDb();
    col.insertMany.mockRejectedValueOnce(new Error('mongo down'));
    const sink = createMongoLogSink({ db, collection: 'app_logs', retentionDays: 30 });
    sink.write(rec());
    // flush must resolve, not reject, despite the insert error.
    await expect(sink.flush()).resolves.toBeUndefined();
    await sink.close();
  });

  it('drops oldest records when the buffer exceeds maxBufferSize', async () => {
    const { db, inserted } = stubDb();
    const sink = createMongoLogSink({ db, collection: 'app_logs', retentionDays: 30, maxBatchSize: 10000, maxBufferSize: 3 });
    for (let i = 0; i < 5; i++) sink.write(rec({ msg: `m${i}` }));
    await sink.flush();
    // Only the last 3 survive (m2, m3, m4); the two oldest were dropped.
    expect(inserted[0].map((d: any) => d.msg)).toEqual(['m2', 'm3', 'm4']);
    await sink.close();
  });
});
