import { describe, it, expect, vi } from 'vitest';
import type { Db } from 'mongodb';
import { runValidatedFind, buildDataQueryTool } from './data-agent';

const allowList = ['products', 'orders', 'promotions'];

/** A db whose `find` returns the given rows for any collection (retrieval-grounding seam). */
function stubDb(rows: any[]) {
  const collection = () => ({ find: () => ({ limit: () => ({ toArray: async () => rows }) }) });
  return { collection } as unknown as Db;
}

describe('runValidatedFind', () => {
  it('executes a valid query with the enforced limit', async () => {
    const find = vi.fn(async () => [{ _id: '1' }]);
    const r = await runValidatedFind({ collection: 'products', filter: { on_sale: true } }, { find, allowList, limit: 25 });
    expect(r.ok).toBe(true);
    expect(r.rows).toEqual([{ _id: '1' }]);
    expect(find).toHaveBeenCalledWith('products', { on_sale: true }, 25);
  });

  it('rejects and does NOT execute a blacklisted-operator query', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    const r = await runValidatedFind({ collection: 'products', filter: { $where: 'x' } }, { find, allowList, limit: 25 });
    expect(r.ok).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects a disallowed collection', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    const r = await runValidatedFind({ collection: 'carts', filter: {} }, { find, allowList, limit: 25 });
    expect(r.ok).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });
});

describe('runValidatedFind date coercion', () => {
  // orders is user-scoped, so the coerced model filter now rides in $and[1] (with { userId }
  // AND-ed in at $and[0]); a userId must be supplied or the query fails closed.
  it('coerces an ISO-string range value on a date field to a BSON Date', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { placed_at: { $gte: '2026-03-01' } } },
      { find, allowList, limit: 25, userId: 'u' },
    );
    const passed = (find.mock.calls[0][1] as any).$and[1];
    expect(passed.placed_at.$gte).toBeInstanceOf(Date);
    expect((passed.placed_at.$gte as Date).toISOString()).toBe(new Date('2026-03-01').toISOString());
  });

  it('coerces a bare (equality) ISO-string on a date field to a Date', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'promotions', filter: { starts_at: '2026-06-01T00:00:00.000Z' } },
      { find, allowList, limit: 25 },
    );
    const passed = find.mock.calls[0][1] as any;
    expect(passed.starts_at).toBeInstanceOf(Date);
  });

  it('coerces each element of an $in array on a date field', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { placed_at: { $in: ['2026-01-01', '2026-02-01'] } } },
      { find, allowList, limit: 25, userId: 'u' },
    );
    const passed = (find.mock.calls[0][1] as any).$and[1];
    expect(passed.placed_at.$in.every((d: unknown) => d instanceof Date)).toBe(true);
  });

  it('leaves non-date fields untouched', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { status: 'placed', total_usd: { $gte: 10 } } },
      { find, allowList, limit: 25, userId: 'u' },
    );
    expect((find.mock.calls[0][1] as any).$and[1]).toEqual({ status: 'placed', total_usd: { $gte: 10 } });
  });

  it('leaves an unparseable date string untouched (no crash, degrades safely)', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { placed_at: { $gte: 'not-a-date' } } },
      { find, allowList, limit: 25, userId: 'u' },
    );
    const passed = (find.mock.calls[0][1] as any).$and[1];
    expect(passed.placed_at.$gte).toBe('not-a-date');
  });

  it('coerces date fields nested inside a logical $and/$or clause', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { $and: [{ status: 'placed' }, { placed_at: { $lt: '2026-05-01' } }] } },
      { find, allowList, limit: 25, userId: 'u' },
    );
    // The model's $and clause is nested under the scoping $and at $and[1].
    const passed = (find.mock.calls[0][1] as any).$and[1];
    expect(passed.$and[1].placed_at.$lt).toBeInstanceOf(Date);
    expect(passed.$and[0].status).toBe('placed');
  });
});

// User-scoping (security): `orders` is per-user data. The model supplies the filter, so
// without server-side scoping a shopper could read anyone's orders. runValidatedFind must
// force { userId } onto every orders query and fail closed when no identity is available.
describe('runValidatedFind user-scoping (orders)', () => {
  it('forces the caller userId onto an orders query (model filter cannot broaden it)', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    const r = await runValidatedFind(
      { collection: 'orders', filter: { status: 'placed' } },
      { find, allowList, limit: 25, userId: 'alice@example.com' },
    );
    expect(r.ok).toBe(true);
    const passed = find.mock.calls[0][1] as any;
    // The userId constraint is AND-ed in, so it always applies regardless of the model filter.
    expect(passed.$and).toEqual([{ userId: 'alice@example.com' }, { status: 'placed' }]);
  });

  it('a model-supplied userId cannot escape the caller scope (still AND-ed with the real one)', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { userId: 'victim@example.com' } },
      { find, allowList, limit: 25, userId: 'alice@example.com' },
    );
    const passed = find.mock.calls[0][1] as any;
    // Real userId AND the model's — the two conjoined can never match another user's docs.
    expect(passed.$and).toEqual([{ userId: 'alice@example.com' }, { userId: 'victim@example.com' }]);
  });

  it('denies an orders query when no caller identity is available (fail closed)', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    const r = await runValidatedFind(
      { collection: 'orders', filter: {} },
      { find, allowList, limit: 25 }, // no userId
    );
    expect(r.ok).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });

  it('does NOT scope a non-user collection (products passes through unchanged)', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'products', filter: { on_sale: true } },
      { find, allowList, limit: 25, userId: 'alice@example.com' },
    );
    expect(find.mock.calls[0][1]).toEqual({ on_sale: true });
  });
});

describe('buildDataQueryTool retrieval-grounding seam', () => {
  it('reports returned product _ids via onProductsFound', async () => {
    const seen: string[] = [];
    const tool = buildDataQueryTool({
      db: stubDb([{ _id: 'prod_0021' }, { _id: 'prod_0061' }]),
      allowList, limit: 25, onProductsFound: ids => seen.push(...ids),
    });
    await tool.execute!({ collection: 'products', filter: { on_sale: true } } as any, {} as any);
    expect(seen).toEqual(['prod_0021', 'prod_0061']);
  });

  it('does not report ids for a non-products query', async () => {
    const seen: string[] = [];
    const tool = buildDataQueryTool({
      db: stubDb([{ _id: 'ord_1' }]),
      allowList, limit: 25, onProductsFound: ids => seen.push(...ids),
    });
    await tool.execute!({ collection: 'orders', filter: {} } as any, {} as any);
    expect(seen).toEqual([]);
  });

  it('does not fire onProductsFound when a products query returns no rows', async () => {
    const cb = vi.fn();
    const tool = buildDataQueryTool({ db: stubDb([]), allowList, limit: 25, onProductsFound: cb });
    await tool.execute!({ collection: 'products', filter: { name: 'nope' } } as any, {} as any);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('buildDataQueryTool trace seam (sub-agent trace out-of-band)', () => {
  it('reports the MQL query + result summary via onTrace so the sub-agent step is not lost', async () => {
    const steps: any[] = [];
    const tool = buildDataQueryTool({
      db: stubDb([{ _id: 'prod_0021' }, { _id: 'prod_0061' }]),
      allowList, limit: 25, onTrace: s => steps.push(s),
    });
    await tool.execute!({ collection: 'products', filter: { on_sale: true } } as any, {} as any);
    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe('dataQuery');
    // The actual MQL the agent ran, so the chat UI can show it.
    expect(steps[0].args).toEqual({ collection: 'products', filter: { on_sale: true } });
    // A human summary + the returned docs.
    expect(steps[0].summary).toContain('2');
    expect(steps[0].result).toMatchObject({ ok: true });
  });

  it('reports a rejected (guardrail-blocked) query via onTrace too', async () => {
    const steps: any[] = [];
    const tool = buildDataQueryTool({ db: stubDb([]), allowList, limit: 25, onTrace: s => steps.push(s) });
    await tool.execute!({ collection: 'carts', filter: {} } as any, {} as any); // disallowed collection
    expect(steps).toHaveLength(1);
    expect(steps[0].tool).toBe('dataQuery');
    expect(steps[0].result).toMatchObject({ ok: false });
  });
});
