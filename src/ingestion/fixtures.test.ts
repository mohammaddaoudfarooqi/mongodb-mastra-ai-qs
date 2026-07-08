import { describe, it, expect } from 'vitest';
import { generateProducts, generateOrders, generatePromotions, CATEGORIES, TEXT_KNOWLEDGE, loadAssetManifest } from './fixtures';
import { PRODUCTS_SCHEMA } from '../mastra/schemas/products';

describe('generateProducts', () => {
  it('loads the committed catalog with schema-valid fields and unique ids', () => {
    const all = generateProducts();
    expect(all.length).toBeGreaterThanOrEqual(1500);
    const allowed = new Set(PRODUCTS_SCHEMA.fields);
    for (const p of all.slice(0, 5)) {
      expect(new Set(Object.keys(p))).toEqual(allowed);
      expect(typeof p._id).toBe('string');
      expect(CATEGORIES).toContain(p.category);
      expect(p.price_usd).toBeGreaterThan(0);
      expect(Array.isArray(p.tags)).toBe(true);
      if (p.on_sale) expect(p.sale_price_usd).toBeLessThan(p.price_usd);
    }
    expect(new Set(all.map(p => p._id)).size).toBe(all.length);
  });

  // Regression guard: product NAMES must be globally unique. Duplicate names (the old
  // generator collapsed 1505 products into ~394 names, up to 6 sharing a name at two
  // different prices) made cart adds ambiguous — a name lookup resolved to an arbitrary
  // variant and the grounding set held conflicting ids, so the agent thrashed on "add".
  it('gives every product a globally unique name', () => {
    const all = generateProducts();
    const names = all.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Every product is in stock so the demo never hits a 0-stock "cannot add / cannot check
  // out" dead end (the old `(i*3)%50` stock formula produced 0-stock items).
  it('keeps every product in stock (stock > 0)', () => {
    for (const p of generateProducts()) expect(p.stock).toBeGreaterThan(0);
  });

  it('honors an explicit count for callers that request a slice', () => {
    expect(generateProducts(100)).toHaveLength(100);
  });

  it('is stable across calls', () => {
    expect(generateProducts(50)).toEqual(generateProducts(50));
  });
});

describe('generateOrders', () => {
  it('references only generated product ids and matches order schema shape', () => {
    const products = generateProducts(100);
    const orders = generateOrders(products, 20);
    expect(orders).toHaveLength(20);
    const ids = new Set(products.map(p => p._id));
    for (const o of orders) {
      expect(['placed', 'shipped', 'delivered', 'cancelled']).toContain(o.status);
      expect(o.items.length).toBeGreaterThan(0);
      for (const it of o.items) expect(ids.has(it.product_id)).toBe(true);
      expect(o.total_usd).toBeGreaterThan(0);
      // placed_at is a BSON Date, not an ISO string (see the datetime-type fix).
      expect(o.placed_at).toBeInstanceOf(Date);
    }
  });
});

describe('generatePromotions', () => {
  it('produces active promotions with a discount and a category', () => {
    const promos = generatePromotions(5);
    expect(promos).toHaveLength(5);
    for (const p of promos) {
      expect(p.discount_pct).toBeGreaterThan(0);
      expect(p.discount_pct).toBeLessThanOrEqual(100);
      expect(CATEGORIES).toContain(p.applies_to_category);
      // starts_at/ends_at are BSON Dates, not ISO strings (see the datetime-type fix).
      expect(p.starts_at).toBeInstanceOf(Date);
      expect(p.ends_at).toBeInstanceOf(Date);
    }
  });
});

describe('TEXT_KNOWLEDGE', () => {
  it('loads the committed markdown KB docs with non-empty text', () => {
    expect(TEXT_KNOWLEDGE.length).toBeGreaterThanOrEqual(5);
    for (const d of TEXT_KNOWLEDGE) {
      expect(d.id).toBeTruthy();
      expect(d.text.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('loadAssetManifest', () => {
  it('loads entries and accepts a pdf mediaType', () => {
    const entries = loadAssetManifest();
    expect(entries.length).toBeGreaterThan(0);
    const kinds = new Set(entries.map(e => e.mediaType));
    for (const k of kinds) expect(['image', 'pdf']).toContain(k);
  });
});
