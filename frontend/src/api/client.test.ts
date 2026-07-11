import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchMe, streamChat, type TraceEvent } from './client';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Build a Response whose body streams the given SSE frame strings, for consumeSSEStream. */
function sseResponse(frames: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const noopHandlers = {
  onToken: () => {},
  onDone: () => {},
  onError: () => {},
};

describe('fetchMe', () => {
  it('returns the authenticated SSO identity from /api/auth/me', async () => {
    const body = {
      email: 'alice@mongodb.com',
      username: 'alice',
      groups: ['g1'],
    };
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const user = await fetchMe();
    expect(user.email).toBe('alice@mongodb.com');
    expect(user.username).toBe('alice');
    expect(user.groups).toEqual(['g1']);
    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/me', expect.any(Object));
  });

  it('throws when unauthenticated (401)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unauthorized', { status: 401 }),
    );
    await expect(fetchMe()).rejects.toThrow(/Not authenticated/);
  });
});

describe('streamChat onTrace (REQ-E-064)', () => {
  it('dispatches a valid trace frame to onTrace with the parsed event', async () => {
    const frames = [
      'event: correlation\ndata: run-1\n\n',
      'event: trace\ndata: {"id":"t1","phase":"start","tool":"dataQuery","args":{"collection":"products","filter":{"on_sale":true}}}\n\n',
      'event: trace\ndata: {"id":"t1","phase":"end","tool":"dataQuery","summary":"2 documents","result":{"ok":true,"rows":[{"_id":"prod_0021"}]}}\n\n',
      'event: token\ndata: Here are 2 items.\n\n',
      'event: done\ndata: \n\n',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(frames));

    const traces: TraceEvent[] = [];
    await streamChat(
      { message: 'sale items', user_id: 'demo', thread_id: 't1' },
      { ...noopHandlers, onTrace: (t) => traces.push(t) },
    );

    expect(traces).toHaveLength(2);
    expect(traces[0]).toMatchObject({ id: 't1', phase: 'start', tool: 'dataQuery' });
    expect(traces[0].args).toEqual({ collection: 'products', filter: { on_sale: true } });
    expect(traces[1]).toMatchObject({ id: 't1', phase: 'end', tool: 'dataQuery', summary: '2 documents' });
    expect(traces[1].result).toMatchObject({ ok: true });
  });

  it('drops a malformed trace frame without breaking the stream (INV-064)', async () => {
    const frames = [
      'event: correlation\ndata: run-1\n\n',
      'event: trace\ndata: {"phase":"start"}\n\n',        // missing tool → invalid
      'event: trace\ndata: not-json\n\n',                  // unparseable
      'event: token\ndata: hi\n\n',
      'event: done\ndata: \n\n',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(frames));

    const traces: TraceEvent[] = [];
    let doneCalled = false;
    let tokenText = '';
    await streamChat(
      { message: 'x', user_id: 'demo', thread_id: 't1' },
      { onToken: (t) => { tokenText += t; }, onDone: () => { doneCalled = true; }, onError: () => {}, onTrace: (t) => traces.push(t) },
    );

    expect(traces).toHaveLength(0);   // both dropped
    expect(tokenText).toBe('hi');     // stream still delivered the token
    expect(doneCalled).toBe(true);    // and terminated cleanly
  });
});
