import { z } from 'zod';

export interface Config {
  mongoUri: string; mongoDb: string; voyageApiKey: string; voyageBaseUrl?: string;
  llmProvider: 'anthropic' | 'openai' | 'bedrock'; llmModel: string; llmBaseUrl?: string; llmGatewayApiKey?: string;
  // AWS region for the Bedrock client (LLM_PROVIDER=bedrock). Optional: when unset the AWS SDK
  // reads AWS_REGION from the environment (set by the EC2 UserData). Ignored by other providers.
  bedrockRegion?: string;
  memoryEmbedModel?: string;
  allowInsecure: boolean;
  responseCache: { enabled: boolean; ttlDays: number; similarityThreshold: number; maxAnswerBytes: number };
  // Memory recall tuning. `semanticRecall` toggles the per-turn cross-thread vector
  // search Mastra runs on EVERY agent.stream() call — an embed + Atlas $vectorSearch
  // over the user's whole history that adds ~10s to a trivial turn. Off by default:
  // cross-thread personalization is carried by working memory (the shopper profile),
  // not by recall, so disabling it keeps that demo working while cutting the tax.
  // `lastMessages` is a cheap storage-only window of recent in-thread turns (no embed).
  memory: { semanticRecall: boolean; lastMessages: number };
  rrfK: number;
  dataAgentAllowList: string[]; dataAgentLimit: number;
  emitPlanFrames: boolean; ingestDescribe: boolean; ingestAssetsDir?: string; ingestPdfScale: number;
  // Max serialized bytes for a `trace` SSE frame's args/result (the in-chat "watch it work"
  // panel). Oversize tool payloads are truncated so one big result can't freeze the client.
  traceMaxBytes: number;
  port: number; defaultUserId: string;
  // Persist app logs to a MongoDB collection (in addition to stdout/stderr). `enabled`
  // defaults on; `collection` is the target name; `retentionDays` drives a TTL index so
  // the log collection self-prunes. Writes are buffered + fail-open (never block a request).
  appLog: { enabled: boolean; collection: string; retentionDays: number };
  mongoPool: { maxPoolSize: number; minPoolSize: number };
  prewarmQueries?: string[];
  // Auth mode: 'local' (default) trusts the client-supplied user_id — demo only, not secure.
  // 'sso' requires a registered authenticator (a deployment-provided adapter) and rejects
  // unauthenticated requests; client-supplied identity is ignored. `authRequired` is derived (sso ⇒ true).
  authMode: 'local' | 'sso'; authRequired: boolean;
  // Whether the storefront may switch the LLM model from the UI. Default true (dev + self-deploy).
  // The public AI4 domain sets this false so every attendee runs the same pinned default model
  // (cost/consistency control): /api/models then returns ONLY the default and the picker is hidden.
  allowModelSwitch: boolean;
  // Per-session request rate limit (default OFF). On for the public AI4 domain so a QR-code burst
  // can't exhaust the single box or the Bedrock quota. See src/server/rate-limit.ts.
  rateLimit: { enabled: boolean; max: number; windowSeconds: number; collection: string };
  // Budget kill-switch (default OFF). When a flag doc is set (e.g. by an AWS Budgets alarm), model
  // calls short-circuit with a graceful message. See src/server/budget.ts.
  budget: { enabled: boolean; collection: string; flagId: string };
  // Attendee lead-capture gate (default OFF). On for the public AI4 domain: the client shows a
  // capture screen and POSTs to /api/leads, which persists to the leads collection in Atlas.
  leadGate: { enabled: boolean; collection: string };
  // Curated preset set (default OFF). On for the public AI4 domain: the SPA shows ONLY the
  // stateless, cache-safe demo prompts and hides the stateful cart/checkout/memory presets that
  // can't work as one-click launches on a shared-identity box. The stage box keeps the full set.
  curatedPresets: boolean;
}

const bool = (v: string | undefined, d: boolean) => (v == null ? d : v === 'true');
const num = (v: string | undefined, d: number) => (v == null || v === '' ? d : Number(v));

const schema = z.object({
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  MONGODB_DATABASE: z.string().min(1, 'MONGODB_DATABASE is required'),
  VOYAGE_API_KEY: z.string().min(1, 'VOYAGE_API_KEY is required'),
  VOYAGE_BASE_URL: z.string().optional(),
  MEMORY_EMBED_MODEL: z.string().optional(),
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'bedrock']).default('anthropic'),
  LLM_MODEL: z.string().min(1),
  LLM_BASE_URL: z.string().optional(),
  BEDROCK_REGION: z.string().optional(),
  GROVE_API_KEY: z.string().optional(),
  ALLOW_INSECURE: z.string().optional(),
  INGEST_ASSETS_DIR: z.string().optional(),
  PREWARM_QUERIES: z.string().optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const allowInsecure = bool(parsed.ALLOW_INSECURE, false);
  const authMode = env.AUTH_MODE === 'sso' ? 'sso' as const : 'local' as const;
  const isTls = parsed.MONGODB_URI.startsWith('mongodb+srv://') || /[?&]tls=true/.test(parsed.MONGODB_URI);
  if (!isTls && !allowInsecure) {
    throw new Error('MONGODB_URI must use TLS (mongodb+srv:// or tls=true). Set ALLOW_INSECURE=true to override for local dev.');
  }
  return {
    mongoUri: parsed.MONGODB_URI,
    mongoDb: parsed.MONGODB_DATABASE,
    voyageApiKey: parsed.VOYAGE_API_KEY,
    voyageBaseUrl: parsed.VOYAGE_BASE_URL || undefined,
    memoryEmbedModel: parsed.MEMORY_EMBED_MODEL || undefined,
    llmProvider: parsed.LLM_PROVIDER,
    llmModel: parsed.LLM_MODEL,
    llmBaseUrl: parsed.LLM_BASE_URL || undefined,
    bedrockRegion: parsed.BEDROCK_REGION || undefined,
    llmGatewayApiKey: parsed.GROVE_API_KEY || undefined,
    allowInsecure,
    responseCache: {
      enabled: bool(env.RESPONSE_CACHE_ENABLED, true),
      ttlDays: num(env.RESPONSE_CACHE_TTL_DAYS, 1),
      similarityThreshold: num(env.RESPONSE_CACHE_SIMILARITY_THRESHOLD, 0.92),
      maxAnswerBytes: num(env.RESPONSE_CACHE_MAX_ANSWER_BYTES, 32768),
    },
    memory: {
      semanticRecall: bool(env.MEMORY_SEMANTIC_RECALL, false),
      lastMessages: num(env.MEMORY_LAST_MESSAGES, 10),
    },
    rrfK: num(env.RRF_K, 60),
    dataAgentAllowList: (env.DATA_AGENT_ALLOW_LIST ?? 'products,orders,promotions')
      .split(',').map(s => s.trim()).filter(Boolean),
    dataAgentLimit: num(env.DATA_AGENT_LIMIT, 25),
    emitPlanFrames: bool(env.EMIT_PLAN_FRAMES, false),
    traceMaxBytes: num(env.TRACE_MAX_BYTES, 8192),
    ingestDescribe: bool(env.INGEST_DESCRIBE, true),
    ingestAssetsDir: parsed.INGEST_ASSETS_DIR || undefined,
    ingestPdfScale: num(env.INGEST_PDF_SCALE, 2.0),
    port: num(env.PORT, 8000),
    defaultUserId: env.DEFAULT_USER_ID ?? 'demo',
    appLog: {
      enabled: bool(env.APP_LOG_MONGO_ENABLED, true),
      collection: env.APP_LOG_COLLECTION ?? 'app_logs',
      retentionDays: num(env.APP_LOG_RETENTION_DAYS, 30),
    },
    authMode,
    authRequired: authMode === 'sso',
    allowModelSwitch: bool(env.ALLOW_MODEL_SWITCH, true),
    rateLimit: {
      enabled: bool(env.RATE_LIMIT_ENABLED, false),
      max: num(env.RATE_LIMIT_MAX, 40),
      windowSeconds: num(env.RATE_LIMIT_WINDOW_SECONDS, 3600),
      collection: env.RATE_LIMIT_COLLECTION ?? 'ratelimit',
    },
    budget: {
      enabled: bool(env.BUDGET_ENABLED, false),
      collection: env.BUDGET_COLLECTION ?? 'flags',
      flagId: env.BUDGET_FLAG_ID ?? 'budget',
    },
    leadGate: {
      enabled: bool(env.LEAD_GATE_ENABLED, false),
      collection: env.LEAD_GATE_COLLECTION ?? 'leads',
    },
    curatedPresets: bool(env.CURATED_PRESETS, false),
    mongoPool: {
      maxPoolSize: num(env.MONGO_MAX_POOL_SIZE, 100),
      minPoolSize: num(env.MONGO_MIN_POOL_SIZE, 10),
    },
    prewarmQueries: parsed.PREWARM_QUERIES
      ? parsed.PREWARM_QUERIES.split('|').map(s => s.trim()).filter(Boolean)
      : undefined,
  };
}
