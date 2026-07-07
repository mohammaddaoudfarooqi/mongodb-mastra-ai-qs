import { registerApiRoute } from '@mastra/core/server';
import type { ApiRoute, ApiRouteHandler } from '@mastra/core/server';
import type { Context } from 'hono';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

/** Default built-SPA directory, relative to the repo root at runtime. */
const DEFAULT_DIST = 'frontend/dist';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve the built React SPA (`frontend/dist`) from the same server as the API,
 * so one Mastra deploy (Docker or Cloud) serves both (D2 / REQ-E-006).
 *
 * - A request whose path looks like a built asset (has a file extension) is
 *   served as that static file; a miss returns 404.
 * - Any other GET (an SPA client route like `/` or `/chat`) returns
 *   `index.html`, letting the client router take over.
 *
 * Path traversal is prevented by normalizing and rejecting any resolved path
 * that escapes the dist directory.
 */
export function buildSpaHandler(distDir = DEFAULT_DIST) {
  return async (c: Context): Promise<Response> => {
    const urlPath = new URL(c.req.url).pathname;
    const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
    const hasExt = extname(rel) !== '';

    if (hasExt) {
      const filePath = join(distDir, rel);
      // Reject traversal outside the dist dir.
      if (!normalize(filePath).startsWith(normalize(distDir))) {
        return c.body(null, 403);
      }
      try {
        const data = await readFile(filePath);
        const type = CONTENT_TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream';
        return c.body(new Uint8Array(data), 200, { 'Content-Type': type });
      } catch {
        return c.body(null, 404);
      }
    }

    // SPA route: serve index.html.
    try {
      const html = await readFile(join(distDir, 'index.html'), 'utf-8');
      return c.html(html);
    } catch {
      return c.body('SPA not built (frontend/dist/index.html missing)', 503);
    }
  };
}

/** The SPA fallback as a Mastra ApiRoute — a catch-all GET registered last. */
export function buildSpaRoute(distDir = DEFAULT_DIST): ApiRoute {
  return registerApiRoute('/*', {
    method: 'GET', requiresAuth: false,
    handler: buildSpaHandler(distDir) as ApiRouteHandler,
  });
}
