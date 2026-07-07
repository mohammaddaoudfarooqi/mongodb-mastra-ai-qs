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
export function buildCartTools(args: { db: Db; userId: string; threadId: string; onMutate?: () => void }) {
  const carts = args.db.collection('carts');
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
      'Add a line to the cart. Look the product up with dataQuery first, then pass a line with ' +
      'product_id, name, qty, unit_price_usd, sale_price_usd (null if not on sale), ' +
      'applied_coupons: [], and line_savings ((unit_price_usd - sale_price_usd) * qty, else 0).',
    inputSchema: z.object({ line: z.any() }),
    execute: async (inputData, context) => {
      args.onMutate?.();
      await carts.updateOne(
        key,
        { $push: { lines: inputData.line }, $set: { updated_at: new Date().toISOString() } },
        { upsert: true },
      );
      return { ok: true };
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
