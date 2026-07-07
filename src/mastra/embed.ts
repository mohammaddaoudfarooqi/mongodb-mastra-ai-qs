import { VoyageAIClient } from 'voyageai';
import type { Config } from '../config';

/**
 * Voyage multimodal embedding, called directly against the underlying SDK.
 *
 * We deliberately bypass `@mastra/voyageai`'s `voyage.multimodal.embedOne`: that wrapper
 * (v0.3.0) maps each input to a BARE ARRAY of content items, so the Voyage `multimodalEmbed`
 * API rejects it with `inputs -> [0]: Expected object. Received list`. The API requires each
 * input to be an OBJECT `{ content: [...] }`. `buildMultimodalInputs` produces that shape and
 * is unit-tested as a regression guard (the wrapper bug was invisible because every test mocked
 * the embedder). All embeddings live in the unified voyage-multimodal-3.5 space (1024-dim cosine),
 * so query and document/cache vectors are comparable.
 */

export const MULTIMODAL_MODEL = 'voyage-multimodal-3.5';

/**
 * Default to the MongoDB-hosted Voyage endpoint so a MongoDB Atlas Voyage key authenticates
 * (native api.voyageai.com rejects Atlas-scoped keys with 403). Override via VOYAGE_BASE_URL;
 * set it empty to fall back to the SDK default (api.voyageai.com) with a native Voyage key.
 */
export const MONGODB_VOYAGE_BASE_URL = 'https://ai.mongodb.com/v1';

export interface MultimodalInput {
  content: { type: 'text'; text: string }[];
}

/** Wrap plain text queries into the object-shaped inputs the Voyage API requires. */
export function buildMultimodalInputs(texts: string[]): MultimodalInput[] {
  return texts.map(text => ({ content: [{ type: 'text', text }] }));
}

/** Minimal structural view of the SDK client methods we depend on (keeps the unit test hermetic). */
export interface MultimodalEmbedClient {
  multimodalEmbed(request: {
    inputs: MultimodalInput[];
    model: string;
    inputType?: 'query' | 'document';
  }): Promise<{ data?: { index?: number; embedding?: number[] }[] }>;
}

export const RERANKER_MODEL = 'rerank-2.5';

export interface RerankClient {
  rerank(request: {
    query: string;
    documents: string[];
    model: string;
    topK?: number;
  }): Promise<{ data?: { index?: number; relevanceScore?: number; document?: string }[] }>;
}

export interface VoyageReranker {
  /** Rerank docs against a query; returns {document, index, score} sorted by descending score. */
  rerankDocuments(query: string, docs: string[], topK?: number): Promise<{ document: string; index: number; score: number }[]>;
}

export function createVoyageReranker(deps: { client: RerankClient; model?: string }): VoyageReranker {
  const model = deps.model ?? RERANKER_MODEL;
  return {
    async rerankDocuments(query, docs, topK) {
      const res = await deps.client.rerank({ query, documents: docs, model, topK });
      return (res.data ?? []).map(r => ({
        index: r.index ?? 0,
        score: r.relevanceScore ?? 0,
        document: r.document ?? docs[r.index ?? 0] ?? '',
      }));
    },
  };
}

export interface VoyageEmbedder {
  /** Embed a single query string, returning its 1024-dim vector. */
  embedQuery(query: string): Promise<number[]>;
}

export function createVoyageEmbedder(deps: {
  client: MultimodalEmbedClient;
  model?: string;
}): VoyageEmbedder {
  const model = deps.model ?? MULTIMODAL_MODEL;
  return {
    async embedQuery(query: string): Promise<number[]> {
      const res = await deps.client.multimodalEmbed({
        inputs: buildMultimodalInputs([query]),
        model,
        inputType: 'query',
      });
      const rows = res.data ?? [];
      const first = rows.find(r => (r.index ?? 0) === 0) ?? rows[0];
      return first?.embedding ?? [];
    },
  };
}

/** Resolve the Voyage base URL: explicit config wins, else the MongoDB-hosted default. */
export function resolveVoyageBaseUrl(cfg: Config): string {
  return cfg.voyageBaseUrl ?? MONGODB_VOYAGE_BASE_URL;
}

/** Construct a live VoyageAIClient pointed at the resolved base URL. */
function voyageClient(cfg: Config): VoyageAIClient {
  return new VoyageAIClient({ apiKey: cfg.voyageApiKey, baseUrl: resolveVoyageBaseUrl(cfg) } as any);
}

/** Construct a VoyageEmbedder backed by a live VoyageAIClient from config. */
export function getQueryEmbedder(cfg: Config): VoyageEmbedder {
  return createVoyageEmbedder({ client: voyageClient(cfg) as unknown as MultimodalEmbedClient, model: MULTIMODAL_MODEL });
}

/** Construct a VoyageReranker backed by a live VoyageAIClient from config. */
export function getReranker(cfg: Config): VoyageReranker {
  return createVoyageReranker({ client: voyageClient(cfg) as unknown as RerankClient, model: RERANKER_MODEL });
}

export type DocContentItem =
  | { type: 'text'; text: string }
  | { type: 'image_base64'; imageBase64: string }
  | { type: 'image_url'; imageUrl: string };

/** Assemble one multimodal document input: text first, optional image second. */
export function buildDocContent(text: string, image?: { base64?: string; url?: string }): { content: DocContentItem[] } {
  const content: DocContentItem[] = [{ type: 'text', text }];
  if (image?.base64) content.push({ type: 'image_base64', imageBase64: image.base64 });
  else if (image?.url) content.push({ type: 'image_url', imageUrl: image.url });
  return { content };
}

export interface DocEmbedClient {
  multimodalEmbed(req: {
    inputs: { content: DocContentItem[] }[];
    model: string;
    inputType?: 'query' | 'document';
  }): Promise<{ data?: { index?: number; embedding?: number[] }[] }>;
}

export interface DocEmbedder {
  /** Embed document inputs; returns 1024-dim vectors in the SAME order as `inputs`. */
  embedDocuments(inputs: { content: DocContentItem[] }[]): Promise<number[][]>;
}

export function createDocEmbedder(deps: { client: DocEmbedClient; model?: string }): DocEmbedder {
  const model = deps.model ?? MULTIMODAL_MODEL;
  return {
    async embedDocuments(inputs) {
      if (inputs.length === 0) return [];
      const res = await deps.client.multimodalEmbed({ inputs, model, inputType: 'document' });
      const rows = (res.data ?? []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return rows.map(r => r.embedding ?? []);
    },
  };
}

export function getDocEmbedder(cfg: Config): DocEmbedder {
  return createDocEmbedder({ client: voyageClient(cfg) as unknown as DocEmbedClient, model: MULTIMODAL_MODEL });
}
