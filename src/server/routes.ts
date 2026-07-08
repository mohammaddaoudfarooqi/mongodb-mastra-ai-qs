import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { MongoClient, type Db } from 'mongodb';
import type { Config } from '../config';
import { logger, setLogSink } from '../observability/logger';
import { createMongoLogSink } from '../observability/mongo-log-sink';
import { toCartsmithFrames, serializeFrame, field, type StreamPart } from './sse';
import { projectMessage } from './projection';
import { buildConcierge, buildConciergeDeps, type TurnContext, type ConciergeDeps } from '../mastra/agent';
import { computeCartTotals, type CartLine } from '../mastra/tools/cart';
import { SemanticResponseCache } from '../cache/semantic-response-cache';
import { isReadEligible, isWriteEligible, isHedge } from '../cache/cache-decisions';
import { getQueryEmbedder } from '../mastra/embed';
import { maxTokensFor, temperatureFor, modelChoices } from '../mastra/models';
import { buildFeedbackDoc, type FeedbackRequest } from './feedback';
import { resolveUserId, getAuthenticator } from './auth';

function freshSignals(): TurnContext['signals'] {
  return { knowledgeSearchRan: false, knowledgeSearchHadResults: false, dataQueryRan: false, mutatingToolRan: false };
}

/** Sentinel thrown to trigger a retry of the agent stream (distinct from a real error). */
const RETRY = Symbol('retry-agent-stream');

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * True for TRANSIENT upstream LLM errors worth a quick retry: gateway overload (Anthropic
 * `Overloaded`/`overloaded_error`, HTTP 529), rate limits (429), and generic timeouts /
 * connection resets. Deterministic errors (bad request, auth) are NOT retried — retrying
 * them just wastes time and delays the error the user needs to see.
 */
function isTransientLLMError(err: unknown): boolean {
  const s = (typeof err === 'string' ? err : (err as any)?.message ?? (err as any)?.type ?? String(err ?? '')).toLowerCase();
  return /overloaded|rate.?limit|too many requests|429|529|503|timeout|etimedout|econnreset|econnrefused|socket hang up|service unavailable/.test(s);
}

/**
 * Per-app dependencies shared by every route handler. Owns the MongoClient,
 * the semantic cache, and a lazily-built ConciergeDeps (connection reuse).
 *
 * Construction is connection-free (MongoClient/MongoDBStore connect lazily),
 * so building a RouteContext performs NO network I/O and NO seeding — this is
 * what lets the handlers mount on both `createApp` (Hono) and the Mastra
 * instance (Cloud) without opening a socket at import time (REQ-E-011).
 */
/**
 * Starts and resumes the human-in-the-loop order workflow. Abstracted behind
 * this seam so route handlers stay unit-testable without a live Mongo/Mastra;
 * the real implementation (storage-bound workflow) is injected in production and
 * exercised by the live integration test. `start`/`resume` are keyed by the
 * composite `threadId` (a deterministic runId), so a run suspended in the /chat
 * request is recoverable in the separate /interrupts/resume request (REQ-E-035).
 */
export interface OrderRunner {
  start: (threadId: string, userId: string) => Promise<{ status: string; suspendPayload?: any }>;
  resume: (threadId: string, decision: string, editedAction?: any, cartVersion?: string) => Promise<{ status: string; message?: string }>;
}

export interface RouteContext {
  cfg: Config;
  db: Db;
  cache: SemanticResponseCache;
  getSharedDeps: () => ConciergeDeps;
  nextCorrelationId: () => string;
  /** Injected order-workflow runner; absent in hermetic tests that don't hit checkout. */
  orderRunner?: OrderRunner;
  /** Test seam: overrides db.collection('feedback') when present (see app.test.ts). */
  feedbackCollection?: { replaceOne: (...args: any[]) => Promise<unknown> };
  /** Test seam: overrides the agent/memory builder so the /chat SSE path can be
   *  exercised without a live LLM (defaults to buildConcierge). */
  buildAgent?: (cfg: Config, turn: TurnContext, deps: ConciergeDeps) => { agent: any; memory: any };
}

export function buildRouteContext(cfg: Config): RouteContext {
  const client = new MongoClient(cfg.mongoUri, {
    maxPoolSize: cfg.mongoPool.maxPoolSize,
    minPoolSize: cfg.mongoPool.minPoolSize,
  });
  const db = client.db(cfg.mongoDb);

  // Attach the MongoDB log sink so app logs are persisted (in addition to stdout/stderr).
  // Connection-free at construction: the sink only buffers until its first timed flush, and
  // the shared MongoClient connects lazily — so building a RouteContext still does no I/O.
  // Idempotent-ish: the last RouteContext built wins as the active sink (there is one per
  // process in practice). Fail-open inside the sink; never throws here.
  if (cfg.appLog?.enabled) {
    setLogSink(createMongoLogSink({
      db, collection: cfg.appLog.collection, retentionDays: cfg.appLog.retentionDays,
    }));
  }

  const cacheCol = db.collection('semantic_response_cache');
  const queryEmbedder = getQueryEmbedder(cfg);
  const cache = new SemanticResponseCache({
    collection: cacheCol,
    embed: q => queryEmbedder.embedQuery(q),
    cfg: cfg.responseCache,
  });

  // Shared connection-holding deps, built lazily on first /chat use (preserves
  // the no-connection-at-construction property the smoke tests rely on).
  let sharedDeps: ConciergeDeps | null = null;
  const getSharedDeps = () => { if (!sharedDeps) sharedDeps = buildConciergeDeps(cfg); return sharedDeps; };

  // A per-turn correlation id without Math.random/Date: monotonic counter + pid.
  let turnSeq = 0;
  const nextCorrelationId = () => `turn-${process.pid}-${++turnSeq}`;

  return {
    cfg, db, cache, getSharedDeps, nextCorrelationId,
    feedbackCollection: (cfg as any).__testFeedbackCollection,
  };
}

/**
 * Route handlers, each a `(RouteContext) => (Context) => Response` factory. The
 * SAME functions mount on the Hono app (`createApp`) and the Mastra instance's
 * `server.apiRoutes`, so the two deploy surfaces cannot drift (REQ-E-001).
 *
 * Handlers read from the request body / query, never from the URL path, so the
 * identical function serves `/chat` (createApp) and `/api/chat` (Mastra).
 */
export const handlers = {
  chat: (rc: RouteContext) => async (c: Context): Promise<Response> => {
    const cfg = rc.cfg;
    // Parse defensively: malformed JSON must be a 400, not an unhandled 500 (R2 #1).
    let body: { user_id?: string; thread_id?: string; message?: string; model?: string };
    try { body = await c.req.json(); } catch { return c.json({ detail: 'invalid JSON body' }, 400); }
    // Validate the message before doing anything else (reviewer finding #8).
    if (typeof body?.message !== 'string' || !body.message.trim()) {
      return c.json({ detail: 'message is required' }, 400);
    }
    const message = body.message; // narrowed to string; stable ref for the stream closure
    // Server-trusted identity (reviewer finding #1): in SSO mode userId comes from the
    // validated session and client-supplied user_id is ignored; unauthenticated ⇒ 401.
    // In local demo mode it falls back to the client value or the default.
    const who = await resolveUserId(c, cfg, body.user_id);
    if ('unauthorized' in who) return c.json({ detail: 'authentication required' }, 401);
    const userId = who.userId;
    const threadId = body.thread_id || `${userId}:default`;
    const model = body.model || cfg.llmModel;
    const correlationId = rc.nextCorrelationId();
    const turn: TurnContext = { signals: freshSignals(), modelOverride: body.model, userId, threadId, message };
    const deps = rc.getSharedDeps();
    const { agent, memory } = (rc.buildAgent ?? buildConcierge)(cfg, turn, deps);

    return stream(c, async honoStream => {
      c.header('Content-Type', 'text/event-stream');

      // Emit correlation FIRST, before the recall/cache/first-LLM work below. That work
      // takes several seconds; writing this frame up front gives the client an immediate
      // ack (spinner/turn id) instead of a dead stream. toCartsmithFrames is told to skip
      // its own correlation frame so the correlation-first contract still holds exactly once.
      await honoStream.write(serializeFrame('correlation', correlationId));

      // A checkout-intent message must never be served from (or written to) the
      // response cache: a cache hit would `return` before the agent runs, so the
      // checkout tool would never fire and no approval card would appear. Cheap
      // lexical guard — the workflow itself validates the cart, this only routes.
      const looksLikeCheckout = /\b(check\s?out|place (my |an )?order|buy (it|my|now)|purchase)\b/i.test(message);

      // Cache read (fresh-conversation only, fail-open). We only need to know whether the
      // thread is empty (isReadEligible === priorCount 0), so a cheap existence check on the
      // message store beats a full semantic recall() (which runs a vector query — seconds of
      // pre-turn latency for a boolean). Only computed when the cache is on; a missing/renamed
      // collection throws → fail-open to priorCount 1 (treat as mid-conversation: skip cache,
      // never serve a stale opener).
      let priorCount = 1;
      if (cfg.responseCache.enabled) {
        try {
          priorCount = await rc.db.collection('mastra_messages')
            .countDocuments({ thread_id: threadId, resourceId: userId }, { limit: 1 });
        } catch (err) { logger.warn('prior-message count failed; bypassing cache', { err: String(err), correlationId }); priorCount = 1; }
      }

      if (!looksLikeCheckout && cfg.responseCache.enabled && isReadEligible(priorCount)) {
        let hit = null as Awaited<ReturnType<SemanticResponseCache['lookup']>>;
        try { hit = await rc.cache.lookup(message, userId, model); }
        catch (err) { logger.warn('cache lookup failed; bypassing', { err: String(err), correlationId }); }
        if (hit) {
          // correlation already written above.
          await honoStream.write(serializeFrame('token', hit.answer));
          await honoStream.write(serializeFrame('done', ''));
          // Persist the exchange so a follow-up is no longer "fresh" and has history.
          try { await memory.saveMessages({ messages: [
            { role: 'user', content: message, threadId, resourceId: userId } as any,
            { role: 'assistant', content: hit.answer, threadId, resourceId: userId } as any,
          ] }); } catch (err) { logger.warn('cache-hit persist failed', { err: String(err), correlationId }); }
          return;
        }
      }

      // Miss: run the agent and adapt its stream to Cartsmith frames.
      const answerParts: string[] = [];
      // Set to true unless a `done` terminal is reached (R2 #2). A turn that errored — via an
      // `error` part OR a THROW while creating/iterating the stream — produced only a PARTIAL
      // answer, so it must never be written to the cache, or the truncated text could later be
      // served as a confident cache hit for the same opener. Default true so a stream that
      // never terminates cleanly is treated as errored for cache purposes.
      let streamErrored = true;
      const temp = temperatureFor(model);
      // maxSteps gives the concierge router room to delegate to a specialist AND then
      // compose a grounded reply from what the specialist returned. Without it, a turn
      // that delegates (and may retry the sub-agent once) can exhaust the default step
      // budget before writing the final answer, producing a false "having trouble
      // retrieving" hedge even though the specialist returned data. Mastra's supervisor
      // pattern documents this: a supervisor needs an explicit step budget.
      const streamOpts: any = { memory: { thread: threadId, resource: userId }, maxOutputTokens: maxTokensFor(model), maxSteps: 8 };
      if (temp !== undefined) streamOpts.temperature = temp;
      // Create the agent stream INSIDE the generator so a throw during stream creation or
      // iteration is caught by toCartsmithFrames' try/catch and turned into an `error` +
      // (nothing after) terminal — never a 200 stream with only a correlation frame (R2 #1).
      //
      // Transient upstream blips (LLM gateway "Overloaded"/429/529/rate limit) are common
      // and recover on a quick retry. We retry ONLY while nothing has been emitted yet
      // (before the first token/tool/interrupt) so a retry never duplicates visible output;
      // once real output starts, an error is surfaced as-is. This is what lets a live demo
      // survive a momentary overload instead of failing the hero prompt.
      async function* parts(): AsyncGenerator<StreamPart> {
        const maxAttempts = 3;
        for (let attempt = 1; ; attempt++) {
          let emitted = false;
          try {
            const agentStream = await agent.stream(message, streamOpts);
            for await (const part of agentStream.fullStream as AsyncIterable<StreamPart>) {
              if (part.type === 'error' && !emitted && attempt < maxAttempts && isTransientLLMError(field(part, 'error') ?? field(part, 'message'))) {
                // Transient error before any output — swallow this stream and retry.
                logger.warn('agent stream transient error; retrying', { attempt, correlationId });
                throw RETRY;
              }
              if (part.type === 'text-delta') { answerParts.push(field<string>(part, 'text') ?? field<string>(part, 'delta') ?? ''); emitted = true; }
              else if (part.type === 'tool-call' || part.type === 'tool-call-start' || part.type === 'tool-result' || part.type === 'error') emitted = true;
              yield part;
            }
            return; // stream completed
          } catch (err) {
            // A throw during stream creation/iteration: retry if transient and nothing emitted.
            if (err !== RETRY && (emitted || attempt >= maxAttempts || !isTransientLLMError(err))) throw err;
            await sleep(250 * attempt); // brief backoff before the next attempt
          }
        }
      }
      // If the agent asked to check out, start the order workflow as a `beforeDone`
      // trailer: the interrupt/token frames it yields are emitted right before the
      // `done` terminal, and ONLY on the success path — never after an `error` (so
      // the INV-002 "interrupt always followed by done" contract holds without this
      // handler parsing sse.ts's wire format). No workflow starts on an errored turn.
      async function* checkoutTrailer(): AsyncGenerator<string> {
        if (!turn.checkoutRequested || !rc.orderRunner) return;
        try {
          const run = await rc.orderRunner.start(threadId, userId);
          if (run.status === 'suspended' && run.suspendPayload) {
            yield serializeFrame('interrupt', JSON.stringify({
              thread_id: threadId,
              action: run.suspendPayload.action,
              allowed_decisions: run.suspendPayload.allowed_decisions,
            }));
          } else {
            // Not suspended = buildQuote bailed pre-approval (empty cart / stock).
            yield serializeFrame('token', "\n\nI couldn't start checkout — your cart may be empty or an item is out of stock. Please review your cart and try again.");
          }
        } catch (err) {
          // buildQuote throws on empty cart / insufficient stock (REQ-E-034); surface it.
          const reason = err instanceof Error ? err.message : 'Checkout could not be started.';
          logger.warn('checkout start failed', { err: String(err), correlationId });
          yield serializeFrame('token', `\n\nI couldn't start checkout: ${reason}`);
        }
      }
      for await (const frame of toCartsmithFrames(parts(), {
        correlationId, emitPlanFrames: cfg.emitPlanFrames, beforeDone: checkoutTrailer, skipCorrelation: true,
        // Authoritative terminal signal: covers both `error` parts and thrown streams (the
        // throw path an in-loop flag alone would miss). Only a clean `done` clears the flag.
        onTerminal: kind => { streamErrored = kind !== 'done'; },
      })) {
        await honoStream.write(frame);
      }

      // Cache write (grounded + non-dataQuery + non-mutating). A checkout turn is
      // mutating, so `isWriteEligible` is false — but guard explicitly too (INV-003).
      // Also never cache an apology/"couldn't retrieve" answer (isHedge): a write-eligible
      // turn can still hedge if the model fumbles the grounding, and a cached hedge is then
      // replayed to every future opener with the same wording (this poisoned the demo's hero
      // prompts). A skipped hedge just recomputes next time — cheap insurance.
      const answer = answerParts.join('');
      if (!streamErrored && !looksLikeCheckout && !turn.checkoutRequested && cfg.responseCache.enabled
          && isReadEligible(priorCount) && isWriteEligible(turn.signals) && answer.length && !isHedge(answer)) {
        try { await rc.cache.save(message, userId, model, answer, new Date()); }
        catch (err) { logger.warn('cache save failed', { err: String(err), correlationId }); }
      }
    });
  },

  models: (rc: RouteContext) => (c: Context): Response => c.json({
    default: rc.cfg.llmModel,
    // Pass the provider so a Bedrock deploy surfaces inference-profile ids (not the
    // Anthropic-API ids Bedrock rejects).
    models: modelChoices(rc.cfg.llmModel, rc.cfg.llmProvider),
  }),

  // The frontend's AuthProvider calls GET /auth/me on mount and throws on non-2xx.
  // In SSO mode this returns the authenticated user (client cannot influence it) and
  // 401s when there is no valid session. In local demo mode there is no login, so it
  // returns the configured dev user; the frontend shows `email` as a read-only badge
  // and uses it as `user_id` for memory/thread scoping.
  authMe: (rc: RouteContext) => async (c: Context): Promise<Response> => {
    const id = await getAuthenticator()(c);
    if (id?.userId) return c.json({ email: id.userId, username: id.userId, groups: [] as string[] });
    if (rc.cfg.authRequired) return c.json({ detail: 'authentication required' }, 401);
    return c.json({ email: rc.cfg.defaultUserId, username: rc.cfg.defaultUserId, groups: [] as string[] });
  },

  health: () => (c: Context): Response => c.json({ status: 'ok' }),

  stats: (rc: RouteContext) => async (c: Context): Promise<Response> => {
    try {
      const products = await rc.db.collection('products').countDocuments();
      const categories = (await rc.db.collection('products').distinct('category')).length;
      const on_sale = await rc.db.collection('products').countDocuments({ on_sale: true });
      return c.json({ products, categories, on_sale });
    } catch { return c.json({ products: null, categories: null, on_sale: null }); }
  },

  cart: (rc: RouteContext) => async (c: Context): Promise<Response> => {
    const who = await resolveUserId(c, rc.cfg, c.req.query('user_id'));
    if ('unauthorized' in who) return c.json({ detail: 'authentication required' }, 401);
    const userId = who.userId;
    const threadId = c.req.query('thread_id') || `${userId}:default`;
    try {
      const doc = await rc.db.collection('carts').findOne({ userId, threadId });
      const lines = (doc?.lines ?? []) as CartLine[];
      return c.json({ lines, ...computeCartTotals(lines), updated_at: doc?.updated_at ?? null });
    } catch { return c.json({ lines: [], subtotal: 0, total_savings: 0, updated_at: null }); }
  },

  messages: (rc: RouteContext) => async (c: Context): Promise<Response> => {
    const who = await resolveUserId(c, rc.cfg, c.req.query('user_id'));
    if ('unauthorized' in who) return c.json({ detail: 'authentication required' }, 401);
    const userId = who.userId;
    const threadId = c.req.query('thread_id');
    if (!threadId) return c.json({ messages: [] });
    try {
      const deps = rc.getSharedDeps();
      const res = await deps.memory.recall({ threadId, resourceId: userId });
      const messages = (res?.messages ?? []).map((m: any) => projectMessage({ role: m.role, content: m.content }));
      return c.json({ messages });
    } catch { return c.json({ messages: [] }); }
  },

  latestThread: (rc: RouteContext) => async (c: Context): Promise<Response> => {
    const who = await resolveUserId(c, rc.cfg, c.req.query('user_id'));
    if ('unauthorized' in who) return c.json({ detail: 'authentication required' }, 401);
    const userId = who.userId;
    try {
      const deps = rc.getSharedDeps();
      const result = await deps.memory.listThreads({ filter: { resourceId: userId } });
      const threads = result?.threads ?? [];
      const latest = threads.sort((a: any, b: any) => (b.updatedAt > a.updatedAt ? 1 : -1))[0];
      return c.json({ thread_id: latest?.id ?? null });
    } catch { return c.json({ thread_id: null }); }
  },

  // Dropped feature: 204 (not 404) so the frontend's swallow-to-empty fetcher never toasts/retries.
  files: () => (c: Context): Response => c.body(null, 204),

  // Revived Spec 530 checkout resume: resume the suspended order workflow for
  // this thread with the shopper's decision, and stream the confirmation as SSE
  // (REQ-E-031/032). Fail-open to an `error` frame. `thread_id` is the composite
  // value echoed verbatim from the interrupt frame.
  resume: (rc: RouteContext) => async (c: Context): Promise<Response> => {
    let body: { thread_id?: string; decision?: string; edited_action?: any; cart_version?: string };
    try { body = await c.req.json(); } catch { return c.body(null, 400); }
    const threadId = body.thread_id;
    const decision = body.decision;
    if (!threadId || !decision) return c.body(null, 400);
    if (!['approve', 'edit', 'reject'].includes(decision)) return c.body(null, 400);
    // In SSO mode, bind the resume to the authenticated user: the composite thread_id is
    // `${userId}:…`, so a client cannot resume another user's suspended checkout (finding #1).
    if (rc.cfg.authRequired) {
      const id = await getAuthenticator()(c);
      if (!id?.userId) return c.json({ detail: 'authentication required' }, 401);
      if (threadId !== id.userId && !threadId.startsWith(`${id.userId}:`)) {
        return c.json({ detail: 'forbidden' }, 403);
      }
    }
    const correlationId = rc.nextCorrelationId();
    return stream(c, async honoStream => {
      c.header('Content-Type', 'text/event-stream');
      await honoStream.write(serializeFrame('correlation', correlationId));
      try {
        if (!rc.orderRunner) throw new Error('checkout is not configured');
        // cart_version binds this approval to the exact quote the shopper saw (finding #3).
        const result = await rc.orderRunner.resume(threadId, decision, body.edited_action, body.cart_version);
        const msg = result.message ?? (result.status === 'placed' ? 'Order placed.' : 'Order cancelled.');
        await honoStream.write(serializeFrame('token', msg));
        await honoStream.write(serializeFrame('done', ''));
      } catch (err) {
        logger.warn('checkout resume failed', { err: String(err), correlationId });
        await honoStream.write(serializeFrame('error', 'Could not resume checkout.'));
      }
    });
  },

  feedback: (rc: RouteContext) => async (c: Context): Promise<Response> => {
    let body: Partial<FeedbackRequest>;
    try { body = await c.req.json<Partial<FeedbackRequest>>(); }
    catch { return c.body(null, 400); }
    if (!body || typeof body.run_id !== 'string' || typeof body.score !== 'number') {
      return c.body(null, 400);
    }
    // Server-trusted identity (R2 #3): in SSO mode the feedback is attributed to the
    // authenticated user and the client-supplied user_id is ignored; unauthenticated ⇒ 401.
    // In local demo mode it falls back to the client value or the default (unchanged).
    const who = await resolveUserId(c, rc.cfg, body.user_id);
    if ('unauthorized' in who) return c.body(null, 401);
    const doc = buildFeedbackDoc({ ...(body as FeedbackRequest), user_id: who.userId }, new Date());
    // `_id` is the run_id string (not an ObjectId), so type the collection loosely.
    const collection = rc.feedbackCollection ?? (rc.db.collection('feedback') as any);
    try {
      await collection.replaceOne({ _id: doc._id }, doc, { upsert: true });
    } catch (err) {
      // Fail-open: never break the UI over a feedback write.
      logger.warn('feedback persist failed', { err: String(err), run_id: doc.run_id });
    }
    return c.body(null, 204);
  },
};
