import { describe, it, expect } from 'vitest';
import { unwrapSuspendPayload } from './order-runner';

/**
 * Mock-parity contract (the reason TC-ORD-I-001 failed once): Mastra's real
 * workflow-level `suspendPayload` is KEYED BY THE SUSPENDED STEP ID —
 * `{ 'approve-order': { action, allowed_decisions } }`, with `suspended` naming
 * the step path — NOT a flat `{ action, allowed_decisions }`. A flat-shape stub
 * hid this; these cases pin the unwrap against the real shape captured live.
 */
describe('unwrapSuspendPayload (mock parity with Mastra workflow suspend)', () => {
  it('unwraps the step-keyed payload to the suspended step payload', () => {
    const real = {
      status: 'suspended',
      suspended: [['approve-order']],
      suspendPayload: {
        'approve-order': {
          action: { name: 'place_order', args: { total_usd: 16 }, description: 'Place order' },
          allowed_decisions: ['approve', 'edit', 'reject'],
        },
      },
    };
    const out = unwrapSuspendPayload(real);
    expect(out.action.name).toBe('place_order');
    expect(out.allowed_decisions).toContain('approve');
  });

  it('passes an already-flat payload through unchanged', () => {
    const flat = { suspendPayload: { action: { name: 'place_order' }, allowed_decisions: ['approve'] } };
    expect(unwrapSuspendPayload(flat).action.name).toBe('place_order');
  });

  it('returns the raw payload when there is no suspended step path', () => {
    const p = { suspendPayload: { action: { name: 'x' } } };
    expect(unwrapSuspendPayload(p)).toEqual(p.suspendPayload);
  });
});
