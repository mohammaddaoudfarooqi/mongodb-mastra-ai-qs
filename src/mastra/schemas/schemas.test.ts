import { describe, it, expect } from 'vitest';
import { SCHEMAS, fieldsFor } from './index';

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
});
