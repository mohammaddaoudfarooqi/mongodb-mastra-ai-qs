import { validateQuery } from './mql-guard';
import { logger } from '../../observability/logger';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Db } from 'mongodb';
import { SCHEMAS } from '../schemas';

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
  const rows = await deps.find(input.collection, input.filter, deps.limit);
  return { ok: true, rows };
}

export function buildDataQueryTool(args: {
  db: Db; allowList: string[]; limit: number; onSignals?: () => void;
}) {
  return createTool({
    id: 'dataQuery',
    description: `Query live retail data. Collections and fields: ${JSON.stringify(
      Object.fromEntries(Object.entries(SCHEMAS).map(([k, v]) => [k, v.fields])),
    )}. Read-only find filters only.`,
    inputSchema: z.object({ collection: z.string(), filter: z.record(z.any()).default({}) }),
    execute: async (inputData, context) => {
      args.onSignals?.();
      return runValidatedFind(
        { collection: inputData.collection, filter: inputData.filter },
        {
          allowList: args.allowList,
          limit: args.limit,
          find: (c, f, l) => args.db.collection(c).find(f as any).limit(l).toArray(),
        },
      );
    },
  });
}
