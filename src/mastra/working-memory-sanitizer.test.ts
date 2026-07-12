import { describe, it, expect, vi } from 'vitest';
import { sanitizeWorkingMemory, installWorkingMemorySanitizer } from './working-memory-sanitizer';

// These strings are taken VERBATIM from live mastra_resources docs on the cluster — the
// actual pollution that made the "recommend" turn recite a 25-item / $1,879.75 cart before
// anything had been added. The sanitizer must strip volatile commerce state (cart totals,
// item counts, "added to cart", availability claims) while preserving durable shopper facts.

describe('sanitizeWorkingMemory', () => {
  it('strips a leaked cart total sentence but keeps durable preferences in the same Notes line', () => {
    const polluted =
      '- Notes: Cooks for a family of four. Current cart: All 25 on-sale kitchen products (5 chef\'s knives, 5 cast iron skillets, 5 insulated water bottles, 5 ceramic mugs, 5 cutting boards). Subtotal: $1,879.75, Total Savings: $470.00, Final Total: $1,409.75. Also interested in quick weeknight chicken recipes.';
    const out = sanitizeWorkingMemory(polluted);
    expect(out).toContain('Cooks for a family of four.');
    expect(out).toContain('quick weeknight chicken recipes');
    expect(out).not.toMatch(/\$1,879\.75|\$470\.00|\$1,409\.75/);
    expect(out).not.toMatch(/current cart/i);
    expect(out).not.toMatch(/25 on-sale/i);
  });

  it('strips any dollar amount / subtotal / savings phrasing', () => {
    const out = sanitizeWorkingMemory('- Notes: Cart total: $2,130.92 with $532.80 in savings.');
    expect(out).not.toMatch(/\$/);
    expect(out).not.toMatch(/savings/i);
    expect(out).not.toMatch(/cart total/i);
  });

  it('strips "added ... to cart" and "cart now contains" mutation state', () => {
    const out = sanitizeWorkingMemory(
      '- Notes: Added all 25 on-sale items to cart. Cart now contains complete collection of Chef\'s Knives and Cast Iron Skillets.'
    );
    expect(out).not.toMatch(/added all/i);
    expect(out).not.toMatch(/cart now contains/i);
    expect(out).not.toMatch(/to cart/i);
  });

  it('strips false store-availability claims the model invented', () => {
    const polluted =
      "- Notes: Learned that store doesn't carry grocery ingredients (produce, dairy) - only carries kitchen tools. Also doesn't carry mixing bowls. Kitchen inventory limited to chef's knives, cast iron skillets, and insulated water bottles.";
    const out = sanitizeWorkingMemory(polluted);
    expect(out).not.toMatch(/doesn'?t carry/i);
    expect(out).not.toMatch(/only carries/i);
    expect(out).not.toMatch(/inventory limited/i);
  });

  it('strips in-stock / out-of-stock transient status', () => {
    const out = sanitizeWorkingMemory(
      '- Notes: Prefers eco items. The Eco Chef Knife is currently in stock and the Deluxe is out of stock.'
    );
    expect(out).toContain('Prefers eco items.');
    expect(out).not.toMatch(/in stock/i);
    expect(out).not.toMatch(/out of stock/i);
  });

  it('preserves durable preferences and the template structure untouched', () => {
    const clean = `# Shopper Profile
- Preferences: Eco-friendly kitchen products
- Interests / categories: Kitchen, sustainable/reusable items, camping, yoga
- Notes: Cooks for a family of four. Prefers sustainable options.`;
    expect(sanitizeWorkingMemory(clean)).toBe(clean);
  });

  it('leaves the field label when every sentence in its value was volatile', () => {
    const out = sanitizeWorkingMemory(
      '# Shopper Profile\n- Preferences: Eco-friendly kitchen products\n- Notes: Added all 25 items to cart. Subtotal: $1,879.75.'
    );
    expect(out).toContain('- Preferences: Eco-friendly kitchen products');
    // the Notes value is fully scrubbed but the labelled line remains (empty value)
    expect(out).toMatch(/- Notes:\s*$/m);
    expect(out).not.toMatch(/\$1,879\.75/);
  });

  it('is idempotent (running twice yields the same result)', () => {
    const polluted =
      '- Notes: Family of four. Cart total: $2,130.92 with $532.80 in savings. Likes eco products.';
    const once = sanitizeWorkingMemory(polluted);
    expect(sanitizeWorkingMemory(once)).toBe(once);
  });

  it('handles empty / undefined input without throwing', () => {
    expect(sanitizeWorkingMemory('')).toBe('');
    expect(sanitizeWorkingMemory(undefined as any)).toBe('');
  });

  // --- Regression: volatile state written as a NON-colon bullet under Notes (review finding #1).
  // Mastra's built-in prompt pushes the model to append free-form sub-bullets under "- Notes:".
  // A bullet without a colon must still be scrubbed, or the exact "$1,879.75 recited before any
  // add" bug re-persists via the bullet form.
  it('scrubs volatile content on non-colon bullet lines (not just label: value lines)', () => {
    const polluted = `# Shopper Profile
- Preferences: Eco-friendly kitchen products
- Notes:
  - Added 25 items to cart totaling $1,879.75
  - Cooks for a family of four
  - Order ORD-1002 has shipped`;
    const out = sanitizeWorkingMemory(polluted);
    expect(out).toContain('- Preferences: Eco-friendly kitchen products');
    expect(out).toContain('Cooks for a family of four'); // durable bullet survives
    expect(out).not.toMatch(/\$1,879\.75/);
    expect(out).not.toMatch(/added 25 items/i);
    expect(out).not.toMatch(/ORD-1002|has shipped/i);
    // the durable bullet keeps its list marker
    expect(out).toMatch(/^\s*-\s+Cooks for a family of four/m);
  });

  it('drops a fully-volatile bullet line entirely rather than leaving a bare marker with junk', () => {
    const out = sanitizeWorkingMemory('- Notes:\n  - Subtotal: $1,879.75, Total Savings: $470.00');
    expect(out).not.toMatch(/\$1,879\.75|\$470\.00|subtotal|savings/i);
    // no orphaned "- 75." style fragment
    expect(out).not.toMatch(/^\s*-\s*\d/m);
  });

  it('preserves the heading and blank lines untouched', () => {
    const doc = '# Shopper Profile\n\n- Preferences: Eco items';
    expect(sanitizeWorkingMemory(doc)).toBe(doc);
  });

  // --- Broadened coverage (review finding #2): loyalty, order status, shipping, bare prices, stock.
  it('strips loyalty points / tier state', () => {
    const out = sanitizeWorkingMemory('- Notes: Prefers eco items. Gold tier member with 1,200 loyalty points.');
    expect(out).toContain('Prefers eco items.');
    expect(out).not.toMatch(/gold tier|loyalty points|1,200/i);
  });

  it('strips order status state', () => {
    const out = sanitizeWorkingMemory('- Notes: Cooks for four. Your order ORD-1002 has shipped. Order status: delivered.');
    expect(out).toContain('Cooks for four.');
    expect(out).not.toMatch(/has shipped|order status|delivered|ORD-1002/i);
  });

  it('strips shipping-cost/time state', () => {
    const out = sanitizeWorkingMemory('- Notes: Likes eco. Shipping is free and takes 3-5 business days.');
    expect(out).toContain('Likes eco.');
    expect(out).not.toMatch(/shipping/i);
  });

  it('strips a bare-number price (no dollar sign)', () => {
    const out = sanitizeWorkingMemory('- Notes: Family of four. The fry pan costs 29.99.');
    expect(out).toContain('Family of four.');
    expect(out).not.toMatch(/29\.99/);
  });

  it('strips "N left / remaining / available" transient stock counts', () => {
    const out = sanitizeWorkingMemory('- Notes: Eco shopper. We have only 3 left of the pan.');
    expect(out).toContain('Eco shopper.');
    expect(out).not.toMatch(/3 left|only 3/i);
  });
});

describe('installWorkingMemorySanitizer', () => {
  it('wraps memory.updateWorkingMemory so persisted content is sanitized at the write boundary', async () => {
    const orig = vi.fn().mockResolvedValue(undefined);
    const memory: any = { updateWorkingMemory: orig };
    installWorkingMemorySanitizer(memory);

    await memory.updateWorkingMemory({
      resourceId: 'demo',
      workingMemory: '- Notes: Likes eco products. Subtotal: $1,879.75, Total Savings: $470.00.',
    });

    expect(orig).toHaveBeenCalledTimes(1);
    const passed = orig.mock.calls[0][0];
    expect(passed.resourceId).toBe('demo');
    expect(passed.workingMemory).toContain('Likes eco products.');
    expect(passed.workingMemory).not.toMatch(/\$1,879\.75|Subtotal|Total Savings/i);
  });

  it('passes through calls with no workingMemory string unchanged', async () => {
    const orig = vi.fn().mockResolvedValue(undefined);
    const memory: any = { updateWorkingMemory: orig };
    installWorkingMemorySanitizer(memory);
    await memory.updateWorkingMemory({ resourceId: 'demo', workingMemory: undefined });
    expect(orig).toHaveBeenCalledWith({ resourceId: 'demo', workingMemory: undefined });
  });
});
