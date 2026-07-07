import { describe, it, expect, afterEach } from 'vitest';
import type { Context } from 'hono';
import type { Config } from '../config';
import { resolveUserId, registerAuthenticator, resetAuthenticator, getAuthenticator } from './auth';

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
