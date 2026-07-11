import React, { useEffect, useState } from 'react';
import { fetchModels, type ModelOption } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import { MongoLeaf, MastraMark } from './brand';

const headerStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  minHeight: 52,
  padding: '0 20px',
  gap: 16,
  background: 'rgba(6,10,15,0.8)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  borderBottom: '1px solid var(--border)',
};

const leftStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minWidth: 0,
};

const titleWrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
};

const titleStyle: React.CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text)',
  letterSpacing: '-0.01em',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const tagStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  color: 'var(--text-secondary)',
  letterSpacing: '0.3px',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const rightStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexShrink: 0,
};

const badgeStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '5px 11px',
  background: 'var(--green-tint)',
  border: '1px solid var(--green-border)',
  borderRadius: 'var(--radius-pill)',
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text)',
  maxWidth: 320,
};

const selectStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text)',
  border: 'none',
  outline: 'none',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  maxWidth: 270,
};

const userWrapStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 10px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-pill)',
};

const userLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '1px',
  color: 'var(--text-secondary)',
};

// Spec 550: the user-id is now the read-only SSO email (no longer editable).
const userEmailStyle: React.CSSProperties = {
  color: 'var(--text)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  maxWidth: 220,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Co-brand lockup shown at the far left of the header: the MongoDB spring-green
// leaf and the Mastra monochrome mark, separated by a hairline divider. The two
// marks are sized to read as equal partners (REQ: equal co-brand), which is why
// the divider — not a "+" — sits between them.
const lockupStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexShrink: 0,
};

const lockupDividerStyle: React.CSSProperties = {
  width: 1,
  height: 22,
  background: 'var(--border-strong)',
  flexShrink: 0,
};

function BrandLockup() {
  return (
    <div style={lockupStyle} aria-label="MongoDB and Mastra">
      <MongoLeaf size={26} />
      <span style={lockupDividerStyle} aria-hidden="true" />
      <MastraMark size={22} />
    </div>
  );
}

/**
 * Bedrock model badge. Reads `/api/models` to populate; selecting an
 * option updates ChatContext so the next /chat request carries the chosen
 * inference-profile id.
 */
function ModelBadge() {
  const { model, setModel } = useChat();
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [defaultId, setDefaultId] = useState<string>('');
  // Server decides whether switching is offered. Locked on the public AI4 domain so every
  // visitor runs the same pinned model; the picker becomes a read-only badge.
  const [allowSwitch, setAllowSwitch] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    fetchModels()
      .then((r) => {
        if (cancelled) return;
        setOptions(r.models);
        setDefaultId(r.default);
        setAllowSwitch(r.allowSwitch !== false);
        if (!model && r.default) setModel(r.default);
      })
      .catch(() => {
        /* keep empty state on error; chat still works (server uses default) */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read-only badge: no models yet, OR switching is locked. Show the chosen/default model's
  // label (falling back to its id) so a locked deploy still names the model it's running.
  const lockedLabel =
    options.find((o) => o.id === (model || defaultId))?.label || defaultId || 'loading…';
  const showStatic = options.length === 0 || !allowSwitch;

  return (
    <div style={badgeStyle} title="Bedrock inference profile">
      <svg width="9" height="9" viewBox="0 0 16 16" fill="var(--spring-green)">
        <circle cx="8" cy="8" r="5" />
      </svg>
      {showStatic ? (
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {lockedLabel}
        </span>
      ) : (
        <select
          style={selectStyle}
          value={model || defaultId}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Select Bedrock model"
        >
          {options.map((o) => (
            <option key={o.id} value={o.id} style={{ color: '#001E2B' }}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export default function Header() {
  // Spec 550: the user identity is the authenticated SSO email — read-only.
  const { email, isLoading, error } = useAuth();
  const display = email || (isLoading ? 'signing in…' : error ? 'not signed in' : '—');
  return (
    <header style={headerStyle}>
      <div style={leftStyle}>
        <BrandLockup />
        <div style={titleWrapStyle}>
          <span style={titleStyle}>MongoDB + Mastra Cart Concierge</span>
          <span style={tagStyle}>
            MongoDB Atlas + Mastra · retail shopping assistant
          </span>
        </div>
      </div>
      <div style={rightStyle}>
        <ModelBadge />
        <div style={userWrapStyle} title="Signed-in user (Okta SSO)">
          <span style={userLabelStyle}>User</span>
          <span style={userEmailStyle} aria-label="Signed-in user">
            {display}
          </span>
        </div>
      </div>
    </header>
  );
}
