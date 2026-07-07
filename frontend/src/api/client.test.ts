import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMe } from './client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchMe', () => {
  it('returns the authenticated SSO identity from /api/auth/me', async () => {
    const body = {
      email: 'alice@mongodb.com',
      username: 'alice',
      groups: ['g1'],
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const user = await fetchMe();
    expect(user.email).toBe('alice@mongodb.com');
    expect(user.username).toBe('alice');
    expect(user.groups).toEqual(['g1']);
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/me', expect.any(Object));
  });

  it('throws when unauthenticated (401)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unauthorized', { status: 401 }),
    );
    await expect(fetchMe()).rejects.toThrow(/Not authenticated/);
  });
});
