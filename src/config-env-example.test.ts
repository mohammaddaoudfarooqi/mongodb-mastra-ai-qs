import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * REQ-E-010: `.env.example` must document every env var the config reads, so
 * Mastra Cloud's first-deploy env seeding and a Docker `.env` both have a
 * complete reference. This guards against a new `env.X` read that ships without
 * a documented default.
 */
describe('.env.example completeness (REQ-E-010)', () => {
  const root = join(__dirname, '..');
  const configSrc = readFileSync(join(root, 'src', 'config.ts'), 'utf-8');
  const envExample = readFileSync(join(root, '.env.example'), 'utf-8');

  // Env keys read in config.ts, via `env.X` or `parsed.X` (zod schema) or the schema object.
  const referenced = new Set<string>();
  for (const m of configSrc.matchAll(/\benv\.([A-Z0-9_]+)\b/g)) referenced.add(m[1]);
  for (const m of configSrc.matchAll(/\bparsed\.([A-Z0-9_]+)\b/g)) referenced.add(m[1]);

  // Keys documented in .env.example (line starts with KEY=).
  const documented = new Set<string>();
  for (const line of envExample.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m) documented.add(m[1]);
  }

  it('documents every env var config.ts reads', () => {
    const missing = [...referenced].filter(k => !documented.has(k)).sort();
    expect(missing, `.env.example missing keys read by config.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents the Mongo pool tuning knobs (REQ-E-007)', () => {
    expect(documented.has('MONGO_MAX_POOL_SIZE')).toBe(true);
    expect(documented.has('MONGO_MIN_POOL_SIZE')).toBe(true);
  });
});
