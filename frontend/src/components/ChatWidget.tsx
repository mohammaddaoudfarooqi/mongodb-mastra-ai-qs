import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useChat } from '../context/ChatContext';
import ChatMessage from './ChatMessage';
import { MongoLeaf, MastraMark } from './brand';
import type { CartResponse, InterruptEvent, Todo } from '../api/client';

/* ── small helpers ─────────────────────────────────────────────────────── */
function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

const STATUS_COLOR: Record<Todo['status'], string> = {
  pending: 'var(--text-secondary)',
  in_progress: 'var(--spring-green)',
  completed: 'var(--forest-green)',
};

/* ── FAB ───────────────────────────────────────────────────────────────── */
function Fab({ open, onClick }: { open: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={open ? 'Close shopping assistant' : 'Open shopping assistant'}
      aria-expanded={open}
      className="fab"
      style={{
        position: 'fixed',
        right: 20,
        bottom: 20,
        zIndex: 1001,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 18px',
        borderRadius: 'var(--radius-pill)',
        border: 'none',
        background: 'var(--spring-green)',
        color: 'var(--slate-navy)',
        fontFamily: 'var(--font-mono)',
        fontSize: '0.7rem',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '1px',
        cursor: 'pointer',
        boxShadow: '0 8px 26px rgba(0,237,100,0.35)',
        transition: 'transform 0.18s ease, box-shadow 0.18s ease',
        transform: hover ? 'translateY(-2px)' : 'none',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '0.95rem' }}>
        {open ? '✕' : '✦'}
      </span>
      <span className="fab-label">
        {open ? 'Close' : 'Ask your assistant'}
      </span>
    </button>
  );
}

/* ── Agent thinking (plan) collapsible ─────────────────────────────────── */
function PlanSection({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '1px',
          color: 'var(--text-secondary)',
        }}
        aria-expanded={open}
      >
        <span>
          Agent thinking · {done}/{todos.length}
        </span>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: '0 14px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {todos.map((t) => (
            <li
              key={t.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                fontSize: 12,
                color: 'var(--text)',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  marginTop: 5,
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: STATUS_COLOR[t.status],
                  boxShadow:
                    t.status === 'in_progress'
                      ? '0 0 8px rgba(0,237,100,0.6)'
                      : 'none',
                }}
              />
              <span
                style={{
                  textDecoration:
                    t.status === 'completed' ? 'line-through' : 'none',
                  opacity: t.status === 'completed' ? 0.6 : 1,
                  lineHeight: 1.45,
                }}
              >
                {t.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Cart strip ────────────────────────────────────────────────────────── */
function CartSection({ cart }: { cart: CartResponse | null }) {
  // Render only once the cart has lines. (null = not yet loaded, [] = empty.)
  if (!cart || cart.lines.length === 0) {
    return (
      <div
        style={{
          borderTop: '1px solid var(--border)',
          padding: '8px 14px',
          background: 'rgba(255,255,255,0.02)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '1px',
            color: 'var(--text-secondary)',
          }}
        >
          🛒 Cart · empty
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: '8px 14px',
        background: 'rgba(0,237,100,0.03)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '1px',
          color: 'var(--spring-green)',
          marginBottom: 6,
        }}
      >
        <span>🛒 Cart · {cart.lines.length}</span>
        <span style={{ color: 'var(--text)' }}>{formatUsd(cart.subtotal)}</span>
      </div>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          maxHeight: 132,
          overflowY: 'auto',
        }}
      >
        {cart.lines.map((line) => {
          const onSale = line.sale_price_usd != null;
          const unit = onSale ? (line.sale_price_usd as number) : line.unit_price_usd;
          return (
            <li
              key={line.product_id}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 6,
                fontSize: 12,
                color: 'var(--text)',
              }}
            >
              <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
                {line.qty}×
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={line.name}
              >
                {line.name}
              </span>
              {line.line_savings != null && line.line_savings > 0 && (
                <span
                  style={{
                    flexShrink: 0,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: 'var(--spring-green)',
                  }}
                >
                  −{formatUsd(line.line_savings)}
                </span>
              )}
              <span
                style={{
                  flexShrink: 0,
                  fontFamily: 'var(--font-mono)',
                  color: onSale ? 'var(--spring-green)' : 'var(--text-secondary)',
                }}
              >
                {formatUsd(unit * line.qty)}
              </span>
            </li>
          );
        })}
      </ul>
      {cart.total_savings > 0 && (
        <div
          style={{
            marginTop: 7,
            paddingTop: 6,
            borderTop: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--spring-green)',
          }}
        >
          <span>You save</span>
          <span>{formatUsd(cart.total_savings)}</span>
        </div>
      )}
    </div>
  );
}

/* ── Checkout approval (HITL) ──────────────────────────────────────────── */
/** Rendered when the order workflow suspends for approval. Reads the pending
 *  interrupt and drives approve/reject via the ChatContext resume flow. */
function ApprovalCard({
  interrupt,
  disabled,
  onApprove,
  onReject,
}: {
  interrupt: InterruptEvent;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const args = interrupt.action?.args as { total_usd?: number; lines?: unknown[] } | undefined;
  const total = typeof args?.total_usd === 'number' ? args.total_usd : undefined;
  const itemCount = Array.isArray(args?.lines) ? args!.lines!.length : undefined;

  const btn = (bg: string, border: string, color: string): React.CSSProperties => ({
    flex: 1,
    padding: '8px 10px',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
    fontWeight: 600,
    color,
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 'var(--radius-md)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  });

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: '10px 14px',
        background: 'rgba(0,237,100,0.05)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '1px',
          color: 'var(--spring-green)',
          marginBottom: 6,
        }}
      >
        ✓ Approve order
      </div>
      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10 }}>
        {interrupt.action?.description ??
          `Place order${itemCount != null ? ` for ${itemCount} item(s)` : ''}${
            total != null ? `, total ${formatUsd(total)}` : ''
          }.`}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          disabled={disabled}
          onClick={onApprove}
          style={btn('var(--green-tint)', 'var(--green-border)', 'var(--spring-green)')}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={onReject}
          style={btn('rgba(255,255,255,0.03)', 'var(--border)', 'var(--text-secondary)')}
        >
          Reject
        </button>
      </div>
    </div>
  );
}

/* ── Panel ─────────────────────────────────────────────────────────────── */
function Panel() {
  const {
    messages,
    isLoading,
    activeTool,
    plan,
    cart,
    userId,
    pendingInterrupt,
    approveCheckout,
    rejectCheckout,
    sendMessage,
    newConversation,
    setOpen,
  } = useChat();
  const [draft, setDraft] = useState('');
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to newest content as tokens stream in.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeTool, isLoading]);

  // Focus the input when the panel mounts (opens).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || isLoading || !userId) return;
    sendMessage(text);
    setDraft('');
  };

  const canSend = !!draft.trim() && !isLoading && !!userId;

  return (
    <div
      role="dialog"
      aria-label="Retail Shopping Assistant"
      className="chat-panel"
      style={{
        position: 'fixed',
        right: 20,
        bottom: 78,
        zIndex: 1000,
        width: expanded
          ? 'min(900px, calc(100vw - 40px))'
          : 'min(420px, calc(100vw - 28px))',
        height: expanded
          ? 'calc(100vh - 110px)'
          : 'min(600px, calc(100vh - 120px))',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-panel)',
        overflow: 'hidden',
        animation: 'panel-in 0.22s ease both',
        transition: 'width 0.2s ease, height 0.2s ease',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 14px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: '0.7rem',
            textTransform: 'uppercase',
            letterSpacing: '1.2px',
            color: 'var(--spring-green)',
          }}
        >
          {/* Co-brand lockup, same as the app header: MongoDB leaf + hairline
              divider + Mastra mark, so the chat panel reads as an equal
              MongoDB × Mastra partnership at the point of interaction. */}
          <MongoLeaf size={16} />
          <span
            aria-hidden="true"
            style={{ width: 1, height: 13, background: 'var(--border-strong)' }}
          />
          <MastraMark size={13} fill="var(--mastra-mark)" />
          MongoDB + Mastra Cart Concierge
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            onClick={newConversation}
            style={{
              padding: '4px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              textTransform: 'uppercase',
              letterSpacing: '1px',
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-pill)',
              cursor: 'pointer',
            }}
            title="Start a new conversation"
          >
            New
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Collapse assistant' : 'Expand assistant'}
            aria-pressed={expanded}
            title={expanded ? 'Restore default size' : 'Expand to a larger view'}
            style={{
              width: 26,
              height: 26,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            {expanded ? '⤡' : '⤢'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close assistant"
            style={{
              width: 26,
              height: 26,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              margin: 'auto',
              textAlign: 'center',
              maxWidth: 260,
              color: 'var(--text-secondary)',
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            Ask about recipes, deals, loyalty, or your shopping list…
          </div>
        ) : (
          messages.map((m) => <ChatMessage key={m.id} message={m} />)
        )}

        {activeTool && (
          <div
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--spring-green)',
              background: 'var(--green-tint)',
              border: '1px solid var(--green-border)',
              borderRadius: 'var(--radius-pill)',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--spring-green)',
                animation: 'pulse-dot 1s ease-in-out infinite',
              }}
            />
            {activeTool} running…
          </div>
        )}
      </div>

      {/* Agent thinking (todos) */}
      <PlanSection todos={plan.todos} />

      {/* Cart */}
      <CartSection cart={cart} />

      {/* Checkout approval (HITL): shown when the order workflow suspends for the
          shopper's decision. Drives the /api/interrupts/resume flow via ChatContext. */}
      {pendingInterrupt && (
        <ApprovalCard
          interrupt={pendingInterrupt}
          disabled={isLoading}
          onApprove={approveCheckout}
          onReject={() => rejectCheckout()}
        />
      )}

      {/* Input */}
      <form
        onSubmit={submit}
        style={{
          display: 'flex',
          gap: 8,
          padding: 12,
          borderTop: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask about recipes, deals, or your shopping list…"
          aria-label="Message"
          spellCheck={false}
          style={{
            flex: 1,
            padding: '10px 12px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text)',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 42,
            background: canSend ? 'var(--spring-green)' : 'rgba(255,255,255,0.06)',
            color: canSend ? 'var(--slate-navy)' : 'var(--text-secondary)',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            cursor: canSend ? 'pointer' : 'not-allowed',
            fontSize: 15,
            transition: 'background 0.15s ease',
          }}
        >
          ↑
        </button>
      </form>

      {/* Feedback hint: only meaningful once a user id is set. */}
      {userId && (
        <div
          style={{
            padding: '0 12px 10px',
            fontSize: 10.5,
            color: 'var(--text-secondary)',
            textAlign: 'center',
            flexShrink: 0,
          }}
        >
          Tip: rate replies with 👍/👎, or type{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>/feedback up|down &lt;comment&gt;</code>.
        </div>
      )}
    </div>
  );
}

export default function ChatWidget() {
  const { open, setOpen } = useChat();

  // Esc closes the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  return (
    <>
      {open && <Panel />}
      <Fab open={open} onClick={() => setOpen(!open)} />
    </>
  );
}
