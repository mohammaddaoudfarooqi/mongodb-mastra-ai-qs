import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpaHandler } from './static';

describe('buildSpaHandler (REQ-E-006: SPA static + fallback)', () => {
  let dist: string;

  beforeAll(async () => {
    dist = await mkdtemp(join(tmpdir(), 'spa-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>storefront</title>');
    await mkdir(join(dist, 'assets'), { recursive: true });
    await writeFile(join(dist, 'assets', 'app.js'), 'console.log("hi")');
  });

  afterAll(async () => { await rm(dist, { recursive: true, force: true }); });

  function app() {
    const a = new Hono();
    a.get('/*', buildSpaHandler(dist));
    return a;
  }

  it('serves index.html for an SPA route (no extension)', async () => {
    const res = await app().request('/chat');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('storefront');
  });

  it('serves index.html for the root path', async () => {
    const res = await app().request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('storefront');
  });

  it('serves a built asset with the right content-type', async () => {
    const res = await app().request('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(await res.text()).toContain('console.log');
  });

  it('returns 404 for a missing asset (has extension, not present)', async () => {
    const res = await app().request('/assets/missing.js');
    expect(res.status).toBe(404);
  });

  it('rejects path traversal outside the dist dir', async () => {
    const res = await app().request('/..%2f..%2fetc%2fpasswd.js');
    expect([403, 404]).toContain(res.status);
  });

  it('returns 503 when the SPA is not built', async () => {
    const a = new Hono();
    a.get('/*', buildSpaHandler(join(tmpdir(), 'does-not-exist-dist')));
    const res = await a.request('/');
    expect(res.status).toBe(503);
  });
});
