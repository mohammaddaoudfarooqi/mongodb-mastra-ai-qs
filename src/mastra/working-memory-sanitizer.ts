/**
 * Working-memory sanitizer.
 *
 * Working memory is a resource-scoped shopper profile injected into the system prompt on
 * EVERY turn (see agent.ts). It is meant to hold ONLY durable shopper facts (preferences,
 * household size, favored categories). But Mastra's built-in working-memory system prompt
 * actively pushes the model to "store any conversation-relevant information" and to call
 * updateWorkingMemory "in every response where you received relevant information" — so the
 * model persists VOLATILE commerce state into the durable profile: cart totals, item counts,
 * "added N items to cart", and even invented store-availability claims.
 *
 * That leaked state then reads back on later turns as if it were current — the concierge
 * recited a "25 items / $1,879.75 / $470 savings" cart on a turn BEFORE anything was added,
 * because a prior run's totals were sitting in the profile Notes. Prompt guidance alone can't
 * stop this (the framework's own prompt overrides ours), so we sanitize at the single write
 * boundary: strip volatile/transactional sentences, keep durable ones. Cart and stock state
 * has exactly one source of truth — the cartRead / dataQuery tools — never memory.
 */

/**
 * A sentence is VOLATILE (must never persist to the durable profile) when it mentions
 * transient commerce state: money amounts, cart/subtotal/savings/order totals, add/remove
 * mutations, or (in)stock / catalog-availability claims. These change per turn and have
 * authoritative tool sources, so persisting them produces stale, fabricated readbacks.
 */
const VOLATILE_SENTENCE_RE = new RegExp(
  [
    '\\$\\s?\\d', // any dollar amount, e.g. $1,879.75
    '\\b\\d+\\.\\d{2}\\b', // a bare-number price, e.g. "costs 29.99" (no dollar sign)
    '\\b(sub\\s?total|final total|cart total|order total|grand total)\\b',
    '\\bsavings?\\b',
    '\\bcart\\b', // "current cart", "cart now contains", "in your cart"
    '\\badded\\b.*\\b(to cart|item|product|items|products)\\b',
    '\\b(to|from)\\s+(the\\s+)?cart\\b',
    '\\bcheckout\\b',
    '\\bcoupon\\b',
    // Order lifecycle / status — tool-sourced (orders.status enum) and changes over time.
    '\\border(s|ed)?\\b', // "your order", "placed an order", "order ORD-1002"
    '\\b(shipped|delivered|placed|cancell?ed)\\b',
    '\\bstatus\\b',
    '\\bship(ping|ped|s)?\\b', // shipping cost/time and shipment state
    // Loyalty program — points/tier are tool-sourced and change with spend.
    '\\b(loyalty|points?|tier|gold|silver|platinum|bronze)\\b',
    // Stock / availability — transient, tool-sourced.
    '\\b(in|out of)\\s+stock\\b',
    '\\b\\d+\\s+(left|remaining|available|in\\s+stock)\\b',
    '\\bonly\\s+\\d+\\b', // "only 3 left of the pan"
    "\\b(does\\s?n'?t|do\\s?n'?t|don't|doesn't)\\s+(carry|stock|sell|have)\\b",
    '\\bonly\\s+(carries|carry|stocks?|sells?)\\b',
    '\\binventory\\s+(is\\s+)?limited\\b',
    "\\b(we\\s+)?carr(y|ies)\\b",
  ].join('|'),
  'i',
);

/**
 * Split a field's value into sentences, keeping their trailing punctuation. Splits on a
 * sentence-ending `.!?` FOLLOWED BY whitespace — so a decimal point inside a number
 * ("$1,879.75") is not a boundary (no space after the dot), which kept a stray "75." from
 * surviving as a non-volatile fragment.
 */
function splitSentences(value: string): string[] {
  return value.split(/(?<=[.!?])\s+/).filter(s => s.trim());
}

/**
 * Remove volatile sentences from a single profile field value, preserving the durable ones
 * verbatim. Kept sentences are rejoined with a single space.
 */
function sanitizeFieldValue(value: string): string {
  if (!value.trim()) return '';
  const kept = splitSentences(value).filter(s => !VOLATILE_SENTENCE_RE.test(s));
  return kept.join(' ').trim();
}

/**
 * Sanitize a full working-memory Markdown document. Operates line by line:
 *  - Headings (`#…`) and blank lines pass through untouched.
 *  - A labelled field line (`- Label: value`) keeps its label (so the template shape survives)
 *    and has its value scrubbed — even to empty.
 *  - A bare bullet / free-text line (`- Added 25 items to cart`, with NO colon) has its content
 *    scrubbed; if nothing durable remains the whole line is DROPPED (no orphaned marker).
 *    This is the case the model uses when it appends volatile sub-bullets under `- Notes:` —
 *    missing it let the exact "$1,879.75 recited before any add" state re-persist. Idempotent.
 */
export function sanitizeWorkingMemory(content: string | undefined | null): string {
  if (!content) return '';
  const out: string[] = [];
  for (const line of content.split('\n')) {
    // Headings and blank/whitespace-only lines are structural — never touch them.
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) {
      out.push(line);
      continue;
    }
    // Labelled field line: optional list marker, a label, a colon, then the value.
    const labelled = line.match(/^(\s*(?:[-*]\s*)?)([^:\n]+):\s*(.*)$/);
    if (labelled) {
      const [, marker, labelText, value] = labelled;
      // A model-invented volatile LABEL ("Subtotal:", "Total Savings:", "Order status:") is
      // dropped whole — only the durable template labels (Preferences, Notes, Family size, …)
      // are non-volatile, so they survive with a scrubbed (possibly empty) value.
      if (VOLATILE_SENTENCE_RE.test(labelText)) continue;
      const cleaned = sanitizeFieldValue(value);
      const label = `${marker}${labelText}:`;
      out.push(cleaned ? `${label} ${cleaned}` : label);
      continue;
    }
    // Bare bullet or free text (no colon): scrub the content after any leading list marker.
    const bullet = line.match(/^(\s*[-*]\s+)(.*)$/);
    if (bullet) {
      const [, marker, text] = bullet;
      const cleaned = sanitizeFieldValue(text);
      if (cleaned) out.push(`${marker}${cleaned}`); // drop the whole bullet if fully volatile
      continue;
    }
    // Other free text: keep only if not volatile.
    const cleaned = sanitizeFieldValue(line);
    if (cleaned) out.push(cleaned);
  }
  return out.join('\n');
}

/**
 * Wrap a Mastra Memory instance so every updateWorkingMemory write is sanitized before it
 * reaches storage. This is the authoritative enforcement point — the model cannot persist
 * volatile cart/order/availability state no matter what the framework's prompt tells it.
 */
export function installWorkingMemorySanitizer(memory: {
  updateWorkingMemory: (args: any) => Promise<any>;
}): void {
  const original = memory.updateWorkingMemory.bind(memory);
  memory.updateWorkingMemory = (args: any) => {
    if (args && typeof args.workingMemory === 'string') {
      return original({ ...args, workingMemory: sanitizeWorkingMemory(args.workingMemory) });
    }
    return original(args);
  };
}
