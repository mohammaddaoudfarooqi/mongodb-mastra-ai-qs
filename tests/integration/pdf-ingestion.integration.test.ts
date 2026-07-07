import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MongoClient } from 'mongodb';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, type Config } from '../../src/config';
import { createKnowledgeVector, provisionKnowledgeIndex, KNOWLEDGE_INDEX } from '../../src/mastra/vector';
import { ingestAsset, type IngestDeps } from '../../src/ingestion/ingest-multimodal';
import { createPdfRasterizer } from '../../src/ingestion/pdf';
import { getDocEmbedder } from '../../src/mastra/embed';
import { createAnthropicDescriber } from '../../src/ingestion/describe';

const hasEnv = !!process.env.MONGODB_URI && !!process.env.VOYAGE_API_KEY;
const CATALOG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'ingestion', 'assets', 'catalog.pdf');

describe.skipIf(!hasEnv)('pdf page-render ingestion + retrieval (Atlas integration)', () => {
  let client: MongoClient;
  let cfg: Config;
  let vector: ReturnType<typeof createKnowledgeVector>;

  beforeAll(async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    const baseDb = process.env.MONGODB_DATABASE ?? 'mongodb_mastra_qs_test';
    cfg = loadConfig({ ...process.env, MONGODB_DATABASE: `${baseDb}_pdf` } as any);
    client = new MongoClient(cfg.mongoUri);
    await client.connect();
    vector = createKnowledgeVector(cfg);
    await provisionKnowledgeIndex(vector);
  }, 120_000);

  afterAll(async () => {
    await client?.db(cfg.mongoDb).collection(KNOWLEDGE_INDEX).drop().catch(() => {});
    await client?.close();
    await (vector as any).disconnect?.().catch?.(() => {});
  });

  it('rasterizes catalog.pdf, embeds each page, and a query retrieves a specific page', async () => {
    const col = client.db(cfg.mongoDb).collection(KNOWLEDGE_INDEX);
    const deps: IngestDeps = {
      vector,
      embedder: getDocEmbedder(cfg),
      describe: createAnthropicDescriber(cfg),
      readAsset: () => readFileSync(CATALOG),
      exists: async (id) => (await col.findOne({ _id: id as any })) != null,
      describeEnabled: false, // keep the test fast/deterministic; text layer alone is enough
      rasterize: createPdfRasterizer({ scale: cfg.ingestPdfScale }).rasterize,
    };
    const entry = { file: 'catalog.pdf', title: 'Summer 2026 catalog', source: 'marketing', mediaType: 'pdf' as const };
    const r = await ingestAsset(deps, entry);
    expect(r).toBe('upserted');

    // At least the 4 authored pages are present, tagged mediaType pdf with page numbers.
    const pdfDocs = await col.find({ 'metadata.mediaType': 'pdf' }).toArray();
    expect(pdfDocs.length).toBeGreaterThanOrEqual(4);
    expect(pdfDocs.every((d: any) => typeof d.metadata.page === 'number')).toBe(true);

    // The sale-terms page carries a coupon code from the seeded promotions (e.g. SAVE5).
    const salePage = pdfDocs.find((d: any) => /SAVE\d+/.test(d.document));
    expect(salePage).toBeDefined();
    expect(salePage!.metadata.page).toBeGreaterThan(0);
  }, 180_000);
});
