// src/server/rate-limit.ts
//
// Per-session request rate limiter, backed by a TTL-indexed counter collection in MongoDB.
// Ported from the MongodbUnpacked playground's ratelimit.js pattern (findOneAndUpdate $inc
// with a TTL index so windows self-expire) — adapted to this app's config + fail-open posture.
//
// WHY: the public AI4 domain is a shared, free-text, Sonnet/Haiku agent behind a QR code. A
// burst of attendees (or abuse) has nothing throttling it otherwise, and every /chat turn hits
// Bedrock. This caps requests per session per window so one visitor can't exhaust the box or the
// Bedrock quota. Config-gated + default OFF, so local dev and self-deploy are unaffected.

import type { Db } from 'mongodb';

export interface RateLimitConfig {
  enabled: boolean;
  /** Max requests allowed per session within the window. */
  max: number;
  /** Window length in seconds (TTL on the counter doc). */
  windowSeconds: number;
  /** Collection name for the counters. */
  collection: string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Current count in this window (after incrementing). */
  count: number;
  limit: number;
}

let indexEnsured = false;

/**
 * Record one request for `sessionId` and report whether it is within the limit. The counter
 * doc's `createdAt` carries a TTL index sized to the window, so a session's window resets
 * automatically once the doc expires. Fail-OPEN: any Mongo error returns allowed:true so a
 * transient DB blip never blocks a live demo (matching the app's fail-open convention).
 */
export async function takeRateLimit(
  db: Db,
  cfg: RateLimitConfig,
  sessionId: string,
): Promise<RateLimitResult> {
  if (!cfg.enabled) return { allowed: true, count: 0, limit: cfg.max };
  try {
    const col = db.collection(cfg.collection);
    if (!indexEnsured) {
      // TTL index so each session's counting window self-expires after windowSeconds.
      await col.createIndex({ createdAt: 1 }, { expireAfterSeconds: cfg.windowSeconds });
      indexEnsured = true;
    }
    const r = await col.findOneAndUpdate(
      { _id: sessionId as any },
      { $inc: { n: 1 }, $setOnInsert: { createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' },
    );
    const count = (r as any)?.n ?? (r as any)?.value?.n ?? 1;
    return { allowed: count <= cfg.max, count, limit: cfg.max };
  } catch {
    return { allowed: true, count: 0, limit: cfg.max }; // fail-open
  }
}

/** Test seam: reset the once-per-process index guard. */
export function __resetRateLimitIndexGuard(): void {
  indexEnsured = false;
}
