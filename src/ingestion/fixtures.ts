import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Product } from '../mastra/schemas/products';
import type { Order } from '../mastra/schemas/orders';
import type { Promotion } from '../mastra/schemas/promotions';

const HERE = dirname(fileURLToPath(import.meta.url));

export const CATEGORIES = [
  'kitchen', 'apparel', 'outdoor', 'electronics', 'home',
  'toys', 'beauty', 'grocery', 'sports', 'office',
];

let CATALOG_CACHE: Product[] | null = null;
function loadCatalog(): Product[] {
  if (!CATALOG_CACHE) {
    const raw = readFileSync(join(HERE, 'data', 'catalog.json'), 'utf8');
    CATALOG_CACHE = JSON.parse(raw) as Product[];
  }
  return CATALOG_CACHE;
}

/** Loads the committed realistic catalog. With `count`, returns the first N entries. */
export function generateProducts(count?: number): Product[] {
  const all = loadCatalog();
  return count === undefined ? all : all.slice(0, count);
}

const STATUSES: Order['status'][] = ['placed', 'shipped', 'delivered', 'cancelled'];

export function generateOrders(products: Product[], count = 20): Order[] {
  const orders: Order[] = [];
  for (let i = 0; i < count; i++) {
    const lineCount = 1 + (i % 3);
    const items = Array.from({ length: lineCount }, (_, j) => {
      const p = products[(i * 3 + j) % products.length];
      return { product_id: p._id, qty: 1 + (j % 2), unit_price_usd: p.price_usd };
    });
    const total = items.reduce((s, it) => s + it.unit_price_usd * it.qty, 0);
    orders.push({
      _id: `order_${String(i + 1).padStart(4, '0')}`,
      userId: i % 2 === 0 ? 'demo' : `user_${i}`,
      status: STATUSES[i % STATUSES.length],
      items,
      total_usd: Number(total.toFixed(2)),
      placed_at: new Date(`2026-0${(i % 6) + 1}-15T10:00:00.000Z`),
    });
  }
  return orders;
}

export function generatePromotions(count = 5): Promotion[] {
  return Array.from({ length: count }, (_, i) => ({
    _id: `promo_${String(i + 1).padStart(4, '0')}`,
    code: `SAVE${(i + 1) * 5}`,
    discount_pct: (i + 1) * 5,
    applies_to_category: CATEGORIES[i % CATEGORIES.length],
    product_ids: [],
    starts_at: new Date('2026-06-01T00:00:00.000Z'),
    ends_at: new Date('2026-09-01T00:00:00.000Z'),
    active: true,
  }));
}

export interface TextKnowledgeDoc { id: string; title: string; source: string; text: string }

function loadTextKnowledge(): TextKnowledgeDoc[] {
  const dir = join(HERE, 'knowledge');
  return readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => {
      const text = readFileSync(join(dir, f), 'utf8');
      const firstLine = text.split('\n', 1)[0].replace(/^#\s*/, '').trim();
      return { id: f.replace(/\.md$/, ''), title: firstLine || f, source: 'knowledge', text };
    });
}

export const TEXT_KNOWLEDGE: TextKnowledgeDoc[] = loadTextKnowledge();

export interface AssetManifestEntry {
  file: string; title: string; source: string; mediaType: 'image' | 'pdf'; extractedText?: string;
}

export function loadAssetManifest(): AssetManifestEntry[] {
  const raw = readFileSync(join(HERE, 'assets', 'manifest.json'), 'utf8');
  return (JSON.parse(raw).assets ?? []) as AssetManifestEntry[];
}
