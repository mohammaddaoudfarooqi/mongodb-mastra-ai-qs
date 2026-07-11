import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LeadGate from './LeadGate';

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
beforeEach(() => localStorage.clear());

describe('<LeadGate>', () => {
  it('renders children directly when the gate is disabled', () => {
    render(<LeadGate enabled={false}><div>STORE</div></LeadGate>);
    expect(screen.getByText('STORE')).toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).toBeNull();
  });

  it('blocks children behind a capture form when enabled', () => {
    render(<LeadGate enabled={true}><div>STORE</div></LeadGate>);
    expect(screen.queryByText('STORE')).toBeNull();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
  });

  it('submits the lead and reveals the store on success', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    render(<LeadGate enabled={true}><div>STORE</div></LeadGate>);
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'ada@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /enter|continue|start/i }));
    await waitFor(() => expect(screen.getByText('STORE')).toBeInTheDocument());
    expect(fetchSpy).toHaveBeenCalledWith('/api/leads', expect.objectContaining({ method: 'POST' }));
  });

  it('skips the form if the visitor already completed it (localStorage)', () => {
    localStorage.setItem('ai4LeadComplete', '1');
    render(<LeadGate enabled={true}><div>STORE</div></LeadGate>);
    expect(screen.getByText('STORE')).toBeInTheDocument();
  });
});
