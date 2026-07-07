import { describe, it, expect } from 'vitest';
import { buildCheckoutTool } from './checkout';

// The checkout tool is the agent's trigger for the order workflow. It carries NO
// identity in its input schema (REQ-E-037) — it only signals intent; the /chat
// bridge starts the run bound to the turn's {userId, threadId} closure.
describe('buildCheckoutTool', () => {
  it('has no identity fields in its input schema', () => {
    const tool = buildCheckoutTool({ onCheckout: () => {} });
    const shape = (tool.inputSchema as any).shape ?? {};
    expect(Object.keys(shape)).not.toContain('userId');
    expect(Object.keys(shape)).not.toContain('threadId');
  });

  it('signals checkout intent when executed', async () => {
    let called = false;
    const tool = buildCheckoutTool({ onCheckout: () => { called = true; } });
    const out = await (tool as any).execute({}, {});
    expect(called).toBe(true);
    expect(String(out?.status ?? out)).toMatch(/pending|checkout|approv/i);
  });
});
