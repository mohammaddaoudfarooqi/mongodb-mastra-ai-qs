import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { Config } from '../config';

const MAX_TOKENS: Record<string, number> = {
  'claude-opus-4-8': 8192,
  'claude-sonnet-4-6': 8192,
  'claude-sonnet-5': 8192,
  'claude-haiku-4-5': 8192,
  'gpt-4o': 8192,
  'meta.llama4-maverick': 4096,
  // Bedrock cross-region inference-profile ids (see BEDROCK_MODEL_CATALOG).
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0': 8192,
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': 8192,
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
 * gateway this quickstart targets: sonnet-4-6 (balanced — the demo default), haiku-4-5
 * (faster/cheaper), and opus-4-8 (deepest reasoning). Sonnet is the default because it is
 * far more reliable than haiku on the grounded tool/agent beats (item selection, retrieval
 * grounding) without opus's latency. The configured `cfg.llmModel` is always included even
 * if it is not in this list, so a custom deployment's default never disappears from the picker.
 */
export const MODEL_CATALOG: ModelChoice[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fast)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8 (deep)' },
];

/**
 * Bedrock catalog. Bedrock does NOT accept the plain Anthropic-API ids above — it needs
 * cross-region INFERENCE-PROFILE ids (the `us.` prefix routes the invocation to whichever
 * of us-east-1/2 / us-west-2 has capacity). These are the ids surfaced when LLM_PROVIDER=bedrock;
 * verify the exact profile ids enabled in the target account/region with
 * `aws bedrock list-inference-profiles --region us-west-2` before a deploy, and update here.
 */
export const BEDROCK_MODEL_CATALOG: ModelChoice[] = [
  { id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude Sonnet 4.5 (Bedrock, balanced)' },
  { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5 (Bedrock, fast)' },
];

/**
 * Build the model list for GET /models: the curated catalog with the configured default
 * guaranteed present and listed first (dedup by id, preserving catalog order otherwise).
 * The catalog is provider-specific: Bedrock uses inference-profile ids, so on
 * `provider==='bedrock'` we surface BEDROCK_MODEL_CATALOG instead of the Anthropic ids
 * (which Bedrock would reject if a user picked one).
 */
export function modelChoices(defaultModel: string, provider?: Config['llmProvider']): ModelChoice[] {
  const catalog = provider === 'bedrock' ? BEDROCK_MODEL_CATALOG : MODEL_CATALOG;
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  const push = (c: ModelChoice) => { if (!seen.has(c.id)) { seen.add(c.id); out.push(c); } };
  const configured = catalog.find(m => m.id === defaultModel);
  push(configured ?? { id: defaultModel, label: defaultModel });
  for (const m of catalog) push(m);
  return out;
}

/**
 * Resolve the model a /chat turn should actually run, ENFORCING the model-switch lock
 * server-side. The UI hiding the picker (GET /models) is cosmetic — a client can still POST
 * /chat with any `model`, so the authoritative decision lives here:
 *
 *   - switching locked  (allowModelSwitch=false): the requested model is IGNORED; every turn
 *     runs the pinned default (cost/consistency control on the public domain).
 *   - switching allowed (default): a requested model is honored ONLY if it is in the provider's
 *     catalog (the same list GET /models offers); anything else falls back to the default. This
 *     stops a client driving the box onto an arbitrary / unauthorized model (e.g. a Bedrock
 *     inference profile the instance role can't invoke — the Haiku-403 class of failure).
 */
export function resolveModel(cfg: Config, requested: string | undefined): string {
  if (!requested || !cfg.allowModelSwitch) return cfg.llmModel;
  const allowed = new Set(modelChoices(cfg.llmModel, cfg.llmProvider).map(m => m.id));
  return allowed.has(requested) ? requested : cfg.llmModel;
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
    case 'bedrock': {
      // Region: explicit cfg.bedrockRegion wins; else the SDK reads AWS_REGION from the env
      // (set by the EC2 UserData). A baseURL override is honored if set (rare).
      //
      // Auth: the @ai-sdk/amazon-bedrock v5 provider does NOT fall back to the AWS default
      // credential chain on its own — without static AWS_ACCESS_KEY_ID it throws "AWS SigV4
      // authentication requires AWS credentials". So hand it a credentialProvider backed by
      // fromNodeProviderChain(), which resolves the EC2 instance role via IMDS (no API key on
      // the box). Locally it picks up env vars / shared config the same way the AWS CLI does.
      const opts: Parameters<typeof createAmazonBedrock>[0] = {
        credentialProvider: fromNodeProviderChain(),
      };
      if (cfg.bedrockRegion) opts.region = cfg.bedrockRegion;
      if (cfg.llmBaseUrl) opts.baseURL = cfg.llmBaseUrl;
      return createAmazonBedrock(opts)(model);
    }
    default:
      throw new Error(`Unsupported LLM_PROVIDER: ${cfg.llmProvider}`);
  }
}

// NOTE: query/document embedding goes through getQueryEmbedder in ./embed, which calls the
// Voyage multimodalEmbed API directly. The @mastra/voyageai `voyage.multimodal` wrapper sends a
// malformed request shape (bare-array inputs) that the live API rejects, so it is not used here.
