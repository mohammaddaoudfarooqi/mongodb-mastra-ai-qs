// src/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig } from './config';

const base = {
  MONGODB_URI: 'mongodb+srv://u:p@c.mongodb.net/',
  MONGODB_DATABASE: 'db',
  VOYAGE_API_KEY: 'vk',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-opus-4-8',
};

describe('loadConfig', () => {
  it('parses a valid env with defaults applied', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.mongoDb).toBe('db');
    expect(c.rrfK).toBe(60);
    expect(c.dataAgentAllowList).toEqual(['products', 'orders', 'promotions']);
    expect(c.responseCache.ttlDays).toBe(1);
  });

  it('throws when VOYAGE_API_KEY is missing', () => {
    const { VOYAGE_API_KEY, ...rest } = base;
    expect(() => loadConfig(rest as NodeJS.ProcessEnv)).toThrow(/VOYAGE_API_KEY/);
  });

  it('throws on a non-TLS mongodb URI unless ALLOW_INSECURE=true', () => {
    const insecure = { ...base, MONGODB_URI: 'mongodb://localhost:27017' };
    expect(() => loadConfig(insecure as NodeJS.ProcessEnv)).toThrow(/TLS|insecure/i);
    expect(() => loadConfig({ ...insecure, ALLOW_INSECURE: 'true' } as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('ingestPdfScale', () => {
  it('defaults to 2.0', () => {
    expect(loadConfig(base as any).ingestPdfScale).toBe(2.0);
  });
  it('reads INGEST_PDF_SCALE', () => {
    expect(loadConfig({ ...base, INGEST_PDF_SCALE: '3' } as any).ingestPdfScale).toBe(3);
  });
});

describe('mongoPool (REQ-E-007)', () => {
  it('defaults to maxPoolSize 100 / minPoolSize 10', () => {
    const c = loadConfig(base as any);
    expect(c.mongoPool).toEqual({ maxPoolSize: 100, minPoolSize: 10 });
  });
  it('honors MONGO_MAX_POOL_SIZE / MONGO_MIN_POOL_SIZE', () => {
    const c = loadConfig({ ...base, MONGO_MAX_POOL_SIZE: '50', MONGO_MIN_POOL_SIZE: '5' } as any);
    expect(c.mongoPool).toEqual({ maxPoolSize: 50, minPoolSize: 5 });
  });
});
