import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPdfRasterizer } from './pdf';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'assets', 'fixtures', 'tiny-2page.pdf');

describe('createPdfRasterizer', () => {
  it('rasterizes each page to a png data url and extracts its text layer', async () => {
    const bytes = readFileSync(FIXTURE);
    const pages = await createPdfRasterizer().rasterize(bytes);

    expect(pages).toHaveLength(2);
    expect(pages.map(p => p.page)).toEqual([1, 2]);
    for (const p of pages) {
      expect(p.imageDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(p.imageDataUrl.length).toBeGreaterThan(100);
    }
    expect(pages[0].text).toContain('ALPHA');
    expect(pages[1].text).toContain('BRAVO');
  }, 30_000);

  it('honors a custom scale (larger scale yields a larger image)', async () => {
    const bytes = readFileSync(FIXTURE);
    const [small] = await createPdfRasterizer({ scale: 1 }).rasterize(bytes);
    const [large] = await createPdfRasterizer({ scale: 3 }).rasterize(bytes);
    expect(large.imageDataUrl.length).toBeGreaterThan(small.imageDataUrl.length);
  }, 30_000);
});
