# MongoDB x Mastra "Better Together" Quickstart

A retail shopping concierge that showcases MongoDB x Mastra capabilities, all on a single Atlas
cluster: multimodal retrieval (Voyage multimodal embeddings), hybrid search with reranking (RRF +
Voyage rerank), cross-thread agent memory (Mastra resource-scoped semantic recall + working memory
on MongoDB), a semantic response cache (vector search + TTL), a safety-wrapped natural-language
data agent (NL to MQL), and a human-in-the-loop **order workflow** (Mastra `suspend`/`resume` to
transactional order placement with inventory effects). A Mastra concierge answers knowledge-base
questions directly and delegates live retail data and the cart to a `dealsAndCart` specialist.
TypeScript, Mastra, Hono, and a Vite/React storefront.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the "one cluster" diagram and a per-capability code map.

## Better together: Mastra agents on one MongoDB cluster

The story this app tells: **Mastra** supplies the agent, tools, memory, and durable workflow;
**MongoDB Atlas** is the single backbone underneath all of it. No second datastore, no bolt-on
vector database, no separate cache. One cluster plays six roles.

### Architecture

<p align="center">
  <img src="./frontend/public/architecture.png" width="768" alt="Architecture">
</p>

Runtime path of a single turn:

### Control Flow

<p align="center">
  <img src="./frontend/public/flow.png" width="768" alt="Control Flow">
</p>

## Quick start (Docker + Studio, one command)

```bash
cp .env.example .env    # fill in MONGODB_URI, VOYAGE_API_KEY, LLM creds
pnpm setup              # provisions Atlas, seeds, builds+runs the app in Docker,
                        # launches Mastra Studio, and opens the browser
```

`pnpm setup` opens the storefront (http://localhost:8000), Mastra Studio (http://localhost:4111),
and the API docs (http://localhost:8000/mastra/api). Transactional checkout requires an Atlas /
replica-set cluster (multi-document transactions). For the manual, process-by-process path, read on.

`pnpm setup` runs Studio on the host. To run it in a container instead, use the opt-in `studio`
compose profile (a plain `docker compose up` runs only the production app):

```bash
docker compose up -d --build                    # app only (storefront + API on :8000)
docker compose --profile studio up -d --build   # app + Mastra Studio (:4111)
```

## Prerequisites

- Node 22 or newer, pnpm (backend), npm (frontend).
- A MongoDB Atlas cluster (vector search enabled).
- A MongoDB Atlas Voyage key and an Anthropic-compatible LLM endpoint (see `.env.example`).

## Setup

1. Copy `.env.example` to `.env` and fill in `MONGODB_URI`, `MONGODB_DATABASE`, `VOYAGE_API_KEY`,
   and the LLM settings. The `.env` is git-ignored; never commit it.
2. Install backend deps: `pnpm install`.
3. Provision indexes, seed data, and ingest the image assets:

   ```bash
   pnpm provision   # knowledge_base vector + search indexes, response cache index + TTL
   pnpm seed        # ~1505 products, 20 orders, 5 promotions, and the text knowledge base
   pnpm embed       # ingest the committed image assets (multimodal)
   ```

### PDF ingestion

The multimodal ingestion step also ingests PDFs. Each page is rasterized to an image and
embedded as one `knowledge_base` document per page (`metadata.mediaType: "pdf"`, `metadata.page`),
so a query can surface a specific catalog page. `pnpm embed` picks up any `mediaType: "pdf"` entry
in `src/ingestion/assets/manifest.json`.

The demo ships a generated `catalog.pdf` (Summer 2026 catalog, derived from the seeded products
and promotions). It is visually rich on purpose (real product photos, color themes, sale ribbons,
coupon tickets) so page-render embedding captures signal a text layer would drop. The product
photos under `src/ingestion/assets/product-images/` are committed CC0 (public domain, no
attribution required, no watermark); `CREDITS.json` records each source. To regenerate:

    pnpm make:catalog            # rebuild catalog.pdf from the committed photos + seeded data
    pnpm fetch:catalog-images    # (optional) re-download the CC0 product photos first

Rasterization resolution is controlled by `INGEST_PDF_SCALE` (default `2.0`).

## Run

Two processes. Start the backend first (it serves on port 8000):

```bash
pnpm dev           # backend on http://localhost:8000
```

Then the frontend (Vite dev server on port 3000, proxying /api to the backend):

```bash
cd frontend
npm install
npm run dev        # storefront on http://localhost:3000
```

Open http://localhost:3000. The storefront loads with a chat assistant. Each preset card drives
one demo beat:

- Multimodal retrieval (HERO): "Show me the summer sale pamphlet and tell me what it is promoting."
- Hybrid + rerank (recipes): "Share a quick pasta recipe I can make tonight."
- Hybrid + rerank (loyalty): "How does your loyalty program work, and how do points convert to rewards?"
- Memory: "Remember that I prefer eco-friendly kitchen products," then "Based on what you know
  about me, what kitchen items would you recommend?"
- Cart / shopping list: "Add the on-sale kitchen product with the biggest savings to my cart and
  show my total savings."
- Semantic cache: "How long does shipping take?" (ask twice to see the instant cached reply).
- NL to MQL data agent: "Show me a few products that are on sale, with their sale prices."

For the human-in-the-loop order workflow, add something to the cart, then say "check out." The
agent pauses for your approval, and on approve places the order in a MongoDB transaction (writes
`orders`, decrements `products.stock`, clears the cart). It is also runnable from Mastra Studio's
workflow runner.

Rate any reply with the thumbs buttons; ratings persist to the `feedback` collection.

## Ports and proxy

The frontend calls `/api/*`; its Vite dev proxy (and the prod nginx config) rewrite `/api/*` to
`/*` and forward to the backend on port 8000. If you change the backend port, update the proxy
target in `frontend/vite.config.ts`.

## Tests

- Backend unit tests: `pnpm vitest run` (Atlas integration and smoke suites skip without env).
- Backend + smoke against a live cluster (uses a separate test database so it never touches demo
  data):

  ```bash
  node --env-file=.env --env-file=.env.integration.local node_modules/vitest/vitest.mjs run tests/integration
  ```

  where `.env.integration.local` sets `MONGODB_DATABASE=mongodb_mastra_qs_test` (git-ignored).
- Frontend tests: `cd frontend && npm test`.

## Reset

To wipe the app-owned collections (leaves Mastra-managed `mastra_*` tables intact), then rebuild:

```bash
pnpm teardown
pnpm provision && pnpm seed && pnpm embed
```

## Notes

- The `.env` `VOYAGE_API_KEY` is a MongoDB Atlas Voyage key; it authenticates against the
  MongoDB-hosted Voyage endpoint (`VOYAGE_BASE_URL`, default `https://ai.mongodb.com/v1`).
- Human-in-the-loop checkout is implemented: the storefront's approval card drives the order
  workflow via the `/api/interrupts/resume` SSE flow. There is no real SSO in this quickstart;
  `/auth/me` returns a fixed dev user derived from `DEFAULT_USER_ID`.
