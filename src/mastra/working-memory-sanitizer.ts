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
    '\\b(sub\\s?total|final total|cart total|order total|grand total)\\b',
    '\\bsavings?\\b',
    '\\bcart\\b', // "current cart", "cart now contains", "in your cart"
    '\\badded\\b.*\\b(to cart|item|product|items|products)\\b',
    '\\b(to|from)\\s+(the\\s+)?cart\\b',
    '\\bcheckout\\b',
    '\\bplaced (an|the|your)? ?order\\b',
    '\\bcoupon\\b',
    '\\b(in|out of)\\s+stock\\b',
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
 * Sanitize a full working-memory Markdown document. Operates line by line: on a labelled
 * profile line (`- Label: value`) it scrubs the value and keeps the label (even if the value
 * becomes empty, so the template shape is preserved); other lines (headings, blanks) pass
 * through untouched. Idempotent.
 */
export function sanitizeWorkingMemory(content: string | undefined | null): string {
  if (!content) return '';
  const lines = content.split('\n');
  const out = lines.map(line => {
    // Match a labelled field line: optional list marker, a label, a colon, then the value.
    const m = line.match(/^(\s*(?:[-*]\s*)?[^:\n]+:)\s*(.*)$/);
    if (!m) return line; // heading, blank, or free text — leave as-is
    const [, label, value] = m;
    const cleaned = sanitizeFieldValue(value);
    return cleaned ? `${label} ${cleaned}` : label;
  });
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
