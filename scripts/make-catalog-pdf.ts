import { PDFDocument, StandardFonts, rgb, degrees, type PDFImage, type PDFPage, type PDFFont, type RGB } from 'pdf-lib';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateProducts, generatePromotions } from '../src/ingestion/fixtures';
import type { Product } from '../src/mastra/schemas/products';

// Authors a visually rich, deterministic demo catalog. The point of page-render
// (multimodal) ingestion is that the page IMAGE carries signal a text layer drops:
// real product PHOTOS, color, layout, sale ribbons, coupon-card design. So this
// embeds committed CC0 (public-domain, no attribution) product photos in the
// product cards and draws real graphics, while still keeping a genuine text layer
// (names, prices, SAVE codes) for the text-only reranker. Regenerate the photos
// with `pnpm fetch:catalog-images`. No em dashes in copy (repo convention).

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'ingestion', 'assets', 'catalog.pdf');
const IMG_DIR = join(HERE, '..', 'src', 'ingestion', 'assets', 'product-images');

// Mirrors fixtures.ts noun derivation so each product maps to its committed photo.
const NOUNS = ['mug', 'shirt', 'chair', 'lamp', 'bottle', 'notebook', 'speaker', 'blanket', 'knife', 'backpack'];
const productIndex = (p: Product) => Number(p._id.replace('prod_', '')) - 1;
const nounFor = (p: Product) => NOUNS[Math.floor(productIndex(p) / 10) % NOUNS.length];

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 40;

// ---- color helpers (deterministic, no randomness) ----

function hsl(h: number, s: number, l: number): RGB {
  // h in [0,360), s/l in [0,1]. Standard HSL -> RGB.
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return rgb(r + m, g + m, b + m);
}

// Each category gets a distinct hue so its page has a recognizable visual identity.
const CATEGORY_HUE: Record<string, number> = {
  kitchen: 24, apparel: 212, outdoor: 138, electronics: 255, home: 186,
  toys: 320, beauty: 340, grocery: 96, sports: 6, office: 222,
};

function theme(category: string) {
  const h = CATEGORY_HUE[category] ?? 210;
  return {
    deep: hsl(h, 0.68, 0.34),
    primary: hsl(h, 0.62, 0.48),
    light: hsl(h, 0.55, 0.92),
    chip: hsl(h, 0.5, 0.86),
  };
}

// A deterministic swatch color per product, standing in for a product photo.
function swatch(p: Product, i: number): RGB {
  const base = CATEGORY_HUE[p.category] ?? 210;
  const h = (base + ((i * 47) % 60) - 30 + 360) % 360;
  const l = 0.44 + ((i * 13) % 28) / 100; // 0.44..0.72
  return hsl(h, 0.58, l);
}

const INK = rgb(0.12, 0.13, 0.16);
const MUTED = rgb(0.42, 0.44, 0.5);
const SALE_RED = rgb(0.82, 0.12, 0.18);
const WHITE = rgb(1, 1, 1);
const PAPER = rgb(0.98, 0.98, 0.985);

// ---- drawing primitives ----

function fonts(doc: PDFDocument) {
  return Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
  ]);
}

/** Wrap text to a max width, returning the lines. */
function wrap(font: PDFFont, text: string, size: number, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const trial = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(trial, size) > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = trial;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function pageBackground(page: PDFPage, color: RGB) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color });
}

/** A category page header band with title and a subtitle strip. */
function header(page: PDFPage, bold: PDFFont, reg: PDFFont, title: string, subtitle: string, t: ReturnType<typeof theme>) {
  const bandH = 96;
  const y = PAGE_H - bandH;
  page.drawRectangle({ x: 0, y, width: PAGE_W, height: bandH, color: t.deep });
  page.drawRectangle({ x: 0, y: y - 8, width: PAGE_W, height: 8, color: t.primary });
  page.drawText(title, { x: MARGIN, y: y + 46, size: 30, font: bold, color: WHITE });
  page.drawText(subtitle, { x: MARGIN, y: y + 22, size: 12, font: reg, color: hsl(0, 0, 0.92) });
  // decorative dots on the right
  for (let i = 0; i < 3; i++) {
    page.drawCircle({ x: PAGE_W - 40 - i * 26, y: y + 48, size: 9 - i * 2, color: t.light, opacity: 0.9 });
  }
}

/** One product card: real product photo (or swatch fallback), name, price with sale treatment, category chip. */
function productCard(
  page: PDFPage, bold: PDFFont, reg: PDFFont,
  p: Product, i: number, x: number, y: number, w: number, h: number, t: ReturnType<typeof theme>,
  photo: PDFImage | null,
) {
  // drop shadow + card
  page.drawRectangle({ x: x + 3, y: y - 3, width: w, height: h, color: rgb(0.85, 0.86, 0.88) });
  page.drawRectangle({ x, y, width: w, height: h, color: WHITE, borderColor: t.chip, borderWidth: 1 });

  // product photo on the left (falls back to a color swatch if the image is missing)
  const sw = 74;
  const ix = x + 12;
  const iy = y + h - sw - 12;
  if (photo) {
    page.drawImage(photo, { x: ix, y: iy, width: sw, height: sw });
    page.drawRectangle({ x: ix, y: iy, width: sw, height: sw, borderColor: t.chip, borderWidth: 1 });
  } else {
    page.drawRectangle({ x: ix, y: iy, width: sw, height: sw, color: swatch(p, i) });
  }

  const tx = x + 12 + sw + 12;
  const tw = w - (12 + sw + 12) - 12;

  // name (wrapped, max 2 lines)
  const nameLines = wrap(bold, p.name, 12, tw).slice(0, 2);
  let ny = y + h - 24;
  for (const ln of nameLines) {
    page.drawText(ln, { x: tx, y: ny, size: 12, font: bold, color: INK });
    ny -= 15;
  }

  // price block (kept clear of the category chip at the card bottom)
  if (p.on_sale) {
    const origY = y + 58;
    const orig = `$${p.price_usd.toFixed(2)}`;
    page.drawText(orig, { x: tx, y: origY, size: 11, font: reg, color: MUTED });
    const ow = reg.widthOfTextAtSize(orig, 11);
    page.drawLine({ start: { x: tx, y: origY + 4 }, end: { x: tx + ow, y: origY + 4 }, thickness: 1, color: SALE_RED });
    page.drawText(`$${p.sale_price_usd.toFixed(2)}`, { x: tx, y: origY - 22, size: 16, font: bold, color: SALE_RED });
    // SALE ribbon in the top-right corner
    page.drawRectangle({ x: x + w - 58, y: y + h - 26, width: 64, height: 18, color: SALE_RED, rotate: degrees(-18) });
    page.drawText('SALE', { x: x + w - 52, y: y + h - 24, size: 10, font: bold, color: WHITE, rotate: degrees(-18) });
  } else {
    page.drawText(`$${p.price_usd.toFixed(2)}`, { x: tx, y: y + 40, size: 16, font: bold, color: INK });
  }

  // category chip
  const chipY = y + 12;
  page.drawRectangle({ x: tx, y: chipY, width: reg.widthOfTextAtSize(p.category, 9) + 14, height: 15, color: t.chip });
  page.drawText(p.category, { x: tx + 7, y: chipY + 4, size: 9, font: reg, color: t.deep });
}

/** A category page: header band + a 2-column grid of product cards. */
function categoryPage(
  doc: PDFDocument, bold: PDFFont, reg: PDFFont, category: string, title: string, subtitle: string,
  products: Product[], photos: Map<string, PDFImage>,
) {
  const t = theme(category);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  pageBackground(page, t.light);
  header(page, bold, reg, title, subtitle, t);

  const items = products.filter(p => p.category === category).slice(0, 6);
  const cols = 2;
  const gap = 16;
  const cardW = (PAGE_W - MARGIN * 2 - gap) / cols;
  const cardH = 150;
  const topY = PAGE_H - 96 - 8 - 24;
  items.forEach((p, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = MARGIN + col * (cardW + gap);
    const y = topY - cardH - row * (cardH + gap);
    productCard(page, bold, reg, p, idx, x, y, cardW, cardH, t, photos.get(nounFor(p)) ?? null);
  });

  // footer note
  page.drawText('Prices shown in USD. Use the coupon codes on the final page to save.', {
    x: MARGIN, y: 28, size: 9, font: reg, color: MUTED,
  });
}

// ---- pages ----

function coverPage(doc: PDFDocument, bold: PDFFont, reg: PDFFont) {
  const t = theme('outdoor');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  pageBackground(page, hsl(138, 0.3, 0.96));

  // masthead: stacked bands approximating a summer gradient
  const bands = 5;
  const bandH = 320 / bands;
  for (let i = 0; i < bands; i++) {
    page.drawRectangle({
      x: 0, y: PAGE_H - (i + 1) * bandH, width: PAGE_W, height: bandH + 0.5,
      color: hsl(138 - i * 6, 0.6, 0.36 + i * 0.05),
    });
  }
  // sun motif
  page.drawCircle({ x: PAGE_W - 96, y: PAGE_H - 96, size: 46, color: hsl(46, 0.9, 0.62) });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    page.drawLine({
      start: { x: PAGE_W - 96 + Math.cos(a) * 54, y: PAGE_H - 96 + Math.sin(a) * 54 },
      end: { x: PAGE_W - 96 + Math.cos(a) * 68, y: PAGE_H - 96 + Math.sin(a) * 68 },
      thickness: 3, color: hsl(46, 0.9, 0.62),
    });
  }

  page.drawText('SUMMER', { x: MARGIN, y: PAGE_H - 150, size: 60, font: bold, color: WHITE });
  page.drawText('2026', { x: MARGIN, y: PAGE_H - 214, size: 60, font: bold, color: hsl(46, 0.95, 0.66) });
  page.drawText('CATALOG', { x: MARGIN + 4, y: PAGE_H - 250, size: 26, font: reg, color: WHITE });

  page.drawText('Fresh deals across kitchen, apparel, outdoor, and more.', {
    x: MARGIN, y: PAGE_H - 360, size: 14, font: reg, color: INK,
  });

  // category chip row
  const chips = ['kitchen', 'apparel', 'outdoor', 'electronics', 'home'];
  let cx = MARGIN;
  const cy = PAGE_H - 410;
  for (const c of chips) {
    const ct = theme(c);
    const cw = reg.widthOfTextAtSize(c, 12) + 22;
    page.drawRectangle({ x: cx, y: cy, width: cw, height: 26, color: ct.primary });
    page.drawText(c, { x: cx + 11, y: cy + 8, size: 12, font: bold, color: WHITE });
    cx += cw + 10;
  }

  // three teaser blocks
  const teasers = [
    ['Kitchen', 'Cookware and gadgets'],
    ['Apparel', 'Seasonal styles'],
    ['Coupons', 'Save up to 25 percent'],
  ];
  const bw = (PAGE_W - MARGIN * 2 - 2 * 16) / 3;
  teasers.forEach(([h, s], i) => {
    const bx = MARGIN + i * (bw + 16);
    const by = 120;
    const bt = theme(['kitchen', 'apparel', 'grocery'][i]);
    page.drawRectangle({ x: bx, y: by, width: bw, height: 150, color: WHITE, borderColor: bt.chip, borderWidth: 1 });
    page.drawRectangle({ x: bx, y: by + 150 - 10, width: bw, height: 10, color: bt.primary });
    page.drawText(h, { x: bx + 14, y: by + 110, size: 16, font: bold, color: INK });
    page.drawText(s, { x: bx + 14, y: by + 90, size: 10, font: reg, color: MUTED });
  });

  page.drawText('MongoDB and Mastra retail demo. Every price and code below is deterministic and matches the seeded data.', {
    x: MARGIN, y: 40, size: 9, font: reg, color: MUTED,
  });
}

function couponPage(doc: PDFDocument, bold: PDFFont, reg: PDFFont, promos: ReturnType<typeof generatePromotions>) {
  const t = theme('grocery');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  pageBackground(page, hsl(96, 0.25, 0.96));
  header(page, bold, reg, 'Sale Terms and Coupons', 'Summer savings valid through August 2026.', t);

  const startY = PAGE_H - 96 - 8 - 40;
  const ticketH = 92;
  const gap = 16;
  const ticketW = PAGE_W - MARGIN * 2;

  promos.forEach((pr, i) => {
    const ct = theme(pr.applies_to_category);
    const y = startY - ticketH - i * (ticketH + gap);
    // ticket body
    page.drawRectangle({ x: MARGIN, y, width: ticketW, height: ticketH, color: ct.light, borderColor: ct.primary, borderWidth: 1.5 });
    // stub perforation
    const stubX = MARGIN + 150;
    for (let d = 0; d < ticketH; d += 10) {
      page.drawLine({ start: { x: stubX, y: y + d }, end: { x: stubX, y: y + d + 5 }, thickness: 1.5, color: ct.primary });
    }
    // big discount circle on the stub
    page.drawCircle({ x: MARGIN + 75, y: y + ticketH / 2, size: 34, color: ct.primary });
    page.drawText(`${pr.discount_pct}%`, { x: MARGIN + 52, y: y + ticketH / 2 - 8, size: 22, font: bold, color: WHITE });

    // code + copy on the right
    page.drawText('COUPON CODE', { x: stubX + 20, y: y + ticketH - 26, size: 9, font: reg, color: MUTED });
    page.drawText(pr.code, { x: stubX + 20, y: y + ticketH - 52, size: 24, font: bold, color: ct.deep });
    page.drawText(`${pr.discount_pct} percent off ${pr.applies_to_category}.`, {
      x: stubX + 20, y: y + 16, size: 12, font: reg, color: INK,
    });
  });

  page.drawText('One code per order. Codes are case sensitive. See store policy for full terms.', {
    x: MARGIN, y: 34, size: 9, font: reg, color: MUTED,
  });
}

/** Embed each committed CC0 product photo once, keyed by noun. Missing files are skipped (card falls back to a swatch). */
async function embedPhotos(doc: PDFDocument): Promise<Map<string, PDFImage>> {
  const photos = new Map<string, PDFImage>();
  for (const noun of NOUNS) {
    const file = join(IMG_DIR, `${noun}.jpg`);
    if (!existsSync(file)) continue;
    try {
      photos.set(noun, await doc.embedJpg(readFileSync(file)));
    } catch (err) {
      console.warn(`skipping ${noun}.jpg (embed failed): ${String(err)}`);
    }
  }
  return photos;
}

async function main() {
  const products = generateProducts();
  const promos = generatePromotions();
  const doc = await PDFDocument.create();
  const [reg, bold] = await fonts(doc);
  const photos = await embedPhotos(doc);
  console.log(`embedded ${photos.size} product photos`);

  coverPage(doc, bold, reg);
  categoryPage(doc, bold, reg, 'kitchen', 'Kitchen Deals', 'Cookware, gadgets, and prep essentials.', products, photos);
  categoryPage(doc, bold, reg, 'apparel', 'Apparel', 'Seasonal styles and everyday basics.', products, photos);
  couponPage(doc, bold, reg, promos);

  writeFileSync(OUT, await doc.save());
  console.log(`wrote ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
