import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db, Collection } from 'mongodb';
import { logger } from '../../observability/logger';

export interface CartLine {
  product_id: string; name: string; qty: number;
  unit_price_usd: number; sale_price_usd: number | null;
  applied_coupons: string[]; line_savings: number;
  /** Coupon $ off this line (the applied promo's % against the effective price × qty).
   *  0 when no coupon applies. Separate from `line_savings` (sale savings) so the charged
   *  total is unambiguous: subtotal is pre-coupon, `total` subtracts this. */
  coupon_savings: number;
}

/** The `carts` document shape, keyed on {userId, threadId}. Typing the collection with
 *  this lets the MongoDB driver accept `$push: { lines }` / `$pull` without casts. */
export interface CartDoc {
  userId: string;
  threadId: string;
  lines: CartLine[];
  updated_at: Date | null;
}

/** The `products` fields the cart resolver reads (a partial view of the full catalog doc). */
interface ProductDoc {
  _id: string;
  name: string;
  category: string;
  price_usd: number;
  sale_price_usd: number | null;
  on_sale: boolean;
}

/** The `promotions` fields applyCoupon validates against (see schemas/promotions.ts). */
interface PromotionDoc {
  code: string;
  discount_pct: number;
  applies_to_category: string;
  product_ids: string[];
  starts_at: Date;
  ends_at: Date;
  active: boolean;
}

export const MUTATING_TOOLS = new Set<string>(['cartAdd', 'cartRemove', 'applyCoupon']);

// Hard ceiling on the distinct-add cap regardless of how many products a turn grounds. A
// single dataQuery is bounded by dataAgentLimit (default 25), but several queries in one turn
// could accumulate more into turnProductIds; this caps the blast radius of grounded-sizing so
// a runaway can never balloon the cart past a sane per-turn maximum.
const MAX_DISTINCT_ADDS_CEILING = 25;

/**
 * A deterministic fingerprint of a cart's contents (product_id + qty per line, order-
 * independent). Used to bind a checkout quote to the exact cart it was built from: if the
 * shopper changes the cart after the approval card appears, the fingerprint no longer
 * matches and the order workflow refuses to place a stale quote / wipe the new cart
 * (reviewer finding #3). Deterministic (no time/random) so it is stable across the
 * suspend→resume boundary and across processes/replicas.
 */
export function cartFingerprint(lines: CartLine[]): string {
  // Include applied coupons in the fingerprint so applying/removing a coupon after the
  // approval card was shown invalidates the stale quote (same drift guard as qty changes).
  // Lines with no coupon keep the plain `product_id:qty` form, so pre-coupon fingerprints
  // (and the tests that pin them) are unchanged.
  return lines
    .map(l => {
      const codes = l.applied_coupons ?? [];
      return codes.length ? `${l.product_id}:${l.qty}#${[...codes].sort().join(',')}` : `${l.product_id}:${l.qty}`;
    })
    .sort()
    .join('|');
}

/**
 * Cart totals. `subtotal` is the effective (sale-when-present) unit price × qty, PRE-coupon
 * (unchanged meaning). `coupon_savings` sums the per-line coupon discounts; `sale_savings`
 * sums per-line sale savings; `total_savings` is their sum; `total` is the amount actually
 * charged (subtotal − coupon_savings). With no coupons, `coupon_savings` is 0, so `subtotal`,
 * `total_savings`, and `total` collapse to the pre-coupon behaviour.
 */
export function computeCartTotals(lines: CartLine[]): {
  subtotal: number; sale_savings: number; coupon_savings: number; total_savings: number; total: number;
} {
  let subtotal = 0;
  let sale_savings = 0;
  let coupon_savings = 0;
  for (const l of lines) {
    const unit = l.sale_price_usd ?? l.unit_price_usd;
    subtotal += unit * l.qty;
    sale_savings += l.line_savings ?? 0;
    coupon_savings += l.coupon_savings ?? 0;
  }
  // Round to cents so summed floats don't display binary noise.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  subtotal = round2(subtotal);
  sale_savings = round2(sale_savings);
  coupon_savings = round2(coupon_savings);
  return {
    subtotal,
    sale_savings,
    coupon_savings,
    total_savings: round2(sale_savings + coupon_savings),
    total: round2(subtotal - coupon_savings),
  };
}

/**
 * Merge cart lines from several documents into one, unioning by product_id and summing qty for
 * repeats. Order-stable (first occurrence wins position). Used by the dedupe migration below.
 */
export function mergeCartLines(lineSets: CartLine[][]): CartLine[] {
  const byId = new Map<string, CartLine>();
  for (const lines of lineSets) {
    for (const l of lines ?? []) {
      const prev = byId.get(l.product_id);
      if (prev) prev.qty += l.qty;
      else byId.set(l.product_id, { ...l });
    }
  }
  return [...byId.values()];
}

/**
 * Provision the authoritative `carts` guard: a UNIQUE index on {userId, threadId}. Without it,
 * concurrent bulk `cartAdd` upserts (Mastra runs tool calls near-simultaneously) each INSERT a
 * separate document for the same key, splitting one shopper's cart across several docs. Checkout
 * reads/deletes with a single findOne/deleteOne on the key, so it quotes and clears only ONE of
 * them — the sibling docs' lines survive as phantom cart items after an order (the "1 item still
 * in cart after checkout" bug).
 *
 * A unique index cannot be created while duplicates exist, so this first MIGRATES: for every key
 * with >1 doc, merge all lines into the most-recently-updated doc (union by product_id, summing
 * qty), delete the rest, THEN create the unique index. Idempotent — safe to re-run.
 */
export async function provisionCartIndex(db: Db): Promise<void> {
  const carts = db.collection<CartDoc>('carts');
  const dupes = await carts.aggregate<{ _id: { userId: string; threadId: string }; count: number }>([
    { $group: { _id: { userId: '$userId', threadId: '$threadId' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  for (const { _id: k } of dupes) {
    const docs = await carts.find({ userId: k.userId, threadId: k.threadId }).toArray();
    // Newest by updated_at wins as the surviving doc (falls back to insertion order).
    const ts = (d: CartDoc) => (d.updated_at ? new Date(d.updated_at).getTime() : 0);
    const sorted = [...docs].sort((a, b) => ts(b) - ts(a));
    const survivor = sorted[0];
    const mergedLines = mergeCartLines(docs.map(d => d.lines ?? []));
    await carts.updateOne(
      { _id: (survivor as any)._id },
      { $set: { lines: mergedLines, updated_at: survivor.updated_at ?? new Date() } },
    );
    const loserIds = sorted.slice(1).map(d => (d as any)._id);
    if (loserIds.length) await carts.deleteMany({ _id: { $in: loserIds } });
    logger.info('carts dedupe', { userId: k.userId, threadId: k.threadId, merged: docs.length, lines: mergedLines.length });
  }
  await carts.createIndex({ userId: 1, threadId: 1 }, { unique: true, name: 'carts_user_thread_unique' });
}

/**
 * Cart tools are bound to the turn's real {userId, threadId} via closure — the model
 * never supplies identity, so it cannot write to (or read) the wrong cart. The same key
 * is what the UI reads at GET /cart, so what the agent builds is exactly what renders.
 */
/** Escape a user/model-supplied string for safe use inside a RegExp (anchored name lookup). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True for a MongoDB duplicate-key (E11000) error — the driver sets `code === 11000`. Used to
 *  detect a concurrent cart insert losing the race under the unique {userId,threadId} index. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}

/**
 * Resolve a model-supplied cart line to an authoritative one built from the `products`
 * doc. The model reliably passes qty but frequently fabricates `product_id` (a slug like
 * `classic-nonstick-fry-pan-12oz` instead of the real `_id` `prod_0061`) and miscomputes
 * price/savings. We look the product up by `_id` first, then fall back to an exact
 * (case-insensitive) name match, and derive every price field from the DB — so the cart
 * (and downstream checkout stock lookup, which keys on the real `_id`) is always correct.
 * Returns null when no product resolves, so cartAdd can refuse rather than store a bad line.
 */
async function resolveLine(products: Collection<ProductDoc>, input: any): Promise<CartLine | null> {
  const qty = Number.isFinite(input?.qty) && input.qty > 0 ? Math.floor(input.qty) : 1;
  let doc: ProductDoc | null = null;
  if (typeof input?.product_id === 'string' && input.product_id) {
    doc = await products.findOne({ _id: input.product_id });
  }
  if (!doc && typeof input?.name === 'string' && input.name.trim()) {
    doc = await products.findOne({ name: { $regex: `^${escapeRegex(input.name.trim())}$`, $options: 'i' } });
  }
  if (!doc) return null;

  const unit_price_usd = doc.price_usd;
  const sale_price_usd = doc.on_sale && typeof doc.sale_price_usd === 'number' ? doc.sale_price_usd : null;
  // Round to cents so savings don't display binary-float noise (e.g. 29.200000000000003).
  const line_savings = sale_price_usd !== null ? Math.round((unit_price_usd - sale_price_usd) * qty * 100) / 100 : 0;
  return {
    product_id: String(doc._id),
    name: doc.name,
    qty,
    unit_price_usd,
    sale_price_usd,
    applied_coupons: [],
    line_savings,
    coupon_savings: 0,
  };
}

export function buildCartTools(args: {
  db: Db; userId: string; threadId: string; onMutate?: () => void;
  /**
   * The `_id`s the specialist's dataQuery returned THIS turn (populated live as queries
   * run). Retrieval grounding: if this set is non-empty, an add is only allowed for a
   * product it contains — the item must come from what the shopper's request actually
   * surfaced, not from memory or model generation. When it is empty (no product query
   * surfaced anything this turn — e.g. a pure "add the bottle I mentioned earlier"
   * reference), the gate is inactive and resolution proceeds by _id/name, so legitimate
   * memory references still work. A rejection tells the model to look the product up,
   * so a genuine reference self-heals by re-querying.
   */
  turnProductIds?: Set<string>;
  /**
   * Max number of DISTINCT new products cartAdd may add in a single turn. The model
   * (both haiku and sonnet) sometimes calls cartAdd 2–3 times for one "add an item"
   * request, ballooning the cart — a prompt rule alone doesn't stop it. Defaults to 1:
   * a re-add of the same product just bumps its qty (idempotent), and a 2nd DISTINCT
   * product in the same turn is refused. A turn that genuinely means "add several"
   * raises this when building the tools. This is the authoritative single-add guard.
   */
  maxDistinctAddsPerTurn?: number;
}) {
  const carts = args.db.collection<CartDoc>('carts');
  const products = args.db.collection<ProductDoc>('products');
  const promotions = args.db.collection<PromotionDoc>('promotions');
  const key = { userId: args.userId, threadId: args.threadId };
  const phrasingCap = args.maxDistinctAddsPerTurn ?? 1;
  const addedThisTurn = new Set<string>();
  // Effective distinct-add cap, evaluated at add-time (NOT frozen at build time): the larger
  // of the phrasing cap and the number of DISTINCT products a dataQuery grounded this turn.
  // The grounded set grows as the turn runs (dataQuery fires per item, then cartAdd), and only
  // its members can be added at all (the grounding gate below), so sizing the cap to it lets a
  // recipe's N ingredients all be added even when the phrasing ("Add to cart", "add the
  // ingredients") didn't trip isBulkAddIntent — the class of bug that dropped 5 of 6 pasta
  // ingredients. The grounding gate is the real ballooning bound; this just stops the cap from
  // rejecting products the shopper's own query surfaced.
  const distinctAddCap = () =>
    Math.min(MAX_DISTINCT_ADDS_CEILING, Math.max(phrasingCap, args.turnProductIds?.size ?? 0));
  const read = createTool({
    id: 'cartRead',
    description: 'Read the current shopping cart for this conversation.',
    inputSchema: z.object({}),
    execute: async (inputData, context) => {
      const doc = await carts.findOne(key);
      const lines = (doc?.lines ?? []) as CartLine[];
      return { lines, ...computeCartTotals(lines), updated_at: doc?.updated_at ?? null };
    },
  });
  const add = createTool({
    id: 'cartAdd',
    description:
      'Add a product to the cart. Pass a line with the product_id (its _id, e.g. "prod_0061") ' +
      'and qty; include the exact product name as a fallback. Prices and savings are looked up ' +
      'from live product data — you do not need to compute unit_price_usd, sale_price_usd, or ' +
      'line_savings (any values you pass are ignored). If the product cannot be found, this ' +
      'returns { ok: false } and adds nothing.',
    inputSchema: z.object({ line: z.any() }),
    execute: async (inputData, context) => {
      // Resolve to an authoritative line BEFORE signalling a mutation or writing: the model
      // often fabricates product_id (slug vs real _id) and miscomputes prices. If nothing
      // resolves, refuse — never store a line the checkout stock lookup can't key on.
      const line = await resolveLine(products, inputData.line);
      if (!line) return { ok: false, reason: 'Product not found — could not add to cart.' };
      // Retrieval grounding: when a product query surfaced results this turn, only add one
      // of those. Catches the "added an item that wasn't in the search results" bug (an
      // off-constraint pick from memory/generation) without parsing the request. An empty
      // set means no query surfaced anything (pure memory reference) — gate stays inactive.
      const grounded = args.turnProductIds;
      if (grounded && grounded.size > 0 && !grounded.has(line.product_id)) {
        // Observability: an ungrounded add attempt (item not in this turn's results) is the
        // signature of memory/generation leaking into a grounded request. Log it so the rate
        // is measurable in production, then refuse and steer the model back to its results.
        logger.info('cart grounding reject', { product_id: line.product_id, resultCount: grounded.size });
        return {
          ok: false,
          reason:
            `"${line.name}" (${line.product_id}) is not one of the products your dataQuery returned ` +
            `this turn, so it was NOT added. Do not ask the shopper anything. Pick one product _id ` +
            `from your most recent dataQuery results that matches the request and call cartAdd again ` +
            `with that exact _id.`,
        };
      }
      // Idempotent re-add: if this product is already a cart line, bump its qty instead of
      // pushing a duplicate. Fixes the model calling cartAdd twice for the same item.
      const existing = await carts.findOne(key);
      const already = (existing?.lines ?? []).find(l => l.product_id === line.product_id);
      if (already) {
        args.onMutate?.();
        addedThisTurn.add(line.product_id);
        await carts.updateOne(
          { ...key, 'lines.product_id': line.product_id },
          { $inc: { 'lines.$.qty': line.qty }, $set: { updated_at: new Date() } },
        );
        return { ok: true, line: { ...already, qty: already.qty + line.qty } };
      }
      // Per-turn distinct-add cap: refuse a 2nd distinct product in one turn unless the
      // tools were built to allow several. Blocks the spurious multi-add that balloons the
      // cart on a single-item request (verify:demo caught 3 lines from one turn).
      const maxAdds = distinctAddCap();
      if (!addedThisTurn.has(line.product_id) && addedThisTurn.size >= maxAdds) {
        logger.info('cart add cap hit', { product_id: line.product_id, addedThisTurn: addedThisTurn.size, maxAdds });
        return {
          ok: false,
          reason:
            `You already added ${addedThisTurn.size} product(s) this turn and the shopper asked for one. ` +
            `"${line.name}" was NOT added. Do not add more items; summarize what is already in the cart.`,
        };
      }
      args.onMutate?.();
      addedThisTurn.add(line.product_id);
      try {
        await carts.updateOne(
          key,
          { $push: { lines: line }, $set: { updated_at: new Date() } },
          { upsert: true },
        );
      } catch (err) {
        // Concurrent bulk-add race: under the unique {userId,threadId} index, a sibling cartAdd
        // won the insert race and materialized the doc after our findOne saw nothing, so our own
        // upsert insert is rejected with E11000. The doc now EXISTS, so retry as a plain $push
        // (no upsert) to land this line in the ONE cart doc — never a second split document that
        // checkout's single findOne/deleteOne would quote/clear only partially (the "1 item
        // survives after checkout" bug). See scripts/provision-indexes.ts for the index.
        if (!isDuplicateKeyError(err)) throw err;
        await carts.updateOne(
          key,
          { $push: { lines: line }, $set: { updated_at: new Date() } },
        );
      }
      return { ok: true, line };
    },
  });
  const remove = createTool({
    id: 'cartRemove',
    description: 'Remove a product line from the cart by product_id.',
    inputSchema: z.object({ product_id: z.string() }),
    execute: async (inputData, context) => {
      args.onMutate?.();
      await carts.updateOne(
        key,
        { $pull: { lines: { product_id: inputData.product_id } }, $set: { updated_at: new Date() } },
      );
      return { ok: true };
    },
  });
  const applyCoupon = createTool({
    id: 'applyCoupon',
    description:
      'Apply a promotional/coupon code (e.g. "SAVE5") to the current cart. Validates the code ' +
      'against live promotions (must exist, be active, be within its date window, and cover items ' +
      'in the cart by category or product) and applies the percentage discount to eligible lines ' +
      'RIGHT NOW — the discount is reflected in the cart total and at checkout. Only ONE code applies ' +
      'per order (a new code replaces any prior one). If the code cannot be applied, returns ' +
      '{ ok: false, reason } and changes nothing — never claim a discount was applied in that case.',
    inputSchema: z.object({ code: z.string() }),
    execute: async (inputData, context) => {
      const code = String(inputData.code ?? '').trim();
      if (!code) return { ok: false, reason: 'No coupon code was provided.' };

      const cart = await carts.findOne(key);
      const lines = (cart?.lines ?? []) as CartLine[];
      if (!lines.length) return { ok: false, reason: 'Your cart is empty — add items before applying a coupon.' };

      // Validate the code exists and is active. Match case-insensitively so "save5" works.
      const promo = await promotions.findOne({
        code: { $regex: `^${escapeRegex(code)}$`, $options: 'i' } as any,
      });
      if (!promo || promo.active !== true) {
        return { ok: false, reason: `"${code}" is not a valid, active coupon code.` };
      }
      // Date window: the code must be currently in effect. starts_at/ends_at are BSON
      // Dates; getTime() is NaN-safe via Number.isFinite so a malformed/missing date is
      // simply not enforced (never a false "outside dates" rejection).
      const now = Date.now();
      const startsAt = promo.starts_at instanceof Date ? promo.starts_at.getTime() : NaN;
      const endsAt = promo.ends_at instanceof Date ? promo.ends_at.getTime() : NaN;
      if ((Number.isFinite(startsAt) && now < startsAt) || (Number.isFinite(endsAt) && now > endsAt)) {
        return { ok: false, reason: `Coupon "${promo.code}" is not active right now (outside its valid dates).` };
      }

      // Resolve each line's category in one batched lookup so we can check scope.
      const ids = lines.map(l => l.product_id);
      const prods = await products.find({ _id: { $in: ids as any } }).toArray();
      const categoryById = new Map(prods.map(p => [String(p._id), p.category]));
      const eligible = (l: CartLine): boolean =>
        (promo.product_ids?.length ? promo.product_ids.includes(l.product_id) : false) ||
        categoryById.get(l.product_id) === promo.applies_to_category;

      // Recompute all lines: clear any prior coupon (one code per order), then stamp the new
      // code + coupon savings onto eligible lines. Discount applies to the effective (sale)
      // price so it stacks on top of a sale. Deterministic math — never model arithmetic.
      let totalCoupon = 0;
      const next = lines.map(l => {
        if (!eligible(l)) return { ...l, applied_coupons: [], coupon_savings: 0 };
        const unit = l.sale_price_usd ?? l.unit_price_usd;
        const saving = Math.round(unit * l.qty * (promo.discount_pct / 100) * 100) / 100;
        totalCoupon += saving;
        return { ...l, applied_coupons: [promo.code], coupon_savings: saving };
      });
      if (totalCoupon <= 0) {
        return {
          ok: false,
          reason: `Coupon "${promo.code}" is valid but nothing in your cart qualifies (it applies to ${promo.applies_to_category}).`,
        };
      }

      args.onMutate?.();
      await carts.updateOne(key, { $set: { lines: next, updated_at: new Date() } });
      const totals = computeCartTotals(next);
      return {
        ok: true,
        applied_coupons: [promo.code],
        coupon_savings: totals.coupon_savings,
        total: totals.total,
        summary: `Applied ${promo.code} (${promo.discount_pct}% off ${promo.applies_to_category}): −$${totals.coupon_savings.toFixed(2)}. New total $${totals.total.toFixed(2)}.`,
      };
    },
  });
  return { cartRead: read, cartAdd: add, cartRemove: remove, applyCoupon };
}
