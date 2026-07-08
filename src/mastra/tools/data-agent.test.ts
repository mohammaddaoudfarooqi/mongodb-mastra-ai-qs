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
  it('coerces an ISO-string range value on a date field to a BSON Date', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { placed_at: { $gte: '2026-03-01' } } },
      { find, allowList, limit: 25 },
    );
    const passed = find.mock.calls[0][1] as any;
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
      { find, allowList, limit: 25 },
    );
    const passed = find.mock.calls[0][1] as any;
    expect(passed.placed_at.$in.every((d: unknown) => d instanceof Date)).toBe(true);
  });

  it('leaves non-date fields untouched', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { status: 'placed', total_usd: { $gte: 10 } } },
      { find, allowList, limit: 25 },
    );
    expect(find.mock.calls[0][1]).toEqual({ status: 'placed', total_usd: { $gte: 10 } });
  });

  it('leaves an unparseable date string untouched (no crash, degrades safely)', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { placed_at: { $gte: 'not-a-date' } } },
      { find, allowList, limit: 25 },
    );
    const passed = find.mock.calls[0][1] as any;
    expect(passed.placed_at.$gte).toBe('not-a-date');
  });

  it('coerces date fields nested inside a logical $and/$or clause', async () => {
    const find = vi.fn(async (_c: string, _f: Record<string, unknown>, _l: number) => [] as unknown[]);
    await runValidatedFind(
      { collection: 'orders', filter: { $and: [{ status: 'placed' }, { placed_at: { $lt: '2026-05-01' } }] } },
      { find, allowList, limit: 25 },
    );
    const passed = find.mock.calls[0][1] as any;
    expect(passed.$and[1].placed_at.$lt).toBeInstanceOf(Date);
    expect(passed.$and[0].status).toBe('placed');
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
