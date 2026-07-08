import type { Config } from '../config';
import type { DescribeFn } from './ingest-multimodal';
import { logger } from '../observability/logger';

const DESCRIBE_PROMPT =
  'Describe this product or marketing image factually and literally in 2 to 3 sentences. ' +
  'Focus on visible objects, colors, materials, and any text shown. Do not speculate.';

/** Parse a base64 image data URL into its media subtype (png/jpeg/gif/webp) and bytes. */
function parseImageDataUrl(dataUrl: string): { subtype: string; b64: string } {
  const m = /^data:image\/([a-z]+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error('describer: not a base64 image data url');
  return { subtype: m[1], b64: m[2] };
}

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
    const { subtype, b64 } = parseImageDataUrl(dataUrl);
    const mediaType = `image/${subtype}`;
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

/** Converse image `format` enum values keyed by data-URL subtype. `jpg` maps to `jpeg`. */
const BEDROCK_IMAGE_FORMAT: Record<string, 'png' | 'jpeg' | 'gif' | 'webp'> = {
  png: 'png', jpeg: 'jpeg', jpg: 'jpeg', gif: 'gif', webp: 'webp',
};

/**
 * Bedrock describer: a Converse call through the SAME credential path the LLM uses
 * (`fromNodeProviderChain()` — the EC2 instance role via IMDS, see src/mastra/models.ts).
 * This is why the old Anthropic-only describer 401'd on the box: it hit api.anthropic.com
 * with no key, on a deploy that runs the model on Bedrock. Converse takes raw image BYTES
 * (not a data URL) and the SDK signs the request; no API key on the box.
 * Only used when INGEST_DESCRIBE=true; failures fall back to raw-image embed upstream.
 * The AWS SDK is imported lazily so ingestion on non-Bedrock deploys never loads it.
 */
export function createBedrockDescriber(cfg: Config): DescribeFn {
  return async ({ title, dataUrl }) => {
    const { subtype, b64 } = parseImageDataUrl(dataUrl);
    const format = BEDROCK_IMAGE_FORMAT[subtype];
    if (!format) throw new Error(`describer: unsupported image format ${subtype}`);
    const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
    const client = new BedrockRuntimeClient({
      region: cfg.bedrockRegion ?? process.env.AWS_REGION,
      credentials: fromNodeProviderChain(),
    });
    const res = await client.send(new ConverseCommand({
      modelId: cfg.llmModel,
      messages: [{
        role: 'user',
        content: [
          { image: { format, source: { bytes: Buffer.from(b64, 'base64') } } },
          { text: `${DESCRIBE_PROMPT} Image title: ${title}.` },
        ],
      }],
      inferenceConfig: { maxTokens: 300 },
    }));
    const text = (res.output?.message?.content ?? [])
      .map(p => p.text ?? '')
      .join(' ')
      .trim();
    if (!text) throw new Error('describer: empty description');
    logger.info('described asset', { title });
    return text;
  };
}

/**
 * Provider-aware describer factory: routes to the Bedrock Converse path when the deploy runs
 * on Bedrock (matching how getLLM picks a provider), otherwise the direct Anthropic/gateway
 * path. OpenAI has no vision describer wired here, so it uses the Anthropic path and simply
 * falls back to raw-image embedding if that is not reachable — no describe is non-fatal.
 */
export function createDescriber(cfg: Config): DescribeFn {
  return cfg.llmProvider === 'bedrock' ? createBedrockDescriber(cfg) : createAnthropicDescriber(cfg);
}
