import React, { useCallback, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from '../context/ChatContext';
import { useChat } from '../context/ChatContext';
import AgentTrace from './AgentTrace';

// The in-chat agent-trace panel is on by default; set VITE_AGENT_TRACE=false to hide it
// (e.g. a minimal self-deploy). Vite inlines import.meta.env at build time.
const AGENT_TRACE_ENABLED = import.meta.env.VITE_AGENT_TRACE !== 'false';

/**
 * URL policy for assistant-rendered markdown. The assistant's output is model-controlled,
 * so a reply containing `![x](https://evil/pixel.png)` would otherwise make the browser
 * fetch a third-party host (tracking / data exfiltration via URL). This runs on top of
 * react-markdown's own defaultUrlTransform (which already strips dangerous schemes like
 * javascript:) and additionally blocks ALL images and non-safe link schemes
 * (reviewer finding #11). Returning '' drops the URL so nothing is requested.
 */
function safeUrlTransform(url: string, key: string, node: { tagName?: string }): string {
  const cleaned = defaultUrlTransform(url);
  // Block every image src: an <img> auto-fires a request on render.
  if (node?.tagName === 'img' || key === 'src') return '';
  // Links: allow only in-page anchors and http(s)/mailto the user must click.
  if (key === 'href') {
    if (/^(https?:|mailto:|#|\/)/i.test(cleaned)) return cleaned;
    return '';
  }
  return cleaned;
}

interface Props {
  message: Message;
}

/**
 * Animated "thinking" indicator shown in an assistant bubble before the first
 * token arrives. A cold model call (router → sub-agent → hybrid search) can take
 * tens of seconds; a static "…" reads as a hung UI. Three staggered pulsing dots
 * make the wait feel alive from the instant the turn starts. Honours
 * prefers-reduced-motion via the shared rule in global.css.
 */
function ThinkingDots() {
  return (
    <span
      aria-label="Assistant is thinking"
      role="status"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 0' }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--spring-green)',
            animation: 'pulse-dot 1.1s ease-in-out infinite',
            animationDelay: `${i * 0.18}s`,
          }}
        />
      ))}
    </span>
  );
}

/**
 * Guard against an UNCLOSED ``` code fence in the assistant's text. The agent
 * sometimes echoes a query in a fence and forgets to close it (e.g.
 * "``` db.products.aggregate(...)"), which makes react-markdown render the
 * entire rest of the message — headings, tables, prose — as one raw code
 * block. If the fence count is odd, drop the last unmatched fence marker so the
 * following markdown renders normally.
 */
function balanceCodeFences(md: string): string {
  const fences = md.match(/```/g);
  if (!fences || fences.length % 2 === 0) return md;
  const i = md.lastIndexOf('```');
  return md.slice(0, i) + md.slice(i + 3);
}

const userBubbleStyle: React.CSSProperties = {
  maxWidth: '86%',
  padding: '9px 12px',
  borderRadius: 'var(--radius-md) var(--radius-md) 4px var(--radius-md)',
  background: 'var(--green-tint-12)',
  border: '1px solid var(--green-border)',
  color: 'var(--text)',
  fontSize: 14,
  lineHeight: 1.55,
  alignSelf: 'flex-end',
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
};

const assistantBubbleStyle: React.CSSProperties = {
  maxWidth: '92%',
  padding: '10px 14px',
  borderRadius: 'var(--radius-md) var(--radius-md) var(--radius-md) 4px',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  fontSize: 14,
  lineHeight: 1.7,
  alignSelf: 'flex-start',
  wordBreak: 'break-word',
};

const errorBubbleStyle: React.CSSProperties = {
  ...assistantBubbleStyle,
  background: 'var(--danger-tint)',
  border: '1px solid rgba(239,68,68,0.4)',
  color: 'var(--danger)',
};

const roleTagStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '1.5px',
  marginBottom: 5,
  color: 'var(--text-secondary)',
};

const systemNoteStyle: React.CSSProperties = {
  alignSelf: 'center',
  fontSize: 12,
  color: 'var(--text-secondary)',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-pill)',
  padding: '6px 12px',
  margin: '2px 0',
  maxWidth: '85%',
  textAlign: 'center',
  lineHeight: 1.5,
};

const feedbackRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 6,
  paddingLeft: 2,
};

const feedbackThanksStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-secondary)',
  marginLeft: 4,
};

function feedbackBtnStyle(active: boolean): React.CSSProperties {
  return {
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)',
    padding: '2px 8px',
    fontSize: 14,
    lineHeight: 1.2,
    border: active ? '1px solid var(--spring-green)' : '1px solid var(--border)',
    background: active ? 'var(--green-tint)' : 'transparent',
  };
}

const ChatMessage: React.FC<Props> = React.memo(({ message }) => {
  const { submitFeedback } = useChat();
  const [busy, setBusy] = useState(false);

  if (message.role === 'system') {
    return <div style={systemNoteStyle}>{message.content}</div>;
  }

  const isUser = message.role === 'user';
  const isError = message.role === 'error';

  const bubbleStyle = isError
    ? errorBubbleStyle
    : isUser
      ? userBubbleStyle
      : assistantBubbleStyle;

  // Thumbs appear only once the turn's run id is known and it has real text
  // (not the streaming "…" placeholder).
  const canRate =
    message.role === 'assistant' &&
    !!message.runId &&
    !!message.content &&
    message.content.trim() !== '…';

  const rate = async (score: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await submitFeedback(message.id, score);
    } finally {
      setBusy(false);
    }
  };

  // Keep code-block rendering plain (no rehype-raw / dangerouslySetInnerHTML).
  const renderCode = useCallback(
    (props: { className?: string; children?: React.ReactNode }) => {
      const { className, children } = props;
      return <code className={className}>{children}</code>;
    },
    [],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
      }}
    >
      {!isUser && (
        <div style={roleTagStyle}>{isError ? 'Error' : 'Assistant'}</div>
      )}
      <div style={bubbleStyle}>
        {isUser ? (
          <div>{message.content}</div>
        ) : !isError && !message.content ? (
          // No tokens yet — show the animated thinking indicator instead of a
          // static "…", so a cold turn never looks hung.
          <ThinkingDots />
        ) : (
          <div className="chat-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              urlTransform={safeUrlTransform}
              // Never render model-supplied images: drop them to their alt text so no
              // external request is ever made (defense in depth with urlTransform).
              components={{ code: renderCode, img: ({ alt }) => <>{alt ?? ''}</> }}
            >
              {balanceCodeFences(message.content || (isError ? '' : '…'))}
            </ReactMarkdown>
          </div>
        )}
      </div>
      {AGENT_TRACE_ENABLED && !isUser && !isError && message.trace && message.trace.length > 0 && (
        <div style={{ width: '100%', marginTop: 6 }}>
          <AgentTrace steps={message.trace} />
        </div>
      )}
      {canRate && (
        <div style={feedbackRowStyle}>
          <button
            type="button"
            aria-label="Good response"
            title="Good response"
            disabled={busy}
            onClick={() => rate(1)}
            style={feedbackBtnStyle(message.feedback === 'up')}
          >
            👍
          </button>
          <button
            type="button"
            aria-label="Bad response"
            title="Bad response"
            disabled={busy}
            onClick={() => rate(0)}
            style={feedbackBtnStyle(message.feedback === 'down')}
          >
            👎
          </button>
          {message.feedback && (
            <span style={feedbackThanksStyle}>Thanks for the feedback!</span>
          )}
        </div>
      )}
    </div>
  );
});

ChatMessage.displayName = 'ChatMessage';
export default ChatMessage;
