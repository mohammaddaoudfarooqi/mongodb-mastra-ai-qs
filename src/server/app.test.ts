import { describe, it, expect } from 'vitest';
import { createApp } from './app';
import { buildFeedbackDoc } from './feedback';

const cfg = {
  mongoUri: 'mongodb+srv://u:p@c.mongodb.net/', mongoDb: 'db', voyageApiKey: 'vk',
  llmProvider: 'anthropic', llmModel: 'claude-opus-4-8', allowInsecure: false,
  responseCache: { enabled: false, ttlDays: 1, similarityThreshold: 0.9, maxAnswerBytes: 32768 },
  memory: { semanticRecall: false, lastMessages: 10 },
  rrfK: 60, dataAgentAllowList: ['products'], dataAgentLimit: 25,
  emitPlanFrames: false, ingestDescribe: true, port: 8000, defaultUserId: 'demo',
  mongoPool: { maxPoolSize: 100, minPoolSize: 10 },
} as any;

describe('GET /health (REQ-E-005)', () => {
  it('returns 200 { status: ok }', async () => {
    const res = await createApp(cfg).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /auth/me', () => {
  it('returns a fixed dev user derived from defaultUserId', async () => {
    const app = createApp(cfg);
    const res = await app.request('/auth/me');
    expect(res.status).toBe(200);
    const body = await res.json() as { email: string; username: string; groups: string[] };
    expect(body).toEqual({ email: 'demo', username: 'demo', groups: [] });
  });

  it('reflects a different configured defaultUserId', async () => {
    const app = createApp({ ...cfg, defaultUserId: 'ai4' });
    const body = await (await app.request('/auth/me')).json() as { email: string };
    expect(body.email).toBe('ai4');
  });
});

describe('POST /feedback', () => {
  function appWithFeedbackCollection(overrides?: { throwOnWrite?: boolean }) {
    const calls: any[] = [];
    const collection = {
      replaceOne: async (filter: any, doc: any, opts: any) => {
        if (overrides?.throwOnWrite) throw new Error('mongo down');
        calls.push({ filter, doc, opts });
        return { acknowledged: true };
      },
    };
    // Test seam: createApp uses (cfg as any).__testFeedbackCollection when present
    // instead of db.collection('feedback'), so the route is hermetic here.
    const app = createApp({ ...cfg, __testFeedbackCollection: collection } as any);
    return { app, calls };
  }

  it('returns 204 and persists a doc keyed by run_id on success', async () => {
    const { app, calls } = appWithFeedbackCollection();
    const res = await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'turn-9', score: 1, comment: 'nice', user_id: 'demo' }),
    });
    expect(res.status).toBe(204);
    expect(calls[0].filter).toEqual({ _id: 'turn-9' });
    expect(calls[0].doc).toMatchObject({ _id: 'turn-9', run_id: 'turn-9', score: 1, comment: 'nice', user_id: 'demo' });
    expect(calls[0].opts).toEqual({ upsert: true });
  });

  it('returns 204 (fail-open) when the Mongo write throws', async () => {
    const { app } = appWithFeedbackCollection({ throwOnWrite: true });
    const res = await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: 'turn-10', score: 0, user_id: 'demo' }),
    });
    expect(res.status).toBe(204);
  });

  it('returns 400 when required fields are missing', async () => {
    const { app } = appWithFeedbackCollection();
    const res = await app.request('/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'no ids' }),
    });
    expect(res.status).toBe(400);
  });
});
