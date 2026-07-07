import { z } from 'zod';

export interface Config {
  mongoUri: string; mongoDb: string; voyageApiKey: string; voyageBaseUrl?: string;
  llmProvider: 'anthropic' | 'openai' | 'bedrock'; llmModel: string; llmBaseUrl?: string; llmGatewayApiKey?: string;
  memoryEmbedModel?: string;
  allowInsecure: boolean;
  responseCache: { enabled: boolean; ttlDays: number; similarityThreshold: number; maxAnswerBytes: number };
  rrfK: number;
  dataAgentAllowList: string[]; dataAgentLimit: number;
  emitPlanFrames: boolean; ingestDescribe: boolean; ingestAssetsDir?: string; ingestPdfScale: number;
  port: number; defaultUserId: string;
  mongoPool: { maxPoolSize: number; minPoolSize: number };
  prewarmQueries?: string[];
  // Auth mode: 'local' (default) trusts the client-supplied user_id — demo only, not secure.
  // 'sso' requires a registered authenticator (a deployment-provided adapter) and rejects
  // unauthenticated requests; client-supplied identity is ignored. `authRequired` is derived (sso ⇒ true).
  authMode: 'local' | 'sso'; authRequired: boolean;
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
    llmGatewayApiKey: parsed.GROVE_API_KEY || undefined,
    allowInsecure,
    responseCache: {
      enabled: bool(env.RESPONSE_CACHE_ENABLED, true),
      ttlDays: num(env.RESPONSE_CACHE_TTL_DAYS, 1),
      similarityThreshold: num(env.RESPONSE_CACHE_SIMILARITY_THRESHOLD, 0.92),
      maxAnswerBytes: num(env.RESPONSE_CACHE_MAX_ANSWER_BYTES, 32768),
    },
    rrfK: num(env.RRF_K, 60),
    dataAgentAllowList: (env.DATA_AGENT_ALLOW_LIST ?? 'products,orders,promotions')
      .split(',').map(s => s.trim()).filter(Boolean),
    dataAgentLimit: num(env.DATA_AGENT_LIMIT, 25),
    emitPlanFrames: bool(env.EMIT_PLAN_FRAMES, false),
    ingestDescribe: bool(env.INGEST_DESCRIBE, true),
    ingestAssetsDir: parsed.INGEST_ASSETS_DIR || undefined,
    ingestPdfScale: num(env.INGEST_PDF_SCALE, 2.0),
    port: num(env.PORT, 8000),
    defaultUserId: env.DEFAULT_USER_ID ?? 'demo',
    authMode,
    authRequired: authMode === 'sso',
    mongoPool: {
      maxPoolSize: num(env.MONGO_MAX_POOL_SIZE, 100),
      minPoolSize: num(env.MONGO_MIN_POOL_SIZE, 10),
    },
    prewarmQueries: parsed.PREWARM_QUERIES
      ? parsed.PREWARM_QUERIES.split('|').map(s => s.trim()).filter(Boolean)
      : undefined,
  };
}
