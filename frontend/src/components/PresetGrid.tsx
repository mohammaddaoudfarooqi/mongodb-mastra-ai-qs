import React, { useState } from 'react';
import { useChat } from '../context/ChatContext';

export interface Preset {
  icon: string;
  text: string;
}

// Ordered as a retail-recipe shopping story: discover the sale → pick a recipe → check
// prices/stock → build the cart → optimize savings → learn the loyalty perks → check out.
// Every prompt maps to a capability the deployed app actually has (multimodal retrieval,
// hybrid+rerank knowledge over the recipe/loyalty/coupon/shipping docs, the NL→MQL data
// agent over products/orders/promotions, cross-thread working memory, the cart tools, and
// the HITL checkout workflow) — so a live demo never hits an unsupported feature.
export const PRESETS: Preset[] = [
  // Beat 1: Multimodal retrieval (HERO) — DEALS. Hits the ingested pamphlet/image assets.
  {
    icon: '🏷️',
    text: 'Show me this week\'s sale pamphlet and tell me what\'s discounted.',
  },
  // Beat 2: Hybrid + rerank — RECIPES. Knowledge base retrieval fused and reranked.
  {
    icon: '🍝',
    text: 'I want to make pasta for dinner tonight. Share a quick recipe and its ingredients.',
  },
  // Beat 3: NL→MQL data agent — live prices + stock for the recipe ingredients.
  {
    icon: '🍗',
    text: 'Find a quick weeknight chicken recipe, then check which ingredients are in stock and their prices.',
  },
  // Beat 4a: Memory. Store a durable preference (cross-thread working memory).
  {
    icon: '🧠',
    text: 'Remember that I prefer eco-friendly kitchen products and cook for a family of four.',
  },
  // Beat 4b: Memory. Recall it and personalize in a later turn.
  {
    icon: '💡',
    text: 'Based on what you know about me, what kitchen items would you recommend?',
  },
  // Beat 5: Cart tools — SHOPPING LIST. Looks a product up, then builds the cart.
  {
    icon: '🛒',
    text: 'Add the on-sale kitchen product with the biggest savings to my cart and show my total savings.',
  },
  // Beat 6: Bulk cart-add (intent-gated multi-add) + honest cart totals from cartRead.
  {
    icon: '🧺',
    text: 'Add one of every discounted item to my cart, then tell me the real cart total.',
  },
  // Beat 7: Hybrid + rerank — COUPONS. Surfaces the coupon-terms knowledge doc.
  {
    icon: '💸',
    text: 'What are the coupon-stacking rules, and which discounts can I combine?',
  },
  // Beat 8: Hybrid + rerank — LOYALTY. Surfaces the loyalty-program knowledge doc.
  {
    icon: '⭐',
    text: 'What are the Gold tier loyalty benefits, and how do points convert to dollars?',
  },
  // Beat 9: Semantic cache. A common question that demonstrates the instant cache hit.
  {
    icon: '⚡',
    text: 'How long does shipping take?',
  },
  // Beat 10: HITL checkout. Starts the approval workflow (pauses for explicit approval).
  {
    icon: '✅',
    text: 'Check out and place my order.',
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

  const ask = (text: string) => {
    setOpen(true);
    // Launch each preset in a NEW conversation so it's a first-turn query the
    // server can serve from / store in the response cache (Spec 520).
    sendMessage(text, { newThread: true });
  };

  return (
    <section style={sectionStyle} id="presets">
      <div style={headingStyle}>Try a demo prompt</div>
      <div style={subheadStyle}>What can your assistant do?</div>
      <div style={gridStyle}>
        {PRESETS.map((p, i) => (
          <PresetCard key={`${i}-${p.icon}`} preset={p} onAsk={() => ask(p.text)} />
        ))}
      </div>
    </section>
  );
}
