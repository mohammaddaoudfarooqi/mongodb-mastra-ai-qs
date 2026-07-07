import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { Config } from '../config';

const MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-8': 8192,
  'claude-sonnet-4-6': 8192,
  'claude-sonnet-5': 8192,
  'claude-haiku-4-5': 8192,
  'gpt-4o': 8192,
  'meta.llama4-maverick': 4096,
};

/** Models that reject an explicit temperature field entirely. */
const NO_TEMPERATURE = new Set(['claude-opus-4-8', 'claude-opus-4-7']);

export function maxTokensFor(model: string): number {
  return MAX_TOKENS[model] ?? 4096;
}

export function temperatureFor(model: string): number | undefined {
  return NO_TEMPERATURE.has(model) ? undefined : 0;
}

/** A selectable model surfaced in the UI dropdown. */
export interface ModelChoice { id: string; label: string; }

/**
 * Models offered in the storefront's model picker. All three are verified against the
 * gateway this quickstart targets: haiku-4-5 (fast, the default), opus-4-8 (deepest
 * reasoning), and sonnet-4-6 (the balance point — the latest Sonnet the gateway serves).
 * The configured `cfg.llmModel` is always included even if it is not in this list, so a
 * custom deployment's default never disappears from the picker.
 */
export const MODEL_CATALOG: ModelChoice[] = [
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (deep)' },
];

/**
 * Build the model list for GET /models: the curated catalog with the configured default
 * guaranteed present and listed first (dedup by id, preserving catalog order otherwise).
 */
export function modelChoices(defaultModel: string): ModelChoice[] {
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  const push = (c: ModelChoice) => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } };
  const configured = MODEL_CATALOG.find(m => m.id === defaultModel);
  push(configured ?? { id: defaultModel, label: defaultModel });
  for (const m of MODEL_CATALOG) push(m);
  return out;
}

/**
 * The @ai-sdk/anthropic client appends `/messages` to baseURL itself, so the
 * configured base must be the API root (…/v1). A LLM_BASE_URL that already ends
 * in `/messages` (as the Grove gateway example does) would otherwise double up.
 */
function normalizeAnthropicBaseURL(url: string): string {
  return url.replace(/\/messages\/?$/, '');
}

export function getLLM(cfg: Config, modelOverride?: string): ReturnType<ReturnType<typeof createAnthropic>> {
  const model = modelOverride || cfg.llmModel;
  switch (cfg.llmProvider) {
    case 'anthropic': {
      // Grove/APIM gateway auth: the gateway expects the key in an `api-key` header.
      // A gateway base URL implies gateway auth; fall back to the SDK's default (x-api-key
      // via ANTHROPIC_API_KEY) when no gateway is configured.
      const opts: Parameters<typeof createAnthropic>[0] = {};
      if (cfg.llmBaseUrl) opts.baseURL = normalizeAnthropicBaseURL(cfg.llmBaseUrl);
      if (cfg.llmGatewayApiKey) {
        opts.headers = { 'api-key': cfg.llmGatewayApiKey };
        // The SDK still requires *some* apiKey to construct; the gateway ignores x-api-key.
        opts.apiKey = cfg.llmGatewayApiKey;
      }
      return createAnthropic(opts)(model);
    }
    case 'openai':
      return createOpenAI(cfg.llmBaseUrl ? { baseURL: cfg.llmBaseUrl } : {})(model);
    case 'bedrock':
      return createAmazonBedrock(cfg.llmBaseUrl ? { baseURL: cfg.llmBaseUrl } : {})(model);
    default:
      throw new Error(`Unsupported LLM_PROVIDER: ${cfg.llmProvider}`);
  }
}

// NOTE: query/document embedding goes through getQueryEmbedder in ./embed, which calls the
// Voyage multimodalEmbed API directly. The @mastra/voyageai `voyage.multimodal` wrapper sends a
// malformed request shape (bare-array inputs) that the live API rejects, so it is not used here.
