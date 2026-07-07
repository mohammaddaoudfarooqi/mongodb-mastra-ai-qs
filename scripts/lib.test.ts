import { describe, it, expect } from 'vitest';
import { batched, resolvePrewarmQueries, DEFAULT_PREWARM_QUERIES, APP_OWNED_COLLECTIONS } from './lib';

describe('batched', () => {
  it('chunks into batches of the given size, last batch smaller', () => {
    expect(batched([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it('returns [] for empty input', () => {
    expect(batched([], 3)).toEqual([]);
  });
});

describe('resolvePrewarmQueries', () => {
  it('falls back to the default demo queries when unset', () => {
    expect(resolvePrewarmQueries({ prewarmQueries: undefined } as any)).toBe(DEFAULT_PREWARM_QUERIES);
    expect(DEFAULT_PREWARM_QUERIES.length).toBeGreaterThan(0);
  });
  it('honors a configured list', () => {
    expect(resolvePrewarmQueries({ prewarmQueries: ['x'] } as any)).toEqual(['x']);
  });
});

describe('APP_OWNED_COLLECTIONS', () => {
  it('includes app collections and excludes Mastra-managed tables', () => {
    expect(APP_OWNED_COLLECTIONS).toContain('knowledge_base');
    expect(APP_OWNED_COLLECTIONS).toContain('semantic_response_cache');
    expect(APP_OWNED_COLLECTIONS.some(c => c.startsWith('mastra_'))).toBe(false);
  });
});
