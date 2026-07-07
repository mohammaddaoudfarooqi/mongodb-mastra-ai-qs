import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';

// Dev-only, run manually (pnpm fetch:catalog-images). Downloads one commercially
// free, no-attribution CC0 (public domain) product photo per catalog noun from
// Openverse (Wikimedia-sourced), validates it decodes as a raster image, crops it
// to a centered square, and writes a committed JPEG. The committed images make
// scripts/make-catalog-pdf.ts fully offline and reproducible; this fetcher is not
// part of make:catalog and never runs at ingest time. No em dashes in copy.

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'src', 'ingestion', 'assets', 'product-images');
const UA = 'mongodb-mastra-ai-qs-demo/1.0 (retail catalog demo)';
const SIZE = 320; // committed square size

// Refined queries so the top CC0 hit is actually the product, not a lookalike.
// Each noun: search queries plus the words the result TITLE must contain, so a
// "bottleneck landscape" or other keyword-collision result is rejected.
const NOUNS: Record<string, { queries: string[]; mustMatch: string[] }> = {
  mug: { queries: ['ceramic coffee mug', 'coffee mug cup'], mustMatch: ['mug', 'cup', 'coffee'] },
  shirt: { queries: ['folded t-shirt clothing', 't-shirt apparel'], mustMatch: ['shirt', 'tshirt', 't-shirt'] },
  chair: { queries: ['wooden chair furniture', 'office chair'], mustMatch: ['chair'] },
  lamp: { queries: ['table lamp light', 'desk lamp'], mustMatch: ['lamp'] },
  bottle: { queries: ['water bottle product', 'plastic water bottle', 'glass drink bottle'], mustMatch: ['bottle'] },
  notebook: { queries: ['paper notebook stationery', 'spiral notebook'], mustMatch: ['notebook', 'note', 'paper', 'pencil'] },
};

interface Candidate { url: string; license: string; title: string; category: string; }

async function search(query: string, photoOnly: boolean): Promise<Candidate[]> {
  // category=photograph excludes illustrations, diagrams, and digitized drawings;
  // we try that first, then fall back to any image if a noun has no CC0 photo.
  const cat = photoOnly ? '&category=photograph' : '';
  const u = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}` +
    `&license=cc0&extension=jpg${cat}&page_size=16&mature=false`;
  const res = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Openverse ${res.status} for "${query}"`);
  const json: any = await res.json();
  return (json.results ?? [])
    .filter((r: any) => ['jpg', 'jpeg', 'png'].includes(r.filetype) && typeof r.url === 'string')
    .map((r: any) => ({ url: r.url, license: r.license, title: r.title ?? '', category: r.category ?? '' }));
}

/** Fetch bytes and decode; returns a centered-square JPEG buffer, or null if not a usable image. */
async function toSquareJpeg(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 4000) return null; // too small to be a real photo
    const img = await loadImage(bytes);
    if (!img.width || !img.height || img.width < 200 || img.height < 200) return null;
    const side = Math.min(img.width, img.height);
    const sx = (img.width - side) / 2;
    const sy = (img.height - side) / 2;
    const canvas = createCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
    return canvas.toBuffer('image/jpeg', 90);
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const manifest: Array<{ noun: string; source: string; license: string; title: string }> = [];

  for (const [noun, { queries, mustMatch }] of Object.entries(NOUNS)) {
    let saved = false;
    // Pass 1: photographs only. Pass 2: any CC0 image (fallback for nouns with no photo).
    for (const photoOnly of [true, false]) {
      for (const q of queries) {
        const candidates = (await search(q, photoOnly)).filter(c => {
          const t = c.title.toLowerCase();
          return mustMatch.some(m => t.includes(m));
        });
        for (const c of candidates) {
          const jpeg = await toSquareJpeg(c.url);
          if (jpeg) {
            const file = join(OUT_DIR, `${noun}.jpg`);
            writeFileSync(file, jpeg);
            manifest.push({ noun, source: c.url, license: c.license, title: c.title });
            console.log(`${noun}: saved (${jpeg.length} bytes, ${c.license}, ${photoOnly ? 'photo' : 'any'}) from ${c.url}`);
            saved = true;
            break;
          }
        }
        if (saved) break;
      }
      if (saved) break;
    }
    if (!saved) console.error(`${noun}: NO usable CC0 image found`);
  }

  // Record provenance next to the images (CC0 needs no attribution, but we keep a
  // record of where each came from and its license for auditability).
  writeFileSync(join(OUT_DIR, 'CREDITS.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nwrote ${manifest.length} images + CREDITS.json to ${OUT_DIR}`);
}

main().catch(err => { console.error(err); process.exit(1); });
