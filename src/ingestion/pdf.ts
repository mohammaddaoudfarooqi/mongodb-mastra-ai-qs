import { createCanvas } from '@napi-rs/canvas';
// pdfjs-dist legacy build is the Node-friendly entrypoint (no DOM globals required).
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfPage {
  page: number;
  imageDataUrl: string;
  text: string;
}

export interface PdfRasterizer {
  /** Render every page to a PNG data URL and extract its embedded text layer, in page order. */
  rasterize(bytes: Buffer): Promise<PdfPage[]>;
}

const DEFAULT_SCALE = 2.0;

export function createPdfRasterizer(deps: { scale?: number } = {}): PdfRasterizer {
  const scale = deps.scale ?? DEFAULT_SCALE;
  return {
    async rasterize(bytes) {
      // pdfjs needs a Uint8Array view over its own copy of the bytes.
      const data = new Uint8Array(bytes);
      // Keep the loading task: its destroy() aborts the pdf.js worker. The proxy's
      // cleanup() only clears cached page data and would leak the worker per call.
      const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });
      const doc = await loadingTask.promise;
      try {
        const pages: PdfPage[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const viewport = page.getViewport({ scale });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const ctx = canvas.getContext('2d');
          // @napi-rs/canvas 2D context is API-compatible with what pdfjs expects.
          await page.render({ canvasContext: ctx as any, viewport, canvas: canvas as any }).promise;
          const imageDataUrl = `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;

          const content = await page.getTextContent();
          const text = content.items
            .map((it: any) => (typeof it.str === 'string' ? it.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

          pages.push({ page: n, imageDataUrl, text });
          page.cleanup();
        }
        return pages;
      } finally {
        await loadingTask.destroy();
      }
    },
  };
}
