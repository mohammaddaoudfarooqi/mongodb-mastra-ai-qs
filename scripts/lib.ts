import type { Config } from '../src/config';

// Re-export so existing `scripts/` imports keep working; the guard lives in src/ so
// src-side entrypoints (seed.ts) can use it without importing across into scripts/.
export { confirmDestructive } from '../src/destructive-guard';

export function batched<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const DEFAULT_PREWARM_QUERIES: string[] = [
  'What is the return policy?',
  'How long does shipping take?',
  'How does the loyalty program work?',
  'Can I combine coupons?',
  'Show me a quick pasta recipe.',
];

export function resolvePrewarmQueries(cfg: Config): string[] {
  return cfg.prewarmQueries ?? DEFAULT_PREWARM_QUERIES;
}

export const APP_OWNED_COLLECTIONS = [
  'knowledge_base', 'semantic_response_cache', 'products', 'orders', 'promotions', 'carts', 'feedback',
];
