import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db, Collection } from 'mongodb';
import { logger } from '../../observability/logger';

export interface CartLine {
  product_id: string; name: string; qty: number;
  unit_price_usd: number; sale_price_usd: number | null;
  applied_coupons: string[]; line_savings: number;
}

/** The `carts` document shape, keyed on {userId, threadId}. Typing the collection with
 *  this lets the MongoDB driver accept `$push: { lines }` / `$pull` without casts. */
export interface CartDoc {
  userId: string;
  threadId: string;
  lines: CartLine[];
  updated_at: string | null;
}

/** The `products` fields the cart resolver reads (a partial view of the full catalog doc). */
interface ProductDoc {
  _id: string;
  name: string;
  price_usd: number;
  sale_price_usd: number | null;
  on_sale: boolean;
}

export const MUTATING_TOOLS = new Set<string>(['cartAdd', 'cartRemove']);

/**
 * A deterministic fingerprint of a cart's contents (product_id + qty per line, order-
 * independent). Used to bind a checkout quote to the exact cart it was built from: if the
 * shopper changes the cart after the approval card appears, the fingerprint no longer
 * matches and the order workflow refuses to place a stale quote / wipe the new cart
 * (reviewer finding #3). Deterministic (no time/random) so it is stable across the
 * suspend→resume boundary and across processes/replicas.
 */
export function cartFingerprint(lines: CartLine[]): string {
  return lines.map(l => `${l.product_id}:${l.qty}`).sort().join('|');
}

/** Subtotal uses the effective (sale when present) unit price × qty; savings summed from lines. */
export function computeCartTotals(lines: CartLine[]): { subtotal: number; total_savings: number } {
  let subtotal = 0;
  let total_savings = 0;
  for (const l of lines) {
    const unit = l.sale_price_usd ?? l.unit_price_usd;
    subtotal += unit * l.qty;
    total_savings += l.line_savings ?? 0;
  }
  return { subtotal, total_savings };
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
}) {
  const carts = args.db.collection<CartDoc>('carts');
  const products = args.db.collection<ProductDoc>('products');
  const key = { userId: args.userId, threadId: args.threadId };
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
      args.onMutate?.();
      await carts.updateOne(
        key,
        { $push: { lines: line }, $set: { updated_at: new Date().toISOString() } },
        { upsert: true },
      );
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
        { $pull: { lines: { product_id: inputData.product_id } }, $set: { updated_at: new Date().toISOString() } },
      );
      return { ok: true };
    },
  });
  return { cartRead: read, cartAdd: add, cartRemove: remove };
}
