export interface Order {
  _id: string; userId: string; status: 'placed' | 'shipped' | 'delivered' | 'cancelled';
  items: { product_id: string; qty: number; unit_price_usd: number }[];
  total_usd: number; placed_at: Date;
}
export const ORDERS_SCHEMA = {
  name: 'orders',
  fields: ['_id', 'userId', 'status', 'items', 'total_usd', 'placed_at'],
  // placed_at is a BSON Date; the NL→MQL layer coerces ISO-8601 strings in filters to
  // Date, so range queries like { placed_at: { $gte: "2026-03-01" } } still work.
  dateFields: ['placed_at'],
  description: 'Customer orders. status enum placed|shipped|delivered|cancelled; placed_at is a BSON Date (query with an ISO-8601 string).',
};
