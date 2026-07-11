import React, { useState } from 'react';
import { submitLead } from '../api/client';

/* ── LeadGate: attendee capture for the public AI4 demo ──────────────────────
 * When `enabled` (server says leadGate on), block the storefront behind a light
 * capture form (name + work email, optional company) and POST it to /api/leads,
 * which mirrors the lead into Atlas. FAIL-OPEN: a submit error still lets the
 * visitor in (the primary capture is Google Forms + PostHog in the deploy overlay),
 * and completion is remembered in localStorage so a repeat visit isn't re-gated.
 * When disabled (local dev / self-deploy), it renders children directly. */

const DONE_KEY = 'ai4LeadComplete';

export default function LeadGate({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const alreadyDone = (() => { try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return false; } })();
  const [done, setDone] = useState(!enabled || alreadyDone);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (done) return <>{children}</>;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!name.trim() || !email.trim()) { setErr('Please enter your name and email.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr('Please enter a valid email.'); return; }
    setBusy(true);
    const r = await submitLead({ name: name.trim(), email: email.trim(), company: company.trim(), consent: true });
    setBusy(false);
    // Fail-open: even if the server rejected, don't trap the visitor — but surface a real
    // validation reason if we got one.
    if (r.ok === false && r.reason) { setErr(r.reason); return; }
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
    setDone(true);
  };

  return (
    <div style={overlay}>
      <form style={card} onSubmit={onSubmit} aria-label="Attendee sign-in">
        <h2 style={{ margin: 0, fontSize: '1.3rem', color: 'var(--slate-navy, #001E2B)' }}>Welcome to the MongoDB × Mastra concierge</h2>
        <p style={{ margin: '6px 0 14px', fontSize: '0.9rem', color: '#5c6c75' }}>
          Enter your details to explore the live AI shopping demo.
        </p>
        <label style={label}>Name
          <input style={input} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
        </label>
        <label style={label}>Work email
          <input style={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label style={label}>Company (optional)
          <input style={input} value={company} onChange={(e) => setCompany(e.target.value)} autoComplete="organization" />
        </label>
        {err && <p style={{ color: '#c0392b', fontSize: '0.8rem', margin: '4px 0 0' }}>{err}</p>}
        <button type="submit" disabled={busy} style={button}>{busy ? 'Starting…' : 'Enter the demo'}</button>
        <p style={{ margin: '10px 0 0', fontSize: '0.7rem', color: '#88959c' }}>
          We’ll only use this to follow up about MongoDB. No spam.
        </p>
      </form>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'rgba(15,23,42,0.6)', backdropFilter: 'blur(8px)',
};
const card: React.CSSProperties = {
  width: 'min(420px, calc(100vw - 2rem))', background: '#fff', borderRadius: 16, padding: '1.75rem 1.5rem',
  boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column',
};
const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.78rem', fontWeight: 600, color: '#475569', marginBottom: 10 };
const input: React.CSSProperties = { padding: '0.6rem 0.7rem', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: '0.9rem' };
const button: React.CSSProperties = { marginTop: 6, padding: '0.75rem', borderRadius: 8, border: 'none', background: 'var(--spring-green, #00ED64)', color: '#001E2B', fontWeight: 700, fontSize: '0.9rem', cursor: 'pointer' };
