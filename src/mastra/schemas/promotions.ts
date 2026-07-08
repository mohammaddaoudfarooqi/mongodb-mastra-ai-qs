export interface Promotion {
  _id: string; code: string; discount_pct: number; applies_to_category: string;
  product_ids: string[]; starts_at: Date; ends_at: Date; active: boolean;
}
export const PROMOTIONS_SCHEMA = {
  name: 'promotions',
  fields: ['_id', 'code', 'discount_pct', 'applies_to_category', 'product_ids', 'starts_at', 'ends_at', 'active'],
  // starts_at/ends_at are BSON Dates; the NL→MQL layer coerces ISO-8601 strings in
  // filters to Date, so date-window queries still work.
  dateFields: ['starts_at', 'ends_at'],
  description: 'Active promotions. discount_pct 0-100; starts_at/ends_at are BSON Dates (query with an ISO-8601 string); active boolean.',
};
