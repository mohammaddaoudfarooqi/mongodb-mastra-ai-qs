import { validateQuery } from './mql-guard';
import { logger } from '../../observability/logger';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db } from 'mongodb';
import { SCHEMAS, dateFieldsFor } from '../schemas';

const LOGICAL_OPS = new Set(['$and', '$or', '$not']);
// Comparison operators whose operands are date VALUES (not sub-filters) for a date field.
const VALUE_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin']);

/** Coerce one date value (or operator object / array) from an ISO string to a Date.
 *  Unparseable strings and non-string values are left untouched, so a malformed date can
 *  never crash the query — it simply won't match a Date-typed column (safe degradation). */
function coerceDateValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms);
  }
  if (Array.isArray(value)) return value.map(coerceDateValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = VALUE_OPS.has(k) ? coerceDateValue(v) : v;
    }
    return out;
  }
  return value;
}

/** Recursively coerce ISO-string date values under declared date fields to BSON Dates,
 *  so the model can express dates as ISO-8601 strings while the columns are stored as
 *  Date. Mirrors the recursive shape of mql-guard's `walk`; only touches declared date
 *  fields and $and/$or/$not sub-clauses, leaving every other value exactly as given. */
function coerceDateFilter(filter: Record<string, unknown>, dateFields: string[]): Record<string, unknown> {
  if (!dateFields.length) return filter;
  const dates = new Set(dateFields);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (LOGICAL_OPS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map(v => (v && typeof v === 'object' ? coerceDateFilter(v as Record<string, unknown>, dateFields) : v))
        : (value && typeof value === 'object' ? coerceDateFilter(value as Record<string, unknown>, dateFields) : value);
    } else if (dates.has(key)) {
      out[key] = coerceDateValue(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface RunFindResult { ok: boolean; rows?: unknown[]; reason?: string; }

function operatorKeys(filter: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) { if (k.startsWith('$')) found.add(k); walk(v); }
    }
  };
  walk(filter);
  return [...found];
}

export async function runValidatedFind(
  input: { collection: string; filter: Record<string, unknown> },
  deps: { find(collection: string, filter: Record<string, unknown>, limit: number): Promise<unknown[]>; allowList: string[]; limit: number },
): Promise<RunFindResult> {
  const verdict = validateQuery(input, { allowList: deps.allowList });
  logger.info('nl2mql audit', {
    collection: input.collection,
    operators: operatorKeys(input.filter),
    decision: verdict.ok ? 'allow' : 'deny',
    reason: verdict.reason,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  // The columns are BSON Dates but the model expresses dates as ISO-8601 strings; coerce
  // string values under declared date fields to Date so range/equality filters match.
  const filter = coerceDateFilter(input.filter, dateFieldsFor(input.collection));
  const rows = await deps.find(input.collection, filter, deps.limit);
  return { ok: true, rows };
}

export function buildDataQueryTool(args: {
  db: Db; allowList: string[]; limit: number; onSignals?: () => void;
  /**
   * Reports the `products` `_id`s a query returned this turn, so cartAdd can enforce
   * retrieval grounding (only add a product the shopper's request actually surfaced).
   * Only products rows are reported — orders/promotions ids are irrelevant to the cart.
   */
  onProductsFound?: (ids: string[]) => void;
}) {
  return createTool({
    id: 'dataQuery',
    description: `Query live retail data. Collections and fields: ${JSON.stringify(
      Object.fromEntries(Object.entries(SCHEMAS).map(([k, v]) => [k, v.fields])),
    )}. Read-only find filters only.`,
    inputSchema: z.object({ collection: z.string(), filter: z.record(z.any()).default({}) }),
    execute: async (inputData, context) => {
      args.onSignals?.();
      const result = await runValidatedFind(
        { collection: inputData.collection, filter: inputData.filter },
        {
          allowList: args.allowList,
          limit: args.limit,
          find: (c, f, l) => args.db.collection(c).find(f as any).limit(l).toArray(),
        },
      );
      if (result.ok && inputData.collection === 'products' && result.rows?.length) {
        args.onProductsFound?.((result.rows as any[]).map(r => String(r._id)));
      }
      return result;
    },
  });
}
