# Tasks — Dual-target deploy (Docker + Mastra Cloud)

TDD. Each task: write test (RED) → minimal code (GREEN) → full suite → demo → commit.
Handlers are moved, not rewritten, so many "tests" are regression assertions that must
stay green through the refactor.

## Traceability matrix

| Req ID | Test Case IDs | Status |
| --- | --- | --- |
| REQ-E-001 | routes.test.ts (cart shared handler), index.test.ts | ✅ Passing |
| REQ-E-002 | index.test.ts (routes registered + invokable) | ✅ Passing |
| REQ-E-003 | index.test.ts (apiPrefix=/mastra/api) + built-server demo | ✅ Passing |
| REQ-E-004 | routes.test.ts (SSE correlation→token→done) | ✅ Passing |
| REQ-E-005 | routes.test.ts + app.test.ts (/health 200) | ✅ Passing |
| REQ-E-006 | static.test.ts (SPA fallback + asset + traversal) | ✅ Passing |
| REQ-E-007 | config.test.ts (mongoPool defaults + overrides) | ✅ Passing |
| REQ-E-008 | build/start scripts + `mastra build` demo | ✅ Demo (built server serves /api/health) |
| REQ-E-009 | Dockerfile + compose + `docker build`/run demo | ✅ Demo (container healthy, /api/health, SPA) |
| REQ-E-010 | config-env-example.test.ts (.env.example completeness) | ✅ Passing |
| REQ-E-011 | routes.test.ts (connection-free construction) | ✅ Passing |
| INV-001 | app.test.ts `/auth/me` (existing) | ✅ Passing |
| INV-002 | app.test.ts `/feedback` (existing) | ✅ Passing |
| INV-003 | routes.test.ts cart shape + existing cart tests | ✅ Passing |
| INV-004 | routes.test.ts SSE + smoke-beats (env-gated) | ✅ Passing (unit); integration env-gated |
| INV-005 | projection.test.ts (files/resume 204) | ✅ Passing |
| INV-006 | cart.test.ts identity binding (existing) | ✅ Passing |
| INV-007 | index.test.ts (Mastra registers concierge agent) | ✅ Passing |
| INV-008 | full vitest suite (135 passed / 11 skipped) | ✅ Passing |

**Status: all tasks complete. `pnpm typecheck` (root+frontend) clean; 135 unit tests pass;
built Mastra server AND Docker container both serve `/api/health` + `/api/cart` + SPA.**

**LIVE END-TO-END VERIFICATION (2026-07-05, against real Atlas + Voyage + LLM):**
- Integration suite `smoke-beats.integration.test.ts`: **6/6 beats PASS** in 305s
  (multimodal HERO, hybrid+rerank, memory recall, semantic cache, NL→MQL, cart round-trip).
- Built Mastra server (`node .mastra/output/index.mjs`, the exact Cloud artifact): live
  `/api/health` 200, `/api/cart` correct shape, `/api/models`, SPA at `/`, and a full
  `/api/chat` SSE turn (correlation→status[knowledgeSearch]→tokens→done, grounded answer).
  Mastra API confirmed on `/mastra/api` (frees `/api/*`).
- Cart preset live: `dataQuery→cartAdd→cartRead` chain, cart persisted under real identity,
  subtotal $20.79 / savings $5.20 (matches the shopping-list plan's fix).
- Docker container: built, `Up (healthy)`, live `/api/health`, SPA + deep-link fallback +
  hashed asset (correct MIME), and a live cart turn → subtotal $68.79 / savings $17.20.
- Known cosmetic: `mastra build` prints "Invalid Mastra config" (entry is `buildMastra()`
  not a literal `new Mastra(...)`) — build+run correct regardless. Also the SPA `/*`
  catch-all shadows Mastra's built-in Studio routes under `/mastra/api/*`; harmless since
  the frontend only calls `/api/*`.

## Task 0: Pool config (smallest, unblocks nothing else) — REQ-E-007
- Files: MODIFY `src/config.ts`, `src/mastra/agent.ts`.
- Subtasks:
  1. RED: TC-E-007 — assert `loadConfig` yields `mongoPool: {maxPoolSize:100, minPoolSize:10}`
     by default and honors `MONGO_MAX_POOL_SIZE`/`MONGO_MIN_POOL_SIZE`.
  2. GREEN: add `mongoPool` to Config + `num()` env reads.
  3. Pass `{ maxPoolSize, minPoolSize }` to `new MongoClient` in `buildConciergeDeps`.
  4. TC-E-007b: assert `buildMastra()`/mastra registers a `concierge` agent (INV-007).
- Acceptance: pool opts defaulted + overridable; agent deps client gets them.
- Demo: `no demo applicable; config unit tests cover the surface`.

## Task 1: Extract handlers into `src/server/routes.ts` — REQ-E-001
- Files: CREATE `src/server/routes.ts`, `src/server/routes.test.ts`; MODIFY `src/server/app.ts`.
- Subtasks:
  1. RED: keep existing `app.test.ts` (`/auth/me`, `/feedback`) as the regression guard
     (INV-001, INV-002) — they must stay green after `createApp` becomes a wrapper.
  2. Move each route body into `handlers.*(rc)` returning a Hono handler. Move the
     `__testFeedbackCollection` seam into `buildRouteContext`.
  3. GREEN: `createApp` builds `RouteContext` and mounts handlers at bare paths.
  4. TC-E-003: a shared route (`/cart`) invoked through `createApp` returns the
     `{lines, subtotal, total_savings, updated_at}` shape (INV-003) — stub db via a
     RouteContext override.
  5. TC-E-011: constructing `buildRouteContext(cfg)` opens NO connection and runs NO
     seeding (assert no network by using a bogus URI and asserting construction doesn't
     throw / doesn't await a connect). (REQ-E-011)
- Acceptance: all existing server tests pass; `/cart` shape test passes; construction is
  connection-free.
- Demo: `npx tsx -e` or dev server — curl `/cart` (see Task 4 demo; combined).

## Task 2: `/health` route — REQ-E-005
- Files: MODIFY `src/server/routes.ts` (add `handlers.health`), `src/server/app.ts`.
- Subtasks:
  1. RED: TC-E-005 — `createApp(cfg).request('/health')` → 200 `{status:'ok'}`.
  2. TC-E-005b — `/files` GET and `/interrupts/resume` POST still 204 (INV-005).
  3. GREEN: add health handler; mount it.
- Acceptance: `/health` 200; 204 routes intact.
- Demo: curl `/health` on dev server.

## Task 3: Register routes + apiPrefix + SPA static on the Mastra instance — REQ-E-002/003/006
- Files: MODIFY `src/mastra/index.ts`; extend `src/server/routes.test.ts`.
- Subtasks:
  1. RED: TC-E-010 — build `mastra`, read `mastra.getServer()?.apiRoutes`, assert an entry
     exists for each browser path at `/api/<path>` (`/api/chat` POST, `/api/cart` GET,
     `/api/health` GET, …). Pull each route's `.handler` and exercise it on a throwaway
     `new Hono()` — assert `/api/health` → 200 and `/api/cart` → cart shape. (This tests
     the EXACT ApiRoute objects the deployer will mount, without needing @mastra/deployer.)
  2. TC-E-010b: assert `mastra.getServer()?.apiPrefix === '/mastra/api'` (REQ-E-003 — frees
     `/api/*`; a `/api/*` custom route is legal only because the prefix moved).
  3. TC-E-004: exercise the `/api/chat` route handler with a stubbed agent stream (reuse
     the existing SSE stubbing approach) → assert correlation + token + done frames.
  4. TC-E-006: SPA fallback handler returns `index.html` bytes for `/` and a non-API path;
     returns the asset for an asset path. (Stub the dist dir with a temp fixture.)
  5. GREEN: add `server: { apiPrefix, apiRoutes: [...], }`, register all handlers at
     `/api/<path>` + `requiresAuth:false`; add the SPA catch-all last. Keep `concierge`
     agent registered (INV-007).
- Acceptance: every route present on the Mastra server config and individually invokable;
  apiPrefix moved; SSE frames stream; SPA fallback works.
- Demo (TC-DEMO-build): add `mastra` dep (Task 5) then `pnpm build` + run built output OR
  `mastra dev`; curl `/api/health` and `/api/cart`. Paste output.

## Task 4: Build/start scripts + `.env.example` — REQ-E-008/010
- Files: MODIFY `package.json`, `.env.example`.
- Subtasks:
  1. Add devDep `mastra` (`@mastra/deployer` CLI); `pnpm install`.
  2. Add scripts `"build": "mastra build"`, `"start": "node <verified output path>"`.
  3. TC-E-010env: a test asserting `.env.example` contains every `process.env.*` key read
     by `src/config.ts` (parse config.ts for `env.X`, diff against `.env.example`).
  4. Verify `mastra build` output path; fix `start` accordingly.
- Acceptance: `pnpm build` produces a runnable server; `.env.example` complete.
- Demo (TC-DEMO-build): `pnpm build && pnpm start` (or `mastra dev`), curl `/api/health`.

## Task 5: Backend Dockerfile + compose — REQ-E-009
- Files: CREATE `Dockerfile`, `docker-compose.yml`, `.dockerignore`.
- Subtasks:
  1. Multi-stage Node 22-alpine: install → build frontend (`frontend/dist`) → `mastra
     build` → runtime stage runs built output as non-root, `EXPOSE ${PORT}`,
     `HEALTHCHECK` curling `/health`.
  2. `docker-compose.yml`: backend service, `env_file: .env`, port map, healthcheck.
  3. `.dockerignore`: node_modules, .git, tests, .env.
- Acceptance: image builds; compose config valid (`docker compose config`).
- Demo (TC-DEMO-docker, env-gated/manual): `docker compose up`, curl `/health` → 200;
  document the command + expected output. Paste if Docker+Atlas available; else mark
  `deferred (needs Docker + Atlas creds)` with the exact commands.

## Final verification (Phase 6)
- `pnpm typecheck` clean (root) + `cd frontend && npx tsc --noEmit`.
- `pnpm test` fully green (unit) — INV-008.
- Coverage of `src/server`, `src/mastra` not reduced; `routes.ts` directly tested.
- Realism: TC-E-010 crosses the Mastra route boundary for real (invokes the actual
  ApiRoute handler); TC-E-004 asserts SSE outcome; demos recorded per task.
- Integration beats (`pnpm test:integration`, env-gated) unchanged and still valid — the
  handlers they hit are the same objects.
