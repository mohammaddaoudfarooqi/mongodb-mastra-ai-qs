import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { MongoClient } from 'mongodb';
import type { MongoDBVector } from '@mastra/mongodb';
import type { Config } from '../config';
import { logger } from '../observability/logger';
import { createKnowledgeVector, KNOWLEDGE_INDEX } from '../mastra/vector';
import { getDocEmbedder, buildDocContent, type DocEmbedder } from '../mastra/embed';
import { loadAssetManifest, type AssetManifestEntry } from './fixtures';
import type { PdfPage } from './pdf';
import { createPdfRasterizer } from './pdf';

const HERE = dirname(fileURLToPath(import.meta.url));

export type DescribeFn = (input: { title: string; dataUrl: string }) => Promise<string>;

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

export function toDataUrl(bytes: Buffer, file: string): string {
  const mime = MIME[extname(file).toLowerCase()] ?? 'image/png';
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

export function buildAssetDocument(entry: AssetManifestEntry, description: string | null): string {
  return [entry.title, description ?? '', entry.extractedText ?? '']
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n');
}

export function buildAssetMetadata(
  entry: AssetManifestEntry,
  description: string | null,
  page?: number,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    mediaType: entry.mediaType, source: entry.source, title: entry.title,
    assetUri: entry.file, describeUsed: description != null,
  };
  if (page != null) meta.page = page;
  return meta;
}

export interface IngestDeps {
  vector: Pick<MongoDBVector, 'upsert'>;
  embedder: DocEmbedder;
  describe: DescribeFn;
  readAsset: (file: string) => Buffer;
  exists: (id: string) => Promise<boolean>;
  describeEnabled: boolean;
  rasterize: (bytes: Buffer) => Promise<PdfPage[]>;
}

async function ingestOne(
  deps: IngestDeps,
  unit: { id: string; entry: AssetManifestEntry; dataUrl: string; page?: number },
): Promise<'upserted' | 'skipped' | 'error'> {
  const { id, entry, dataUrl, page } = unit;
  try {
    if (await deps.exists(id)) {
      logger.info('ingest skip (exists)', { asset: id });
      return 'skipped';
    }
    let description: string | null = null;
    if (deps.describeEnabled) {
      try {
        description = await deps.describe({ title: entry.title, dataUrl });
      } catch (err) {
        logger.warn('describe failed; raw-image embed fallback', { asset: id, err: String(err) });
      }
    }
    const document = buildAssetDocument(entry, description);
    const [vector] = await deps.embedder.embedDocuments([buildDocContent(document, { base64: dataUrl })]);
    await deps.vector.upsert({
      indexName: KNOWLEDGE_INDEX,
      vectors: [vector],
      metadata: [buildAssetMetadata(entry, description, page)],
      ids: [id],
      documents: [document],
    });
    logger.info('ingest upserted', { asset: id, describeUsed: description != null });
    return 'upserted';
  } catch (err) {
    logger.error('ingest error; asset skipped', { asset: id, err: String(err) });
    return 'error';
  }
}

function rollup(results: Array<'upserted' | 'skipped' | 'error'>): 'upserted' | 'skipped' | 'error' {
  if (results.some(r => r === 'upserted')) return 'upserted';
  if (results.some(r => r === 'error')) return 'error';
  return 'skipped';
}

export async function ingestAsset(deps: IngestDeps, entry: AssetManifestEntry): Promise<'upserted' | 'skipped' | 'error'> {
  if (entry.mediaType === 'pdf') {
    let pages: PdfPage[];
    try {
      const bytes = deps.readAsset(entry.file);
      pages = await deps.rasterize(bytes);
    } catch (err) {
      logger.error('ingest error; pdf skipped', { asset: entry.file, err: String(err) });
      return 'error';
    }
    const results: Array<'upserted' | 'skipped' | 'error'> = [];
    for (const p of pages) {
      const pageEntry: AssetManifestEntry = {
        file: entry.file, source: entry.source, mediaType: 'pdf',
        title: `${entry.title} (page ${p.page})`, extractedText: p.text || undefined,
      };
      results.push(await ingestOne(deps, { id: `${entry.file}#p${p.page}`, entry: pageEntry, dataUrl: p.imageDataUrl, page: p.page }));
    }
    logger.info('ingest pdf complete', { asset: entry.file, pages: pages.length });
    return rollup(results);
  }

  // image path
  let dataUrl: string;
  try {
    dataUrl = toDataUrl(deps.readAsset(entry.file), entry.file);
  } catch (err) {
    logger.error('ingest error; asset skipped', { asset: entry.file, err: String(err) });
    return 'error';
  }
  return ingestOne(deps, { id: entry.file, entry, dataUrl });
}

export async function runIngest(cfg: Config, describe?: DescribeFn): Promise<{ upserted: number; skipped: number; errors: number }> {
  const client = new MongoClient(cfg.mongoUri);
  const vector = createKnowledgeVector(cfg);
  const assetsDir = cfg.ingestAssetsDir ?? join(HERE, 'assets');
  let describer = describe;
  if (!describer) {
    // Provider-aware: Bedrock deploys (EC2 instance role) use the Converse path; the direct
    // Anthropic REST describer only knows api-key/x-api-key auth and 401s on Bedrock.
    const { createDescriber } = await import('./describe');
    describer = createDescriber(cfg);
  }
  try {
    await client.connect();
    const col = client.db(cfg.mongoDb).collection(KNOWLEDGE_INDEX);
    const deps: IngestDeps = {
      vector,
      embedder: getDocEmbedder(cfg),
      describe: describer,
      readAsset: (file) => readFileSync(join(assetsDir, file)),
      exists: async (id) => (await col.findOne({ _id: id as any })) != null,
      describeEnabled: cfg.ingestDescribe,
      rasterize: createPdfRasterizer({ scale: cfg.ingestPdfScale }).rasterize,
    };
    const manifest = loadAssetManifest();
    let upserted = 0, skipped = 0, errors = 0;
    for (const entry of manifest) {
      const r = await ingestAsset(deps, entry);
      if (r === 'upserted') upserted++; else if (r === 'skipped') skipped++; else errors++;
    }
    logger.info('ingest complete', { upserted, skipped, errors });
    return { upserted, skipped, errors };
  } finally {
    await client.close();
    await (vector as any).disconnect?.().catch?.(() => {});
  }
}

// Entry point: `pnpm embed`
if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  const { loadConfig } = await import('../config');
  runIngest(loadConfig())
    .then(r => { logger.info('ingest done', r); process.exit(r.errors > 0 && r.upserted === 0 ? 1 : 0); })
    .catch(err => { logger.error('ingest failed', { err: String(err) }); process.exit(1); });
}
