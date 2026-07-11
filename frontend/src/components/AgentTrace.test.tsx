import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import AgentTrace, { curatedLine } from './AgentTrace';
import type { TraceEvent } from '../api/client';

afterEach(cleanup);

describe('curatedLine (REQ-E-065: human-readable step)', () => {
  it('renders a dataQuery step as a legible MongoDB line', () => {
    const line = curatedLine({
      id: 't1', phase: 'end', tool: 'dataQuery', summary: '8 documents from products',
      args: { collection: 'products', filter: { price: { $lt: 50 } } },
      result: { ok: true, rows: [] },
    });
    expect(line).toContain('products');
    expect(line).toMatch(/document|querie/i);
  });

  it('renders a knowledgeSearch step with a hit count', () => {
    const line = curatedLine({ id: 'k1', phase: 'end', tool: 'knowledgeSearch', summary: '5 hits', result: { hits: [] } });
    expect(line).toMatch(/search|knowledge/i);
    expect(line).toContain('5');
  });
});

describe('<AgentTrace> (REQ-E-065)', () => {
  const steps: TraceEvent[] = [
    { id: 't1', phase: 'start', tool: 'dataQuery', args: { collection: 'products', filter: { on_sale: true } } },
    { id: 't1', phase: 'end', tool: 'dataQuery', summary: '2 documents from products', result: { ok: true, rows: [{ _id: 'prod_0021' }] } },
  ];

  it('renders nothing when there are no steps', () => {
    const { container } = render(<AgentTrace steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a curated step line and reveals the raw MQL + docs on expand', () => {
    render(<AgentTrace steps={steps} />);
    // Curated summary is visible up front.
    expect(screen.getByText(/2 documents from products/i)).toBeInTheDocument();
    // The raw MQL is behind a "show query" affordance (details/expander).
    const toggle = screen.getByRole('button', { name: /query|raw|details/i });
    fireEvent.click(toggle);
    // After expand, the raw MQL JSON + returned doc id are shown in <pre> blocks.
    const pres = document.querySelectorAll('pre');
    const preText = Array.from(pres).map((p) => p.textContent).join('\n');
    expect(preText).toMatch(/"on_sale":\s*true/);
    expect(preText).toContain('prod_0021');
  });
});
