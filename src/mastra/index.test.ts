import { describe, it, expect, beforeAll } from 'vitest';
import { Hono } from 'hono';
import type { ApiRoute } from '@mastra/core/server';
import type { Config } from '../config';

const cfg = {
  mongoUri: 'mongodb+srv://u:p@c.mongodb.net/', mongoDb: 'db', voyageApiKey: 'vk',
  llmProvider: 'anthropic', llmModel: 'claude-opus-4-8', allowInsecure: false,
  responseCache: { enabled: false, ttlDays: 1, similarityThreshold: 0.9, maxAnswerBytes: 32768 },
  memory: { semanticRecall: false, lastMessages: 10 },
  rrfK: 60, dataAgentAllowList: ['products'], dataAgentLimit: 25,
  emitPlanFrames: false, ingestDescribe: true, port: 8000, defaultUserId: 'demo',
  mongoPool: { maxPoolSize: 100, minPoolSize: 10 },
} as Config;

// The module eagerly builds `mastra` from process.env at import (Mastra deployer
// convention). Provide a valid env so importing the module does not throw.
beforeAll(() => {
  process.env.MONGODB_URI ??= 'mongodb+srv://u:p@c.mongodb.net/';
  process.env.MONGODB_DATABASE ??= 'db';
  process.env.VOYAGE_API_KEY ??= 'vk';
  process.env.LLM_MODEL ??= 'claude-opus-4-8';
});

// Import lazily (after env is set) to avoid the eager loadConfig() at collect time.
async function mod() { return import('./index'); }

/** Mount a single ApiRoute's handler on a throwaway Hono to exercise the exact
 * object the deployer will mount (we can't boot the real Mastra HTTP server in
 * this test since @mastra/deployer isn't installed). */
function mountRoute(route: ApiRoute) {
  const app = new Hono();
  const path = (route as any).path as string;
  const method = ((route as any).method as string).toLowerCase() as 'get' | 'post';
  const handler = (route as any).handler;
  (app as any)[method](path, handler);
  return app;
}

describe('buildMastra (INV-007: concierge agent + REQ-E-003: apiPrefix)', () => {
  it('registers the concierge agent so Mastra Studio keeps working', async () => {
    const mastra = (await mod()).buildMastra(cfg);
    expect(mastra.getAgent('concierge')).toBeDefined();
  });

  it('moves the built-in apiPrefix off /api to free /api/* for custom routes', async () => {
    const mastra = (await mod()).buildMastra(cfg);
    expect(mastra.getServer()?.apiPrefix).toBe('/mastra/api');
  });

  // REQ-E-035: workflow run snapshots must persist so a run suspended in the
  // /chat request resumes in a separate /interrupts/resume request. Assert the
  // real MongoDBStore is configured — not Mastra's in-memory fallback (which
  // would make `getStorage()` truthy but non-durable).
  it('registers a durable MongoDBStore for workflow run snapshots', async () => {
    const mastra = (await mod()).buildMastra(cfg);
    const storage = mastra.getStorage() as any;
    // `getStorage()` returns a MastraCompositeStore; its `name` reflects the
    // configured adapter ('MongoDBStore', not the in-memory fallback), and its
    // `workflows` sub-store backs run snapshots (TABLE_WORKFLOW_SNAPSHOT).
    expect(storage?.name).toBe('MongoDBStore');
    expect(storage?.stores?.workflows?.constructor?.name).toContain('Workflows');
  });

  // REQ-E-036: the order workflow is registered so it appears in Studio and is
  // resumable by id from the resume route.
  it('registers the place-order workflow on the instance', async () => {
    const mastra = (await mod()).buildMastra(cfg);
    expect(mastra.getWorkflow('place-order')).toBeDefined();
  });

  // Studio metrics require a real (non-NoOp) observability entrypoint whose observability
  // store supports metrics. We keep MongoDB as the durable top-level store but route ONLY
  // the observability domain to an in-memory store (which supports metrics + traces), so
  // Studio's metrics panel populates instead of showing the "requires ClickHouse/…/in-memory"
  // message. Assert both: a configured observability entrypoint, and the in-memory obs domain.
  it('configures a real observability entrypoint with a metrics-capable (in-memory) obs store', async () => {
    const mastra = (await mod()).buildMastra(cfg);
    const obs = mastra.observability as any;
    expect(obs).toBeDefined();
    expect(obs.constructor?.name).not.toBe('NoOpObservability');
    const storage = mastra.getStorage() as any;
    // Top-level store stays MongoDB (durable workflows) …
    expect(storage?.name).toBe('MongoDBStore');
    // … but the observability domain is the in-memory one (metrics-capable).
    expect(storage?.stores?.observability?.constructor?.name).toContain('InMemory');
  });

  it('registers every browser route on the server under /api/*', async () => {
    const mastra = (await mod()).buildMastra(cfg);
    const routes = mastra.getServer()?.apiRoutes ?? [];
    const paths = routes.map(r => `${(r as any).method} ${(r as any).path}`);
    for (const expected of [
      'GET /api/health', 'POST /api/chat', 'GET /api/models', 'GET /api/auth/me',
      'GET /api/stats', 'GET /api/cart', 'GET /api/messages', 'GET /api/threads/latest',
      'GET /api/files', 'POST /api/interrupts/resume', 'POST /api/feedback',
    ]) {
      expect(paths).toContain(expected);
    }
    // SPA fallback present and registered LAST.
    expect((routes[routes.length - 1] as any).path).toBe('/*');
  });

  // Under Mastra Studio (`mastra dev`, NODE_ENV=development) the built-in playground
  // owns `/`; our storefront `/*` catch-all must NOT be registered there or it shadows
  // the playground and 503s ("SPA not built") on the relative dist path.
  it('omits the storefront /* SPA fallback in development (Studio owns /)', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const mastra = (await mod()).buildMastra(cfg);
      const paths = (mastra.getServer()?.apiRoutes ?? []).map(r => (r as any).path);
      expect(paths).not.toContain('/*');
      // The API routes are still present in dev.
      expect(paths).toContain('/api/health');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('buildApiRoutes handlers are invokable (REQ-E-002 / boundary #2)', () => {
  it('GET /api/health handler returns 200 { status: ok }', async () => {
    const { buildApiRoutes } = await mod();
    const { buildRouteContext } = await import('../server/routes');
    const routes = buildApiRoutes(buildRouteContext(cfg));
    const health = routes.find(r => (r as any).path === '/api/health')!;
    const res = await mountRoute(health).request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /api/cart handler returns the derived cart shape (same handler as createApp)', async () => {
    const { buildApiRoutes } = await mod();
    const { buildRouteContext } = await import('../server/routes');
    const rc = buildRouteContext(cfg);
    (rc as any).db = { collection: () => ({ findOne: async () => ({
      lines: [{ product_id: 'p1', name: 'Mug', qty: 2, unit_price_usd: 10, sale_price_usd: 8, applied_coupons: [], line_savings: 4 }],
      updated_at: null,
    }) }) };
    const cart = buildApiRoutes(rc).find(r => (r as any).path === '/api/cart')!;
    const res = await mountRoute(cart).request('/api/cart?user_id=demo&thread_id=t1');
    expect(res.status).toBe(200);
    const body = await res.json() as { subtotal: number; total_savings: number };
    expect(body.subtotal).toBe(16);
    expect(body.total_savings).toBe(4);
  });
});
