import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PresetGrid, { PRESETS } from './PresetGrid';
import { AuthProvider } from '../context/AuthContext';
import { ChatProvider } from '../context/ChatContext';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Capture the body of every POST /chat so we can assert which thread_id a preset launched on.
function mockApi(meBody: unknown) {
  const chatBodies: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/me')) return new Response(JSON.stringify(meBody), { status: 200 });
    if (url.includes('/chat')) {
      if (init?.body) chatBodies.push(JSON.parse(String(init.body)));
      // Minimal SSE stream so the client's reader completes without error.
      return new Response('event: done\ndata: {}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
  return chatBodies;
}

function renderGrid() {
  render(
    <AuthProvider>
      <ChatProvider>
        <PresetGrid />
      </ChatProvider>
    </AuthProvider>,
  );
}

describe('PresetGrid — curated public set', () => {
  it('shows only the curated (stateless, cache-safe) prompts when curatedPresets is on', async () => {
    mockApi({ email: 'demo', username: 'demo', groups: [], curatedPresets: true });
    renderGrid();

    const curated = PRESETS.filter(p => p.curated);
    // Every curated prompt is present…
    for (const p of curated) {
      expect(await screen.findByText(p.text)).toBeInTheDocument();
    }
    // …and the stateful cart/checkout/memory prompts are hidden.
    expect(screen.queryByText('Check out and place my order.')).toBeNull();
    expect(screen.queryByText(/Remember that I prefer eco-friendly/)).toBeNull();
    expect(screen.queryByText(/Add the on-sale kitchen product/)).toBeNull();
  });

  it('shows the full set on the stage box (curatedPresets off)', async () => {
    mockApi({ email: 'demo', username: 'demo', groups: [], curatedPresets: false });
    renderGrid();
    expect(await screen.findByText('Check out and place my order.')).toBeInTheDocument();
    expect(screen.getByText(/Remember that I prefer eco-friendly/)).toBeInTheDocument();
  });
});

describe('PresetGrid — stateful checkout does not wipe the cart', () => {
  it('launches the checkout preset on the CURRENT thread, not a fresh one', async () => {
    const chatBodies = mockApi({ email: 'demo', username: 'demo', groups: [], curatedPresets: false });
    renderGrid();

    // Fire a stateless prompt first to establish the current thread id.
    fireEvent.click((await screen.findByText('How long does shipping take?')).closest('button')!);
    await waitFor(() => expect(chatBodies.length).toBe(1));
    const statelessThread = chatBodies[0].thread_id;

    // Now the checkout preset (stateful). It must reuse the SAME thread, not mint a new one —
    // otherwise it checks out an empty cart. (Its message differs, so this is a real reuse.)
    fireEvent.click(screen.getByText('Check out and place my order.').closest('button')!);
    await waitFor(() => expect(chatBodies.length).toBe(2));
    expect(chatBodies[1].message).toBe('Check out and place my order.');
    expect(chatBodies[1].thread_id).toBe(statelessThread);
  });
});
