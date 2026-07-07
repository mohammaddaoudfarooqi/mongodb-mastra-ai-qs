import { describe, it, expect, vi } from 'vitest';
import { provisionLexicalSearchIndex, KNOWLEDGE_SEARCH_INDEX } from './vector';

/** A fake MongoDBVector exposing just the `.db.collection()` handle the lexical
 *  provisioner reaches through, with the createSearchIndex/listSearchIndexes API. */
function fakeVector(existingIndexes: { name: string }[] = []) {
  const created: any[] = [];
  const col = {
    createIndex: vi.fn(async () => ({})),
    listSearchIndexes: () => ({ toArray: async () => existingIndexes }),
    createSearchIndex: vi.fn(async (spec: any) => { created.push(spec); return spec.name; }),
  };
  const v = { db: { collection: () => col } } as any;
  return { v, col, created };
}

describe('provisionLexicalSearchIndex (reviewer finding #9)', () => {
  it('creates the lexical $search index with dynamic mapping when absent', async () => {
    const { v, col, created } = fakeVector([]);
    await provisionLexicalSearchIndex(v);
    expect(col.createSearchIndex).toHaveBeenCalledTimes(1);
    expect(created[0].name).toBe(KNOWLEDGE_SEARCH_INDEX);
    expect(created[0].definition.mappings.dynamic).toBe(true);
  });

  it('is idempotent: does not recreate an existing index', async () => {
    const { v, col } = fakeVector([{ name: KNOWLEDGE_SEARCH_INDEX }]);
    await provisionLexicalSearchIndex(v);
    expect(col.createSearchIndex).not.toHaveBeenCalled();
  });

  it('is best-effort: swallows createSearchIndex failure (does not throw)', async () => {
    const { v, col } = fakeVector([]);
    col.createSearchIndex.mockRejectedValueOnce(new Error('atlas down'));
    await expect(provisionLexicalSearchIndex(v)).resolves.toBeUndefined();
  });

  it('skips cleanly when the collection handle is unavailable', async () => {
    await expect(provisionLexicalSearchIndex({} as any)).resolves.toBeUndefined();
  });
});
