// src/mastra/tools/knowledge-search.test.ts
import { describe, it, expect, vi } from 'vitest';
import { runKnowledgeSearch, type SearchDeps } from './knowledge-search';
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
