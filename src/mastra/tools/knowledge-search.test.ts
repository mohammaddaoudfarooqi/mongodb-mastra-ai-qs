// src/mastra/tools/knowledge-search.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runKnowledgeSearch, hasPerishableHit, type SearchDeps, type KnowledgeHit } from './knowledge-search';
import type { RankedDoc } from './rrf';

const doc = (id: string, text: string): RankedDoc => ({ id, document: text, metadata: { mediaType: 'text' } });

function deps(over: Partial<SearchDeps> = {}): SearchDeps {
  return {
    embed: async () => Array.from({ length: 1024 }, () => 0.1),
    vectorSearch: async () => [doc('a', 'alpha'), doc('b', 'beta')],
    lexicalSearch: async () => [doc('b', 'beta'), doc('c', 'gamma')],
    rerank: async (_q, docs) => docs.map((_d, i) => ({ index: i, score: 1 - i * 0.1 })),
    ...over,
  };
}

describe('runKnowledgeSearch', () => {
  it('fuses vector + lexical, reranks, and returns top-k hits', async () => {
    const hits = await runKnowledgeSearch('q', deps(), { rrfK: 60, topK: 2 });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toHaveProperty('document');
    expect(hits[0]).toHaveProperty('score');
  });

  it('falls back to fused order when rerank throws (degrade, not throw)', async () => {
    const hits = await runKnowledgeSearch('q', deps({ rerank: async () => { throw new Error('rerank down'); } }), { rrfK: 60, topK: 3 });
    expect(hits.length).toBeGreaterThan(0); // still returns fused results
  });

  it('falls back to vector-only when lexical search throws', async () => {
    const hits = await runKnowledgeSearch('q', deps({ lexicalSearch: async () => { throw new Error('search down'); } }), { rrfK: 60, topK: 2 });
    expect(hits.map(h => h.id)).toContain('a');
  });

  it('returns [] when embed fails', async () => {
    const hits = await runKnowledgeSearch('q', deps({ embed: async () => { throw new Error('embed down'); } }), { rrfK: 60, topK: 2 });
    expect(hits).toEqual([]);
  });
});

describe('hasPerishableHit', () => {
  const hit = (source: string): KnowledgeHit => ({ id: 'x', document: 'd', metadata: { source }, score: 1 });

  it('is true when any hit is from a perishable (marketing) source', () => {
    // The sale pamphlet / catalog are ingested with source:"marketing" — time-bound content
    // whose grounded answer must NOT be cached as a fresh opener.
    expect(hasPerishableHit([hit('knowledge'), hit('marketing')])).toBe(true);
    expect(hasPerishableHit([hit('marketing')])).toBe(true);
  });

  it('is false when every hit is a stable knowledge/policy source', () => {
    expect(hasPerishableHit([hit('knowledge'), hit('knowledge')])).toBe(false);
  });

  it('is false for no hits and tolerates missing/odd metadata', () => {
    expect(hasPerishableHit([])).toBe(false);
    expect(hasPerishableHit([{ id: 'y', document: 'd', metadata: {}, score: 1 }])).toBe(false);
    expect(hasPerishableHit([{ id: 'z', document: 'd', metadata: { source: 'catalog' }, score: 1 }])).toBe(false);
  });
});
