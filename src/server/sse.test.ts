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
