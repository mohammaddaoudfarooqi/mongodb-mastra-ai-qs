export interface RankedDoc { id: string; document?: string; metadata?: Record<string, unknown>; }

/**
 * Reciprocal Rank Fusion. score(d) = Σ_i 1 / (k + rank_i(d)), ranks 0-based.
 * A doc appearing in both lists gets both contributions summed; deduped by id.
 */
export function rrfFuse(
  vectorList: RankedDoc[],
  lexicalList: RankedDoc[],
  k = 60,
): (RankedDoc & { rrfScore: number })[] {
  const acc = new Map<string, RankedDoc & { rrfScore: number }>();
  const add = (list: RankedDoc[]) => {
    list.forEach((doc, rank) => {
      const contribution = 1 / (k + rank);
      const existing = acc.get(doc.id);
      if (existing) existing.rrfScore += contribution;
      else acc.set(doc.id, { ...doc, rrfScore: contribution });
    });
  };
  add(vectorList);
  add(lexicalList);
  return [...acc.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}
