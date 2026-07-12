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

/**
 * Recipe ingredients the knowledge base's recipes reference (the 20-Minute Garlic Butter Pasta
 * and the 20-Minute Garlic Chicken Skillet). The demo must be able to ADD every one of these to
 * the cart, so each is guaranteed a real, in-stock grocery product (see recipeIngredientProducts).
 * `match` is the set of lowercase substrings that must all appear in a product name to count as
 * that ingredient — kept in sync with the recipe text and asserted by fixtures.test.ts. garlic and
 * parsley are shared across both recipes (listed once).
 */
export const RECIPE_INGREDIENTS: { label: string; name: string; match: string[]; price: number }[] = [
  { label: 'spaghetti',    name: 'Spaghetti Pasta 16oz',          match: ['spaghetti'],          price: 2.49 },
  { label: 'butter',       name: 'Unsalted Butter 16oz',          match: ['butter'],             price: 4.99 },
  { label: 'garlic',       name: 'Fresh Garlic Bulbs 3-pack',     match: ['garlic'],             price: 1.99 },
  { label: 'chili flakes', name: 'Crushed Chili Flakes 2oz',      match: ['chili', 'flakes'],    price: 3.49 },
  { label: 'parmesan',     name: 'Grated Parmesan Cheese 8oz',    match: ['parmesan'],           price: 6.99 },
  { label: 'parsley',      name: 'Fresh Parsley Bunch',           match: ['parsley'],            price: 1.79 },
  { label: 'chicken',      name: 'Boneless Chicken Breast 1lb',   match: ['chicken'],            price: 7.99 },
  { label: 'olive oil',    name: 'Extra Virgin Olive Oil 16oz',   match: ['olive'],              price: 8.49 },
  { label: 'lemon',        name: 'Fresh Lemons 4-pack',           match: ['lemon'],              price: 2.29 },
  { label: 'black pepper', name: 'Ground Black Pepper 2oz',       match: ['pepper'],             price: 3.29 },
];

/**
 * Concrete in-stock grocery products for every RECIPE_INGREDIENTS entry. Ids live in a reserved
 * `prod_9xxx` range so they never collide with the generated catalog (`prod_0001`..`prod_1505`).
 * Without these, a shopper asking to "add the pasta recipe ingredients" got "we don't carry
 * those" because the generated grocery vocab has only generic "Pasta" (no spaghetti/garlic/etc.).
 */
export function recipeIngredientProducts(): Product[] {
  return RECIPE_INGREDIENTS.map((ing, i) => ({
    _id: `prod_9${String(i + 1).padStart(3, '0')}`,
    name: ing.name,
    category: 'grocery',
    // Name the ingredient in the description too, so a lexical/substring or $regex lookup on
    // description finds it even if the agent doesn't guess the exact product name.
    description: `${ing.name} — ${ing.label} for home cooking (e.g. our quick weeknight recipes). In stock and ready to ship.`,
    price_usd: ing.price,
    sale_price_usd: ing.price,
    on_sale: false,
    stock: 99,
    // Tag with each plain ingredient keyword ("spaghetti", "butter", …) so the NL→MQL agent's
    // instinctive tag query — {tags: "<ingredient>"} — resolves without needing the exact
    // product name. This is what makes "add the recipe ingredients" reliably work in the demo.
    tags: ['grocery', 'recipe-ingredient', ...ing.match],
  }));
}

/**
 * Loads the committed realistic catalog PLUS the guaranteed recipe-ingredient products.
 * With `count`, returns the first N entries of the combined list. The recipe products are
 * appended so a `count` slice used elsewhere still yields the generated catalog first.
 */
export function generateProducts(count?: number): Product[] {
  const all = [...loadCatalog(), ...recipeIngredientProducts()];
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
