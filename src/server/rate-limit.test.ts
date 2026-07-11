// src/server/rate-limit.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { takeRateLimit, __resetRateLimitIndexGuard, type RateLimitConfig } from './rate-limit';

const cfg: RateLimitConfig = { enabled: true, max: 3, windowSeconds: 3600, collection: 'ratelimit' };

/** A db whose ratelimit collection increments an in-memory counter per _id. */
function stubDb() {
  const counts = new Map<string, number>();
  const col = {
    createIndex: vi.fn(async () => 'ratelimit_ttl'),
    findOneAndUpdate: vi.fn(async (filter: any) => {
      const id = filter._id as string;
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      return { _id: id, n };
    }),
  };
  return { db: { collection: () => col } as any, col, counts };
}

beforeEach(() => __resetRateLimitIndexGuard());

describe('takeRateLimit', () => {
  it('allows up to max requests, then blocks (per session)', async () => {
    const { db } = stubDb();
    const r1 = await takeRateLimit(db, cfg, 's1');
    const r2 = await takeRateLimit(db, cfg, 's1');
    const r3 = await takeRateLimit(db, cfg, 's1');
    const r4 = await takeRateLimit(db, cfg, 's1');
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r4.allowed).toBe(false);
    expect(r4.count).toBe(4);
    expect(r4.limit).toBe(3);
  });

  it('counts each session independently', async () => {
    const { db } = stubDb();
    for (let i = 0; i < 4; i++) await takeRateLimit(db, cfg, 'sA');
    const other = await takeRateLimit(db, cfg, 'sB');
    expect(other.allowed).toBe(true); // sB has its own budget
  });

  it('is a no-op (always allowed) when disabled', async () => {
    const { db, col } = stubDb();
    const r = await takeRateLimit(db, { ...cfg, enabled: false }, 's1');
    expect(r.allowed).toBe(true);
    expect(col.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('fails OPEN on a Mongo error (never blocks the demo)', async () => {
    const db = { collection: () => ({ createIndex: async () => { throw new Error('down'); }, findOneAndUpdate: async () => { throw new Error('down'); } }) } as any;
    const r = await takeRateLimit(db, cfg, 's1');
    expect(r.allowed).toBe(true);
  });

  it('creates the TTL index once per process', async () => {
    const { db, col } = stubDb();
    await takeRateLimit(db, cfg, 's1');
    await takeRateLimit(db, cfg, 's2');
    expect(col.createIndex).toHaveBeenCalledTimes(1);
  });
});
