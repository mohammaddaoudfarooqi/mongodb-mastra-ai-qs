import { describe, it, expect, vi } from 'vitest';
import { toDataUrl, buildAssetDocument, buildAssetMetadata, ingestAsset } from './ingest-multimodal';

const ENTRY = { file: 'mug-red.png', title: 'Red mug', source: 'catalog', mediaType: 'image' as const, extractedText: '12 oz ceramic' };
const PDF_ENTRY = { file: 'catalog.pdf', title: 'Catalog', source: 'marketing', mediaType: 'pdf' as const };

const twoPages = () => ([
  { page: 1, imageDataUrl: 'data:image/png;base64,AAA', text: 'page one text' },
  { page: 2, imageDataUrl: 'data:image/png;base64,BBB', text: 'page two text' },
]);

describe('toDataUrl', () => {
  it('builds a png data url', () => {
    expect(toDataUrl(Buffer.from('AB'), 'mug-red.png')).toBe(`data:image/png;base64,${Buffer.from('AB').toString('base64')}`);
  });
  it('maps jpg/jpeg to image/jpeg', () => {
    expect(toDataUrl(Buffer.from('x'), 'a.jpg')).toMatch(/^data:image\/jpeg;base64,/);
    expect(toDataUrl(Buffer.from('x'), 'a.jpeg')).toMatch(/^data:image\/jpeg;base64,/);
  });
});

describe('buildAssetDocument', () => {
  it('is the lexically complete superset: title + description + extractedText', () => {
    expect(buildAssetDocument(ENTRY, 'A red ceramic mug on a table.'))
      .toBe('Red mug\nA red ceramic mug on a table.\n12 oz ceramic');
  });
  it('omits the description line when describe was skipped/failed', () => {
    expect(buildAssetDocument(ENTRY, null)).toBe('Red mug\n12 oz ceramic');
  });
});

describe('buildAssetMetadata', () => {
  it('records describeUsed=true and the entry mediaType (no page for images)', () => {
    expect(buildAssetMetadata(ENTRY, 'desc')).toEqual({
      mediaType: 'image', source: 'catalog', title: 'Red mug', assetUri: 'mug-red.png', describeUsed: true,
    });
  });
  it('records describeUsed=false when description is null', () => {
    expect(buildAssetMetadata(ENTRY, null).describeUsed).toBe(false);
  });
  it('includes page and pdf mediaType for a pdf page entry', () => {
    const pdfEntry = { file: 'catalog.pdf', title: 'Catalog (page 2)', source: 'marketing', mediaType: 'pdf' as const };
    expect(buildAssetMetadata(pdfEntry, 'desc', 2)).toEqual({
      mediaType: 'pdf', source: 'marketing', title: 'Catalog (page 2)', assetUri: 'catalog.pdf', describeUsed: true, page: 2,
    });
  });
});

describe('ingestAsset', () => {
  const baseDeps = () => ({
    vector: { upsert: vi.fn(async () => []) },
    embedder: { embedDocuments: vi.fn(async () => [[0.1, 0.2]]) },
    describe: vi.fn(async () => 'A red ceramic mug.'),
    readAsset: vi.fn(() => Buffer.from('imgbytes')),
    exists: vi.fn(async () => false),
    describeEnabled: true,
    rasterize: vi.fn(async () => twoPages()),
  });

  it('describes, embeds image paired with text, and upserts (describeUsed=true)', async () => {
    const deps = baseDeps();
    const r = await ingestAsset(deps as any, ENTRY);
    expect(r).toBe('upserted');
    expect(deps.describe).toHaveBeenCalled();
    // embedded content pairs description text with the image
    expect(deps.embedder.embedDocuments).toHaveBeenCalled();
    const embedArg = (deps.embedder.embedDocuments.mock.calls[0] as any)?.[0]?.[0];
    expect(embedArg).toBeDefined();
    expect(embedArg?.content[0]).toEqual({ type: 'text', text: expect.stringContaining('Red mug') });
    expect(embedArg?.content[1].type).toBe('image_base64');
    expect(deps.vector.upsert).toHaveBeenCalled();
    const upsertArg = (deps.vector.upsert.mock.calls[0] as any)?.[0];
    expect(upsertArg).toBeDefined();
    expect(upsertArg?.ids).toEqual(['mug-red.png']);
    expect(upsertArg?.metadata[0]?.describeUsed).toBe(true);
  });

  it('skips an asset already present in knowledge_base (resumable)', async () => {
    const deps = { ...baseDeps(), exists: vi.fn(async () => true) };
    const r = await ingestAsset(deps as any, ENTRY);
    expect(r).toBe('skipped');
    expect(deps.embedder.embedDocuments).not.toHaveBeenCalled();
  });

  it('falls back to raw-image embed when describe throws (describeUsed=false, still upserts)', async () => {
    const deps = { ...baseDeps(), describe: vi.fn(async () => { throw new Error('vision down'); }) };
    const r = await ingestAsset(deps as any, ENTRY);
    expect(r).toBe('upserted');
    expect(deps.vector.upsert).toHaveBeenCalled();
    const upsertArg = (deps.vector.upsert.mock.calls[0] as any)?.[0];
    expect(upsertArg?.metadata[0]?.describeUsed).toBe(false);
  });

  it('does not describe when describeEnabled is false', async () => {
    const deps = { ...baseDeps(), describeEnabled: false };
    const r = await ingestAsset(deps as any, ENTRY);
    expect(r).toBe('upserted');
    expect(deps.describe).not.toHaveBeenCalled();
    expect(deps.vector.upsert).toHaveBeenCalled();
    const upsertArg = (deps.vector.upsert.mock.calls[0] as any)?.[0];
    expect(upsertArg?.metadata[0]?.describeUsed).toBe(false);
  });

  it('returns error and does not upsert when the asset file cannot be read', async () => {
    const deps = { ...baseDeps(), readAsset: vi.fn(() => { throw new Error('ENOENT'); }) };
    const r = await ingestAsset(deps as any, ENTRY);
    expect(r).toBe('error');
    expect(deps.vector.upsert).not.toHaveBeenCalled();
  });

  it('fans a pdf out to one upsert per page with _id=file#pN, page metadata, and pdf mediaType', async () => {
    const deps = baseDeps();
    const r = await ingestAsset(deps as any, PDF_ENTRY);
    expect(r).toBe('upserted');
    expect(deps.rasterize).toHaveBeenCalledTimes(1);
    expect(deps.vector.upsert).toHaveBeenCalledTimes(2);
    const first = (deps.vector.upsert.mock.calls[0] as any)[0];
    const second = (deps.vector.upsert.mock.calls[1] as any)[0];
    expect(first.ids).toEqual(['catalog.pdf#p1']);
    expect(second.ids).toEqual(['catalog.pdf#p2']);
    expect(first.metadata[0]).toMatchObject({ mediaType: 'pdf', page: 1, assetUri: 'catalog.pdf' });
    expect(second.metadata[0]).toMatchObject({ mediaType: 'pdf', page: 2 });
    // page text is part of the embedded + stored document
    expect(first.documents[0]).toContain('page one text');
    // image half of the multimodal input is the rendered page
    const embedArg = (deps.embedder.embedDocuments.mock.calls[0] as any)[0][0];
    expect(embedArg.content[1]).toEqual({ type: 'image_base64', imageBase64: 'data:image/png;base64,AAA' });
  });

  it('per-page resumability: skips an already-ingested page and ingests the rest', async () => {
    const deps = { ...baseDeps(), exists: vi.fn(async (id: string) => id === 'catalog.pdf#p1') };
    const r = await ingestAsset(deps as any, PDF_ENTRY);
    expect(r).toBe('upserted'); // at least one page upserted
    expect(deps.vector.upsert).toHaveBeenCalledTimes(1);
    expect((deps.vector.upsert.mock.calls[0] as any)[0].ids).toEqual(['catalog.pdf#p2']);
  });

  it('per-page describe fallback: one page describe throws, that page still upserts (describeUsed=false)', async () => {
    let call = 0;
    const deps = { ...baseDeps(), describe: vi.fn(async () => { if (call++ === 0) throw new Error('vision down'); return 'ok'; }) };
    const r = await ingestAsset(deps as any, PDF_ENTRY);
    expect(r).toBe('upserted');
    expect(deps.vector.upsert).toHaveBeenCalledTimes(2);
    expect((deps.vector.upsert.mock.calls[0] as any)[0].metadata[0].describeUsed).toBe(false);
    expect((deps.vector.upsert.mock.calls[1] as any)[0].metadata[0].describeUsed).toBe(true);
  });

  it('returns error and upserts nothing when rasterize throws', async () => {
    const deps = { ...baseDeps(), rasterize: vi.fn(async () => { throw new Error('corrupt pdf'); }) };
    const r = await ingestAsset(deps as any, PDF_ENTRY);
    expect(r).toBe('error');
    expect(deps.vector.upsert).not.toHaveBeenCalled();
  });

  it('rolls page results up: all pages skipped => entry skipped', async () => {
    const deps = { ...baseDeps(), exists: vi.fn(async () => true) };
    const r = await ingestAsset(deps as any, PDF_ENTRY);
    expect(r).toBe('skipped');
    expect(deps.vector.upsert).not.toHaveBeenCalled();
  });
});
