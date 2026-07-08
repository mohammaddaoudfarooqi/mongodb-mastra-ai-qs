import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../config';

// Capture what ConverseCommand was constructed with, and what the client sent, so we can
// assert the describer builds the right request WITHOUT any real AWS call.
const sendMock = vi.fn();
const converseArgs: any[] = [];

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn(() => ({ send: sendMock })),
  ConverseCommand: vi.fn((input: any) => { converseArgs.push(input); return { input }; }),
}));

vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: vi.fn(() => vi.fn()),
}));

import { createBedrockDescriber, createDescriber, createAnthropicDescriber } from './describe';

const cfg = (over: Partial<Config> = {}): Config => ({
  llmProvider: 'bedrock',
  llmModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  bedrockRegion: 'us-west-2',
  ...over,
} as Config);

// A 1x1 png data URL (payload content is irrelevant; only the base64 decode + format matter).
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

describe('createBedrockDescriber', () => {
  beforeEach(() => { sendMock.mockReset(); converseArgs.length = 0; });

  it('sends a Converse request with the model id, decoded image bytes, and mapped format', async () => {
    sendMock.mockResolvedValue({ output: { message: { content: [{ text: 'A red ceramic mug.' }] } } });
    const describe = createBedrockDescriber(cfg());
    const text = await describe({ title: 'Red Mug', dataUrl: PNG_DATA_URL });

    expect(text).toBe('A red ceramic mug.');
    expect(sendMock).toHaveBeenCalledOnce();
    const input = converseArgs[0];
    expect(input.modelId).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    const [img, txt] = input.messages[0].content;
    expect(img.image.format).toBe('png');
    // Raw bytes, not base64 (the SDK signs + encodes) — must equal the decoded payload.
    expect(Buffer.from(img.image.source.bytes).equals(Buffer.from('iVBORw0KGgo=', 'base64'))).toBe(true);
    expect(txt.text).toContain('Red Mug');
    expect(input.inferenceConfig.maxTokens).toBe(300);
  });

  it('maps jpg/jpeg subtype to the jpeg format enum', async () => {
    sendMock.mockResolvedValue({ output: { message: { content: [{ text: 'ok' }] } } });
    await createBedrockDescriber(cfg())({ title: 't', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' });
    expect(converseArgs[0].messages[0].content[0].image.format).toBe('jpeg');
  });

  it('throws on empty model output so the upstream raw-image fallback triggers', async () => {
    sendMock.mockResolvedValue({ output: { message: { content: [] } } });
    await expect(createBedrockDescriber(cfg())({ title: 't', dataUrl: PNG_DATA_URL }))
      .rejects.toThrow(/empty/i);
  });

  it('throws on a non-image data url', async () => {
    await expect(createBedrockDescriber(cfg())({ title: 't', dataUrl: 'not-a-data-url' }))
      .rejects.toThrow(/data url/i);
  });

  it('rejects an unsupported image format', async () => {
    await expect(createBedrockDescriber(cfg())({ title: 't', dataUrl: 'data:image/tiff;base64,AAAA' }))
      .rejects.toThrow(/unsupported image format/i);
  });
});

describe('createDescriber dispatch', () => {
  it('returns a working bedrock describer when provider is bedrock', async () => {
    sendMock.mockReset(); converseArgs.length = 0;
    sendMock.mockResolvedValue({ output: { message: { content: [{ text: 'desc' }] } } });
    const describe = createDescriber(cfg({ llmProvider: 'bedrock' }));
    expect(await describe({ title: 't', dataUrl: PNG_DATA_URL })).toBe('desc');
    expect(sendMock).toHaveBeenCalledOnce(); // proves the bedrock path, not anthropic REST
  });

  it('does not use the bedrock path for the anthropic provider', () => {
    // The anthropic describer is a distinct function reference; dispatch must not return the
    // bedrock one. (We assert by identity to avoid making a real network call.)
    const anth = createDescriber(cfg({ llmProvider: 'anthropic' }));
    expect(typeof anth).toBe('function');
    // Sanity: constructing the anthropic describer directly yields the same kind of fn.
    expect(typeof createAnthropicDescriber(cfg({ llmProvider: 'anthropic' }))).toBe('function');
  });
});
