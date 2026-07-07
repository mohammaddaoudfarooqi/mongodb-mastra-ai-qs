# Design Delta — Dual-target deploy (Docker + Mastra Cloud)

Documents only what changes. Existing architecture (agent, tools, cache, memory) is
unchanged except where noted.

## Modified components

### 1. Route handlers extracted (`src/server/routes.ts` — NEW)
`createApp` (`src/server/app.ts`) currently defines route logic inline over closures on
`cfg`, a `MongoClient`, `cache`, `getSharedDeps`. Extract that into a **RouteContext** +
handler functions:

```ts
export interface RouteContext {
  cfg: Config;
  db: Db;
  cache: SemanticResponseCache;
  getSharedDeps: () => ConciergeDeps;
  nextCorrelationId: () => string;
  feedbackCollection?: any; // __testFeedbackCollection seam
}
export function buildRouteContext(cfg: Config): RouteContext { /* owns client, db, cache */ }

export const handlers = {
  chat:      (rc: RouteContext) => (c: Context) => Promise<Response>,
  models:    (rc) => (c) => Response,
  authMe:    (rc) => (c) => Response,
  stats:     (rc) => (c) => Promise<Response>,
  cart:      (rc) => (c) => Promise<Response>,
  messages:  (rc) => (c) => Promise<Response>,
  latestThread: (rc) => (c) => Promise<Response>,
  files:     () => (c) => Response,          // 204
  resume:    () => (c) => Response,           // 204
  feedback:  (rc) => (c) => Promise<Response>,
  health:    (rc) => (c) => Response,         // NEW
};
```

Each handler is the exact body currently inside the corresponding `app.<verb>(...)`
callback — moved, not rewritten. The SSE `/chat` handler keeps `stream(c, ...)` from
`hono/streaming` (Mastra route handlers return a `Response`; Hono's `stream()` returns
one, and Mastra's server IS Hono, so this composes).

### 2. `createApp` becomes a thin wrapper (`src/server/app.ts` — MODIFIED)
`createApp(cfg)` builds a `RouteContext` (or accepts one for tests) and mounts the
handlers onto a fresh `Hono()` at the current bare paths (`/chat`, `/cart`, …). Behavior
identical → INV-001..005, INV-008 hold. The `__testFeedbackCollection` seam moves into
`buildRouteContext` (reads `(cfg as any).__testFeedbackCollection`).

### 3. Mastra instance registers the routes (`src/mastra/index.ts` — MODIFIED)
```ts
const rc = buildRouteContext(cfg);
export const mastra = new Mastra({
  agents: { concierge },              // INV-007 unchanged
  server: {
    apiPrefix: '/mastra/api',         // REQ-E-003: free /api/* for our routes
    apiRoutes: [
      registerApiRoute('/health',  { method: 'GET',  requiresAuth: false, handler: handlers.health(rc) }),
      registerApiRoute('/chat',    { method: 'POST', requiresAuth: false, handler: handlers.chat(rc) }),
      registerApiRoute('/cart',    { method: 'GET',  requiresAuth: false, handler: handlers.cart(rc) }),
      // …every route… all under the browser-facing bare path (served at /<path>, since apiPrefix moved)
    ],
  },
});
```
NOTE: with `apiPrefix='/mastra/api'`, custom routes mount at their literal path
(`/chat`, `/cart`, …). The **frontend** calls `/api/*`; see §5 for reconciliation.

### 4. Mongo pool tuning (`src/config.ts`, `src/mastra/agent.ts`, `src/server/routes.ts` — MODIFIED)
Add `mongoPool: { maxPoolSize, minPoolSize }` to `Config` (env `MONGO_MAX_POOL_SIZE`
default 100, `MONGO_MIN_POOL_SIZE` default 10). Pass to every runtime `new MongoClient`
(agent deps + route context). Ingestion scripts (`seed.ts`, `ingest-multimodal.ts`) are
one-off — left as-is (small pool is fine), REQ-E-011.

### 5. Frontend API base reconciliation
The browser calls `/api/*` (hardcoded, and Mastra's default prefix). Two clean options;
we pick **(a)** for same-origin simplicity:
- **(a) Serve routes at bare paths + one static server that also serves the SPA.** The
  deployed origin serves `/chat`, `/cart`, … AND `/api/*` must reach them. Simplest: add
  a tiny middleware/route alias so `/api/<x>` maps to `/<x>` on the Mastra server, OR
  register the custom routes at `/api/<x>` — but that collides with the default prefix,
  which is why REQ-E-003 moves the prefix to `/mastra/api`, making `/api/*` legal for
  custom routes. **Chosen: register custom routes at `/api/<path>`** (legal once prefix
  moved), so the browser's `/api/chat` hits our handler with zero rewrite in prod. In
  `createApp` (Docker-hermetic tests) keep bare paths to avoid churning existing tests;
  the Mastra registration uses `/api/<path>`. Dev Vite proxy already targets the Docker
  backend on bare paths — unchanged.
  - Consequence: handlers are path-agnostic (they read query/body, not path), so the
    same handler serves `/chat` (createApp) and `/api/chat` (Mastra). No drift.

### 6. SPA static serving (`src/mastra/index.ts` / server build — NEW)
Serve `frontend/dist` from the Mastra server: a catch-all GET route (registered last,
`requiresAuth:false`) that returns `index.html` for non-API/non-asset paths and the
static asset otherwise (REQ-E-006). Docker copies `frontend/dist` into the image.

### 7. Build & deploy tooling (NEW / MODIFIED)
- `package.json`: add devDep `mastra` (`@mastra/deployer`), scripts
  `"build": "mastra build"`, `"start": "node .mastra/output/index.mjs"` (verify path),
  keep `"dev"`.
- `Dockerfile` (backend, NEW): multi-stage Node 22-alpine → `mastra build` → run
  `.mastra/output`, non-root, `EXPOSE ${PORT}`, `HEALTHCHECK` on `/health`.
- `docker-compose.yml` (root, NEW): `backend` service, env from `.env`, healthcheck.
- `.env.example` (MODIFIED): add pool sizes; ensure all keys present.

## Files to modify vs create

| Action | File |
| --- | --- |
| CREATE | `src/server/routes.ts` (RouteContext + handlers) |
| CREATE | `src/server/routes.test.ts` (handler-level + Mastra-surface tests) |
| CREATE | `Dockerfile` (backend), `docker-compose.yml`, `.dockerignore` |
| MODIFY | `src/server/app.ts` (thin wrapper over handlers) |
| MODIFY | `src/mastra/index.ts` (server.apiRoutes + SPA static + apiPrefix) |
| MODIFY | `src/config.ts` (mongoPool config) |
| MODIFY | `src/mastra/agent.ts` (pass pool opts to MongoClient) |
| MODIFY | `package.json` (mastra dep + build/start scripts) |
| MODIFY | `.env.example` (pool sizes, completeness) |
| MODIFY | `src/server/app.test.ts` (only if wrapper signature changes; keep assertions) |

## Boundary Inventory

| # | Boundary | From | To | Acceptance test |
| - | --- | --- | --- | --- |
| 1 | HTTP entry (Hono) | test client | `createApp` route | TC-E-001 (`app.request('/health')` 200) — existing seam |
| 2 | HTTP entry (Mastra) | test client | `mastra` instance fetch handler → custom `/api/*` route | TC-E-010 (fetch the Mastra server handler for `/api/health`, `/api/cart`) |
| 3 | SSE stream | `/chat` handler | client EventSource | TC-E-004 (assert correlation+token+done frames from the handler over both surfaces) |
| 4 | Handler-shared contract | `createApp` `/cart` | Mastra `/api/cart` | TC-E-003 (same handler yields same body shape on both surfaces) |
| 5 | Sync→Async DB | route handler | `MongoClient` w/ pool opts | TC-E-007 (assert pool options passed; existing integration beats cross to real Atlas) |
| 6 | Static SPA | browser GET `/` | `frontend/dist/index.html` | TC-E-006 (SPA fallback returns index.html; asset path returns asset) — unit over the static handler |
| 7 | Build artifact | `mastra build` | runnable server | TC-DEMO (phase-end: run built/dev server, curl `/api/health` + `/api/cart`) |
| 8 | Container | `docker compose up` | live backend on Atlas | TC-DEMO (manual: compose up, curl `/health`) — env-gated, documented |

Boundaries 7–8 need real infra (build toolchain / Docker + Atlas); covered by phase-end
demos, not unit tests. All in-process boundaries (1–6) have unit acceptance tests.

## Mock-parity note
The Mastra `server.apiRoutes` handler and the `createApp` handler are the **same function
object** (REQ-E-001) — parity is structural, not asserted by duplication. TC-E-003
additionally exercises a shared route through *both* surfaces to prove no wrapper-level
divergence (the realism check for boundary #4).

## Test infrastructure
Already exists (vitest). No bootstrap needed. New tests co-located: `src/server/routes.test.ts`.
