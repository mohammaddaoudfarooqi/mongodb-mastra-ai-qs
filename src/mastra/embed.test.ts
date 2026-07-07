import { describe, it, expect, vi } from 'vitest';
import { buildMultimodalInputs, createVoyageEmbedder, resolveVoyageBaseUrl, MONGODB_VOYAGE_BASE_URL, buildDocContent, createDocEmbedder } from './embed';
import type { Config } from '../config';

describe('buildMultimodalInputs', () => {
  it('wraps each text as an input OBJECT with a content array (not a bare list)', () => {
    // Regression guard: @mastra/voyageai@0.3.0 sent a bare array per input, which the
    // Voyage multimodalEmbed API rejects with "inputs -> [0]: Expected object. Received list".
    // Each input MUST be { content: [{ type:'text', text }] }.
    expect(buildMultimodalInputs(['hello'])).toEqual([
      { content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('maps multiple texts to multiple input objects preserving order', () => {
    expect(buildMultimodalInputs(['a', 'b'])).toEqual([
      { content: [{ type: 'text', text: 'a' }] },
      { content: [{ type: 'text', text: 'b' }] },
    ]);
  });
});

describe('createVoyageEmbedder', () => {
  it('calls multimodalEmbed with the object-shaped inputs and query inputType, returning the vector', async () => {
    const multimodalEmbed = vi.fn(async () => ({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }));
    const embedder = createVoyageEmbedder({
      client: { multimodalEmbed } as any,
      model: 'voyage-multimodal-3.5',
    });

    const vec = await embedder.embedQuery('return policy');

    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(multimodalEmbed).toHaveBeenCalledWith({
      inputs: [{ content: [{ type: 'text', text: 'return policy' }] }],
      model: 'voyage-multimodal-3.5',
      inputType: 'query',
    });
  });

  it('returns the embedding for index 0 even if the API returns results out of order', async () => {
    const multimodalEmbed = vi.fn(async () => ({
      data: [
        { index: 1, embedding: [9, 9] },
        { index: 0, embedding: [1, 1] },
      ],
    }));
    const embedder = createVoyageEmbedder({ client: { multimodalEmbed } as any, model: 'm' });
    expect(await embedder.embedQuery('q')).toEqual([1, 1]);
  });
});

describe('resolveVoyageBaseUrl', () => {
  it('defaults to the MongoDB-hosted endpoint so an Atlas Voyage key authenticates', () => {
    expect(resolveVoyageBaseUrl({ voyageBaseUrl: undefined } as Config)).toBe(MONGODB_VOYAGE_BASE_URL);
    expect(MONGODB_VOYAGE_BASE_URL).toBe('https://ai.mongodb.com/v1');
  });

  it('honors an explicit VOYAGE_BASE_URL override', () => {
    expect(resolveVoyageBaseUrl({ voyageBaseUrl: 'https://api.voyageai.com/v1' } as Config))
      .toBe('https://api.voyageai.com/v1');
  });
});

describe('buildDocContent', () => {
  it('text-only input is a single content object with one text item', () => {
    expect(buildDocContent('a policy')).toEqual({ content: [{ type: 'text', text: 'a policy' }] });
  });

  it('text + base64 image interleaves text then image_base64 (camelCase key the SDK expects)', () => {
    expect(buildDocContent('a red mug', { base64: 'data:image/png;base64,AAAA' })).toEqual({
      content: [
        { type: 'text', text: 'a red mug' },
        { type: 'image_base64', imageBase64: 'data:image/png;base64,AAAA' },
      ],
    });
  });

  it('text + url image uses image_url', () => {
    expect(buildDocContent('a mug', { url: 'https://x/y.png' })).toEqual({
      content: [
        { type: 'text', text: 'a mug' },
        { type: 'image_url', imageUrl: 'https://x/y.png' },
      ],
    });
  });
});

describe('createDocEmbedder', () => {
  it('embeds documents with inputType document and returns vectors in input order', async () => {
    const multimodalEmbed = vi.fn(async () => ({
      data: [
        { index: 1, embedding: [2, 2] },
        { index: 0, embedding: [1, 1] },
      ],
    }));
    const embedder = createDocEmbedder({ client: { multimodalEmbed } as any, model: 'voyage-multimodal-3.5' });
    const vecs = await embedder.embedDocuments([
      buildDocContent('first'),
      buildDocContent('second'),
    ]);
    expect(vecs).toEqual([[1, 1], [2, 2]]); // re-ordered by index -> input order
    expect(multimodalEmbed).toHaveBeenCalledWith({
      inputs: [
        { content: [{ type: 'text', text: 'first' }] },
        { content: [{ type: 'text', text: 'second' }] },
      ],
      model: 'voyage-multimodal-3.5',
      inputType: 'document',
    });
  });

  it('returns [] for an empty input list without calling the client', async () => {
    const multimodalEmbed = vi.fn();
    const embedder = createDocEmbedder({ client: { multimodalEmbed } as any });
    expect(await embedder.embedDocuments([])).toEqual([]);
    expect(multimodalEmbed).not.toHaveBeenCalled();
  });
});
