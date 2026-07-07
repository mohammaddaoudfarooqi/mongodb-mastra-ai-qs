// src/mastra/tools/mql-guard.test.ts
import { describe, it, expect } from 'vitest';
import { validateQuery } from './mql-guard';

const allowList = ['products', 'orders', 'promotions'];
const ok = (r: { ok: boolean }) => r.ok;

describe('validateQuery', () => {
  it('allows a simple valid products query', () => {
    expect(ok(validateQuery({ collection: 'products', filter: { on_sale: true } }, { allowList }))).toBe(true);
  });

  it('allows permitted operators on declared fields', () => {
    expect(ok(validateQuery({ collection: 'products', filter: { price_usd: { $lte: 10 } } }, { allowList }))).toBe(true);
    expect(ok(validateQuery({ collection: 'products', filter: { $or: [{ on_sale: true }, { stock: { $gt: 0 } }] } }, { allowList }))).toBe(true);
  });

  it('rejects a collection not in the allow-list (carts never allowed)', () => {
    expect(ok(validateQuery({ collection: 'carts', filter: {} }, { allowList }))).toBe(false);
    expect(ok(validateQuery({ collection: 'products', filter: {} }, { allowList: [] }))).toBe(false);
  });

  it('hard-rejects $where / $function / $accumulator / $expr-with-code', () => {
    expect(ok(validateQuery({ collection: 'products', filter: { $where: '1==1' } }, { allowList }))).toBe(false);
    expect(ok(validateQuery({ collection: 'products', filter: { $function: {} } }, { allowList }))).toBe(false);
    expect(ok(validateQuery({ collection: 'products', filter: { $accumulator: {} } }, { allowList }))).toBe(false);
  });

  it('rejects aggregation stages leaking into a find filter', () => {
    expect(ok(validateQuery({ collection: 'products', filter: { $lookup: {} } }, { allowList }))).toBe(false);
    expect(ok(validateQuery({ collection: 'products', filter: { $merge: {} } }, { allowList }))).toBe(false);
  });

  it('rejects hallucinated / undeclared field names', () => {
    expect(ok(validateQuery({ collection: 'products', filter: { nonexistent_field: 1 } }, { allowList }))).toBe(false);
  });

  it('caps $regex length to block catastrophic backtracking', () => {
    const huge = 'a'.repeat(1000);
    expect(ok(validateQuery({ collection: 'products', filter: { name: { $regex: huge } } }, { allowList, regexMaxLen: 128 }))).toBe(false);
    expect(ok(validateQuery({ collection: 'products', filter: { name: { $regex: '^milk' } } }, { allowList, regexMaxLen: 128 }))).toBe(true);
  });

  it('blocks nested attacks: blacklisted operators inside logical arrays', () => {
    // 1. Blacklisted operator nested inside a logical operator array
    expect(ok(validateQuery({ collection: 'products', filter: { $or: [{ $where: '1==1' }] } }, { allowList }))).toBe(false);

    // 2. Blacklisted operator nested as a value under a valid field
    expect(ok(validateQuery({ collection: 'products', filter: { price_usd: { $where: 'x' } } }, { allowList }))).toBe(false);
  });

  it('blocks nested attacks: unknown operators and fields in logical contexts', () => {
    // 3. Unknown operator nested inside a logical operator
    expect(ok(validateQuery({ collection: 'products', filter: { $and: [{ price_usd: { $unknownOp: 10 } }] } }, { allowList }))).toBe(false);

    // 4. Unknown/hallucinated field nested inside a logical operator
    expect(ok(validateQuery({ collection: 'products', filter: { $or: [{ nonexistent_field: 1 }] } }, { allowList }))).toBe(false);
  });

  it('blocks nested attacks: $regex length violation in nested context', () => {
    // 5. $regex length violation in a nested context
    const huge = 'a'.repeat(1000);
    expect(ok(validateQuery({ collection: 'products', filter: { $and: [{ name: { $regex: huge } }] } }, { allowList, regexMaxLen: 128 }))).toBe(false);
  });

  it('allows deeply-nested valid queries (positive control)', () => {
    // 6. A valid deeply-nested query should be ALLOWED
    expect(ok(validateQuery({
      collection: 'products',
      filter: { $and: [{ $or: [{ on_sale: true }, { price_usd: { $lte: 10 } }] }, { stock: { $gt: 0 } }] }
    }, { allowList }))).toBe(true);
  });
});
