import { describe, it, expect, vi } from 'vitest';

// Mock external dependencies that aren't under test
vi.mock('@mastra/voyageai', () => ({
  voyage: { multimodal: {} },
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(),
}));

vi.mock('@ai-sdk/amazon-bedrock', () => ({
  createAmazonBedrock: vi.fn(() => vi.fn()),
}));

const fakeCredentialProvider = vi.fn();
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn(() => fakeCredentialProvider),
}));

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { maxTokensFor, temperatureFor, modelChoices, getLLM, MODEL_CATALOG, BEDROCK_MODEL_CATALOG } from './models';
import type { Config } from '../config';

describe('model helpers', () => {
  it('maps known models to token caps and defaults unknown to 4096', () => {
    expect(maxTokensFor('claude-opus-4-8')).toBe(8192);
    expect(maxTokensFor('some-unknown-model')).toBe(4096);
  });

  it('omits temperature for models that reject it, else returns 0', () => {
    expect(temperatureFor('claude-opus-4-8')).toBeUndefined();
    expect(temperatureFor('gpt-4o')).toBe(0);
  });
});

describe('modelChoices (GET /models catalog)', () => {
  it('offers sonnet-4-6 (default, first), haiku-4-5, and opus-4-8', () => {
    const ids = MODEL_CATALOG.map(m => m.id);
    expect(ids).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8']);
  });

  it('lists the configured default first with no duplicate', () => {
    const choices = modelChoices('claude-sonnet-4-6');
    expect(choices[0].id).toBe('claude-sonnet-4-6');
    const ids = choices.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
    expect(ids).toContain('claude-haiku-4-5');
    expect(ids).toContain('claude-opus-4-8');
  });

  it('includes an unlisted custom default so it never disappears from the picker', () => {
    const choices = modelChoices('some-custom-deploy-model');
    expect(choices[0]).toEqual({ id: 'some-custom-deploy-model', label: 'some-custom-deploy-model' });
    expect(choices.length).toBe(MODEL_CATALOG.length + 1);
  });

  it('surfaces the Bedrock inference-profile catalog when provider is bedrock', () => {
    // Bedrock rejects the plain Anthropic ids, so the picker must offer profile ids instead.
    const bedrockDefault = BEDROCK_MODEL_CATALOG[0].id;
    const choices = modelChoices(bedrockDefault, 'bedrock');
    const ids = choices.map(c => c.id);
    expect(ids).toEqual(BEDROCK_MODEL_CATALOG.map(m => m.id));
    expect(ids[0]).toBe(bedrockDefault);
    // All Bedrock ids are cross-region inference profiles (us. prefix), never bare Anthropic ids.
    expect(ids.every(id => id.startsWith('us.anthropic.'))).toBe(true);
    expect(ids).not.toContain('claude-sonnet-4-6');
  });

  it('keeps the Anthropic catalog for the default (non-bedrock) provider', () => {
    expect(modelChoices('claude-sonnet-4-6', 'anthropic').map(c => c.id))
      .toEqual(MODEL_CATALOG.map(m => m.id));
  });
});

describe('getLLM bedrock auth', () => {
  it('passes a credentialProvider (instance-role via IMDS) and the region to Bedrock', () => {
    // Regression guard: @ai-sdk/amazon-bedrock v5 does NOT use the AWS default credential
    // chain on its own — without a credentialProvider it throws "AWS SigV4 authentication
    // requires AWS credentials" on the EC2 box (no static keys, only the instance role).
    vi.mocked(createAmazonBedrock).mockClear();
    const cfg = {
      llmProvider: 'bedrock',
      llmModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      bedrockRegion: 'us-west-2',
    } as unknown as Config;

    getLLM(cfg);

    const opts = vi.mocked(createAmazonBedrock).mock.calls[0][0];
    expect(opts?.credentialProvider).toBe(fakeCredentialProvider);
    expect(opts?.region).toBe('us-west-2');
  });
});
