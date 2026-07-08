import { describe, it, expect } from 'vitest';
import { SCHEMAS, fieldsFor, dateFieldsFor } from './index';

describe('retail schemas', () => {
  it('exposes products/orders/promotions with declared fields', () => {
    expect(Object.keys(SCHEMAS).sort()).toEqual(['orders', 'products', 'promotions']);
    expect(SCHEMAS.products.fields).toContain('price_usd');
    expect(SCHEMAS.products.fields).toContain('on_sale');
    expect(SCHEMAS.orders.fields).toContain('status');
    expect(SCHEMAS.promotions.fields).toContain('discount_pct');
  });

  it('fieldsFor returns null for an unknown collection (fail-closed hook)', () => {
    expect(fieldsFor('carts')).toBeNull();
    expect(fieldsFor('products')).not.toBeNull();
  });

  it('declares BSON Date fields per collection for NL→MQL coercion', () => {
    expect(dateFieldsFor('orders')).toEqual(['placed_at']);
    expect(dateFieldsFor('promotions')).toEqual(['starts_at', 'ends_at']);
    expect(dateFieldsFor('products')).toEqual([]);   // no date fields
    expect(dateFieldsFor('carts')).toEqual([]);      // unknown collection → empty
  });
});
