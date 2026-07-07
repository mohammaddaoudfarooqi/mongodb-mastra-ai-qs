import { describe, it, expect } from 'vitest';
import { loadConfig, type Config } from '../../src/config';
import { getMemoryEmbedder } from '../../src/mastra/memory-embedder';

const hasEnv = !!process.env.MONGODB_URI && !!process.env.VOYAGE_API_KEY;

describe.skipIf(!hasEnv)('memory embedder (Atlas/Voyage integration)', () => {
  it('embeds text via the MongoDB-hosted Voyage endpoint and returns a 1024-dim vector', async () => {
    try { process.loadEnvFile?.(); } catch { /* optional */ }
    const cfg: Config = loadConfig(process.env as any);
    const model = getMemoryEmbedder(cfg);
    const res = await model.doEmbed({ values: ['the shopper prefers eco-friendly kitchen products'] });
    expect(res.embeddings).toHaveLength(1);
    expect(res.embeddings[0].length).toBe(1024);
  }, 60_000);
});
