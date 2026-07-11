import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCard } from './ChatWidget';
import type { InterruptEvent } from '../api/client';

afterEach(cleanup);

const interrupt = (allowed: string[]): InterruptEvent => ({
  thread_id: 'demo:t1',
  action: { name: 'place_order', args: { total_usd: 42, lines: [{}, {}] }, description: 'Place order for 2 item(s), total $42.00.' },
  allowed_decisions: allowed,
});

describe('ApprovalCard (allowed_decisions drive the buttons)', () => {
  it('renders only the actions the interrupt allows', () => {
    render(
      <ApprovalCard interrupt={interrupt(['approve', 'reject'])} disabled={false} onApprove={() => {}} onReject={() => {}} onEdit={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reject/i })).toBeTruthy();
    // Edit was NOT allowed → not rendered.
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('exposes an Edit action when allowed_decisions includes "edit" and wires it to onEdit', () => {
    const onEdit = vi.fn();
    render(
      <ApprovalCard interrupt={interrupt(['approve', 'edit', 'reject'])} disabled={false} onApprove={() => {}} onReject={() => {}} onEdit={onEdit} />,
    );
    const editBtn = screen.getByRole('button', { name: /edit/i });
    fireEvent.click(editBtn);
    // Edit forwards the interrupt's action (name + args) so the server can act on the decision.
    expect(onEdit).toHaveBeenCalledWith({ name: 'place_order', args: { total_usd: 42, lines: [{}, {}] } });
  });

  it('falls back to approve/reject when allowed_decisions is empty (never leaves the user stuck)', () => {
    render(
      <ApprovalCard interrupt={interrupt([])} disabled={false} onApprove={() => {}} onReject={() => {}} onEdit={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reject/i })).toBeTruthy();
  });

  it('disables every action button while a resume is in flight', () => {
    render(
      <ApprovalCard interrupt={interrupt(['approve', 'edit', 'reject'])} disabled onApprove={() => {}} onReject={() => {}} onEdit={() => {}} />,
    );
    for (const name of [/approve/i, /edit/i, /reject/i]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
