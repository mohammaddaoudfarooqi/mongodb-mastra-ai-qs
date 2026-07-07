import { Hono } from 'hono';
import { loadConfig, type Config } from '../config';
import { logger } from '../observability/logger';
import { buildRouteContext, handlers, type RouteContext } from './routes';
import { buildOrderRunner } from './order-runner';

/**
 * The standalone Hono app used for local dev (`tsx src/server/app.ts`), the
 * Docker image, and hermetic route tests. It mounts the SAME handler functions
 * that `src/mastra/index.ts` registers on the Mastra instance's server
 * (`server.apiRoutes`), so the two deploy surfaces never diverge (REQ-E-001).
 *
 * Paths here are bare (`/chat`, `/cart`, …) to preserve the existing test and
 * dev-proxy contract; the Mastra registration uses `/api/<path>` (legal once
 * the Mastra `apiPrefix` is moved off `/api`). Handlers are path-agnostic.
 */
export function createApp(cfg: Config = loadConfig(), rc: RouteContext = buildRouteContext(cfg)): Hono {
  const app = new Hono();

  // Wire the order-workflow runner (checkout HITL) if not already provided.
  // Connection-free until first checkout, so hermetic tests that inject their
  // own rc (or skip checkout) are unaffected.
  if (!rc.orderRunner) rc.orderRunner = buildOrderRunner(cfg, rc);

  app.get('/health', handlers.health());
  app.post('/chat', handlers.chat(rc));
  app.get('/models', handlers.models(rc));
  app.get('/auth/me', handlers.authMe(rc));
  app.get('/stats', handlers.stats(rc));
  app.get('/cart', handlers.cart(rc));
  app.get('/messages', handlers.messages(rc));
  app.get('/threads/latest', handlers.latestThread(rc));
  app.get('/files', handlers.files());
  app.post('/interrupts/resume', handlers.resume(rc));
  app.post('/feedback', handlers.feedback(rc));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Load .env into process.env before validating config (Node >=20.12 built-in; no-op if absent).
  try { process.loadEnvFile(); } catch { /* no .env present: rely on the ambient environment */ }
  const cfg = loadConfig();
  const app = createApp(cfg);
  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port: cfg.port });
  logger.info('server listening', { port: cfg.port });
}
