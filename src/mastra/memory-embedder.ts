import { VoyageAIClient } from 'voyageai';
import type { Config } from '../config';
import { resolveVoyageBaseUrl } from './embed';

/**
 * Memory semantic-recall embedder. Mastra `Memory` takes an AI-SDK EmbeddingModelV2<string>.
 * We implement the minimal surface backed by Voyage TEXT embeddings on the MongoDB-hosted
 * endpoint, so the Atlas-scoped VOYAGE_API_KEY authenticates (native api.voyageai.com 403s it),
 * and the dimension probe succeeds without @huggingface/transformers (see fixes.md #4).
 *
 * Note: memory recall is text-only, so voyage-3.5 (1024-dim) is used here rather than the
 * multimodal model used for knowledge_base (both are 1024-dim cosine), but memory has its own
 * Mastra-managed index so the space need not match knowledge_base.
 */
export const MEMORY_EMBED_MODEL = 'voyage-3.5';

export interface TextEmbedClient {
  embed(req: {
    input: string[];
    model: string;
    inputType?: 'query' | 'document';
  }): Promise<{ data?: { index?: number; embedding?: number[] }[] }>;
}

// Structural type: the fields Mastra's Memory reads off an EmbeddingModelV2<string>.
export interface EmbeddingModelV2Like {
  readonly specificationVersion: 'v2';
  readonly provider: string;
  readonly modelId: string;
  readonly maxEmbeddingsPerCall: number | undefined;
  readonly supportsParallelCalls: boolean;
  doEmbed(options: { values: string[] }): Promise<{ embeddings: number[][]; usage?: { tokens: number } }>;
}

export function createMongoVoyageEmbeddingModel(deps: { client: TextEmbedClient; model?: string }): EmbeddingModelV2Like {
  const modelId = deps.model ?? MEMORY_EMBED_MODEL;
  return {
    specificationVersion: 'v2',
    provider: 'voyage.mongodb',
    modelId,
    maxEmbeddingsPerCall: 128,
    supportsParallelCalls: false,
    async doEmbed({ values }) {
      const res = await deps.client.embed({ input: values, model: modelId, inputType: 'document' });
      const rows = (res.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return { embeddings: rows.map(r => r.embedding ?? []), usage: { tokens: 0 } };
    },
  };
}

export function getMemoryEmbedder(cfg: Config): EmbeddingModelV2Like {
  const client = new VoyageAIClient({ apiKey: cfg.voyageApiKey, baseUrl: resolveVoyageBaseUrl(cfg) } as any);
  return createMongoVoyageEmbeddingModel({ client: client as unknown as TextEmbedClient, model: cfg.memoryEmbedModel });
}
