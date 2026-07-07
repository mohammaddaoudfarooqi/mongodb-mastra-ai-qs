import { describe, it, expect } from 'vitest';
import type { Db } from 'mongodb';
import { buildCartTools, computeCartTotals, MUTATING_TOOLS, type CartLine } from './cart';

const line = (over: Partial<CartLine> = {}): CartLine => ({
  product_id: 'p', name: 'n', qty: 1, unit_price_usd: 10, sale_price_usd: null,
  applied_coupons: [], line_savings: 0, ...over,
});

describe('computeCartTotals', () => {
  it('sums subtotal from effective line prices and aggregates savings', () => {
    const lines = [line({ qty: 2 }), line({ unit_price_usd: 5, sale_price_usd: 4, qty: 1, line_savings: 1 })];
    const t = computeCartTotals(lines);
    expect(t.subtotal).toBe(2 * 10 + 4);
    expect(t.total_savings).toBe(1);
  });

  it('declares cartAdd/cartRemove as mutating tools', () => {
    expect(MUTATING_TOOLS.has('cartAdd')).toBe(true);
    expect(MUTATING_TOOLS.has('cartRemove')).toBe(true);
    expect(MUTATING_TOOLS.has('knowledgeSearch')).toBe(false);
  });
});

/** Minimal in-memory `carts` collection capturing the filter every op is keyed on. */
function stubDb() {
  const calls: { op: string; filter: any; update?: any }[] = [];
  let doc: any = null;
  const collection = () => ({
    findOne: async (filter: any) => { calls.push({ op: 'findOne', filter }); return doc; },
    updateOne: async (filter: any, update: any) => {
      calls.push({ op: 'updateOne', filter, update });
      doc ??= { ...filter, lines: [] };
      if (update.$push?.lines) doc.lines.push(update.$push.lines);
      if (update.$pull?.lines) {
        const pid = update.$pull.lines.product_id;
        doc.lines = doc.lines.filter((l: CartLine) => l.product_id !== pid);
      }
      return { acknowledged: true };
    },
  });
  return { db: { collection } as unknown as Db, calls, setDoc: (d: any) => { doc = d; } };
}

describe('buildCartTools identity binding', () => {
  const key = { userId: 'demo', threadId: 'demo:t1' };

  it('keys every op on the bound identity, not tool input', async () => {
    const { db, calls } = stubDb();
    const { cartAdd, cartRead, cartRemove } = buildCartTools({ db, ...key });

    // Tool input carries NO identity — only the line / product_id.
    await cartAdd.execute!({ line: { product_id: 'p1', name: 'Mug', qty: 1, unit_price_usd: 10, sale_price_usd: 8, applied_coupons: [], line_savings: 2 } } as any, {} as any);
    await cartRead.execute!({} as any, {} as any);
    await cartRemove.execute!({ product_id: 'p1' } as any, {} as any);

    for (const c of calls) expect(c.filter).toEqual(key);
  });

  it('cartRead derives totals from the bound cart lines', async () => {
    const { db, setDoc } = stubDb();
    setDoc({ ...key, lines: [{ product_id: 'p1', name: 'Mug', qty: 2, unit_price_usd: 10, sale_price_usd: 8, applied_coupons: [], line_savings: 4 }] });
    const { cartRead } = buildCartTools({ db, ...key });
    const res: any = await cartRead.execute!({} as any, {} as any);
    expect(res.subtotal).toBe(16);
    expect(res.total_savings).toBe(4);
  });

  it('fires onMutate for add/remove', async () => {
    const { db } = stubDb();
    let mutations = 0;
    const { cartAdd, cartRemove } = buildCartTools({ db, ...key, onMutate: () => { mutations++; } });
    await cartAdd.execute!({ line: { product_id: 'p1', name: 'x', qty: 1, unit_price_usd: 1, sale_price_usd: null, applied_coupons: [], line_savings: 0 } } as any, {} as any);
    await cartRemove.execute!({ product_id: 'p1' } as any, {} as any);
    expect(mutations).toBe(2);
  });
});
