import { describe, it, expect } from 'vitest';
import type { Db } from 'mongodb';
import { buildPlaceOrderWorkflow, buildOrderSteps } from './place-order';
import { cartFingerprint as cartFingerprintOf } from '../tools/cart';

// Unit tests exercise the STEP logic directly with stubbed collections — no live
// DB, no LLM. The live transaction + cross-request resume are covered by
// tests/integration/order-workflow.integration.test.ts (TC-ORD-I-*).

type Doc = Record<string, any>;

/** A minimal fake `Db` whose collections are backed by in-memory arrays, with a
 * transaction shim (`client.withSession`/`withTransaction` just run the callback). */
function fakeDb(seed: { carts?: Doc[]; products?: Doc[]; orders?: Doc[] }) {
  const store: Record<string, Doc[]> = {
    carts: seed.carts ?? [], products: seed.products ?? [], orders: seed.orders ?? [],
  };
  const calls = { insertOne: 0, updateOne: 0, deleteOne: 0 };
  // Minimal query matcher supporting equality plus the $in / $gte operators the
  // workflow uses (batched stock lookup + conditional decrement).
  const matchVal = (actual: any, cond: any): boolean => {
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$in' in cond) return (cond.$in as any[]).includes(actual);
      if ('$gte' in cond) return typeof actual === 'number' && actual >= cond.$gte;
    }
    return actual === cond;
  };
  const match = (d: Doc, q: Doc) => Object.entries(q).every(([k, v]) => matchVal(d[k], v));
  const collection = (name: string) => ({
    findOne: async (q: Doc) => store[name].find(d => match(d, q)) ?? null,
    find: (q: Doc) => ({ toArray: async () => store[name].filter(d => match(d, q)) }),
    insertOne: async (doc: Doc) => { calls.insertOne++; store[name].push(doc); return { insertedId: doc._id }; },
    updateOne: async (q: Doc, update: Doc) => {
      calls.updateOne++;
      const d = store[name].find(x => match(x, q));
      if (d && update.$inc) for (const [k, v] of Object.entries(update.$inc)) d[k] = (d[k] ?? 0) + (v as number);
      return { modifiedCount: d ? 1 : 0 };
    },
    deleteOne: async (q: Doc) => {
      calls.deleteOne++;
      const i = store[name].findIndex(d => match(d, q));
      if (i >= 0) store[name].splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
  });
  const db = { collection } as unknown as Db;
  // The workflow reaches the MongoClient via db.client for transactions. The fake
  // mirrors real rollback: if the transaction body throws, restore the pre-txn
  // store snapshot (so a mid-transaction abort leaves NO partial writes — the
  // property the TOCTOU test depends on / mock parity with a real replica set).
  (db as any).client = {
    withSession: async (fn: (s: any) => Promise<void>) => fn({
      withTransaction: async (t: () => Promise<void>) => {
        const snapshot = JSON.parse(JSON.stringify(store));
        try { await t(); }
        catch (err) { for (const k of Object.keys(store)) store[k] = snapshot[k]; throw err; }
      },
    }),
  };
  return { db, store, calls };
}

const LINE = (over: Partial<Doc> = {}): Doc => ({
  product_id: 'p1', name: 'Eco Mug', qty: 2,
  unit_price_usd: 10, sale_price_usd: 8, applied_coupons: [], line_savings: 4, coupon_savings: 0, ...over,
});

const INIT = { userId: 'u1', threadId: 'u1:t1', now: '2026-07-07T00:00:00.000Z', orderId: 'order-fixed-1' };

// cart_version is the fingerprint of [LINE()] (product_id:qty) — must match what
// cartFingerprint produces for the seeded cart, or the drift guard fires.
const QUOTE = { lines: [LINE()], subtotal: 16, total_savings: 4, total_usd: 16, cart_version: 'p1:2' };

describe('place-order workflow steps', () => {
  it('exposes a committed workflow and the three steps bound to a db', () => {
    const { db } = fakeDb({});
    expect(buildPlaceOrderWorkflow(db)).toBeDefined();
    const steps = buildOrderSteps(db);
    expect(steps.buildQuote.id).toBe('build-quote');
    expect(steps.approveOrder.id).toBe('approve-order');
    expect(steps.placeOrder.id).toBe('place-order');
  });

  it('buildQuote charges subtotal minus coupon savings and reports total savings', async () => {
    // One kitchen line on sale (8, was 10, qty 2 → subtotal 16, sale savings 4) with a
    // coupon knocking 1.60 off: charged total is 16 − 1.60 = 14.40, savings 4 + 1.60 = 5.60.
    const { db } = fakeDb({
      carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [LINE({ applied_coupons: ['SAVE10KIT'], coupon_savings: 1.6 })] }],
      products: [{ _id: 'p1', stock: 50 }],
    });
    const q = await buildOrderSteps(db).buildQuote.execute({ inputData: INIT } as any) as any;
    expect(q.subtotal).toBe(16);          // pre-coupon
    expect(q.coupon_savings).toBe(1.6);
    expect(q.total_usd).toBe(14.4);       // subtotal − coupon (the amount charged)
    expect(q.total_savings).toBe(5.6);    // sale (4) + coupon (1.6)
  });

  // REQ-E-037: identity comes from the workflow input closure; no model-facing
  // identity field is invented inside the steps. The InputSchema carries exactly
  // userId/threadId/now/orderId (server-supplied), nothing the model sets.
  it('InputSchema carries only server-supplied fields (REQ-E-037)', () => {
    const { db } = fakeDb({});
    const shape = Object.keys((buildOrderSteps(db).inputSchema as any).shape);
    expect(shape.sort()).toEqual(['now', 'orderId', 'threadId', 'userId']);
  });

  it('buildQuote computes totals from cart lines', async () => {
    const { db } = fakeDb({
      carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [LINE(), LINE({ product_id: 'p2', qty: 1, line_savings: 0, sale_price_usd: null, unit_price_usd: 5 })] }],
      products: [{ _id: 'p1', stock: 50 }, { _id: 'p2', stock: 50 }],
    });
    const q = await buildOrderSteps(db).buildQuote.execute({ inputData: INIT } as any) as any;
    expect(q.subtotal).toBe(8 * 2 + 5 * 1); // 21
    expect(q.total_savings).toBe(4);
    expect(q.total_usd).toBe(21);
    expect(q.lines).toHaveLength(2);
    // Quote carries a cart fingerprint (order-independent product_id:qty) so placeOrder
    // can detect drift after approval (reviewer finding #3).
    expect(q.cart_version).toBe('p1:2|p2:1');
  });

  // REQ-E-034: insufficient stock fails BEFORE any suspend/write.
  it('buildQuote throws on insufficient stock (REQ-E-034)', async () => {
    const { db } = fakeDb({
      carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [LINE({ qty: 5 })] }],
      products: [{ _id: 'p1', stock: 3 }],
    });
    await expect(buildOrderSteps(db).buildQuote.execute({ inputData: INIT } as any))
      .rejects.toThrow(/stock/i);
  });

  it('buildQuote throws on an empty cart', async () => {
    const { db } = fakeDb({ carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [] }] });
    await expect(buildOrderSteps(db).buildQuote.execute({ inputData: INIT } as any))
      .rejects.toThrow(/empty/i);
  });

  // approveOrder suspends with the interrupt payload on first entry (no resumeData).
  it('approveOrder suspends with the place_order action + allowed_decisions', async () => {
    const { db } = fakeDb({});
    let suspended: any = null;
    const suspend = async (payload: any) => { suspended = payload; return payload; };
    await buildOrderSteps(db).approveOrder.execute({ inputData: QUOTE, resumeData: undefined, suspend } as any);
    expect(suspended.action.name).toBe('place_order');
    expect(suspended.allowed_decisions).toEqual(['approve', 'edit', 'reject']);
    expect(suspended.action.args.total_usd).toBe(16);
  });

  it('approveOrder returns the decision + quote once resumed', async () => {
    const { db } = fakeDb({});
    const out = await buildOrderSteps(db).approveOrder.execute({
      inputData: QUOTE, resumeData: { decision: 'approve' }, suspend: async () => ({}),
    } as any) as any;
    expect(out.decision).toBe('approve');
    expect(out.quote.total_usd).toBe(16);
  });

  // REQ-E-032: reject writes NOTHING to orders/products/carts.
  it('placeOrder on reject returns cancelled and performs no writes (REQ-E-032)', async () => {
    const { db, calls } = fakeDb({});
    const out = await buildOrderSteps(db).placeOrder.execute({
      inputData: { decision: 'reject', quote: QUOTE },
      getInitData: () => INIT,
    } as any) as any;
    expect(out.status).toBe('cancelled');
    expect(calls.insertOne).toBe(0);
    expect(calls.updateOne).toBe(0);
    expect(calls.deleteOne).toBe(0);
  });

  // REQ-E-033 + security: `edit` must NOT commit an order (no client-supplied quote
  // ever reaches placeOrder), and approveOrder must not merge edited_action.args into
  // the quote. edit is a safe cancel (adjust cart + re-checkout).
  it('placeOrder on edit returns cancelled and performs no writes', async () => {
    const { db, calls } = fakeDb({});
    const out = await buildOrderSteps(db).placeOrder.execute({
      inputData: { decision: 'edit', quote: QUOTE },
      getInitData: () => INIT,
    } as any) as any;
    expect(out.status).toBe('cancelled');
    expect(out.message).toMatch(/adjust|cart|again/i);
    expect(calls.insertOne).toBe(0);
    expect(calls.updateOne).toBe(0);
    expect(calls.deleteOne).toBe(0);
  });

  it('approveOrder ignores client-supplied edited_action.args (no quote tampering)', async () => {
    const { db } = fakeDb({});
    const out = await buildOrderSteps(db).approveOrder.execute({
      inputData: QUOTE,
      resumeData: { decision: 'edit', edited_action: { name: 'place_order', args: { total_usd: 0.01, lines: [] } } },
      suspend: async () => ({}),
    } as any) as any;
    // The forwarded quote is the SERVER quote, not the tampered client args.
    expect(out.quote.total_usd).toBe(16);
    expect(out.quote.lines).toHaveLength(1);
  });

  // REQ-E-031: approve inserts one order, decrements stock per line, clears cart.
  it('placeOrder on approve inserts order + decrements stock + clears cart (REQ-E-031)', async () => {
    const { db, store } = fakeDb({
      carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [LINE()] }],
      products: [{ _id: 'p1', stock: 50 }],
    });
    const out = await buildOrderSteps(db).placeOrder.execute({
      inputData: { decision: 'approve', quote: QUOTE },
      getInitData: () => INIT,
    } as any) as any;
    expect(out.status).toBe('placed');
    expect(out.order_id).toBe('order-fixed-1');
    expect(store.orders).toHaveLength(1);
    expect(store.orders[0].total_usd).toBe(16);
    expect(store.orders[0].status).toBe('placed');
    // Effective (sale) unit price is stored so items reconcile with total_usd.
    expect(store.orders[0].items[0].unit_price_usd).toBe(8);
    expect(store.orders[0].items[0].list_price_usd).toBe(10);
    // placed_at is persisted as a BSON Date built from the string `now` carried through the
    // (JSON-serialized) workflow snapshot — not stored as a raw ISO string.
    expect(store.orders[0].placed_at).toBeInstanceOf(Date);
    expect((store.orders[0].placed_at as Date).toISOString()).toBe(INIT.now);
    expect(store.products[0].stock).toBe(48); // 50 - qty(2)
    expect(store.carts).toHaveLength(0);      // cart cleared
  });

  // Coupon: the placed order records the discounted total, the coupon codes used, the total
  // savings, and per-item applied_coupons + coupon_savings so it reconciles with total_usd.
  it('placeOrder records coupon codes, savings, and the discounted total on the order', async () => {
    const couponedLine = LINE({ applied_coupons: ['SAVE10KIT'], coupon_savings: 1.6 });
    const couponedQuote = {
      lines: [couponedLine], subtotal: 16, coupon_savings: 1.6, total_savings: 5.6,
      total_usd: 14.4, cart_version: cartFingerprintOf([couponedLine] as any),
    };
    const { db, store } = fakeDb({
      carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [couponedLine] }],
      products: [{ _id: 'p1', stock: 50 }],
    });
    const out = await buildOrderSteps(db).placeOrder.execute({
      inputData: { decision: 'approve', quote: couponedQuote },
      getInitData: () => INIT,
    } as any) as any;
    expect(out.status).toBe('placed');
    expect(out.total_usd).toBe(14.4);
    const order = store.orders[0];
    expect(order.total_usd).toBe(14.4);
    expect(order.coupons_used).toEqual(['SAVE10KIT']);
    expect(order.savings_usd).toBe(5.6);
    expect(order.items[0].applied_coupons).toEqual(['SAVE10KIT']);
    expect(order.items[0].coupon_savings).toBe(1.6);
  });

  // F3 (TOCTOU): if stock dropped below qty between quote and commit, the conditional
  // decrement matches nothing → the transaction aborts and NO order is written.
  it('placeOrder aborts if stock dropped below qty at commit time (no oversell)', async () => {
    const { db, store } = fakeDb({
      carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [LINE({ qty: 2 })] }],
      products: [{ _id: 'p1', stock: 1 }], // dropped to 1 after the quote saw >=2
    });
    await expect(buildOrderSteps(db).placeOrder.execute({
      inputData: { decision: 'approve', quote: QUOTE },
      getInitData: () => INIT,
    } as any)).rejects.toThrow(/insufficient stock/i);
    expect(store.orders).toHaveLength(0);   // no order written
    expect(store.products[0].stock).toBe(1); // stock untouched (never negative)
  });

  // Reviewer finding #3: approving a stale quote must NOT place the order or wipe the
  // cart the shopper changed after the approval card. The in-transaction fingerprint
  // re-check aborts when the live cart differs from the approved quote.
  it('placeOrder aborts (no write, cart intact) when the cart changed after approval', async () => {
    const { db, store } = fakeDb({
      // Live cart now has an EXTRA line the quote never saw (qty/line drift).
      carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [LINE(), LINE({ product_id: 'p2', qty: 1 })] }],
      products: [{ _id: 'p1', stock: 50 }, { _id: 'p2', stock: 50 }],
    });
    await expect(buildOrderSteps(db).placeOrder.execute({
      inputData: { decision: 'approve', quote: QUOTE }, // quote.cart_version = 'p1:2'
      getInitData: () => INIT,
    } as any)).rejects.toThrow(/cart changed/i);
    expect(store.orders).toHaveLength(0);          // no order placed
    expect(store.carts[0].lines).toHaveLength(2);  // the changed cart is NOT wiped
  });

  it('placeOrder commits when the live cart still matches the approved quote', async () => {
    const { db, store } = fakeDb({
      carts: [{ userId: 'u1', threadId: 'u1:t1', lines: [LINE()] }], // fingerprint 'p1:2'
      products: [{ _id: 'p1', stock: 50 }],
    });
    const out = await buildOrderSteps(db).placeOrder.execute({
      inputData: { decision: 'approve', quote: QUOTE },
      getInitData: () => INIT,
    } as any) as any;
    expect(out.status).toBe('placed');
    expect(store.orders).toHaveLength(1);
    expect(store.carts).toHaveLength(0); // matching cart is cleared as normal
  });

  // The earlier (cheaper) binding: approveOrder downgrades an approve to a cancel when the
  // resume echoes a cart_version that no longer matches the server quote.
  it('approveOrder downgrades approve→reject when resume cart_version mismatches the quote', async () => {
    const { db } = fakeDb({});
    const out = await buildOrderSteps(db).approveOrder.execute({
      inputData: QUOTE, // cart_version 'p1:2'
      resumeData: { decision: 'approve', cart_version: 'p1:2|p9:9' }, // stale card
      suspend: async () => ({}),
    } as any) as any;
    expect(out.decision).toBe('reject');
  });

  it('approveOrder keeps approve when resume cart_version matches (or is absent)', async () => {
    const { db } = fakeDb({});
    const match = await buildOrderSteps(db).approveOrder.execute({
      inputData: QUOTE, resumeData: { decision: 'approve', cart_version: 'p1:2' }, suspend: async () => ({}),
    } as any) as any;
    expect(match.decision).toBe('approve');
    const absent = await buildOrderSteps(db).approveOrder.execute({
      inputData: QUOTE, resumeData: { decision: 'approve' }, suspend: async () => ({}),
    } as any) as any;
    expect(absent.decision).toBe('approve'); // backward-compatible when client omits it
  });
});
