export interface Order {
  _id: string; userId: string; status: 'placed' | 'shipped' | 'delivered' | 'cancelled';
  items: { product_id: string; qty: number; unit_price_usd: number }[];
  total_usd: number; placed_at: string;
}
export const ORDERS_SCHEMA = {
  name: 'orders',
  fields: ['_id', 'userId', 'status', 'items', 'total_usd', 'placed_at'],
  description: 'Customer orders. status enum placed|shipped|delivered|cancelled; placed_at ISO-8601.',
};
