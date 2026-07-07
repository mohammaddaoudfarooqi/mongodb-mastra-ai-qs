import { fieldsFor } from '../schemas';

export interface GuardResult { ok: boolean; reason?: string; }

const ALLOWED_OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$not', '$exists', '$regex', '$text', '$options',
]);
const BLACKLIST = new Set([
  '$where', '$function', '$accumulator', '$expr',
  '$lookup', '$merge', '$out', '$unionWith', '$graphLookup', '$facet',
]);
const LOGICAL = new Set(['$and', '$or', '$not']);

function fail(reason: string): GuardResult { return { ok: false, reason }; }

/** Recursively validate operators, fields, and $regex length. */
function walk(node: unknown, fields: string[], regexMaxLen: number): GuardResult {
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = walk(item, fields, regexMaxLen);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if (node === null || typeof node !== 'object') return { ok: true };

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('$')) {
      if (BLACKLIST.has(key)) return fail(`operator not permitted: ${key}`);
      if (!ALLOWED_OPERATORS.has(key)) return fail(`operator not in allow-list: ${key}`);
      if (key === '$regex' && typeof value === 'string' && value.length > regexMaxLen) {
        return fail(`$regex exceeds max length ${regexMaxLen}`);
      }
      if (LOGICAL.has(key)) {
        const r = walk(value, fields, regexMaxLen);
        if (!r.ok) return r;
      } else if (value !== null && typeof value === 'object') {
        const r = walk(value, fields, regexMaxLen);
        if (!r.ok) return r;
      }
    } else {
      // field name (dot notation allowed; validate the root segment)
      const root = key.split('.')[0];
      if (!fields.includes(root)) return fail(`unknown field: ${key}`);
      if (value !== null && typeof value === 'object') {
        const r = walk(value, fields, regexMaxLen);
        if (!r.ok) return r;
      }
    }
  }
  return { ok: true };
}

export function validateQuery(
  input: { collection: string; filter: Record<string, unknown> },
  opts: { allowList: string[]; regexMaxLen?: number },
): GuardResult {
  if (!opts.allowList.includes(input.collection)) {
    return fail(`collection not in allow-list: ${input.collection}`);
  }
  const fields = fieldsFor(input.collection);
  if (!fields) return fail(`no declared schema for collection: ${input.collection}`);
  return walk(input.filter, fields, opts.regexMaxLen ?? 128);
}
