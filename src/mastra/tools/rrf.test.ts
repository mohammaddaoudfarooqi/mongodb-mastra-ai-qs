import { describe, it, expect } from 'vitest';
import { rrfFuse, type RankedDoc } from './rrf';

const d = (id: string): RankedDoc => ({ id });

describe('rrfFuse', () => {
  it('dedups by id and sums per-list contributions', () => {
    const vec = [d('a'), d('b'), d('c')];   // ranks 0,1,2
    const lex = [d('b'), d('a'), d('x')];   // ranks 0,1,2
    const fused = rrfFuse(vec, lex, 60);
    const ids = fused.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
    // b: 1/61 + 1/60 ; a: 1/60 + 1/61  -> equal; both above c and x
    expect(ids.slice(0, 2).sort()).toEqual(['a', 'b']);
    const b = fused.find(f => f.id === 'b')!;
    expect(b.rrfScore).toBeCloseTo(1 / 61 + 1 / 60, 10);
  });

  it('ranks a doc present in both lists above singletons', () => {
    const vec = [d('a'), d('solo1')];
    const lex = [d('a'), d('solo2')];
    const fused = rrfFuse(vec, lex);
    expect(fused[0].id).toBe('a');
  });

  it('defaults k to 60', () => {
    const fused = rrfFuse([d('a')], []);
    expect(fused[0].rrfScore).toBeCloseTo(1 / 60, 10);
  });
});
