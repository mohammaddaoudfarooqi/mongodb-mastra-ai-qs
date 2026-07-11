// src/server/sse.test.ts
import { describe, it, expect } from 'vitest';
import { serializeFrame, toCartsmithFrames, type StreamPart } from './sse';

async function* mockStream(parts: StreamPart[]): AsyncGenerator<StreamPart> {
  for (const p of parts) yield p;
}
async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const f of gen) out.push(f);
  return out;
}

describe('serializeFrame', () => {
  it('emits a single data line for newline-free payload', () => {
    expect(serializeFrame('token', 'hello')).toBe('event: token\ndata: hello\n\n');
  });

  it('emits one data line per newline segment (parser rejoins with \\n)', () => {
    expect(serializeFrame('token', 'a\nb')).toBe('event: token\ndata: a\ndata: b\n\n');
  });

  it('round-trips through the Cartsmith parse rules (strip one leading space, join with \\n)', () => {
    const frame = serializeFrame('token', 'x\ny');
    // Mimic consumeSSEStream: split lines, take data: lines, slice(5).replace(/^ /,''), join('\n')
    const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''));
    expect(dataLines.join('\n')).toBe('x\ny');
  });
});

describe('toCartsmithFrames', () => {
  it('emits correlation first, then tokens, then a single done', async () => {
    const parts: StreamPart[] = [
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'run-1' }));
    expect(frames[0]).toBe('event: correlation\ndata: run-1\n\n');
    expect(frames).toContain('event: token\ndata: Hel\n\n');
    expect(frames).toContain('event: token\ndata: lo\n\n');
    expect(frames.filter(f => f.startsWith('event: done') || f.startsWith('event: error'))).toHaveLength(1);
    expect(frames.at(-1)).toBe('event: done\ndata: \n\n');
  });

  it('omits the correlation frame when skipCorrelation is set (caller wrote it early)', async () => {
    const parts: StreamPart[] = [
      { type: 'text-delta', text: 'Hi' },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'run-1', skipCorrelation: true }));
    expect(frames.some(f => f.startsWith('event: correlation'))).toBe(false);
    expect(frames[0]).toBe('event: token\ndata: Hi\n\n');
    expect(frames.at(-1)).toBe('event: done\ndata: \n\n');
  });

  it('maps tool-call / tool-result to status frames', async () => {
    const parts: StreamPart[] = [
      { type: 'tool-call', toolName: 'knowledgeSearch' },
      { type: 'tool-result', toolName: 'knowledgeSearch' },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c' }));
    expect(frames).toContain('event: status\ndata: {"phase":"tool_start","name":"knowledgeSearch"}\n\n');
    expect(frames).toContain('event: status\ndata: {"phase":"tool_end","name":"knowledgeSearch"}\n\n');
  });

  it('reads text/toolName/error from the nested Mastra payload shape', async () => {
    // Mastra fullStream nests real data under `payload`: { type, runId, from, payload: {...} }.
    // This is the live shape (flat AI-SDK keys are absent); the adapter must read through payload.
    const parts: StreamPart[] = [
      { type: 'text-delta', runId: 'r', from: 'AGENT', payload: { id: 'p', text: 'Hel' } },
      { type: 'text-delta', runId: 'r', from: 'AGENT', payload: { id: 'p', text: 'lo' } },
      { type: 'tool-call', runId: 'r', from: 'AGENT', payload: { toolCallId: 't1', toolName: 'knowledgeSearch', args: {} } },
      { type: 'tool-result', runId: 'r', from: 'AGENT', payload: { toolCallId: 't1', toolName: 'knowledgeSearch', result: { hits: [] } } },
      { type: 'finish', runId: 'r', from: 'AGENT', payload: {} },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'run-1' }));
    expect(frames).toContain('event: token\ndata: Hel\n\n');
    expect(frames).toContain('event: token\ndata: lo\n\n');
    expect(frames).toContain('event: status\ndata: {"phase":"tool_start","name":"knowledgeSearch"}\n\n');
    expect(frames).toContain('event: status\ndata: {"phase":"tool_end","name":"knowledgeSearch"}\n\n');
    expect(frames.at(-1)).toBe('event: done\ndata: \n\n');
  });

  it('emits a payload-nested error part as the single error terminal', async () => {
    const parts: StreamPart[] = [
      { type: 'text-delta', runId: 'r', from: 'AGENT', payload: { text: 'partial' } },
      { type: 'error', runId: 'r', from: 'AGENT', payload: { error: 'gateway 500' } },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c' }));
    const terminals = frames.filter(f => f.startsWith('event: done') || f.startsWith('event: error'));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toBe('event: error\ndata: gateway 500\n\n');
  });

  it('emits exactly one error terminal when the stream throws mid-flight', async () => {
    async function* boom(): AsyncGenerator<StreamPart> {
      yield { type: 'text-delta', text: 'partial' };
      throw new Error('llm exploded');
    }
    const frames = await collect(toCartsmithFrames(boom(), { correlationId: 'c' }));
    expect(frames[0]).toBe('event: correlation\ndata: c\n\n');
    const terminals = frames.filter(f => f.startsWith('event: done') || f.startsWith('event: error'));
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toBe('event: error\ndata: llm exploded\n\n');
  });

  // ── Agent trace frames (REQ-E-060..065) ────────────────────────────────
  // A `trace` frame carries the tool args (tool-call) and result + a human
  // summary (tool-result), correlated by the tool call id, so the chat UI can
  // show the real MongoDB query and the documents it returned.
  function parseTrace(frame: string): any {
    return JSON.parse(frame.replace(/^event: trace\ndata: /, '').replace(/\n\n$/, ''));
  }

  it('TC-E-060: emits a trace start frame carrying tool args on tool-call', async () => {
    const parts: StreamPart[] = [
      { type: 'tool-call', payload: { toolCallId: 't1', toolName: 'dataQuery', args: { collection: 'products', filter: { price: { $lt: 50 } } } } },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c' }));
    const trace = frames.filter(f => f.startsWith('event: trace')).map(parseTrace);
    const start = trace.find(t => t.phase === 'start');
    expect(start).toBeTruthy();
    expect(start).toMatchObject({ id: 't1', tool: 'dataQuery', phase: 'start' });
    expect(start.args).toEqual({ collection: 'products', filter: { price: { $lt: 50 } } });
  });

  it('TC-E-061: emits a trace end frame with result + summary on tool-result', async () => {
    const parts: StreamPart[] = [
      { type: 'tool-call', payload: { toolCallId: 't1', toolName: 'dataQuery', args: { collection: 'products' } } },
      { type: 'tool-result', payload: { toolCallId: 't1', toolName: 'dataQuery', result: { ok: true, rows: [{ _id: 'p1' }, { _id: 'p2' }] } } },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c' }));
    const trace = frames.filter(f => f.startsWith('event: trace')).map(parseTrace);
    const end = trace.find(t => t.phase === 'end');
    expect(end).toBeTruthy();
    expect(end).toMatchObject({ id: 't1', tool: 'dataQuery', phase: 'end' });
    expect(end.result).toEqual({ ok: true, rows: [{ _id: 'p1' }, { _id: 'p2' }] });
    expect(typeof end.summary).toBe('string');
    expect(end.summary.length).toBeGreaterThan(0);
  });

  it('TC-E-062: caps an oversize trace payload with a truncation marker', async () => {
    const big = 'x'.repeat(20000);
    const parts: StreamPart[] = [
      { type: 'tool-result', payload: { toolCallId: 't1', toolName: 'dataQuery', result: { blob: big } } },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c', traceMaxBytes: 8192 }));
    const end = frames.filter(f => f.startsWith('event: trace')).map(parseTrace).find(t => t.phase === 'end');
    expect(end).toBeTruthy();
    // The whole serialized frame must be bounded, and it must say it was truncated.
    const frame = frames.find(f => f.startsWith('event: trace') && f.includes('"phase":"end"'))!;
    expect(frame.length).toBeLessThan(8192 + 512);
    expect(JSON.stringify(end)).toMatch(/truncat/i);
  });

  it('TC-E-063: scrubs secret-looking fields from trace payloads', async () => {
    const parts: StreamPart[] = [
      { type: 'tool-call', payload: { toolCallId: 't1', toolName: 'dataQuery', args: { api_key: 'sk-supersecret', filter: { name: 'shoe' } } } },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c' }));
    const start = frames.filter(f => f.startsWith('event: trace')).map(parseTrace).find(t => t.phase === 'start');
    expect(JSON.stringify(start)).not.toContain('sk-supersecret');
    expect(start.args.filter).toEqual({ name: 'shoe' }); // non-secret fields preserved
  });

  it('TC-E-060: reads args/result through the flat AI-SDK shape too', async () => {
    const parts: StreamPart[] = [
      { type: 'tool-call', toolCallId: 't9', toolName: 'knowledgeSearch', args: { query: 'returns policy' } },
      { type: 'tool-result', toolCallId: 't9', toolName: 'knowledgeSearch', result: { hits: [{ id: 'k1' }] } },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c' }));
    const trace = frames.filter(f => f.startsWith('event: trace')).map(parseTrace);
    expect(trace.find(t => t.phase === 'start')?.args).toEqual({ query: 'returns policy' });
    expect(trace.find(t => t.phase === 'end')?.result).toEqual({ hits: [{ id: 'k1' }] });
  });

  it('TC-E-065-ORDER: never emits a trace frame before correlation or after a terminal', async () => {
    const parts: StreamPart[] = [
      { type: 'tool-call', payload: { toolCallId: 't1', toolName: 'dataQuery', args: {} } },
      { type: 'tool-result', payload: { toolCallId: 't1', toolName: 'dataQuery', result: { ok: true, rows: [] } } },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c' }));
    const firstTrace = frames.findIndex(f => f.startsWith('event: trace'));
    const terminal = frames.findIndex(f => f.startsWith('event: done') || f.startsWith('event: error'));
    expect(frames[0]).toBe('event: correlation\ndata: c\n\n');
    expect(firstTrace).toBeGreaterThan(0);
    expect(firstTrace).toBeLessThan(terminal); // all trace frames precede the terminal
  });

  it('INV-060: still emits the existing status frames alongside trace frames', async () => {
    const parts: StreamPart[] = [
      { type: 'tool-call', payload: { toolCallId: 't1', toolName: 'dataQuery', args: {} } },
      { type: 'tool-result', payload: { toolCallId: 't1', toolName: 'dataQuery', result: { ok: true, rows: [] } } },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c' }));
    expect(frames).toContain('event: status\ndata: {"phase":"tool_start","name":"dataQuery"}\n\n');
    expect(frames).toContain('event: status\ndata: {"phase":"tool_end","name":"dataQuery"}\n\n');
  });

  it('emits incremental plan snapshots when emitPlanFrames is on', async () => {
    const parts: StreamPart[] = [
      { type: 'tool-call', toolName: 'knowledgeSearch' },
      { type: 'tool-result', toolName: 'knowledgeSearch' },
      { type: 'finish' },
    ];
    const frames = await collect(toCartsmithFrames(mockStream(parts), { correlationId: 'c', emitPlanFrames: true }));
    const planFrames = frames.filter(f => f.startsWith('event: plan'));
    // one on tool start (in_progress), one on tool end (completed)
    expect(planFrames).toHaveLength(2);
    const first = JSON.parse(planFrames[0].split('data: ')[1]);
    expect(first.todos[0]).toMatchObject({ text: 'knowledgeSearch', status: 'in_progress' });
    const second = JSON.parse(planFrames[1].split('data: ')[1]);
    expect(second.todos[0]).toMatchObject({ text: 'knowledgeSearch', status: 'completed' });
  });
});
