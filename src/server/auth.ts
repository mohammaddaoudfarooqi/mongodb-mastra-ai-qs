import type { Context } from 'hono';
import type { Config } from '../config';
import { logger } from '../observability/logger';

/**
 * Server-trusted identity for a request. `userId` is the resource/thread scope key used
 * for memory, carts, messages, and checkout. When it comes from here it is authoritative:
 * routes must NOT let a client-supplied `user_id`/`thread_id` override it.
 */
export interface Identity {
  userId: string;
}

/**
 * Resolves the authenticated identity for a request, or null when there is none.
 *
 * Two deployment modes, one seam:
 *   - Local demo (default, AUTH_MODE=local): the built-in resolver returns null, so routes
 *     fall back to the client-supplied user_id (or DEFAULT_USER_ID). This is intentional —
 *     the demo has no login and lets you switch users to show cross-thread memory. It is
 *     NOT secure and must not be exposed publicly (README documents this).
 *   - SSO (AUTH_MODE=sso): a registered resolver validates the hosting platform's session
 *     and returns the real user. Client-supplied identity is then ignored, and a request with
 *     no valid session is rejected 401. That resolver is injected via `registerAuthenticator`
 *     from a deployment-only entrypoint that is NOT committed to the public repo, so no
 *     SSO/session code ships here.
 */
export type Authenticator = (c: Context) => Identity | null | Promise<Identity | null>;

// Module-level override so a private deployment entrypoint can plug in an SSO resolver
// without editing committed code: `registerAuthenticator(ssoResolver)` before serving.
let override: Authenticator | null = null;

/** Register a custom authenticator (a deployment SSO adapter). Call once at startup, before serving. */
export function registerAuthenticator(fn: Authenticator): void {
  override = fn;
}

/** Test/reset seam: clear any registered authenticator. */
export function resetAuthenticator(): void {
  override = null;
}

/** The active authenticator: the registered override if any, else a no-auth resolver. */
export function getAuthenticator(): Authenticator {
  return override ?? (() => null);
}

/**
 * Startup hook: in SSO mode, load the deployment's auth adapter and let it register an
 * authenticator. The adapter module is resolved from AUTH_ADAPTER_MODULE (default
 * './auth-adapter') and is NOT part of this repo — the hosting platform's SSO integration
 * lives there and is deployed alongside the image without being committed to the public repo.
 * The adapter must export `register(register: typeof registerAuthenticator, cfg: Config)`.
 *
 * In local mode this is a no-op, so the public code runs with no auth and no SSO deps.
 * In SSO mode a missing/broken adapter is fatal — we refuse to run "secure" without one,
 * so requests fail closed (401) rather than silently trusting client identity.
 */
export async function initAuth(cfg: Config): Promise<void> {
  if (!cfg.authRequired) return;
  const modulePath = process.env.AUTH_ADAPTER_MODULE || './auth-adapter';
  try {
    const mod = await import(/* @vite-ignore */ modulePath) as { register?: (r: typeof registerAuthenticator, cfg: Config) => void | Promise<void> };
    if (typeof mod.register !== 'function') {
      throw new Error(`auth adapter "${modulePath}" has no exported register()`);
    }
    await mod.register(registerAuthenticator, cfg);
    logger.info('auth adapter registered', { module: modulePath });
  } catch (err) {
    // Fail closed: without a working authenticator, resolveUserId returns unauthorized for
    // every request, so this does not open a hole — but surface it loudly so the deploy is fixed.
    logger.error('AUTH_MODE=sso but auth adapter failed to load; all requests will 401', { module: modulePath, err: String(err) });
  }
}

/**
 * Resolve the identity a route should act as. Returns the server-trusted userId when an
 * authenticator provides one; otherwise (local demo) falls back to the client-supplied
 * `user_id` or the configured default. When `cfg.authRequired` is set and no identity is
 * resolved, returns { unauthorized: true } so the route can reply 401 — a client cannot
 * then impersonate anyone by passing a `user_id`.
 */
export async function resolveUserId(
  c: Context,
  cfg: Config,
  clientUserId: string | undefined,
): Promise<{ userId: string } | { unauthorized: true }> {
  const id = await getAuthenticator()(c);
  if (id?.userId) return { userId: id.userId };
  if (cfg.authRequired) return { unauthorized: true };
  return { userId: clientUserId || cfg.defaultUserId };
}
