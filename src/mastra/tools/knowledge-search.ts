import { rrfFuse, type RankedDoc } from './rrf';
import { logger } from '../../observability/logger';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { MongoDBVector } from '@mastra/mongodb';
import { KNOWLEDGE_INDEX } from '../vector';

export interface KnowledgeHit { id: string; document: string; metadata: Record<string, unknown>; score: number; }

export interface SearchDeps {
  embed(q: string): Promise<number[]>;
  vectorSearch(vec: number[], topK: number): Promise<RankedDoc[]>;
  lexicalSearch(q: string, topK: number): Promise<RankedDoc[]>;
  rerank(q: string, docs: RankedDoc[], topK: number): Promise<{ index: number; score: number }[]>;
}

export async function runKnowledgeSearch(
  query: string,
  deps: SearchDeps,
  opts: { rrfK: number; topK: number },
): Promise<KnowledgeHit[]> {
  const CANDIDATES = Math.max(opts.topK * 4, 20);

  let vec: number[];
  try {
    vec = await deps.embed(query);
  } catch (err) {
    logger.warn('knowledgeSearch embed failed; returning empty', { err: String(err) });
    return [];
  }

  const [vectorList, lexicalList] = await Promise.all([
    deps.vectorSearch(vec, CANDIDATES).catch(err => {
      logger.warn('vectorSearch failed', { err: String(err) });
      return [] as RankedDoc[];
    }),
    deps.lexicalSearch(query, CANDIDATES).catch(err => {
      logger.warn('lexicalSearch failed; vector-only', { err: String(err) });
      return [] as RankedDoc[];
    }),
  ]);

  const fused = rrfFuse(vectorList, lexicalList, opts.rrfK);
  if (fused.length === 0) return [];

  let ordered = fused;
  try {
    const scores = await deps.rerank(query, fused, opts.topK);
    ordered = scores
      .map(s => ({ doc: fused[s.index], score: s.score }))
      .filter(x => x.doc)
      .sort((a, b) => b.score - a.score)
      .map(x => ({ ...x.doc, rrfScore: x.score }));
  } catch (err) {
    logger.warn('rerank failed; using fused order', { err: String(err) });
  }

  return ordered.slice(0, opts.topK).map(d => ({
    id: d.id,
    document: d.document ?? '',
    metadata: d.metadata ?? {},
    score: (d as any).rrfScore ?? 0,
  }));
}

/**
 * Build the Mastra knowledgeSearch tool. `onSignals` lets the server record that
 * knowledgeSearch ran and whether it returned results (for cache write eligibility).
 */
export function buildKnowledgeSearchTool(args: {
  vector: MongoDBVector;
  embed: (q: string) => Promise<number[]>;
  reranker: { rerankDocuments(q: string, docs: string[], topK?: number): Promise<{ document: string; index: number; score: number }[]> };
  rrfK: number;
  onSignals?: (s: { ran: true; hadResults: boolean }) => void;
}) {
  const deps: SearchDeps = {
    embed: args.embed,
    vectorSearch: async (vec, topK) => {
      const res = await args.vector.query({ indexName: KNOWLEDGE_INDEX, queryVector: vec, topK });
      return res.map(r => ({ id: r.id, document: r.document, metadata: r.metadata }));
    },
    lexicalSearch: async (q, topK) => {
      // $search over the derived search index on the knowledge_base collection.
      const col = (args.vector as any).db?.collection?.(KNOWLEDGE_INDEX);
      if (!col) return [];
      const rows = await col.aggregate([
        { $search: { index: `${KNOWLEDGE_INDEX}_search_index`, text: { query: q, path: { wildcard: '*' } } } },
        { $limit: topK },
        { $project: { _id: 1, document: 1, metadata: 1 } },
      ]).toArray();
      return rows.map((r: any) => ({ id: r._id, document: r.document, metadata: r.metadata }));
    },
    rerank: async (q, docs, topK) => {
      const results = await args.reranker.rerankDocuments(q, docs.map(d => d.document ?? ''), topK);
      return results.map(r => ({ index: r.index, score: r.score }));
    },
  };

  return createTool({
    id: 'knowledgeSearch',
    description: 'Search the retail knowledge base (policies, recipes, product pamphlets, images). Returns grounded snippets.',
    inputSchema: z.object({ query: z.string(), topK: z.number().int().positive().max(20).default(5) }),
    execute: async (inputData, context) => {
      const hits = await runKnowledgeSearch(inputData.query, deps, { rrfK: args.rrfK, topK: inputData.topK });
      args.onSignals?.({ ran: true, hadResults: hits.length > 0 });
      return { hits };
    },
  });
}
