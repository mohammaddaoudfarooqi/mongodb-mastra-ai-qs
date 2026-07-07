import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Db } from 'mongodb';
import { buildRouteContext, handlers, type RouteContext } from './routes';
import { registerAuthenticator, resetAuthenticator } from './auth';
import type { Config } from '../config';

const cfg = {
  mongoUri: 'mongodb+srv://u:p@c.mongodb.net/', mongoDb: 'db', voyageApiKey: 'vk',
  llmProvider: 'anthropic', llmModel: 'claude-opus-4-8', allowInsecure: false,
  responseCache: { enabled: false, ttlDays: 1, similarityThreshold: 0.9, maxAnswerBytes: 32768 },
  rrfK: 60, dataAgentAllowList: ['products'], dataAgentLimit: 25,
  emitPlanFrames: false, ingestDescribe: true, port: 8000, defaultUserId: 'demo',
  mongoPool: { maxPoolSize: 100, minPoolSize: 10 },
} as Config;

/** A RouteContext with a stubbed db, for hermetic handler tests. */
function stubRc(over: Partial<RouteContext> = {}): RouteContext {
  return {
    cfg,
    db: { collection: () => ({}) } as unknown as Db,
    cache: {} as any,
    getSharedDeps: () => { throw new Error('not needed'); },
    nextCorrelationId: () => 'turn-test-1',
    orderRunner: undefined,
    ...over,
  };
}

describe('buildRouteContext (REQ-E-011: connection-free construction)', () => {
  it('constructs without opening a connection or seeding', () => {
    // A bogus-but-TLS URI: MongoClient connects lazily, so construction must not throw
    // and must not perform any network I/O. If it eagerly connected, this would hang/throw.
    const rc = buildRouteContext(cfg);
    expect(rc.db).toBeDefined();
    expect(rc.cache).toBeDefined();
    expect(typeof rc.nextCorrelationId).toBe('function');
    // Monotonic correlation ids, no Date/random.
    expect(rc.nextCorrelationId()).toMatch(/^turn-\d+-\d+$/);
  });

  it('exposes the __testFeedbackCollection seam from cfg', () => {
    const fake = { replaceOne: async () => ({ acknowledged: true }) };
    const rc = buildRouteContext({ ...cfg, __testFeedbackCollection: fake } as any);
    expect(rc.feedbackCollection).toBe(fake);
  });
});

describe('handlers.cart (REQ-E-001 / INV-003: shape via the shared handler)', () => {
  function appWithCart(doc: any) {
    const rc = stubRc({
      db: { collection: () => ({ findOne: async () => doc }) } as unknown as Db,
    });
    const app = new Hono();
    app.get('/cart', handlers.cart(rc));
    return app;
  }

  it('derives subtotal/total_savings from lines via computeCartTotals', async () => {
    const app = appWithCart({
      lines: [{ product_id: 'p1', name: 'Mug', qty: 2, unit_price_usd: 10, sale_price_usd: 8, applied_coupons: [], line_savings: 4 }],
      updated_at: null,
    });
    const res = await app.request('/cart?user_id=demo&thread_id=t1');
    expect(res.status).toBe(200);
    const body = await res.json() as { lines: unknown[]; subtotal: number; total_savings: number; updated_at: null };
    expect(body.lines.length).toBe(1);
    expect(body.subtotal).toBe(16);
    expect(body.total_savings).toBe(4);
    expect(body.updated_at).toBeNull();
  });

  it('returns an empty cart shape on db error (fail-open)', async () => {
    const rc = stubRc({ db: { collection: () => ({ findOne: async () => { throw new Error('down'); } }) } as unknown as Db });
    const app = new Hono();
    app.get('/cart', handlers.cart(rc));
    const res = await app.request('/cart');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lines: [], subtotal: 0, total_savings: 0, updated_at: null });
  });
});

describe('handlers.chat (REQ-E-004 / boundary #3: SSE streams incrementally)', () => {
  async function* fakeFullStream() {
    yield { type: 'text-delta', text: 'Hel' } as any;
    yield { type: 'text-delta', text: 'lo' } as any;
    yield { type: 'finish' } as any;
  }
  const fakeAgent = { stream: async () => ({ fullStream: fakeFullStream() }) };
  const fakeMemory = {
    recall: async () => ({ messages: [] }),
    saveMessages: async () => {},
  };

  function chatApp() {
    const rc = stubRc({
      cfg: { ...cfg, responseCache: { ...cfg.responseCache, enabled: false } },
      getSharedDeps: () => ({} as any),
      buildAgent: () => ({ agent: fakeAgent, memory: fakeMemory }),
    });
    const app = new Hono();
    app.post('/chat', handlers.chat(rc));
    return app;
  }

  it('rejects a chat request with a missing/empty message (400) — reviewer finding #8', async () => {
    for (const bad of [{}, { message: '' }, { message: '   ' }, { message: 123 }]) {
      const res = await chatApp().request('/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_id: 'demo', thread_id: 't1', ...bad }),
      });
      expect(res.status).toBe(400);
    }
  });

  it('streams correlation → token(s) → done as SSE frames', async () => {
    const res = await chatApp().request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', user_id: 'demo', thread_id: 't1' }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: correlation');
    expect(text).toContain('event: token\ndata: Hel');
    expect(text).toContain('event: token\ndata: lo');
    expect(text).toContain('event: done');
  });

  // Reviewer finding #6: a turn that grounds on knowledgeSearch but then ERRORS mid-stream
  // produced only a partial answer — it must NOT be written to the response cache, or the
  // truncated text could later be served as a confident cache hit.
  it('does NOT cache a grounded answer when the stream errors mid-response', async () => {
    async function* groundedThenError() {
      yield { type: 'tool-result', toolName: 'knowledgeSearch' } as any; // write-eligible signal
      yield { type: 'text-delta', text: 'Partial ans' } as any;
      yield { type: 'error', error: 'model blew up' } as any;
    }
    const saved: unknown[] = [];
    const rc = stubRc({
      cfg: { ...cfg, responseCache: { ...cfg.responseCache, enabled: true } },
      db: { collection: () => ({ countDocuments: async () => 0 }) } as unknown as Db,
      cache: { lookup: async () => null, save: async (...a: unknown[]) => { saved.push(a); } } as any,
      getSharedDeps: () => ({} as any),
      buildAgent: (_cfg: Config, turn: any) => {
        // Simulate knowledgeSearch running with results (write-eligible per isWriteEligible).
        turn.signals.knowledgeSearchRan = true;
        turn.signals.knowledgeSearchHadResults = true;
        return { agent: { stream: async () => ({ fullStream: groundedThenError() }) }, memory: fakeMemory };
      },
    });
    const app = new Hono();
    app.post('/chat', handlers.chat(rc));
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how long does shipping take?', user_id: 'demo', thread_id: 'demo:new' }),
    });
    const text = await res.text();
    expect(text).toContain('event: error');   // the stream surfaced the error
    expect(saved.length).toBe(0);              // and nothing was cached
  });

  // R2 #1: malformed JSON must be a 400, not an unhandled 500.
  it('returns 400 (not 500) for a malformed JSON body', async () => {
    const res = await chatApp().request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: '{ not valid json',
    });
    expect(res.status).toBe(400);
  });

  // R2 #2: a stream that THROWS (not an explicit error part) must emit an error terminal
  // AND not cache the partial answer. The pre-fix code only caught `error` parts.
  it('emits an error terminal and does NOT cache when the stream THROWS mid-response', async () => {
    async function* throwingStream() {
      yield { type: 'tool-result', toolName: 'knowledgeSearch' } as any;
      yield { type: 'text-delta', text: 'Partial' } as any;
      throw new Error('iter blew up');
    }
    const saved: unknown[] = [];
    const rc = stubRc({
      cfg: { ...cfg, responseCache: { ...cfg.responseCache, enabled: true } },
      db: { collection: () => ({ countDocuments: async () => 0 }) } as unknown as Db,
      cache: { lookup: async () => null, save: async (...a: unknown[]) => { saved.push(a); } } as any,
      getSharedDeps: () => ({} as any),
      buildAgent: (_cfg: Config, turn: any) => {
        turn.signals.knowledgeSearchRan = true;
        turn.signals.knowledgeSearchHadResults = true;
        return { agent: { stream: async () => ({ fullStream: throwingStream() }) }, memory: fakeMemory };
      },
    });
    const app = new Hono();
    app.post('/chat', handlers.chat(rc));
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'how long does shipping take?', user_id: 'demo', thread_id: 'demo:new2' }),
    });
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(saved.length).toBe(0);
  });

  // R2 #1: a throw while CREATING the agent stream (after correlation is written) must still
  // produce an error terminal — never a 200 stream with only a correlation frame.
  it('emits an error terminal when agent.stream() throws after correlation', async () => {
    const rc = stubRc({
      cfg: { ...cfg, responseCache: { ...cfg.responseCache, enabled: false } },
      getSharedDeps: () => ({} as any),
      buildAgent: () => ({
        agent: { stream: async () => { throw new Error('stream creation failed'); } },
        memory: fakeMemory,
      }),
    });
    const app = new Hono();
    app.post('/chat', handlers.chat(rc));
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', user_id: 'demo', thread_id: 't1' }),
    });
    expect(res.status).toBe(200); // SSE already opened; error is conveyed as a frame
    const text = await res.text();
    expect(text).toContain('event: correlation');
    expect(text).toContain('event: error');
  });

  // Transient-overload resilience: a gateway "Overloaded" before any output retries and
  // recovers, so a live demo survives an upstream blip on the hero prompt.
  it('retries a transient LLM overload (before output) and then succeeds', async () => {
    let attempts = 0;
    async function* overloadedThenOk() {
      attempts++;
      if (attempts === 1) { yield { type: 'error', error: 'Overloaded' } as any; return; }
      yield { type: 'text-delta', text: 'Recovered answer' } as any;
      yield { type: 'finish' } as any;
    }
    const rc = stubRc({
      cfg: { ...cfg, responseCache: { ...cfg.responseCache, enabled: false } },
      getSharedDeps: () => ({} as any),
      buildAgent: () => ({ agent: { stream: async () => ({ fullStream: overloadedThenOk() }) }, memory: fakeMemory }),
    });
    const app = new Hono();
    app.post('/chat', handlers.chat(rc));
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', user_id: 'demo', thread_id: 't1' }),
    });
    const text = await res.text();
    expect(attempts).toBe(2);                       // it retried once
    expect(text).toContain('event: token\ndata: Recovered answer');
    expect(text).toContain('event: done');
    expect(text).not.toContain('event: error');     // the transient error was swallowed
  });

  // A NON-transient error is surfaced immediately, not retried.
  it('does NOT retry a non-transient error', async () => {
    let attempts = 0;
    async function* badRequest() {
      attempts++;
      yield { type: 'error', error: 'invalid request: bad model' } as any;
    }
    const rc = stubRc({
      cfg: { ...cfg, responseCache: { ...cfg.responseCache, enabled: false } },
      getSharedDeps: () => ({} as any),
      buildAgent: () => ({ agent: { stream: async () => ({ fullStream: badRequest() }) }, memory: fakeMemory }),
    });
    const app = new Hono();
    app.post('/chat', handlers.chat(rc));
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi', user_id: 'demo', thread_id: 't1' }),
    });
    const text = await res.text();
    expect(attempts).toBe(1);                        // no retry
    expect(text).toContain('event: error');
  });
});

describe('auth enforcement on identity-bearing routes (reviewer finding #1)', () => {
  afterEach(() => resetAuthenticator());

  const ssoCart = () => {
    const rc = stubRc({
      cfg: { ...cfg, authMode: 'sso', authRequired: true } as Config,
      db: { collection: () => ({ findOne: async () => ({ lines: [] }) }) } as unknown as Db,
    });
    const app = new Hono();
    app.get('/cart', handlers.cart(rc));
    return app;
  };

  it('SSO mode: /cart is 401 without an authenticated session', async () => {
    const res = await ssoCart().request('/cart?user_id=attacker');
    expect(res.status).toBe(401);
  });

  it('SSO mode: /cart uses the authenticated user, ignoring ?user_id', async () => {
    let queriedUserId: string | undefined;
    registerAuthenticator(() => ({ userId: 'real@corp' }));
    const rc = stubRc({
      cfg: { ...cfg, authMode: 'sso', authRequired: true } as Config,
      db: { collection: () => ({ findOne: async (q: any) => { queriedUserId = q.userId; return { lines: [] }; } }) } as unknown as Db,
    });
    const app = new Hono();
    app.get('/cart', handlers.cart(rc));
    const res = await app.request('/cart?user_id=attacker');
    expect(res.status).toBe(200);
    expect(queriedUserId).toBe('real@corp'); // not "attacker"
  });

  it('local mode: /cart trusts ?user_id (demo behavior preserved)', async () => {
    let queriedUserId: string | undefined;
    const rc = stubRc({
      db: { collection: () => ({ findOne: async (q: any) => { queriedUserId = q.userId; return { lines: [] }; } }) } as unknown as Db,
    });
    const app = new Hono();
    app.get('/cart', handlers.cart(rc));
    const res = await app.request('/cart?user_id=alice');
    expect(res.status).toBe(200);
    expect(queriedUserId).toBe('alice');
  });

  // R2 #3: /feedback must also be auth-gated in SSO mode.
  it('SSO mode: /feedback is 401 without an authenticated session', async () => {
    const rc = stubRc({ cfg: { ...cfg, authMode: 'sso', authRequired: true } as Config });
    const app = new Hono();
    app.post('/feedback', handlers.feedback(rc));
    const res = await app.request('/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 't1', score: 1, user_id: 'attacker' }),
    });
    expect(res.status).toBe(401);
  });

  it('SSO mode: /feedback attributes to the authenticated user, ignoring body.user_id', async () => {
    registerAuthenticator(() => ({ userId: 'real@corp' }));
    const writes: any[] = [];
    const rc = stubRc({
      cfg: { ...cfg, authMode: 'sso', authRequired: true } as Config,
      feedbackCollection: { replaceOne: async (_f: any, doc: any) => { writes.push(doc); return {}; } },
    });
    const app = new Hono();
    app.post('/feedback', handlers.feedback(rc));
    const res = await app.request('/feedback', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 't1', score: 1, user_id: 'attacker' }),
    });
    expect(res.status).toBe(204);
    expect(writes[0].user_id).toBe('real@corp'); // not "attacker"
  });
});

describe('handlers.health (REQ-E-005)', () => {
  it('returns 200 { status: ok } with no dependencies', async () => {
    const app = new Hono();
    app.get('/health', handlers.health());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

// The checkout bridge (REQ-E-030..033, INV-002/003). Unit tests stub the
// OrderRunner; the live workflow run/suspend/resume is covered by
// tests/integration/order-workflow.integration.test.ts.
describe('checkout bridge (REQ-E-030 / INV-002 / INV-003)', () => {
  async function* fakeFullStream() {
    yield { type: 'text-delta', text: 'Starting checkout' } as any;
    yield { type: 'finish' } as any;
  }
  const fakeMemory = { recall: async () => ({ messages: [] }), saveMessages: async () => {} };

  // A buildAgent seam whose stream flips turn.checkoutRequested, simulating the
  // agent calling the checkout tool mid-turn.
  function checkoutAgent() {
    return (_cfg: Config, turn: any) => ({
      agent: { stream: async () => { turn.checkoutRequested = true; return { fullStream: fakeFullStream() }; } },
      memory: fakeMemory,
    });
  }

  it('emits a non-terminal interrupt frame FOLLOWED BY done when checkout suspends (REQ-E-030/INV-002)', async () => {
    const savedCalls: unknown[] = [];
    const rc = stubRc({
      cfg: { ...cfg, responseCache: { ...cfg.responseCache, enabled: true } },
      // With the cache on, the chat handler counts prior messages via
      // db.collection('mastra_messages').countDocuments to test opener-eligibility.
      db: { collection: () => ({ countDocuments: async () => 0 }) } as unknown as Db,
      cache: { lookup: async () => null, save: async (...a: unknown[]) => { savedCalls.push(a); } } as any,
      getSharedDeps: () => ({} as any),
      buildAgent: checkoutAgent(),
      orderRunner: {
        start: async () => ({ status: 'suspended', suspendPayload: {
          action: { name: 'place_order', args: { total_usd: 42 }, description: 'Place order' },
          allowed_decisions: ['approve', 'edit', 'reject'],
        } }),
        resume: async () => ({ status: 'placed', message: 'done' }),
      },
    });
    const app = new Hono();
    app.post('/chat', handlers.chat(rc));
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'buy my cart', user_id: 'demo', thread_id: 'demo:t1' }),
    });
    const text = await res.text();
    expect(text).toContain('event: interrupt');
    expect(text).toContain('"name":"place_order"');
    expect(text).toContain('"allowed_decisions"');
    // Non-terminal: a done frame follows the interrupt (INV-002).
    const iIdx = text.indexOf('event: interrupt');
    const dIdx = text.lastIndexOf('event: done');
    expect(iIdx).toBeGreaterThan(-1);
    expect(dIdx).toBeGreaterThan(iIdx);
    // INV-003: a checkout turn is mutating — never cache-written.
    expect(savedCalls.length).toBe(0);
  });

  it('does NOT emit an interrupt (or start the workflow) when the checkout turn errors (INV-002)', async () => {
    let started = false;
    async function* erroringStream() {
      yield { type: 'text-delta', text: 'Starting checkout' } as any;
      yield { type: 'error', error: 'model blew up' } as any;
    }
    const rc = stubRc({
      getSharedDeps: () => ({} as any),
      buildAgent: (_cfg: Config, turn: any) => ({
        agent: { stream: async () => { turn.checkoutRequested = true; return { fullStream: erroringStream() }; } },
        memory: fakeMemory,
      }),
      orderRunner: {
        start: async () => { started = true; return { status: 'suspended', suspendPayload: { action: { name: 'place_order' }, allowed_decisions: [] } }; },
        resume: async () => ({ status: 'placed' }),
      },
    });
    const app = new Hono();
    app.post('/chat', handlers.chat(rc));
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'buy my cart', user_id: 'demo', thread_id: 'demo:t1' }),
    });
    const text = await res.text();
    expect(text).toContain('event: error');       // the failure is surfaced
    expect(text).not.toContain('event: interrupt'); // no interrupt after error
    expect(started).toBe(false);                    // and no workflow started for a failed turn
  });

  it('resume streams a confirmation token + done on approve (REQ-E-031)', async () => {
    const rc = stubRc({
      orderRunner: {
        start: async () => ({ status: 'suspended' }),
        resume: async () => ({ status: 'placed', message: 'Order order-1 placed.' }),
      },
    });
    const app = new Hono();
    app.post('/interrupts/resume', handlers.resume(rc));
    const res = await app.request('/interrupts/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thread_id: 'demo:t1', decision: 'approve' }),
    });
    const text = await res.text();
    expect(text).toContain('event: token\ndata: Order order-1 placed.');
    expect(text).toContain('event: done');
  });

  it('resume emits an error frame when the runner fails (fail-open)', async () => {
    const rc = stubRc({
      orderRunner: {
        start: async () => ({ status: 'suspended' }),
        resume: async () => { throw new Error('no suspended run'); },
      },
    });
    const app = new Hono();
    app.post('/interrupts/resume', handlers.resume(rc));
    const res = await app.request('/interrupts/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thread_id: 'demo:t1', decision: 'approve' }),
    });
    const text = await res.text();
    expect(text).toContain('event: error');
  });
});
