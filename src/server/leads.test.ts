// src/server/leads.test.ts
import { describe, it, expect } from 'vitest';
import { buildLeadDoc } from './leads';

const TS = new Date('2026-08-01T12:00:00.000Z');

describe('buildLeadDoc', () => {
  it('builds a normalized doc for a valid submission', () => {
    const r = buildLeadDoc({ name: '  Ada Lovelace ', email: 'ADA@Example.COM', company: 'Analytical', consent: true, source: 'ai4' }, TS, 'UA/1.0');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc).toEqual({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        company: 'Analytical',
        consent: true,
        source: 'ai4',
        userAgent: 'UA/1.0',
        ts: TS,
      });
    }
  });

  it('rejects a missing name', () => {
    const r = buildLeadDoc({ email: 'a@b.com' }, TS);
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/name/) });
  });

  it('rejects a missing or malformed email', () => {
    expect(buildLeadDoc({ name: 'X' }, TS).ok).toBe(false);
    expect(buildLeadDoc({ name: 'X', email: 'not-an-email' }, TS).ok).toBe(false);
    expect(buildLeadDoc({ name: 'X', email: 'x@y.z' }, TS).ok).toBe(true);
  });

  it('defaults source to ai4 and consent to false, caps userAgent', () => {
    const r = buildLeadDoc({ name: 'X', email: 'x@y.co' }, TS, 'z'.repeat(1000));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.source).toBe('ai4');
      expect(r.doc.consent).toBe(false);
      expect(r.doc.userAgent.length).toBe(512);
    }
  });
});
