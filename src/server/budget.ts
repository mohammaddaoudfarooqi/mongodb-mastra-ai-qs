// src/server/budget.ts
//
// Budget kill-switch. Ported from the MongodbUnpacked playground's budget.js pattern: a single
// flag doc in a Mongo collection that, when set, short-circuits model calls. Wire an AWS Budgets
// alarm (or a manual toggle) to flip `{ _id: "budget", over: true }` and the app stops spending
// on the LLM immediately, returning a graceful "temporarily unavailable" message instead of a
// hard error. Config-gated + default OFF; fail-OPEN (a read error never blocks the demo).

import type { Db } from 'mongodb';

export interface BudgetConfig {
  enabled: boolean;
  collection: string;
  /** _id of the flag doc to read (default "budget"). */
  flagId: string;
}

/**
 * True when the budget cap has been tripped (spending should stop). Reads a single flag doc;
 * returns false (spend allowed) when disabled or on any error, so the kill-switch can only ever
 * STOP spending deliberately, never block the demo by accident.
 */
export async function isOverBudget(db: Db, cfg: BudgetConfig): Promise<boolean> {
  if (!cfg.enabled) return false;
  try {
    const doc = await db.collection(cfg.collection).findOne({ _id: cfg.flagId as any });
    return !!(doc as any)?.over;
  } catch {
    return false; // fail-open
  }
}

/** The message shown to a shopper when the budget cap is active. */
export const BUDGET_TRIPPED_MESSAGE =
  "Our AI concierge is taking a short break to stay within today's usage budget. " +
  'Please try again a little later — thanks for exploring the demo!';
