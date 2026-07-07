export interface Product {
  _id: string; name: string; category: string; description: string;
  price_usd: number; sale_price_usd: number; on_sale: boolean; stock: number; tags: string[];
}
export const PRODUCTS_SCHEMA = {
  name: 'products',
  fields: ['_id', 'name', 'category', 'description', 'price_usd', 'sale_price_usd', 'on_sale', 'stock', 'tags'],
  description: 'Retail catalog. price_usd/sale_price_usd in USD; on_sale boolean; stock integer; tags string array.',
};
