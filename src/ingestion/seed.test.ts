import { describe, it, expect, vi } from 'vitest';
import { buildTextKnowledgeDocs, embedAndUpsert } from './seed';

describe('buildTextKnowledgeDocs', () => {
  it('builds a lexically complete document with text metadata', () => {
    const out = buildTextKnowledgeDocs([
      { id: 'return-policy', title: 'Return Policy', source: 'knowledge', text: 'Returns within 30 days.' },
    ]);
    expect(out).toEqual([
      {
        id: 'return-policy',
        document: 'Return Policy\n\nReturns within 30 days.',
        metadata: { mediaType: 'text', source: 'knowledge', title: 'Return Policy' },
      },
    ]);
  });
});

describe('embedAndUpsert', () => {
  it('embeds documents in batches and upserts vectors/metadata/ids/documents by index name', async () => {
    const embedDocuments = vi.fn(async (inputs: any[]) => inputs.map(() => [0.1, 0.2]));
    const upsert = vi.fn(async (args: any) => undefined);
    const docs = [
      { id: 'a', document: 'doc a', metadata: { mediaType: 'text' } },
      { id: 'b', document: 'doc b', metadata: { mediaType: 'text' } },
      { id: 'c', document: 'doc c', metadata: { mediaType: 'text' } },
    ];
    const n = await embedAndUpsert({ upsert } as any, { embedDocuments } as any, docs, 2);
    expect(n).toBe(3);
    // batch size 2 → two embed calls (2 then 1)
    expect(embedDocuments).toHaveBeenCalledTimes(2);
    // upsert called with derived index name and aligned arrays
    expect(upsert).toHaveBeenCalledTimes(2);
    const firstCall = upsert.mock.calls[0][0];
    expect(firstCall.indexName).toBe('knowledge_base');
    expect(firstCall.ids).toEqual(['a', 'b']);
    expect(firstCall.documents).toEqual(['doc a', 'doc b']);
    expect(firstCall.vectors).toEqual([[0.1, 0.2], [0.1, 0.2]]);
    expect(firstCall.metadata).toEqual([{ mediaType: 'text' }, { mediaType: 'text' }]);
  });

  it('returns 0 and does not upsert for an empty doc list', async () => {
    const embedDocuments = vi.fn(async () => []);
    const upsert = vi.fn(async () => undefined);
    expect(await embedAndUpsert({ upsert } as any, { embedDocuments } as any, [], 32)).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});
