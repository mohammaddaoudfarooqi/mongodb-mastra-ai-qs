# Requirements — Dual-target deploy (Docker + Mastra Cloud)

**Workflow:** Enhancement (brownfield, tests exist).
**Goal:** the app deploys to **both** a self-hosted Docker container and **Mastra
Cloud (`projects.mastra.ai`)** from one codebase, serving byte-identical routes, with
the React SPA served by the same backend. Precursor for the later multi-agent work in
`to_do.md`.

## Codebase Context (from Phase 0)

- **Stack:** TypeScript (ESM, Node ≥22.13), Hono server, Mastra (`@mastra/core@1.49.0`,
  `@mastra/memory`, `@mastra/mongodb`), MongoDB Atlas, Voyage. Runner: vitest.
- **Current entry:** `tsx src/server/app.ts` builds a bespoke Hono app (`createApp`) with
  all routes; `src/mastra/index.ts` exports a `Mastra()` instance used *only* for Studio.
- **Verified API facts (`@mastra/core@1.49.0`):**
  - `registerApiRoute(path, { method, handler, requiresAuth? })` and
    `server.apiRoutes: ApiRoute[]` exist. Handler gets a Hono `Context`; SSE supported.
  - `server.apiPrefix` defaults to `/api`; **custom route paths may not start with the
    active `apiPrefix`** (reserved for built-in Mastra routes). Setting
    `apiPrefix: '/mastra/api'` frees `/api/*` for custom routes.
  - The `mastra` CLI (`mastra build`) is **not** currently a dependency.
- **Frontend:** `frontend/src/api/client.ts` hardcodes `API_BASE = '/api'`; dev uses a
  Vite proxy rewriting `/api → /` onto port 8000. Build output `frontend/dist` (Vite
  default).
- **Route surface to preserve:** `POST /chat` (SSE), `GET /models`, `GET /auth/me`,
  `GET /stats`, `GET /cart`, `GET /messages`, `GET /threads/latest`, `GET /files` (204),
  `POST /interrupts/resume` (204), `POST /feedback`.
- **Existing tests that must stay green:** `src/server/app.test.ts` (calls
  `createApp(cfg).request(...)`, uses `__testFeedbackCollection` seam), `sse.test.ts`,
  `feedback.test.ts`, `projection.test.ts`, cart/agent unit tests, integration beats.

## Decisions (from user)

- **D1 — One Mastra server.** Routes move onto the Mastra instance's `server.apiRoutes`
  as the single deployable artifact. `createApp` is refactored into a thin Hono wrapper
  over the SAME shared handler functions, retained so hermetic route tests stay green.
- **D2 — SPA served by the backend.** The built SPA (`frontend/dist`) is served static
  by the same server (same origin as the API).

## Functional Requirements

- **REQ-E-001** (Ubiquitous): THE SYSTEM SHALL define each HTTP route's logic as a
  framework-agnostic handler function that accepts a Hono `Context` and the app
  dependencies, callable from both the Mastra instance's `apiRoutes` and `createApp`.
- **REQ-E-002** (Ubiquitous): THE SYSTEM SHALL register every current route
  (`/chat`, `/models`, `/auth/me`, `/stats`, `/cart`, `/messages`, `/threads/latest`,
  `/files`, `/interrupts/resume`, `/feedback`) on the `Mastra()` instance via
  `server.apiRoutes`, using the same handler functions as `createApp` (REQ-E-001).
- **REQ-E-003** (Ubiquitous): THE SYSTEM SHALL set the Mastra server `apiPrefix` to a
  non-`/api` value (`/mastra/api`) so custom routes remain reachable at `/api/*` for the
  browser and do not collide with built-in Mastra routes.
- **REQ-E-004** (Event-Driven): WHEN a client sends `POST /chat`, THE SYSTEM SHALL stream
  Server-Sent Events (correlation, token, status, done/error frames) through the
  Mastra-registered route identically to the current `createApp` behavior.
- **REQ-E-005** (Ubiquitous): THE SYSTEM SHALL expose `GET /health` returning HTTP 200
  with a JSON liveness body, registered on BOTH the Mastra instance and `createApp`, and
  requiring no auth.
- **REQ-E-006** (Event-Driven): WHEN a browser requests a non-API, non-asset path (an SPA
  route), THE SYSTEM SHALL serve the built `frontend/dist/index.html` (SPA fallback), and
  WHEN it requests a built asset path, THE SYSTEM SHALL serve that static file.
- **REQ-E-007** (Ubiquitous): THE SYSTEM SHALL construct every runtime `MongoClient`
  (server + agent deps) with `maxPoolSize` and `minPoolSize` options sourced from config
  (env-overridable), defaulting to 100 / 10.
- **REQ-E-008** (Ubiquitous): THE SYSTEM SHALL provide a `mastra build` npm script and a
  `start` script that runs the built Mastra server output, with `@mastra/deployer` (the
  `mastra` CLI) added as a dev dependency.
- **REQ-E-009** (Ubiquitous): THE SYSTEM SHALL provide a backend `Dockerfile` (Node 22,
  multi-stage, non-root) that builds via `mastra build` and runs the built server, and a
  root `docker-compose.yml` bringing up the backend against Atlas with a `/health`
  healthcheck.
- **REQ-E-010** (Ubiquitous): THE SYSTEM SHALL document env vars required for both targets
  in `.env.example` (Mongo URI/DB, Voyage key, LLM creds, pool sizes, port), so Mastra
  Cloud's first-deploy env seeding and Docker both have a complete reference.
- **REQ-E-011** (State-Driven): WHILE running under `mastra build` output OR the Docker
  image, THE SYSTEM SHALL NOT run data ingestion/seeding as part of build or server
  startup (ingestion stays a separate one-off script), to respect the 15-minute build cap
  and ephemeral filesystem.

## Unchanged Behavior (invariants — regression protection)

- **INV-001**: WHEN `createApp(cfg).request('/auth/me')` is called, THE SYSTEM SHALL
  CONTINUE TO return 200 with `{ email, username, groups }` derived from `defaultUserId`.
- **INV-002**: WHEN `POST /feedback` receives a valid body, THE SYSTEM SHALL CONTINUE TO
  return 204 and upsert a doc keyed by `run_id`; invalid → 400; Mongo write throw → 204
  (fail-open). (Covers the `__testFeedbackCollection` seam.)
- **INV-003**: WHEN `GET /cart` is called for a `{user_id, thread_id}`, THE SYSTEM SHALL
  CONTINUE TO return `{ lines, subtotal, total_savings, updated_at }` with totals derived
  via `computeCartTotals`, and an empty cart on error.
- **INV-004**: WHEN `POST /chat` runs (miss path), THE SYSTEM SHALL CONTINUE TO emit the
  correlation → token(s) → done frame sequence and honor the semantic response cache
  read/write eligibility rules.
- **INV-005**: THE SYSTEM SHALL CONTINUE TO expose `GET /files` and
  `POST /interrupts/resume` as 204 no-content.
- **INV-006**: THE SYSTEM SHALL CONTINUE TO bind cart tools to the turn identity
  `{userId, threadId}` (closure, never model-supplied) — no regression of the prior fix.
- **INV-007**: THE `Mastra()` instance SHALL CONTINUE TO register the `concierge` agent so
  Mastra Studio keeps working.
- **INV-008**: All existing unit + integration tests SHALL CONTINUE TO pass unchanged
  (except additive changes to `app.test.ts`/new files).

## Non-Functional

- **REQ-NF-COV**: THE SYSTEM SHALL keep the vitest suite green with no reduction in
  coverage of `src/server` and `src/mastra`; new handler module SHALL have direct tests.

## Premortem — top 5 ways this fails in production

| # | Failure mode | Mitigation (EARS) |
| - | --- | --- |
| 1 | Mastra reserves `/api/*`; our routes registered at `/api/chat` are shadowed by built-in routes → 404/blank on Cloud. | REQ-E-003: THE SYSTEM SHALL set `apiPrefix='/mastra/api'` and a mock-parity test SHALL assert a custom `/api/*` route is reachable on the Mastra instance's fetch handler. |
| 2 | SSE `/chat` works on Hono but the Mastra route wrapper buffers the stream → client hangs. | REQ-E-004: THE SYSTEM SHALL cover `/chat` via the Mastra instance fetch handler with a test asserting streamed SSE frames arrive incrementally (done frame present). |
| 3 | Handler extraction drifts: `createApp` and Mastra routes diverge, one path fixed but not the other. | REQ-E-001/002: BOTH surfaces SHALL be built from the SAME handler functions; a test SHALL assert the two route tables reference identical handlers (or exercise both surfaces for a shared route). |
| 4 | Ingestion runs at build/startup → 15-min Cloud build cap exceeded, or ephemeral FS write fails. | REQ-E-011: THE SYSTEM SHALL keep ingestion out of build/startup; a test SHALL assert server construction performs no seeding and opens no eager connection. |
| 5 | Untuned Mongo pool exhausts connections under demo concurrency → stalled requests. | REQ-E-007: THE SYSTEM SHALL set `maxPoolSize/minPoolSize` from config on every runtime `MongoClient`; a test SHALL assert the options are passed. |

Each premortem row maps to a requirement above and yields ≥1 acceptance test in tasks.md.
