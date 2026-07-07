import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * The concierge's trigger for the human-in-the-loop order workflow. It carries NO
 * identity in its input schema (REQ-E-037): the tool only signals that the shopper
 * wants to check out. The /chat route bridge observes the `onCheckout` signal after
 * the agent turn and starts the `place-order` run bound to the turn's real
 * {userId, threadId} closure, then emits the interrupt SSE frame.
 *
 * Returning a "pending approval" status keeps the model from fabricating an order
 * confirmation — the real confirmation only comes after the resume step commits.
 */
export function buildCheckoutTool(args: { onCheckout: () => void }) {
  return createTool({
    id: 'checkout',
    description:
      'Begin checkout for the current cart. Call this when the shopper wants to buy / place an order / ' +
      'check out. It starts an approval flow; do NOT claim the order is placed — the shopper must approve first.',
    inputSchema: z.object({}),
    execute: async (_inputData, _context) => {
      args.onCheckout();
      return { status: 'pending_approval' as const };
    },
  });
}
