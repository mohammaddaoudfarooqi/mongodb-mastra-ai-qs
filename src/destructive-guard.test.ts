import { describe, it, expect, afterEach } from 'vitest';
import type { Config } from './config';
import { confirmDestructive } from './destructive-guard';

const cfg = (mongoDb: string): Config =>
  ({ mongoDb, mongoUri: 'mongodb+srv://u:p@c.mongodb.net/' } as Config);

const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe('confirmDestructive (reviewer finding #12)', () => {
  it('allows a normal test/dev database', () => {
    expect(() => confirmDestructive(cfg('mongodb_mastra_qs'), 'seed')).not.toThrow();
  });

  it('refuses a production-looking database name without FORCE_DESTRUCTIVE', () => {
    expect(() => confirmDestructive(cfg('mongodb_mastra_prod'), 'seed')).toThrow(/production/i);
    expect(() => confirmDestructive(cfg('retail_live'), 'seed')).toThrow(/production/i);
  });

  it('allows a production-looking name when FORCE_DESTRUCTIVE=1', () => {
    process.env.FORCE_DESTRUCTIVE = '1';
    expect(() => confirmDestructive(cfg('mongodb_mastra_prod'), 'seed')).not.toThrow();
  });

  it('requireConfirm blocks teardown unless CONFIRM_DESTRUCTIVE=1', () => {
    expect(() => confirmDestructive(cfg('devdb'), 'teardown', { requireConfirm: true })).toThrow(/confirmation/i);
    process.env.CONFIRM_DESTRUCTIVE = '1';
    expect(() => confirmDestructive(cfg('devdb'), 'teardown', { requireConfirm: true })).not.toThrow();
  });
});
