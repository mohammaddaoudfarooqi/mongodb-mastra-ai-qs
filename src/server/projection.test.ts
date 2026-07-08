import { describe, it, expect } from 'vitest';
import { projectMessage } from './projection';
import { createApp } from './app';

describe('projectMessage', () => {
  it('maps agent roles to the frontend message-type contract', () => {
    expect(projectMessage({ role: 'user', content: 'hi' }).type).toBe('human');
    expect(projectMessage({ role: 'assistant', content: 'yo' }).type).toBe('ai');
    expect(projectMessage({ role: 'tool', content: 'result' }).type).toBe('tool');
    expect(projectMessage({ role: 'system', content: 's' }).type).toBe('system');
  });

  it('flattens a JSON-string content into a plain string', () => {
    const stored = JSON.stringify({ parts: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] });
    expect(projectMessage({ role: 'assistant', content: stored }).content).toBe('hello world');
  });

  it('passes through a plain string content unchanged', () => {
    expect(projectMessage({ role: 'user', content: 'plain' }).content).toBe('plain');
  });
});

describe('createApp route registration', () => {
  const cfg = {
    mongoUri: 'mongodb+srv://u:p@c.mongodb.net/', mongoDb: 'db', voyageApiKey: 'vk',
    llmProvider: 'anthropic', llmModel: 'claude-opus-4-8', allowInsecure: false,
    responseCache: { enabled: false, ttlDays: 1, similarityThreshold: 0.9, maxAnswerBytes: 32768 },
    memory: { semanticRecall: false, lastMessages: 10 },
    rrfK: 60, dataAgentAllowList: ['products'], dataAgentLimit: 25,
    emitPlanFrames: false, ingestDescribe: true, port: 8000, defaultUserId: 'demo',
    mongoPool: { maxPoolSize: 100, minPoolSize: 10 },
  } as any;

  it('returns models without touching Mongo', async () => {
    const app = createApp(cfg);
    const res = await app.request('/models');
    expect(res.status).toBe(200);
    const body = await res.json() as { default: string };
    expect(body.default).toBe('claude-opus-4-8');
  });

  it('returns 204 for the dropped /files route', async () => {
    const app = createApp(cfg);
    expect((await app.request('/files')).status).toBe(204);
  });

  // /interrupts/resume was revived as the checkout HITL resume (REQ-E-031); it is
  // no longer a 204 stub. A body-less POST is a malformed request → 400.
  it('rejects a malformed resume POST with 400 (route is live, not a 204 stub)', async () => {
    const app = createApp(cfg);
    expect((await app.request('/interrupts/resume', { method: 'POST' })).status).toBe(400);
  });
});
