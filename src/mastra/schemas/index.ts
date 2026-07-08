import { PRODUCTS_SCHEMA } from './products';
import { ORDERS_SCHEMA } from './orders';
import { PROMOTIONS_SCHEMA } from './promotions';

export interface CollectionSchema {
  name: string;
  fields: string[];
  description: string;
  /** Fields stored as BSON Date. The NL→MQL layer coerces ISO-8601 string values under
   *  these fields to Date before querying, so a Date column stays queryable by string. */
  dateFields?: string[];
}
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

/** The BSON Date fields declared for a collection (empty when none / unknown collection). */
export function dateFieldsFor(collection: string): string[] {
  return SCHEMAS[collection]?.dateFields ?? [];
}
