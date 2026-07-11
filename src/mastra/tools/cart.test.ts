import { describe, it, expect } from 'vitest';
import type { Db } from 'mongodb';
import { buildCartTools, computeCartTotals, mergeCartLines, provisionCartIndex, MUTATING_TOOLS, type CartLine } from './cart';

const line = (over: Partial<CartLine> = {}): CartLine => ({
  product_id: 'p', name: 'n', qty: 1, unit_price_usd: 10, sale_price_usd: null,
  applied_coupons: [], line_savings: 0, coupon_savings: 0, ...over,
});

describe('computeCartTotals', () => {
  it('sums subtotal from effective line prices and aggregates savings', () => {
    const lines = [line({ qty: 2 }), line({ unit_price_usd: 5, sale_price_usd: 4, qty: 1, line_savings: 1 })];
    const t = computeCartTotals(lines);
    expect(t.subtotal).toBe(2 * 10 + 4);
    expect(t.total_savings).toBe(1);
  });

  it('folds coupon savings into total_savings and the charged total', () => {
    // A single kitchen line on sale at 4 (was 5), qty 2, with a coupon knocking 0.40 off.
    const lines = [line({ unit_price_usd: 5, sale_price_usd: 4, qty: 2, line_savings: 2, coupon_savings: 0.4 })];
    const t = computeCartTotals(lines);
    expect(t.subtotal).toBe(8);            // effective(sale) 4 × 2, pre-coupon (unchanged meaning)
    expect(t.coupon_savings).toBe(0.4);    // sum of line coupon savings
    expect(t.sale_savings).toBe(2);        // (5-4) × 2
    expect(t.total_savings).toBe(2.4);     // sale + coupon
    expect(t.total).toBe(7.6);             // subtotal − coupon_savings (amount charged)
  });

  it('leaves subtotal/total_savings unchanged when there are no coupons (backward compat)', () => {
    const lines = [line({ unit_price_usd: 5, sale_price_usd: 4, qty: 1, line_savings: 1 })];
    const t = computeCartTotals(lines);
    expect(t.subtotal).toBe(4);
    expect(t.coupon_savings).toBe(0);
    expect(t.total_savings).toBe(1);
    expect(t.total).toBe(4);               // no coupon → total === subtotal
  });

  it('declares cartAdd/cartRemove/applyCoupon as mutating tools', () => {
    expect(MUTATING_TOOLS.has('cartAdd')).toBe(true);
    expect(MUTATING_TOOLS.has('cartRemove')).toBe(true);
    expect(MUTATING_TOOLS.has('applyCoupon')).toBe(true);
    expect(MUTATING_TOOLS.has('knowledgeSearch')).toBe(false);
  });
});

/**
 * Minimal in-memory db with a `carts` collection (capturing the filter every op is
 * keyed on), a `products` collection (so cartAdd can resolve a line against real
 * product data), and a `promotions` collection (so applyCoupon can validate codes).
 * `products` seeds a couple of catalog docs the tests look up.
 */
function stubDb(products: any[] = PRODUCTS, promotions: any[] = PROMOTIONS, opts: { raceOnUpsert?: CartLine } = {}) {
  const calls: { op: string; filter: any; update?: any; options?: any }[] = [];
  let doc: any = null;
  // When armed, the FIRST upserting updateOne that would insert (no doc yet) simulates a
  // concurrent writer winning the race under a unique {userId,threadId} index: the sibling
  // insert already materialized the doc (with `raceOnUpsert`'s line), so our own upsert insert
  // is rejected with an E11000 duplicate-key error. This is the production bulk-add race.
  let raceArmed: CartLine | null = opts.raceOnUpsert ?? null;
  const carts = {
    findOne: async (filter: any) => { calls.push({ op: 'findOne', filter }); return doc; },
    updateOne: async (filter: any, update: any, options?: any) => {
      calls.push({ op: 'updateOne', filter, update, options });
      if (options?.upsert && doc === null && raceArmed) {
        // The concurrent winner created the doc; our upsert insert violates the unique index.
        doc = { userId: filter.userId, threadId: filter.threadId, lines: [raceArmed], updated_at: new Date() };
        raceArmed = null;
        const err: any = new Error('E11000 duplicate key error collection: carts index: userId_1_threadId_1');
        err.code = 11000;
        throw err;
      }
      doc ??= { userId: filter.userId, threadId: filter.threadId, lines: [] };
      if (update.$push?.lines) doc.lines.push(update.$push.lines);
      if (update.$pull?.lines) {
        const pid = update.$pull.lines.product_id;
        doc.lines = doc.lines.filter((l: CartLine) => l.product_id !== pid);
      }
      // Positional qty bump for the idempotent re-add path ($inc on lines.$.qty, keyed by
      // the filter's 'lines.product_id').
      if (update.$inc?.['lines.$.qty'] !== undefined) {
        const pid = filter['lines.product_id'];
        const l = doc.lines.find((x: CartLine) => x.product_id === pid);
        if (l) l.qty += update.$inc['lines.$.qty'];
      }
      // Whole-lines replacement (applyCoupon stamps coupon savings via $set: { lines }).
      if (update.$set?.lines !== undefined) doc.lines = update.$set.lines;
      return { acknowledged: true };
    },
  };
  const productsCol = {
    // Supports { _id } and { name: { $regex, $options } } lookups (the two cartAdd uses).
    findOne: async (filter: any) => {
      if (filter._id !== undefined) return products.find(p => p._id === filter._id) ?? null;
      const rx = filter.name?.$regex;
      if (rx) { const re = new RegExp(rx, filter.name.$options ?? ''); return products.find(p => re.test(p.name)) ?? null; }
      return null;
    },
    // Batched lookup applyCoupon uses to resolve each line's category ({ _id: { $in } }).
    find: (filter: any) => ({
      toArray: async () => {
        const ids: string[] = filter?._id?.$in ?? [];
        return products.filter(p => ids.includes(p._id));
      },
    }),
  };
  const promotionsCol = {
    // applyCoupon looks a promotion up by its natural `code` (case-insensitive regex).
    findOne: async (filter: any) => {
      const rx = filter.code?.$regex;
      if (rx) { const re = new RegExp(rx, filter.code.$options ?? ''); return promotions.find(p => re.test(p.code)) ?? null; }
      return promotions.find(p => p.code === filter.code) ?? null;
    },
  };
  const collection = (name: string) =>
    (name === 'products' ? productsCol : name === 'promotions' ? promotionsCol : carts) as any;
  return { db: { collection } as unknown as Db, calls, setDoc: (d: any) => { doc = d; } };
}

const PRODUCTS = [
  { _id: 'prod_0021', name: 'Classic Insulated Water Bottle 8in', category: 'kitchen', price_usd: 145.99, sale_price_usd: 116.79, on_sale: true, stock: 5 },
  { _id: 'prod_0061', name: 'Classic Nonstick Fry Pan 12oz', category: 'kitchen', price_usd: 25.99, sale_price_usd: null, on_sale: false, stock: 3 },
  { _id: 'prod_0099', name: 'Trail Running Jacket', category: 'apparel', price_usd: 80, sale_price_usd: null, on_sale: false, stock: 4 },
];

// A wide, currently-open window so the date-window check passes in tests without a fixed clock.
// starts_at/ends_at are BSON Dates (matching how the app now stores promotions).
const PROMOTIONS = [
  { _id: 'promo_0001', code: 'SAVE5', discount_pct: 5, applies_to_category: 'kitchen', product_ids: [], starts_at: new Date('2000-01-01T00:00:00.000Z'), ends_at: new Date('2999-01-01T00:00:00.000Z'), active: true },
  { _id: 'promo_0002', code: 'EXPIRED', discount_pct: 10, applies_to_category: 'kitchen', product_ids: [], starts_at: new Date('2000-01-01T00:00:00.000Z'), ends_at: new Date('2001-01-01T00:00:00.000Z'), active: true },
  { _id: 'promo_0003', code: 'INACTIVE', discount_pct: 10, applies_to_category: 'kitchen', product_ids: [], starts_at: new Date('2000-01-01T00:00:00.000Z'), ends_at: new Date('2999-01-01T00:00:00.000Z'), active: false },
  { _id: 'promo_0004', code: 'SAVE10APP', discount_pct: 10, applies_to_category: 'apparel', product_ids: [], starts_at: new Date('2000-01-01T00:00:00.000Z'), ends_at: new Date('2999-01-01T00:00:00.000Z'), active: true },
];

describe('buildCartTools identity binding', () => {
  const key = { userId: 'demo', threadId: 'demo:t1' };

  it('keys every cart op on the bound identity, not tool input', async () => {
    const { db, calls } = stubDb();
    const { cartAdd, cartRead, cartRemove } = buildCartTools({ db, ...key });

    // Tool input carries NO identity — only the line / product_id.
    await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    await cartRead.execute!({} as any, {} as any);
    await cartRemove.execute!({ product_id: 'prod_0021' } as any, {} as any);

    // Every `carts` op is keyed on the bound identity. (The products lookup cartAdd
    // does to resolve the line is on a different collection and carries no identity.)
    for (const c of calls) expect(c.filter).toEqual(key);
  });

  it('resolves cartAdd against products by _id and builds the authoritative line', async () => {
    const { db, calls } = stubDb();
    const { cartAdd } = buildCartTools({ db, ...key });
    // Model passes only an id + qty (and may pass wrong price fields, which we ignore).
    const res: any = await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 2, unit_price_usd: 1, sale_price_usd: 1 } } as any, {} as any);
    expect(res.ok).toBe(true);
    const pushed = calls.find(c => c.op === 'updateOne')!.update.$push.lines as CartLine;
    // Prices + savings come from the DB doc, not the model input.
    expect(pushed.product_id).toBe('prod_0021');
    expect(pushed.name).toBe('Classic Insulated Water Bottle 8in');
    expect(pushed.qty).toBe(2);
    expect(pushed.unit_price_usd).toBe(145.99);
    expect(pushed.sale_price_usd).toBe(116.79);
    expect(pushed.line_savings).toBeCloseTo((145.99 - 116.79) * 2, 2);
    expect(pushed.applied_coupons).toEqual([]);
  });

  it('falls back to a name lookup when the id is a fabricated slug', async () => {
    const { db, calls } = stubDb();
    const { cartAdd } = buildCartTools({ db, ...key });
    // The slug bug: model invents `classic-nonstick-fry-pan-12oz` as the id but the
    // name is right. We resolve by name and store the REAL _id so checkout works.
    const res: any = await cartAdd.execute!({ line: { product_id: 'classic-nonstick-fry-pan-12oz', name: 'Classic Nonstick Fry Pan 12oz', qty: 1 } } as any, {} as any);
    expect(res.ok).toBe(true);
    const pushed = calls.find(c => c.op === 'updateOne')!.update.$push.lines as CartLine;
    expect(pushed.product_id).toBe('prod_0061');   // real _id, not the slug
    expect(pushed.sale_price_usd).toBeNull();
    expect(pushed.line_savings).toBe(0);
  });

  it('does not write a line and reports not-found when the product cannot be resolved', async () => {
    const { db, calls } = stubDb();
    const { cartAdd } = buildCartTools({ db, ...key });
    const res: any = await cartAdd.execute!({ line: { product_id: 'nope', name: 'Ghost Product', qty: 1 } } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/not found/i);
    expect(calls.some(c => c.op === 'updateOne')).toBe(false);   // no cart mutation
  });

  // Retrieval grounding (fixes the "adds a product not in the search results" bug — a
  // constraint-request contamination where memory/generation supplies an off-constraint
  // item). The gate keys on THIS turn's product-query results, not on parsing the request.
  it('rejects an add that is not in this turn\'s product-query results', async () => {
    const { db, calls } = stubDb();
    // A products query ran this turn and returned prod_0021 (e.g. "on-sale kitchen").
    const turnProductIds = new Set(['prod_0021']);
    const { cartAdd } = buildCartTools({ db, ...key, turnProductIds });
    // Model tries to add prod_0061 — a real product, but NOT one the query surfaced.
    const res: any = await cartAdd.execute!({ line: { product_id: 'prod_0061', qty: 1 } } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/dataQuery|not added|cartAdd again/i);   // drives a retry, not a question
    expect(calls.some(c => c.op === 'updateOne')).toBe(false);   // nothing added
  });

  it('allows an add that IS in this turn\'s product-query results', async () => {
    const { db, calls } = stubDb();
    const turnProductIds = new Set(['prod_0021', 'prod_0061']);
    const { cartAdd } = buildCartTools({ db, ...key, turnProductIds });
    const res: any = await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    expect(res.ok).toBe(true);
    expect(calls.some(c => c.op === 'updateOne')).toBe(true);
  });

  it('allows a memory-reference add when NO product query returned rows this turn', async () => {
    const { db, calls } = stubDb();
    // Empty set = no products query surfaced anything this turn (a pure "add the bottle I
    // mentioned earlier" reference, or a name query that missed). Memory add must still work.
    const turnProductIds = new Set<string>();
    const { cartAdd } = buildCartTools({ db, ...key, turnProductIds });
    const res: any = await cartAdd.execute!({ line: { product_id: 'prod_0061', qty: 1 } } as any, {} as any);
    expect(res.ok).toBe(true);
    expect(calls.some(c => c.op === 'updateOne')).toBe(true);
  });

  it('cartRead derives totals from the bound cart lines', async () => {
    const { db, setDoc } = stubDb();
    setDoc({ ...key, lines: [{ product_id: 'p1', name: 'Mug', qty: 2, unit_price_usd: 10, sale_price_usd: 8, applied_coupons: [], line_savings: 4 }] });
    const { cartRead } = buildCartTools({ db, ...key });
    const res: any = await cartRead.execute!({} as any, {} as any);
    expect(res.subtotal).toBe(16);
    expect(res.total_savings).toBe(4);
  });

  it('stamps updated_at as a BSON Date (not an ISO string) on add', async () => {
    const { db, calls } = stubDb();
    const { cartAdd } = buildCartTools({ db, ...key });
    await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    const setUpdate = calls.find(c => c.op === 'updateOne')!.update.$set;
    expect(setUpdate.updated_at).toBeInstanceOf(Date);
  });

  it('fires onMutate for add/remove', async () => {
    const { db } = stubDb();
    let mutations = 0;
    const { cartAdd, cartRemove } = buildCartTools({ db, ...key, onMutate: () => { mutations++; } });
    await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    await cartRemove.execute!({ product_id: 'prod_0021' } as any, {} as any);
    expect(mutations).toBe(2);
  });

  // Single-add guard (verify:demo caught the model calling cartAdd 3x for one request).
  it('re-adding the SAME product bumps qty instead of duplicating the line', async () => {
    const { db } = stubDb();
    const { cartAdd } = buildCartTools({ db, ...key });
    await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    const res: any = await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    expect(res.ok).toBe(true);
    const cart: any = await buildCartTools({ db, ...key }).cartRead.execute!({} as any, {} as any);
    expect(cart.lines).toHaveLength(1);          // one line, not two
    expect(cart.lines[0].qty).toBe(2);           // qty bumped
  });

  it('refuses a 2nd DISTINCT product in the same turn by default (maxDistinctAddsPerTurn=1)', async () => {
    const { db } = stubDb();
    const { cartAdd } = buildCartTools({ db, ...key });
    const first: any = await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    const second: any = await cartAdd.execute!({ line: { product_id: 'prod_0061', qty: 1 } } as any, {} as any);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/not added|already added/i);
    const cart: any = await buildCartTools({ db, ...key }).cartRead.execute!({} as any, {} as any);
    expect(cart.lines).toHaveLength(1);          // only the first product
  });

  it('allows several distinct adds when maxDistinctAddsPerTurn is raised', async () => {
    const { db } = stubDb();
    const { cartAdd } = buildCartTools({ db, ...key, maxDistinctAddsPerTurn: 5 });
    const a: any = await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    const b: any = await cartAdd.execute!({ line: { product_id: 'prod_0061', qty: 1 } } as any, {} as any);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const cart: any = await buildCartTools({ db, ...key }).cartRead.execute!({} as any, {} as any);
    expect(cart.lines).toHaveLength(2);
  });

  // Grounded-set sizing (the recipe-ingredient fix): when a dataQuery surfaced several
  // distinct products this turn, adding each of THOSE grounded products must succeed even
  // with the default phrasing cap of 1. This is what makes "share a recipe" → "Add to cart"
  // add all N ingredients regardless of the phrasing not tripping isBulkAddIntent. The
  // grounding gate still bounds it: only products in turnProductIds can be added at all.
  it('sizes the distinct-add cap to the grounded set (adds every grounded product at cap=1)', async () => {
    const { db } = stubDb();
    // A recipe query surfaced three ingredient products this turn.
    const turnProductIds = new Set(['prod_0021', 'prod_0061', 'prod_0099']);
    const { cartAdd } = buildCartTools({ db, ...key, turnProductIds }); // maxDistinctAddsPerTurn defaults to 1
    const a: any = await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    const b: any = await cartAdd.execute!({ line: { product_id: 'prod_0061', qty: 1 } } as any, {} as any);
    const c: any = await cartAdd.execute!({ line: { product_id: 'prod_0099', qty: 1 } } as any, {} as any);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c.ok).toBe(true);
    const cart: any = await buildCartTools({ db, ...key }).cartRead.execute!({} as any, {} as any);
    expect(cart.lines).toHaveLength(3);
  });

  // The grounded set grows AS the turn runs (dataQuery fires per ingredient, then cartAdd).
  // Because turnProductIds is a shared reference read at add-time, a product added after the
  // set expands must still be allowed — the cap can't be frozen at build time.
  it('re-reads the grounded set at add-time as it grows during the turn', async () => {
    const { db } = stubDb();
    const turnProductIds = new Set<string>();
    const { cartAdd } = buildCartTools({ db, ...key, turnProductIds });
    turnProductIds.add('prod_0021');
    const a: any = await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    // Second ingredient's dataQuery only now surfaces prod_0061.
    turnProductIds.add('prod_0061');
    const b: any = await cartAdd.execute!({ line: { product_id: 'prod_0061', qty: 1 } } as any, {} as any);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const cart: any = await buildCartTools({ db, ...key }).cartRead.execute!({} as any, {} as any);
    expect(cart.lines).toHaveLength(2);
  });

  // Concurrent bulk-add race (the "1 item survives after checkout" bug): under a unique
  // {userId,threadId} index, when a sibling cartAdd wins the insert race our own upsert insert
  // is rejected with E11000. cartAdd must recover by re-pushing the line onto the now-existing
  // doc (a plain $push, no upsert) so the item still lands in the ONE cart doc — never a second
  // split document that checkout's single findOne/deleteOne would miss.
  it('recovers from a duplicate-key race by re-pushing onto the existing cart doc', async () => {
    const existing = line({ product_id: 'prod_0061', name: 'Classic Nonstick Fry Pan 12oz' });
    const { db, calls } = stubDb(PRODUCTS, PROMOTIONS, { raceOnUpsert: existing });
    const turnProductIds = new Set(['prod_0021', 'prod_0061']);
    const { cartAdd } = buildCartTools({ db, ...key, turnProductIds });
    const res: any = await cartAdd.execute!({ line: { product_id: 'prod_0021', qty: 1 } } as any, {} as any);
    expect(res.ok).toBe(true);                                   // the add still succeeds
    // The retry is a non-upsert $push (the doc already exists after the racing insert).
    const retry = calls.filter(c => c.op === 'updateOne' && c.update?.$push?.lines).slice(-1)[0];
    expect(retry.options?.upsert).toBeFalsy();
    // Exactly one cart doc, holding BOTH the racing sibling's line and ours (no split doc).
    const cart: any = await buildCartTools({ db, ...key }).cartRead.execute!({} as any, {} as any);
    const ids = cart.lines.map((l: CartLine) => l.product_id).sort();
    expect(ids).toEqual(['prod_0021', 'prod_0061']);
  });
});

// provisionCartIndex is the authoritative guard against the split-cart bug: it dedupes any
// existing multi-doc keys (a unique index can't be created while duplicates exist) then creates
// the unique {userId,threadId} index. These tests pin the merge math and the migration steps.
describe('mergeCartLines', () => {
  it('unions lines by product_id and sums qty for repeats', () => {
    const merged = mergeCartLines([
      [line({ product_id: 'a', qty: 1 }), line({ product_id: 'b', qty: 2 })],
      [line({ product_id: 'a', qty: 3 }), line({ product_id: 'c', qty: 1 })],
    ]);
    const byId = Object.fromEntries(merged.map(l => [l.product_id, l.qty]));
    expect(byId).toEqual({ a: 4, b: 2, c: 1 });
  });

  it('tolerates empty / missing line arrays', () => {
    expect(mergeCartLines([])).toEqual([]);
    expect(mergeCartLines([[], [line({ product_id: 'a', qty: 1 })]])).toHaveLength(1);
  });
});

describe('provisionCartIndex', () => {
  /** In-memory carts collection tracking aggregate/find/update/delete + createIndex. */
  function cartsDb(seed: any[]) {
    let docs = seed.map((d, i) => ({ _id: `c${i}`, ...d }));
    const created: any[] = [];
    const match = (d: any, q: any) => {
      if (q._id?.$in) return q._id.$in.includes(d._id);
      return Object.entries(q).every(([k, v]) => d[k] === v);
    };
    const carts = {
      aggregate: (_pipeline: any) => ({
        toArray: async () => {
          const groups = new Map<string, { _id: any; count: number }>();
          for (const d of docs) {
            const key = `${d.userId} ${d.threadId}`;
            const g = groups.get(key) ?? { _id: { userId: d.userId, threadId: d.threadId }, count: 0 };
            g.count++; groups.set(key, g);
          }
          return [...groups.values()].filter(g => g.count > 1);
        },
      }),
      find: (q: any) => ({ toArray: async () => docs.filter(d => match(d, q)) }),
      updateOne: async (q: any, update: any) => {
        const d = docs.find(x => match(x, q));
        if (d && update.$set) Object.assign(d, update.$set);
        return { modifiedCount: d ? 1 : 0 };
      },
      deleteMany: async (q: any) => {
        const before = docs.length;
        docs = docs.filter(d => !match(d, q));
        return { deletedCount: before - docs.length };
      },
      createIndex: async (spec: any, opts: any) => { created.push({ spec, opts }); return 'idx'; },
    };
    const db = { collection: () => carts } as any;
    return { db, getDocs: () => docs, created };
  }

  it('merges duplicate {userId,threadId} docs into the newest, deletes the rest, then creates a unique index', async () => {
    const { db, getDocs, created } = cartsDb([
      { userId: 'demo', threadId: 't', lines: [line({ product_id: 'a', qty: 1 })], updated_at: new Date('2026-01-01T00:00:00Z') },
      { userId: 'demo', threadId: 't', lines: [line({ product_id: 'b', qty: 1 })], updated_at: new Date('2026-01-02T00:00:00Z') }, // newest → survivor
      { userId: 'other', threadId: 't', lines: [line({ product_id: 'z', qty: 1 })], updated_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    await provisionCartIndex(db);
    const docs = getDocs();
    // demo/t collapsed to ONE doc holding both lines; other/t untouched.
    const demo = docs.filter(d => d.userId === 'demo' && d.threadId === 't');
    expect(demo).toHaveLength(1);
    expect(demo[0].lines.map((l: CartLine) => l.product_id).sort()).toEqual(['a', 'b']);
    expect(docs.filter(d => d.userId === 'other')).toHaveLength(1);
    // The unique index was created with the documented name.
    expect(created).toHaveLength(1);
    expect(created[0].spec).toEqual({ userId: 1, threadId: 1 });
    expect(created[0].opts).toMatchObject({ unique: true });
  });

  it('creates the unique index even when there are no duplicates to merge', async () => {
    const { db, created } = cartsDb([{ userId: 'demo', threadId: 't', lines: [], updated_at: new Date() }]);
    await provisionCartIndex(db);
    expect(created).toHaveLength(1);
    expect(created[0].opts).toMatchObject({ unique: true });
  });
});

// applyCoupon closes the gap that let the agent promise "SAVE5 will be applied at checkout"
// while placing the order at full price: nothing could actually apply a coupon. It validates
// the code (exists + active + in date window + category/product scope), then stamps the % off
// the effective (sale) price onto eligible lines — deterministic math, never LLM arithmetic.
describe('applyCoupon', () => {
  const key = { userId: 'demo', threadId: 'demo:t1' };
  // The reported transcript: one on-sale kitchen line (Water Bottle, sale 116.79 × 1).
  const kitchenCart = (over: Partial<CartLine> = {}) => ({
    ...key,
    lines: [line({ product_id: 'prod_0021', name: 'Classic Insulated Water Bottle 8in', unit_price_usd: 145.99, sale_price_usd: 116.79, qty: 1, line_savings: 29.2, ...over })],
  });

  it('applies a valid in-scope code: stamps % off the sale price and returns the discounted total', async () => {
    const { db, setDoc } = stubDb();
    setDoc(kitchenCart());
    const { applyCoupon } = buildCartTools({ db, ...key });
    const res: any = await applyCoupon.execute!({ code: 'SAVE5' } as any, {} as any);
    expect(res.ok).toBe(true);
    expect(res.applied_coupons).toEqual(['SAVE5']);
    // 5% of the effective (sale) price 116.79 × 1 = 5.8395 → 5.84.
    expect(res.coupon_savings).toBeCloseTo(5.84, 2);
    expect(res.total).toBeCloseTo(116.79 - 5.84, 2);
    // Verify it persisted to the cart line.
    const cart: any = await buildCartTools({ db, ...key }).cartRead.execute!({} as any, {} as any);
    expect(cart.lines[0].applied_coupons).toEqual(['SAVE5']);
    expect(cart.lines[0].coupon_savings).toBeCloseTo(5.84, 2);
    expect(cart.total).toBeCloseTo(110.95, 2);
  });

  it('refuses an unknown code and writes nothing', async () => {
    const { db, setDoc, calls } = stubDb();
    setDoc(kitchenCart());
    const { applyCoupon } = buildCartTools({ db, ...key });
    const res: any = await applyCoupon.execute!({ code: 'NOPE' } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/invalid|not.*valid|unknown|inactive/i);
    expect(calls.some(c => c.op === 'updateOne')).toBe(false);
  });

  it('refuses an inactive code', async () => {
    const { db, setDoc, calls } = stubDb();
    setDoc(kitchenCart());
    const { applyCoupon } = buildCartTools({ db, ...key });
    const res: any = await applyCoupon.execute!({ code: 'INACTIVE' } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(calls.some(c => c.op === 'updateOne')).toBe(false);
  });

  it('refuses an expired (out-of-date-window) code', async () => {
    const { db, setDoc, calls } = stubDb();
    setDoc(kitchenCart());
    const { applyCoupon } = buildCartTools({ db, ...key });
    const res: any = await applyCoupon.execute!({ code: 'EXPIRED' } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/expired|not yet|window|active/i);
    expect(calls.some(c => c.op === 'updateOne')).toBe(false);
  });

  it('refuses a valid code when nothing in the cart qualifies for its scope', async () => {
    const { db, setDoc, calls } = stubDb();
    setDoc(kitchenCart()); // kitchen cart, but SAVE10APP is apparel-scoped
    const { applyCoupon } = buildCartTools({ db, ...key });
    const res: any = await applyCoupon.execute!({ code: 'SAVE10APP' } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/qualif|eligible|nothing|scope|categor/i);
    expect(calls.some(c => c.op === 'updateOne')).toBe(false);
  });

  it('refuses when the cart is empty', async () => {
    const { db, calls } = stubDb();
    const { applyCoupon } = buildCartTools({ db, ...key });
    const res: any = await applyCoupon.execute!({ code: 'SAVE5' } as any, {} as any);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/empty|no.*cart|add/i);
    expect(calls.some(c => c.op === 'updateOne')).toBe(false);
  });

  it('replaces a prior code (one coupon per order)', async () => {
    // Cart already has SAVE5 stamped; applying a different valid kitchen code replaces it.
    const { db, setDoc } = stubDb([
      { _id: 'prod_0021', name: 'Classic Insulated Water Bottle 8in', category: 'kitchen', price_usd: 145.99, sale_price_usd: 116.79, on_sale: true, stock: 5 },
    ], [
      { _id: 'promo_0001', code: 'SAVE5', discount_pct: 5, applies_to_category: 'kitchen', product_ids: [], starts_at: new Date('2000-01-01T00:00:00.000Z'), ends_at: new Date('2999-01-01T00:00:00.000Z'), active: true },
      { _id: 'promo_0005', code: 'SAVE20KIT', discount_pct: 20, applies_to_category: 'kitchen', product_ids: [], starts_at: new Date('2000-01-01T00:00:00.000Z'), ends_at: new Date('2999-01-01T00:00:00.000Z'), active: true },
    ]);
    setDoc(kitchenCart({ applied_coupons: ['SAVE5'], coupon_savings: 5.84 }));
    const { applyCoupon } = buildCartTools({ db, ...key });
    const res: any = await applyCoupon.execute!({ code: 'SAVE20KIT' } as any, {} as any);
    expect(res.ok).toBe(true);
    expect(res.applied_coupons).toEqual(['SAVE20KIT']);
    const cart: any = await buildCartTools({ db, ...key }).cartRead.execute!({} as any, {} as any);
    // Only the new code remains on the line — SAVE5 is gone (not stacked).
    expect(cart.lines[0].applied_coupons).toEqual(['SAVE20KIT']);
    expect(cart.lines[0].coupon_savings).toBeCloseTo(116.79 * 0.2, 2);
  });

  it('fires onMutate when a coupon is applied', async () => {
    const { db, setDoc } = stubDb();
    setDoc(kitchenCart());
    let mutations = 0;
    const { applyCoupon } = buildCartTools({ db, ...key, onMutate: () => { mutations++; } });
    await applyCoupon.execute!({ code: 'SAVE5' } as any, {} as any);
    expect(mutations).toBe(1);
  });
});
