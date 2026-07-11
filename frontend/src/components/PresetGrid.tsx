import React, { useState } from 'react';
import { useChat } from '../context/ChatContext';
import { useAuth } from '../context/AuthContext';

export interface Preset {
  icon: string;
  text: string;
  /**
   * Shown on the CURATED (public AI4 domain) grid. These are the stateless, cache-safe prompts
   * that work as one-click first-turns and can't misbehave on a shared-identity box at scale.
   * Presets without `curated` appear only on the full stage-box grid.
   */
  curated?: boolean;
  /**
   * Launch this preset in a fresh conversation (default true). Stateless info prompts start
   * fresh so the server can serve them from the response cache (Spec 520). STATEFUL prompts —
   * cart, checkout, memory recall — set this false so they build on the CURRENT thread instead
   * of wiping the cart/messages the earlier beats created (the checkout-clears-everything bug).
   */
  newThread?: boolean;
}

// Ordered as a retail-recipe shopping story: discover the sale → pick a recipe → check
// prices/stock → build the cart → optimize savings → learn the loyalty perks → check out.
// Every prompt maps to a capability the deployed app actually has (multimodal retrieval,
// hybrid+rerank knowledge over the recipe/loyalty/coupon/shipping docs, the NL→MQL data
// agent over products/orders/promotions, cross-thread working memory, the cart tools, and
// the HITL checkout workflow) — so a live demo never hits an unsupported feature.
//
// `curated: true` marks the subset shown on the public AI4 domain (CURATED_PRESETS=true): only
// stateless, cache-safe prompts that survive one-click launch on a shared-identity box. The
// stateful cart/checkout/memory beats stay on the presenter's stage box, where identity is
// single-user and the presenter drives the sequence turn-by-turn on one thread.
export const PRESETS: Preset[] = [
  // Beat 1: Multimodal retrieval (HERO) — DEALS. Hits the ingested pamphlet/image assets.
  {
    icon: '🏷️',
    text: 'Show me this week\'s sale pamphlet and tell me what\'s discounted.',
    curated: true,
  },
  // Beat 2: Hybrid + rerank — RECIPES. Knowledge base retrieval fused and reranked.
  {
    icon: '🍝',
    text: 'I want to make pasta for dinner tonight. Share a quick recipe and its ingredients.',
    curated: true,
  },
  // Beat 3: NL→MQL data agent — live prices + stock for the recipe ingredients.
  {
    icon: '🍗',
    text: 'Find a quick weeknight chicken recipe, then check which ingredients are in stock and their prices.',
    curated: true,
  },
  // Beat 4a: Memory. Store a durable preference (cross-thread working memory). STAGE ONLY —
  // working memory is resource-scoped, so on the shared-identity public box every attendee
  // would write into the same shopper profile (collision + prank surface).
  {
    icon: '🧠',
    text: 'Remember that I prefer eco-friendly kitchen products and cook for a family of four.',
  },
  // Beat 4b: Memory. Recall it and personalize. STAGE ONLY (and stateful: continues the thread
  // so it recalls what Beat 4a just stored instead of starting cold).
  {
    icon: '💡',
    text: 'Based on what you know about me, what kitchen items would you recommend?',
    newThread: false,
  },
  // Beat 5: Cart tools — SHOPPING LIST. Looks a product up, then builds the cart. STAGE ONLY;
  // stateful so the cart it builds persists into the checkout beat.
  {
    icon: '🛒',
    text: 'Add the on-sale kitchen product with the biggest savings to my cart and show my total savings.',
    newThread: false,
  },
  // Beat 6: Bulk cart-add (intent-gated multi-add) + honest cart totals from cartRead. STAGE ONLY.
  {
    icon: '🧺',
    text: 'Add one of every discounted item to my cart, then tell me the real cart total.',
    newThread: false,
  },
  // Beat 7: Hybrid + rerank — COUPONS. Surfaces the coupon-terms knowledge doc.
  {
    icon: '💸',
    text: 'What are the coupon-stacking rules, and which discounts can I combine?',
    curated: true,
  },
  // Beat 8: Hybrid + rerank — LOYALTY. Surfaces the loyalty-program knowledge doc.
  {
    icon: '⭐',
    text: 'What are the Gold tier loyalty benefits, and how do points convert to dollars?',
    curated: true,
  },
  // Beat 9: Semantic cache. A common question that demonstrates the instant cache hit.
  {
    icon: '⚡',
    text: 'How long does shipping take?',
    curated: true,
  },
  // Beat 10: HITL checkout. Starts the approval workflow (pauses for explicit approval). STAGE
  // ONLY and STATEFUL: it must run on the current thread so it checks out the cart the earlier
  // beats built — launching it fresh (newThread) wipes the cart and fails "cart may be empty".
  {
    icon: '✅',
    text: 'Check out and place my order.',
    newThread: false,
  },
];

const sectionStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 1120,
  margin: '0 auto',
  padding: '56px 24px 24px',
};

const headingStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '2px',
  color: 'var(--spring-green)',
  marginBottom: 6,
};

const subheadStyle: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: '1.6rem',
  fontWeight: 500,
  color: 'var(--text)',
  marginBottom: 24,
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))',
  gap: 20,
};

const baseCardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '20px 20px 16px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--text)',
  transition: 'transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease',
};

const iconStyle: React.CSSProperties = {
  fontSize: 26,
  lineHeight: 1,
};

const cardTextStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.55,
  color: 'var(--text)',
  flex: 1,
};

const askStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '1px',
  color: 'var(--spring-green)',
};

function PresetCard({ preset, onAsk }: { preset: Preset; onAsk: () => void }) {
  const [hover, setHover] = useState(false);
  const style: React.CSSProperties = hover
    ? {
        ...baseCardStyle,
        transform: 'translateY(-2px)',
        borderColor: 'var(--green-border)',
        boxShadow: '0 0 0 1px rgba(0,237,100,0.15), 0 12px 30px rgba(0,0,0,0.35)',
      }
    : baseCardStyle;
  return (
    <button
      type="button"
      style={style}
      onClick={onAsk}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <span style={iconStyle} aria-hidden="true">
        {preset.icon}
      </span>
      <span style={cardTextStyle}>{preset.text}</span>
      <span style={askStyle}>Ask →</span>
    </button>
  );
}

export default function PresetGrid() {
  const { sendMessage, setOpen } = useChat();
  // Public AI4 domain (CURATED_PRESETS=true) shows only the stateless, cache-safe subset; the
  // stage box shows every beat. Resolved at runtime from /api/auth/me so the SAME built image
  // serves both — no separate build.
  const { curatedPresets } = useAuth();
  const presets = curatedPresets ? PRESETS.filter(p => p.curated) : PRESETS;

  const ask = (preset: Preset) => {
    setOpen(true);
    // Stateless info prompts launch in a fresh conversation so the server can serve them from
    // the response cache (Spec 520). Stateful prompts (cart/checkout/memory recall) default to
    // false so they continue the CURRENT thread — checkout must see the cart the earlier beats
    // built, not a wiped one.
    const newThread = preset.newThread !== false;
    sendMessage(preset.text, { newThread });
  };

  return (
    <section style={sectionStyle} id="presets">
      <div style={headingStyle}>Try a demo prompt</div>
      <div style={subheadStyle}>What can your assistant do?</div>
      <div style={gridStyle}>
        {presets.map((p, i) => (
          <PresetCard key={`${i}-${p.icon}`} preset={p} onAsk={() => ask(p)} />
        ))}
      </div>
    </section>
  );
}
