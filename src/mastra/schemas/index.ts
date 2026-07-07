import { PRODUCTS_SCHEMA } from './products';
import { ORDERS_SCHEMA } from './orders';
import { PROMOTIONS_SCHEMA } from './promotions';

export interface CollectionSchema { name: string; fields: string[]; description: string; }
export * from './products';
export * from './orders';
export * from './promotions';

export const SCHEMAS: Record<string, CollectionSchema> = {
  products: PRODUCTS_SCHEMA,
  orders: ORDERS_SCHEMA,
  promotions: PROMOTIONS_SCHEMA,
};

export function fieldsFor(collection: string): string[] | null {
  return SCHEMAS[collection]?.fields ?? null;
}
