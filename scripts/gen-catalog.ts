import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Product } from '../src/mastra/schemas/products';
import { CATEGORIES } from '../src/ingestion/fixtures';

const HERE = dirname(fileURLToPath(import.meta.url));

// Curated, realistic retail vocabulary per category. Each entry combines with a
// descriptor + optional spec suffix to yield natural product names at scale.
const VOCAB: Record<string, { nouns: string[]; specs: string[] }> = {
  kitchen:     { nouns: ["Chef's Knife", 'Cast Iron Skillet', 'Insulated Water Bottle', 'Ceramic Mug', 'Cutting Board', 'Mixing Bowl Set', 'Nonstick Fry Pan', 'French Press', 'Measuring Cup Set', 'Stockpot'], specs: ['8in', '12oz', '32oz', '3qt', 'Large', 'Set of 4', ''] },
  apparel:     { nouns: ['Merino Wool Base Layer', 'Packable Rain Jacket', 'Cotton Crew Tee', 'Fleece Hoodie', 'Chino Pants', 'Wool Socks', 'Puffer Vest', 'Denim Jacket', 'Performance Shorts', 'Flannel Shirt'], specs: ['S', 'M', 'L', 'XL', ''] },
  outdoor:     { nouns: ['Camping Tent', 'Sleeping Bag', 'Trekking Poles', 'Hydration Pack', 'Camp Stove', 'Headlamp', 'Cooler', 'Hammock', 'Trail Backpack', 'Folding Chair'], specs: ['2-Person', '20L', '40L', 'Compact', ''] },
  electronics: { nouns: ['Wireless Bluetooth Speaker', 'USB-C Fast Charger', 'Noise-Cancelling Earbuds', 'Portable Power Bank', 'Mechanical Keyboard', 'Webcam', 'Smart Plug', 'LED Desk Lamp', 'Wireless Mouse', 'HDMI Cable'], specs: ['65W', '10000mAh', '1080p', '6ft', ''] },
  home:        { nouns: ['Throw Blanket', 'Scented Candle', 'Picture Frame', 'Storage Bin', 'Area Rug', 'Table Lamp', 'Bath Towel Set', 'Wall Clock', 'Planter Pot', 'Curtain Panel'], specs: ['Large', 'Set of 2', '5x7', ''] },
  toys:        { nouns: ['Building Block Set', 'Plush Bear', 'Wooden Puzzle', 'RC Car', 'Board Game', 'Art Kit', 'Action Figure', 'Play Kitchen', 'Toy Train Set', 'Science Kit'], specs: ['100pc', 'Deluxe', 'Mini', ''] },
  beauty:      { nouns: ['Facial Cleanser', 'Vitamin C Serum', 'Sheet Mask Pack', 'Lip Balm', 'Hair Dryer', 'Makeup Brush Set', 'Body Lotion', 'Sunscreen SPF 50', 'Nail Polish', 'Beard Oil'], specs: ['Travel Size', '4oz', 'Set of 5', ''] },
  grocery:     { nouns: ['Organic Coffee Beans', 'Extra Virgin Olive Oil', 'Dark Chocolate Bar', 'Rolled Oats', 'Almond Butter', 'Green Tea', 'Sea Salt', 'Honey', 'Pasta', 'Granola'], specs: ['12oz', '500ml', '1kg', ''] },
  sports:      { nouns: ['Yoga Mat', 'Adjustable Dumbbell', 'Resistance Band Set', 'Foam Roller', 'Jump Rope', 'Water Bottle', 'Basketball', 'Running Belt', 'Kettlebell', 'Gym Towel'], specs: ['15lb', '6mm', 'Official', ''] },
  office:      { nouns: ['Notebook', 'Gel Pen Set', 'Desk Organizer', 'Sticky Notes', 'Whiteboard', 'File Folder Set', 'Stapler', 'Laptop Stand', 'Monitor Riser', 'Cable Clips'], specs: ['A5', 'Pack of 12', 'Large', ''] },
};
const DESCRIPTORS = ['Classic', 'Premium', 'Deluxe', 'Compact', 'Eco', 'Pro', 'Everyday', 'Signature', 'Essential', 'Heavy-Duty'];

const COUNT = 1505;

function build(): Product[] {
  const out: Product[] = [];
  for (let i = 0; i < COUNT; i++) {
    const category = CATEGORIES[i % CATEGORIES.length];
    const v = VOCAB[category];
    const noun = v.nouns[Math.floor(i / CATEGORIES.length) % v.nouns.length];
    const descriptor = DESCRIPTORS[i % DESCRIPTORS.length];
    const spec = v.specs[Math.floor(i / (CATEGORIES.length * 3)) % v.specs.length];
    const name = [descriptor, noun, spec].filter(Boolean).join(' ');
    const price = 5 + ((i * 7) % 200) + 0.99;
    const onSale = i % 4 === 0;
    out.push({
      _id: `prod_${String(i + 1).padStart(4, '0')}`,
      name,
      category,
      description: `${name} — a well-reviewed ${category} product. Durable, dependable, and ready to ship.`,
      price_usd: Number(price.toFixed(2)),
      sale_price_usd: onSale ? Number((price * 0.8).toFixed(2)) : Number(price.toFixed(2)),
      on_sale: onSale,
      stock: (i * 3) % 50,
      tags: [category, descriptor.toLowerCase()],
    });
  }
  return out;
}

const dir = join(HERE, '..', 'src', 'ingestion', 'data');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'catalog.json'), JSON.stringify(build(), null, 2) + '\n');
console.log(`wrote ${COUNT} products to ${join(dir, 'catalog.json')}`);
