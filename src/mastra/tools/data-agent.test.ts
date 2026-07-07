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
    const find = vi.fn(async () => []);
    const r = await runValidatedFind({ collection: 'products', filter: { $where: 'x' } }, { find, allowList, limit: 25 });
    expect(r.ok).toBe(false);
    expect(find).not.toHaveBeenCalled();
  });

  it('rejects a disallowed collection', async () => {
    const find = vi.fn(async () => []);
    const r = await runValidatedFind({ collection: 'carts', filter: {} }, { find, allowList, limit: 25 });
    expect(r.ok).toBe(false);
    expect(find).not.toHaveBeenCalled();
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
