// src/server/trace.test.ts
import { describe, it, expect } from 'vitest';
import { TraceSink } from './trace';

describe('TraceSink', () => {
  it('collects pushed steps in order and assigns ids when omitted', () => {
    const sink = new TraceSink();
    sink.push({ tool: 'dataQuery', args: { collection: 'products' }, summary: '8 documents', result: { ok: true } });
    sink.push({ tool: 'cartAdd', summary: 'added Trail Runner', result: { ok: true } });
    const steps = sink.list();
    expect(steps).toHaveLength(2);
    expect(sink.size).toBe(2);
    expect(steps[0]).toMatchObject({ tool: 'dataQuery', summary: '8 documents' });
    expect(steps[0].id).toBeTruthy();
    expect(steps[1].id).not.toBe(steps[0].id); // unique ids
  });

  it('preserves a caller-supplied id', () => {
    const sink = new TraceSink();
    sink.push({ id: 'call-42', tool: 'dataQuery' });
    expect(sink.list()[0].id).toBe('call-42');
  });

  it('starts empty', () => {
    expect(new TraceSink().list()).toEqual([]);
  });
});
