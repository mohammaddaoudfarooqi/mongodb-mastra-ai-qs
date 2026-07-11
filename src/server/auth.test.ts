import { describe, it, expect, afterEach } from 'vitest';
import type { Context } from 'hono';
import type { Config } from '../config';
import { resolveUserId, scopeThreadId, registerAuthenticator, resetAuthenticator, getAuthenticator } from './auth';

const localCfg = { defaultUserId: 'demo', authRequired: false } as Config;
const ssoCfg = { defaultUserId: 'demo', authRequired: true } as Config;
const ctx = {} as Context;

afterEach(() => resetAuthenticator());

describe('resolveUserId', () => {
  it('local mode: uses the client-supplied user_id', async () => {
    expect(await resolveUserId(ctx, localCfg, 'alice')).toEqual({ userId: 'alice' });
  });

  it('local mode: falls back to defaultUserId when client sends nothing', async () => {
    expect(await resolveUserId(ctx, localCfg, undefined)).toEqual({ userId: 'demo' });
  });

  it('sso mode: rejects when no authenticator resolves an identity', async () => {
    // Even if the client sends a user_id, an unauthenticated request is unauthorized —
    // the client cannot impersonate anyone.
    expect(await resolveUserId(ctx, ssoCfg, 'attacker')).toEqual({ unauthorized: true });
  });

  it('sso mode: uses the authenticated identity and IGNORES client-supplied user_id', async () => {
    registerAuthenticator(() => ({ userId: 'real-user@corp' }));
    expect(await resolveUserId(ctx, ssoCfg, 'attacker')).toEqual({ userId: 'real-user@corp' });
  });

  it('a registered authenticator also wins in local mode (client value ignored)', async () => {
    registerAuthenticator(async () => ({ userId: 'sso-user' }));
    expect(await resolveUserId(ctx, localCfg, 'alice')).toEqual({ userId: 'sso-user' });
  });
});

// scopeThreadId binds a per-conversation thread to its owning user in SSO mode so the resume
// ownership check (threadId === userId || startsWith(`${userId}:`)) holds for a checkout started
// with a bare client sub. Local mode is unchanged (bare sub) so the demo's cross-user switching
// still works. Idempotent so an already-composite id (echoed from an interrupt, or a restored
// thread) is not double-prefixed.
describe('scopeThreadId', () => {
  it('local mode: returns the client sub unchanged', () => {
    expect(scopeThreadId(localCfg, 'alice', 'abc123')).toBe('abc123');
  });

  it('sso mode: prefixes the sub with the owning user so resume ownership holds', () => {
    const scoped = scopeThreadId(ssoCfg, 'real-user@corp', 'abc123');
    expect(scoped).toBe('real-user@corp:abc123');
    // Satisfies the resume ownership contract in routes.ts.
    expect(scoped === 'real-user@corp' || scoped.startsWith('real-user@corp:')).toBe(true);
  });

  it('sso mode: is idempotent for an already-scoped thread id (no double prefix)', () => {
    expect(scopeThreadId(ssoCfg, 'real-user@corp', 'real-user@corp:abc123')).toBe('real-user@corp:abc123');
  });

  it('falls back to a per-user default thread when no sub is supplied', () => {
    expect(scopeThreadId(ssoCfg, 'real-user@corp', undefined)).toBe('real-user@corp:default');
    expect(scopeThreadId(localCfg, 'alice', undefined)).toBe('alice:default');
  });
});

describe('registerAuthenticator', () => {
  it('defaults to a no-auth resolver returning null', async () => {
    expect(await getAuthenticator()(ctx)).toBeNull();
  });

  it('override is replaceable and resettable', async () => {
    registerAuthenticator(() => ({ userId: 'x' }));
    expect(await getAuthenticator()(ctx)).toEqual({ userId: 'x' });
    resetAuthenticator();
    expect(await getAuthenticator()(ctx)).toBeNull();
  });
});
