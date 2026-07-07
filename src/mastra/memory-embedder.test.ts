import { describe, it, expect, vi } from 'vitest';
import { createMongoVoyageEmbeddingModel } from './memory-embedder';

describe('createMongoVoyageEmbeddingModel', () => {
  it('is a v2 embedding model with voyage provider metadata', () => {
    const model = createMongoVoyageEmbeddingModel({ client: { embed: vi.fn() } as any, model: 'voyage-3.5' });
    expect(model.specificationVersion).toBe('v2');
    expect(model.provider).toBe('voyage.mongodb');
    expect(model.modelId).toBe('voyage-3.5');
  });

  it('doEmbed calls Voyage embed with document inputType and returns vectors in input order', async () => {
    const embed = vi.fn(async () => ({
      data: [
        { index: 1, embedding: [9, 9] },
        { index: 0, embedding: [1, 1] },
      ],
    }));
    const model = createMongoVoyageEmbeddingModel({ client: { embed } as any, model: 'voyage-3.5' });
    const res = await model.doEmbed({ values: ['a', 'b'] });
    expect(res.embeddings).toEqual([[1, 1], [9, 9]]);
    expect(embed).toHaveBeenCalledWith({ input: ['a', 'b'], model: 'voyage-3.5', inputType: 'document' });
  });

  it('handles a single value', async () => {
    const embed = vi.fn(async () => ({ data: [{ index: 0, embedding: [0.5] }] }));
    const model = createMongoVoyageEmbeddingModel({ client: { embed } as any });
    const res = await model.doEmbed({ values: ['solo'] });
    expect(res.embeddings).toEqual([[0.5]]);
  });
});
