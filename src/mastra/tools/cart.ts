import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db } from 'mongodb';

export interface CartLine {
  product_id: string; name: string; qty: number;
  unit_price_usd: number; sale_price_usd: number | null;
  applied_coupons: string[]; line_savings: number;
}

export const MUTATING_TOOLS = new Set<string>(['cartAdd', 'cartRemove']);

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
async function resolveLine(products: ReturnType<Db['collection']>, input: any): Promise<CartLine | null> {
  const qty = Number.isFinite(input?.qty) && input.qty > 0 ? Math.floor(input.qty) : 1;
  let doc: any = null;
  if (typeof input?.product_id === 'string' && input.product_id) {
    doc = await products.findOne({ _id: input.product_id as any });
  }
  if (!doc && typeof input?.name === 'string' && input.name.trim()) {
    doc = await products.findOne({ name: { $regex: `^${escapeRegex(input.name.trim())}$`, $options: 'i' } });
  }
  if (!doc) return null;

  const unit_price_usd = doc.price_usd as number;
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

export function buildCartTools(args: { db: Db; userId: string; threadId: string; onMutate?: () => void }) {
  const carts = args.db.collection('carts');
  const products = args.db.collection('products');
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
        { $pull: { lines: { product_id: inputData.product_id } } as any, $set: { updated_at: new Date().toISOString() } },
      );
      return { ok: true };
    },
  });
  return { cartRead: read, cartAdd: add, cartRemove: remove };
}
