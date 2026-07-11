// src/server/budget.test.ts
import { describe, it, expect } from 'vitest';
import { isOverBudget, BUDGET_TRIPPED_MESSAGE, type BudgetConfig } from './budget';

const cfg: BudgetConfig = { enabled: true, collection: 'flags', flagId: 'budget' };

function dbWithFlag(doc: any) {
  return { collection: () => ({ findOne: async () => doc }) } as any;
}

describe('isOverBudget', () => {
  it('is true when the flag doc has over:true', async () => {
    expect(await isOverBudget(dbWithFlag({ _id: 'budget', over: true }), cfg)).toBe(true);
  });

  it('is false when the flag is absent or over is falsy', async () => {
    expect(await isOverBudget(dbWithFlag(null), cfg)).toBe(false);
    expect(await isOverBudget(dbWithFlag({ _id: 'budget', over: false }), cfg)).toBe(false);
  });

  it('is false (spend allowed) when disabled — never reads', async () => {
    let read = false;
    const db = { collection: () => ({ findOne: async () => { read = true; return { over: true }; } }) } as any;
    expect(await isOverBudget(db, { ...cfg, enabled: false })).toBe(false);
    expect(read).toBe(false);
  });

  it('fails OPEN (spend allowed) on a Mongo error', async () => {
    const db = { collection: () => ({ findOne: async () => { throw new Error('down'); } }) } as any;
    expect(await isOverBudget(db, cfg)).toBe(false);
  });

  it('exposes a shopper-facing message', () => {
    expect(BUDGET_TRIPPED_MESSAGE).toMatch(/budget|break|later/i);
  });
});
