import type { Config } from '../config';
import type { DescribeFn } from './ingest-multimodal';
import { logger } from '../observability/logger';

const DESCRIBE_PROMPT =
  'Describe this product or marketing image factually and literally in 2 to 3 sentences. ' +
  'Focus on visible objects, colors, materials, and any text shown. Do not speculate.';

/**
 * Default describer: a direct Anthropic Messages API call, reusing the same base URL and
 * `api-key` gateway auth as the LLM (src/mastra/models.ts). We call the REST endpoint directly
 * (the `ai` package is not a dependency) so ingestion stays dependency-light.
 * Only used when INGEST_DESCRIBE=true; failures fall back to raw-image embed upstream.
 */
export function createAnthropicDescriber(cfg: Config): DescribeFn {
  const base = (cfg.llmBaseUrl ?? 'https://api.anthropic.com/v1').replace(/\/messages\/?$/, '');
  const url = `${base}/messages`;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (cfg.llmGatewayApiKey) headers['api-key'] = cfg.llmGatewayApiKey;
  else if (process.env.ANTHROPIC_API_KEY) headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;

  return async ({ title, dataUrl }) => {
    const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('describer: not a base64 image data url');
    const [, mediaType, b64] = m;
    const body = {
      model: cfg.llmModel,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
          { type: 'text', text: `${DESCRIBE_PROMPT} Image title: ${title}.` },
        ],
      }],
    };
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`describer HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (json.content ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join(' ').trim();
    if (!text) throw new Error('describer: empty description');
    logger.info('described asset', { title });
    return text;
  };
}
