// src/server/leads.ts
//
// Attendee lead capture for the public AI4 demo. The soft gate in the SPA collects a name/email
// (+ optional company) before the storefront is usable, and POSTs here. We persist each lead to a
// `leads` collection in the SAME Atlas cluster as everything else — dogfooding the "one cluster,
// now also the CRM" story you can show live on stage. Google Forms + PostHog stay the primary
// capture (in the private overlay); this Atlas mirror is additive and best-effort.

export interface LeadInput {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  consent?: unknown;
  source?: unknown;
}

export interface LeadDoc {
  name: string;
  email: string;
  company: string;
  consent: boolean;
  source: string;
  userAgent: string;
  ts: Date;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate + normalize a lead submission into a storable doc, or return an error reason.
 * `ts` is injected (never Date.now() here) so the caller controls the timestamp and tests are
 * deterministic. Email is required and structurally validated; name is required; the rest optional.
 */
export function buildLeadDoc(
  input: LeadInput,
  ts: Date,
  userAgent = '',
): { ok: true; doc: LeadDoc } | { ok: false; reason: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!name) return { ok: false, reason: 'name is required' };
  if (!email || !EMAIL_RE.test(email)) return { ok: false, reason: 'a valid email is required' };
  return {
    ok: true,
    doc: {
      name,
      email: email.toLowerCase(),
      company: typeof input.company === 'string' ? input.company.trim() : '',
      consent: input.consent === true,
      source: typeof input.source === 'string' && input.source ? input.source : 'ai4',
      userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : '',
      ts,
    },
  };
}
