export interface Promotion {
  _id: string; code: string; discount_pct: number; applies_to_category: string;
  product_ids: string[]; starts_at: string; ends_at: string; active: boolean;
}
export const PROMOTIONS_SCHEMA = {
  name: 'promotions',
  fields: ['_id', 'code', 'discount_pct', 'applies_to_category', 'product_ids', 'starts_at', 'ends_at', 'active'],
  description: 'Active promotions. discount_pct 0-100; starts_at/ends_at ISO-8601; active boolean.',
};
