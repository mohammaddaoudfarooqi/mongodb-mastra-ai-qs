import { Mastra } from '@mastra/core';
import { MongoDBStore } from '@mastra/mongodb';
import { InMemoryStore } from '@mastra/core/storage';
import { Observability, MastraStorageExporter } from '@mastra/observability';
import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute, ApiRouteHandler } from '@mastra/core/server';
import type { Context } from 'hono';
import { loadConfig, type Config } from '../config';
import { buildConcierge } from './agent';
import { buildPlaceOrderWorkflow } from './workflows/place-order';
import { buildOrderRunner } from '../server/order-runner';
import { buildRouteContext, handlers, type RouteContext } from '../server/routes';
import { buildSpaRoute } from '../server/static';
import { initAuth } from '../server/auth';
import { logger } from '../observability/logger';

/**
 * The browser-facing HTTP routes, registered on the Mastra server under `/api/*`.
 *
 * These use the SAME handler functions as the standalone Hono app (`createApp`),
 * so the Docker deploy and the Mastra Cloud deploy serve byte-identical behavior
 * (REQ-E-001/002). The paths are `/api/<name>` to match the frontend's hardcoded
 * `API_BASE = '/api'`; this is legal only because we move Mastra's own
 * `apiPrefix` off `/api` (see `buildMastra`), freeing `/api/*` for custom routes
 * (REQ-E-003).
 */
export function buildApiRoutes(rc: RouteContext): ApiRoute[] {
  const pub = { requiresAuth: false as const };
  // The shared handlers take a plain Hono `Context`; `registerApiRoute` narrows
  // the handler's context to a path-typed variant. They are structurally
  // compatible (`ApiRouteHandler` is `(c: any) => Response`), so cast at this
  // one boundary rather than weakening the handlers' own types.
  const h = (fn: (c: Context) => Response | Promise<Response>): ApiRouteHandler => fn as ApiRouteHandler;
  return [
    registerApiRoute('/api/health',         { method: 'GET',  ...pub, handler: h(handlers.health()) }),
    registerApiRoute('/api/chat',           { method: 'POST', ...pub, handler: h(handlers.chat(rc)) }),
    registerApiRoute('/api/models',         { method: 'GET',  ...pub, handler: h(handlers.models(rc)) }),
    registerApiRoute('/api/auth/me',        { method: 'GET',  ...pub, handler: h(handlers.authMe(rc)) }),
    registerApiRoute('/api/stats',          { method: 'GET',  ...pub, handler: h(handlers.stats(rc)) }),
    registerApiRoute('/api/cart',           { method: 'GET',  ...pub, handler: h(handlers.cart(rc)) }),
    registerApiRoute('/api/messages',       { method: 'GET',  ...pub, handler: h(handlers.messages(rc)) }),
    registerApiRoute('/api/threads/latest', { method: 'GET',  ...pub, handler: h(handlers.latestThread(rc)) }),
    registerApiRoute('/api/files',          { method: 'GET',  ...pub, handler: h(handlers.files()) }),
    registerApiRoute('/api/interrupts/resume', { method: 'POST', ...pub, handler: h(handlers.resume(rc)) }),
    registerApiRoute('/api/feedback',       { method: 'POST', ...pub, handler: h(handlers.feedback(rc)) }),
  ];
}

/**
 * DI hub. Registers the concierge agent (for Mastra Studio and the deployed
 * server) plus every browser-facing route and the SPA static fallback, so a
 * single `mastra build` artifact serves the API and the storefront (D2/REQ-E-006).
 */
export function buildMastra(cfg: Config = loadConfig()) {
  const { agent } = buildConcierge(cfg, {
    signals: { knowledgeSearchRan: false, knowledgeSearchHadResults: false, dataQueryRan: false, mutatingToolRan: false },
  });
  const rc = buildRouteContext(cfg);
  // Wire the checkout runner so the Cloud surface (this instance's apiRoutes) has a
  // functional /api/chat interrupt + /api/interrupts/resume, exactly like createApp.
  // Without this the storefront checkout would be dead on Cloud (drift).
  if (!rc.orderRunner) rc.orderRunner = buildOrderRunner(cfg, rc);

  // Top-level storage persists workflow run snapshots (TABLE_WORKFLOW_SNAPSHOT via
  // @mastra/mongodb) so a run suspended in the /chat request can be resumed in a separate
  // /interrupts/resume request (REQ-E-035). Memory keeps its own store on the agent; this
  // one backs workflows.
  const storage = new MongoDBStore({ id: 'mastra-store', uri: cfg.mongoUri, dbName: cfg.mongoDb });
  // Studio's metrics/observability panel needs a metrics-capable observability store.
  // MongoDB's observability domain persists spans/traces but NOT metrics (no aggregation),
  // so Studio shows "Metrics require ClickHouse/…/in-memory storage". Route ONLY the
  // observability domain to an in-memory store (which supports metrics + traces), leaving
  // workflows/memory/scores durable on MongoDB. In-memory observability is per-process and
  // resets on restart — fine for the demo; the composite still reports name 'MongoDBStore'.
  storage.stores.observability = new InMemoryStore({ id: 'obs-inmem' }).stores.observability;

  const mastra = new Mastra({
    agents: { concierge: agent },
    // The HITL order workflow (REQ-E-036): runnable/inspectable in Mastra Studio
    // and resumable by id from the /api/interrupts/resume route. Bound to the
    // shared route-context db (connection-free at construction).
    workflows: { 'place-order': buildPlaceOrderWorkflow(rc.db) },
    storage,
    // Observability entrypoint: feeds the Studio traces + metrics panels. The storage
    // exporter buffers spans/metrics/logs and flushes them to the instance's observability
    // store (the in-memory one wired above). Enabled for both the app and the `mastra dev`
    // studio process (same buildMastra), so metrics populate in Studio.
    observability: new Observability({
      configs: { default: { serviceName: 'concierge', exporters: [new MastraStorageExporter()] } },
    }),
    server: {
      // Move Mastra's built-in route prefix off `/api` so our custom `/api/*`
      // routes (which the frontend calls) do not collide with it (REQ-E-003).
      apiPrefix: '/mastra/api',
      apiRoutes: [
        ...buildApiRoutes(rc),
        // SPA fallback registered last: serves frontend/dist for any non-API GET.
        // Skip it under Mastra Studio (`mastra dev`, NODE_ENV=development) — there the
        // built-in playground owns `/`, and a `/*` catch-all would shadow it (and 503 on
        // the relative dist path, since dev runs from a different cwd).
        ...(process.env.NODE_ENV === 'development' ? [] : [buildSpaRoute()]),
      ],
    },
  });

  // Registering an observability entrypoint makes Mastra eagerly initialize storage (to wire
  // the exporter to the observability store), which kicks off MongoDB default-index creation.
  // Attach a catch so a failed/slow init (an unreachable cluster, or a placeholder URI in unit
  // tests) surfaces as a logged warning instead of an unhandled promise rejection that could
  // crash the process or leak across test files. Against a reachable cluster this resolves
  // quietly and the index creation still happens.
  void mastra.getStorage()?.init?.().catch((err: unknown) => {
    logger.warn('mastra storage init failed (non-fatal)', { err: String(err) });
  });

  return mastra;
}

export const mastra = buildMastra();

// Register the SSO adapter (AUTH_MODE=sso) at module load. Fire-and-forget: routes fail
// closed (401) until it resolves, so an early request cannot slip through unauthenticated.
// No-op in local demo mode. Guarded so importing this module in tests never triggers it.
if (process.env.AUTH_MODE === 'sso') {
  void initAuth(loadConfig()).catch(() => { /* logged inside initAuth */ });
}
