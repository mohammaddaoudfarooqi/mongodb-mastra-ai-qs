import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../config';

const cfg = {
  mongoUri: 'mongodb+srv://u:p@c.mongodb.net/', mongoDb: 'db', voyageApiKey: 'vk',
  llmProvider: 'anthropic', llmModel: 'claude-opus-4-8', allowInsecure: false,
  responseCache: { enabled: true, ttlDays: 1, similarityThreshold: 0.9, maxAnswerBytes: 32768 },
  memory: { semanticRecall: false, lastMessages: 10 },
  rrfK: 60, dataAgentAllowList: ['products', 'orders', 'promotions'], dataAgentLimit: 25,
  emitPlanFrames: false, ingestDescribe: true, port: 8000, defaultUserId: 'demo',
  mongoPool: { maxPoolSize: 100, minPoolSize: 10 },
} as Config;

describe('buildConcierge', () => {
  const turn = () => ({ signals: { knowledgeSearchRan: false, knowledgeSearchHadResults: false, dataQueryRan: false, mutatingToolRan: false } });

  it('returns a concierge router with the dealsAndCart sub-agent and a direct knowledgeSearch tool', async () => {
    const { buildConcierge } = await import('./agent');
    const { agent } = buildConcierge(cfg, turn());
    expect(agent).toBeDefined();
    expect(agent.id).toBe('concierge');
    // dealsAndCart stays a native sub-agent (exposed via __getStaticAgents); knowledge
    // retrieval is a DIRECT router tool so the answering LLM reads the hits itself
    // (no empty-sub-agent-text boundary — see the KB retrieval fix).
    const subs = (agent as any).__getStaticAgents();
    expect(Object.keys(subs)).toEqual(['dealsAndCart']);
    const tools = await (agent as any).listTools();
    expect(Object.keys(tools)).toContain('knowledgeSearch');
    // checkout is a direct router tool too: it is a pure signal (no MQL guard, no cart
    // identity), and the router is the agent that converses with the shopper, so a bare
    // "yes"/"approved" confirmation reaches the tool instead of being narrated as a fake
    // completed order by a router that lacked the tool (the checkout-not-triggered bug).
    expect(Object.keys(tools)).toContain('checkout');
  });

  it('threads the turn signal bag rather than defaulting it away', async () => {
    const { buildConcierge } = await import('./agent');
    const t = turn();
    buildConcierge(cfg, t);
    expect(t.signals.knowledgeSearchRan).toBe(false);
  });

  it('gives the dealsAndCart specialist data + cart tools but NOT checkout', async () => {
    const { buildConcierge } = await import('./agent');
    const { agent } = buildConcierge(cfg, turn());
    const subs = (agent as any).__getStaticAgents();
    const tools = await (subs.dealsAndCart as any).listTools();
    expect(Object.keys(tools)).toEqual(expect.arrayContaining(['dataQuery', 'cartAdd', 'cartRead', 'cartRemove', 'applyCoupon']));
    // checkout moved to the router (see the topology test above); the specialist must not
    // own it, or a delegated turn could start the order flow without the router's approval
    // framing — and a bare confirmation would again miss the tool.
    expect(Object.keys(tools)).not.toContain('checkout');
  });

  it('defaults semanticRecall OFF (the per-turn vector search) but keeps resource working memory', async () => {
    // The per-turn cross-thread vector search is the biggest latency tax (adds ~10s to
    // even "hi"), and cross-thread personalization rides on working memory, not recall —
    // so the default config disables recall while keeping the resource-scoped shopper
    // profile. lastMessages gives cheap in-thread coherence (storage read, no embed).
    const { buildConcierge } = await import('./agent');
    const { memory } = buildConcierge(cfg, turn());
    const resolved = (memory as any).getMergedThreadConfig();
    expect(resolved.semanticRecall).toBe(false);
    expect(resolved.lastMessages).toBe(10);
    expect(resolved.workingMemory).toMatchObject({ enabled: true, scope: 'resource' });
  });

  it('enables resource-scoped recall when cfg.memory.semanticRecall is on', async () => {
    const { buildConcierge } = await import('./agent');
    const { memory } = buildConcierge({ ...cfg, memory: { semanticRecall: true, lastMessages: 10 } }, turn());
    const resolved = (memory as any).getMergedThreadConfig();
    expect(resolved.semanticRecall).toMatchObject({ scope: 'resource' });
  });

  it('sanitizes working-memory writes so volatile cart/order state cannot persist to the profile', async () => {
    // Mastra's built-in working-memory prompt pushes the model to store "any relevant info",
    // so it writes cart totals/counts into the durable profile; they then read back as
    // fabricated current cart state on a later turn. buildConciergeDeps installs a sanitizer
    // at the updateWorkingMemory boundary — verify a leaked-total write is scrubbed before
    // storage while durable preferences survive.
    const { buildConcierge } = await import('./agent');
    const { memory } = buildConcierge(cfg, turn());
    // Bypass the real Mongo store: updateWorkingMemory awaits this.getMemoryStore().updateResource,
    // so a fake store lets us assert what the sanitizer handed downstream without a connection.
    const updateResource = vi.fn().mockResolvedValue(undefined);
    (memory as any).getMemoryStore = async () => ({ updateResource });

    await memory.updateWorkingMemory({
      resourceId: 'demo',
      workingMemory:
        '# Shopper Profile\n- Preferences: Eco-friendly kitchen products\n- Notes: Cooks for a family of four. Current cart: 25 on-sale items. Subtotal: $1,879.75, Total Savings: $470.00.',
    } as any);

    expect(updateResource).toHaveBeenCalledTimes(1);
    const persisted = updateResource.mock.calls[0][0].workingMemory as string;
    expect(persisted).toContain('Eco-friendly kitchen products');
    expect(persisted).toContain('Cooks for a family of four.');
    expect(persisted).not.toMatch(/\$1,879\.75|\$470\.00|Subtotal|Total Savings|current cart/i);
  });
});

describe('isBulkAddIntent', () => {
  it('matches explicit bulk/all-item add phrasings', async () => {
    const { isBulkAddIntent } = await import('./agent');
    for (const m of [
      'add all',
      'add all the discounted items',
      'add everything on sale',
      'add them all',
      'add one each',
      'put these in my cart',
      'add every item',
      'add all of them',
    ]) {
      expect(isBulkAddIntent(m)).toBe(true);
    }
  });

  it('does NOT match single-item adds (anti-ballooning guard stays at 1)', async () => {
    const { isBulkAddIntent } = await import('./agent');
    for (const m of [
      'add the mug',
      'add a kitchen item',
      'add the biggest-savings sports product',
      'what is on discount?',
      'add it to my cart',
      undefined,
      '',
    ]) {
      expect(isBulkAddIntent(m as any)).toBe(false);
    }
  });
});
