# Architecture: MongoDB x Mastra concierge

A reference architecture for building an AI shopping concierge on **one MongoDB Atlas cluster**.
The same cluster is the operational database, the vector store, the agent memory, the semantic
response cache, the order ledger, the workflow-snapshot store, and the application log store, with
no second datastore.

## One cluster, seven roles

```
                          ┌───────────────────────────────────────────────┐
   React storefront       │                MongoDB Atlas                  │
   (frontend/, SPA)       │                                               │
        │  /api/* SSE     │  products / orders / promotions   (data)      │
        ▼                 │  knowledge_base        (vector + text search) │
  Hono / Mastra server    │  mastra_messages/threads   (agent memory)     │
  (src/server, src/mastra)│  semantic_response_cache   (vector + TTL)     │
        │                 │  orders + products.stock   (transactions)     │
        ▼                 │  mastra_workflow_snapshot  (suspend/resume)   │
  Concierge router  ──────┤  app_logs                  (logs, TTL)        │
   ├─ knowledge  spec.    └───────────────────────────────────────────────┘
   ├─ dealsAndCart spec.
   └─ place-order workflow (HITL)
        ▲   Voyage embeddings + rerank (multimodal)   LLM (Anthropic / Bedrock)
        └── external model calls
```

Observability is the one signal that does not live on Atlas. MongoDB's observability store keeps
traces and spans, but not metrics (it has no aggregation), so the Mastra instance routes only the
observability metrics domain to an in-memory store and keeps everything else on Atlas. Studio's
metrics panel reads that in-memory store; it resets on restart.

The frontend talks only to `/api/*` (SSE for chat). Mastra's own routes live under `/mastra/api`
so `/api/*` is free for the app's handlers; the same handler functions mount on both the standalone
Hono app (`createApp`, dev/Docker) and the Mastra instance's `server.apiRoutes` (Cloud), so the two
deploy surfaces never drift.

## Request path

1. Browser → `POST /api/chat` (SSE). `src/server/routes.ts` `handlers.chat`.
2. A per-turn concierge is built (`src/mastra/agent.ts` `buildConcierge`): a **router** over two
   specialists (`knowledge`, `dealsAndCart`) sharing one `Memory`.
3. The router delegates; tools run; tokens stream back as SSE `token` frames.
4. On checkout intent the `checkout` tool flips `TurnContext.checkoutRequested`; the handler starts
   the `place-order` workflow, which **suspends**, and emits a non-terminal `interrupt` SSE frame.
5. The storefront's approval card POSTs `/api/interrupts/resume`; the run resumes and commits.

## Per-capability code map

| Capability | Entry / key files | MongoDB surface |
| --- | --- | --- |
| Multi-agent router + specialists | `src/mastra/agent.ts` (`buildConcierge`) | — |
| Multimodal retrieval | `src/ingestion/ingest-multimodal.ts`, `src/ingestion/pdf.ts`, `src/mastra/vector.ts` | `knowledge_base` (vector) |
| Hybrid search + rerank | `src/mastra/tools/knowledge-search.ts`, `src/mastra/tools/rrf.ts` | `knowledge_base` (vector + text, RRF) |
| Cross-thread memory | `src/mastra/agent.ts` (`Memory`: resource-scoped `semanticRecall` + `workingMemory`) | `mastra_messages`, `mastra_threads` |
| Semantic response cache | `src/cache/semantic-response-cache.ts`, `src/cache/cache-decisions.ts` | `semantic_response_cache` (vector + TTL) |
| NL → MQL data agent | `src/mastra/tools/data-agent.ts`, `src/mastra/tools/mql-guard.ts` | `products`, `orders`, `promotions` |
| Cart | `src/mastra/tools/cart.ts` | `carts` |
| Order workflow (HITL) | `src/mastra/workflows/place-order.ts`, `src/mastra/tools/checkout.ts`, `src/server/order-runner.ts`, `src/server/routes.ts` (`resume`) | `orders` + `products.stock` + `carts` (transaction), `mastra_workflow_snapshot` |
| SSE framing | `src/server/sse.ts` (`toCartsmithFrames`) | — |
| App logging | `src/observability/logger.ts` (`LogSink`), `src/observability/mongo-log-sink.ts` | `app_logs` (buffered writes, TTL) |
| Observability / Studio metrics | `src/mastra/index.ts` (`Observability` + in-memory metrics domain) | traces on Atlas, metrics in-memory |
| DI / route registration | `src/mastra/index.ts` (`buildMastra`), `src/server/app.ts` (`createApp`) | top-level workflow `storage` |

## Order workflow: suspend / resume across two requests

```
POST /api/chat  ──▶ concierge calls `checkout` tool ──▶ start place-order run
                     build-quote (read cart, verify stock, compute totals)
                     approve-order  ── suspend ──▶  interrupt SSE frame + done
                                                    (run snapshot persisted in
                                                     mastra_workflow_snapshot)

POST /api/interrupts/resume {thread_id, decision}
                     resume run by deterministic runId `checkout:<thread_id>`
                     place-order (decision=approve):
                       ONE MongoDB transaction:
                         insert orders doc  +  $inc products.stock -qty  +  clear cart
                     ──▶ confirmation SSE token + done
```

The run id is derived from the composite `thread_id`, so the resume request recovers exactly the
run the chat request suspended. Identity (`userId`/`threadId`) flows from the turn closure, never a
model-supplied field. Transactions are **required**: a standalone `mongod` (no replica set) cannot
place orders; use Atlas or a replica set.

## Deploy surfaces

- **Local / Docker**: `createApp` (Hono) serves `/api/*` + the SPA on `:8000`
  (`Dockerfile`, `docker-compose.yml`). `pnpm setup` scripts the whole bring-up.
- **Mastra Cloud**: `mastra build` → the Mastra instance (`src/mastra/index.ts`) serves the same
  `apiRoutes`. Ingestion (`provision`/`seed`/`embed`) runs once against Atlas, never in the build
  (Cloud 15-min build cap + ephemeral filesystem).
