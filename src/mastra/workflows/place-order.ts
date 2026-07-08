import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Db } from 'mongodb';
import { computeCartTotals, cartFingerprint, type CartLine } from '../tools/cart';

/**
 * Human-in-the-loop order workflow (revives the parked "Spec 530" checkout).
 *
 *   build-quote  → read the cart, verify stock, compute totals
 *   approve-order → suspend for the shopper's approve / edit / reject decision
 *   place-order  → on approve, a single MongoDB transaction: insert one order,
 *                  decrement product stock per line, clear the cart
 *
 * Identity (`userId`/`threadId`) flows through the workflow INPUT from the turn
 * closure — never a model-supplied field (REQ-E-037). `now`/`orderId` are also
 * server-supplied so the steps stay deterministic (no argless `new Date()`).
 *
 * Transactions are REQUIRED (Atlas / replica-set); there is no non-transactional
 * fallback. See the design spec's INV / Premortem.
 */

const InputSchema = z.object({
  userId: z.string(),
  threadId: z.string(),
  now: z.string(),      // ISO-8601 timestamp, supplied by the caller; stored as a BSON Date in placeOrder
  orderId: z.string(),  // unique order id, supplied by the caller
});

const QuoteSchema = z.object({
  lines: z.array(z.any()),
  subtotal: z.number(),
  total_savings: z.number(),
  // Coupon $ off folded into total_usd (0 when no coupon). Carried so the confirmation and
  // the persisted order can report the discount explicitly.
  coupon_savings: z.number().optional(),
  total_usd: z.number(),
  // Fingerprint of the cart this quote was built from. Carried through suspend→resume so
  // placeOrder can detect (inside the transaction) whether the cart changed after approval.
  cart_version: z.string(),
});

const ResultSchema = z.object({
  status: z.enum(['placed', 'cancelled']),
  order_id: z.string().optional(),
  total_usd: z.number().optional(),
  message: z.string(),
});

const ResumeSchema = z.object({
  decision: z.enum(['approve', 'edit', 'reject']),
  edited_action: z.object({ name: z.string(), args: z.record(z.any()) }).optional(),
  // The cart_version the shopper saw on the approval card, echoed back from the interrupt.
  // When present on an approve, it must match the server quote's version or the approve is
  // downgraded to a safe cancel — binds the approval to the exact quote that was shown.
  cart_version: z.string().optional(),
});

const SuspendSchema = z.object({
  action: z.object({ name: z.string(), args: z.any(), description: z.string() }),
  allowed_decisions: z.array(z.string()),
});

const ApprovalSchema = z.object({ decision: z.string(), quote: QuoteSchema });

/**
 * Build the three steps bound to a `Db`. Exported for unit testing the step
 * logic directly with a stubbed db (the committed workflow uses these same
 * instances). `db.client` must expose the MongoClient for transactions.
 */
export function buildOrderSteps(db: Db) {
  const buildQuote = createStep({
    id: 'build-quote',
    inputSchema: InputSchema,
    outputSchema: QuoteSchema,
    execute: async ({ inputData }: any) => {
      const { userId, threadId } = inputData;
      const cart = await db.collection('carts').findOne({ userId, threadId });
      const lines = (cart?.lines ?? []) as CartLine[];
      if (!lines.length) throw new Error('Your cart is empty — nothing to check out.');

      // Single batched lookup instead of one findOne per line (checkout hot path).
      const ids = lines.map(l => l.product_id);
      const products = await db.collection('products').find({ _id: { $in: ids as any } }).toArray();
      const stockById = new Map(products.map(p => [String(p._id), p.stock as number]));
      const insufficient = lines
        .filter(l => { const s = stockById.get(l.product_id); return typeof s !== 'number' || s < l.qty; })
        .map(l => l.product_id);
      if (insufficient.length) throw new Error(`Insufficient stock for: ${insufficient.join(', ')}`);

      // total_usd is the amount actually charged: subtotal minus any coupon savings. total_savings
      // now includes both sale and coupon savings (computeCartTotals folds them together).
      const { subtotal, coupon_savings, total_savings, total } = computeCartTotals(lines);
      return { lines, subtotal, coupon_savings, total_savings, total_usd: total, cart_version: cartFingerprint(lines) };
    },
  });

  const approveOrder = createStep({
    id: 'approve-order',
    inputSchema: QuoteSchema,
    resumeSchema: ResumeSchema,
    suspendSchema: SuspendSchema,
    outputSchema: ApprovalSchema,
    execute: async ({ inputData, resumeData, suspend }: any) => {
      if (!resumeData) {
        const description = `Place order for ${inputData.lines.length} item(s), total $${inputData.total_usd.toFixed(2)}.`;
        return await suspend({
          action: { name: 'place_order', args: inputData, description },
          allowed_decisions: ['approve', 'edit', 'reject'],
        });
      }
      // Forward the shopper's decision with the SERVER-computed quote unchanged.
      // We deliberately do NOT merge `resumeData.edited_action.args` into the quote:
      // that payload is client-supplied (the frontend echoes back `action.args`), so
      // trusting it would let a resume set an arbitrary total or drive stock negative.
      // `edit` is handled downstream as a safe cancel (adjust cart + re-checkout);
      // only `approve` commits, against the quote this server built and validated.
      //
      // Binding (reviewer finding #3): if the resume echoes a cart_version, it must match
      // the quote the server is about to place. A mismatch means the shopper approved a card
      // built from a different cart state — downgrade to a safe cancel rather than place it.
      // (The transaction re-checks the LIVE cart too; this is the earlier, cheaper guard.)
      if (resumeData.decision === 'approve' && typeof resumeData.cart_version === 'string'
          && resumeData.cart_version !== inputData.cart_version) {
        return { decision: 'reject', quote: inputData };
      }
      return { decision: resumeData.decision, quote: inputData };
    },
  });

  const placeOrder = createStep({
    id: 'place-order',
    inputSchema: ApprovalSchema,
    outputSchema: ResultSchema,
    execute: async ({ inputData, getInitData }: any) => {
      const { decision, quote } = inputData;
      // Only `approve` commits. `reject` cancels; `edit` also cancels safely — the
      // shopper adjusts the cart and checks out again (a true in-place re-quote loop
      // is a future enhancement). This guarantees an order is only ever placed against
      // the server-built quote, never a client-supplied one.
      if (decision !== 'approve') {
        const message = decision === 'edit'
          ? 'Checkout cancelled — adjust your cart and check out again to change the order.'
          : 'Order cancelled — no charges made.';
        return { status: 'cancelled' as const, message };
      }

      const init = getInitData() as z.infer<typeof InputSchema>;
      const client = (db as any).client;
      if (!client?.withSession) throw new Error('Order placement requires a transactional MongoDB client.');

      await client.withSession(async (session: any) => {
        await session.withTransaction(async () => {
          // Cart-drift guard (reviewer finding #3): re-read the cart INSIDE the transaction
          // and abort if it no longer matches the approved quote. Without this, approving an
          // old interrupt card would place the stale quote AND delete whatever is in the cart
          // now — silently wiping items the shopper added after the card appeared. Keyed on
          // the deterministic cart fingerprint, so it holds across the suspend→resume boundary
          // and across processes/replicas. This is the authoritative check: it cannot be
          // bypassed by a client, unlike a token echoed through the resume request.
          const current = await db.collection('carts').findOne({ userId: init.userId, threadId: init.threadId }, { session });
          const currentVersion = cartFingerprint((current?.lines ?? []) as CartLine[]);
          if (currentVersion !== quote.cart_version) {
            throw new Error('Your cart changed after this order was prepared — review your cart and check out again.');
          }
          // Union of coupon codes applied across the cart (one per order, but stored as an
          // array to mirror the line shape and the reference order schema).
          const couponsUsed = [...new Set(quote.lines.flatMap((l: CartLine) => l.applied_coupons ?? []))];
          await db.collection('orders').insertOne({
            _id: init.orderId as any,
            userId: init.userId,
            status: 'placed',
            // Persist the effective (sale-when-present) unit price actually charged, plus the
            // sale price + savings AND any coupon applied, so line items reconcile with total_usd.
            items: quote.lines.map((l: CartLine) => ({
              product_id: l.product_id,
              qty: l.qty,
              unit_price_usd: l.sale_price_usd ?? l.unit_price_usd,
              list_price_usd: l.unit_price_usd,
              sale_price_usd: l.sale_price_usd,
              line_savings: l.line_savings,
              applied_coupons: l.applied_coupons ?? [],
              coupon_savings: l.coupon_savings ?? 0,
            })),
            coupons_used: couponsUsed,
            savings_usd: quote.total_savings,
            total_usd: quote.total_usd,
            // Persist as a BSON Date. `init.now` is the ISO string carried through the
            // JSON-serialized workflow snapshot (it must stay a string in transit across
            // suspend→resume); convert to a Date only here, at the storage boundary.
            placed_at: new Date(init.now),
          }, { session });
          // Conditional decrement re-checks stock INSIDE the transaction (TOCTOU): if
          // inventory dropped below qty since the quote, modifiedCount is 0 and we abort
          // the whole transaction — no oversell, no negative stock, no partial order.
          for (const l of quote.lines as CartLine[]) {
            const res = await db.collection('products').updateOne(
              { _id: l.product_id as any, stock: { $gte: l.qty } },
              { $inc: { stock: -l.qty } },
              { session },
            );
            if (res.modifiedCount !== 1) {
              throw new Error(`Insufficient stock for ${l.product_id} at checkout — order cancelled.`);
            }
          }
          await db.collection('carts').deleteOne({ userId: init.userId, threadId: init.threadId }, { session });
        });
      });

      return { status: 'placed' as const, order_id: init.orderId, total_usd: quote.total_usd, message: `Order ${init.orderId} placed.` };
    },
  });

  return { inputSchema: InputSchema, buildQuote, approveOrder, placeOrder };
}

/** Build the committed place-order workflow bound to a `Db`. */
export function buildPlaceOrderWorkflow(db: Db) {
  const { buildQuote, approveOrder, placeOrder } = buildOrderSteps(db);
  return createWorkflow({
    id: 'place-order',
    inputSchema: InputSchema,
    outputSchema: ResultSchema,
  })
    .then(buildQuote)
    .then(approveOrder)
    .then(placeOrder)
    .commit();
}
