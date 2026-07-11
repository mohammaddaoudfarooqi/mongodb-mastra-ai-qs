import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Header from './Header';
import { AuthProvider } from '../context/AuthContext';
import { ChatProvider } from '../context/ChatContext';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockApi(meBody: unknown, modelsBody: unknown) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/auth/me')) {
      return new Response(JSON.stringify(meBody), { status: 200 });
    }
    if (url.includes('/models')) {
      return new Response(JSON.stringify(modelsBody), { status: 200 });
    }
    // threads/latest etc. — return benign empties so providers settle.
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

describe('Header (Spec 550)', () => {
  it('REQ-E-561: shows the SSO email read-only (no editable user input)', async () => {
    mockApi(
      { email: 'alice@mongodb.com', username: 'alice', groups: [] },
      { default: 'm1', models: [{ id: 'm1', label: 'haiku' }] },
    );

    render(
      <AuthProvider>
        <ChatProvider>
          <Header />
        </ChatProvider>
      </AuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('alice@mongodb.com')).toBeInTheDocument(),
    );
    // The old editable "User ID" textbox must be gone.
    expect(screen.queryByLabelText('User ID')).toBeNull();
  });

  it('renders the MongoDB + Mastra co-brand lockup', async () => {
    mockApi(
      { email: 'a@b.com', username: 'a', groups: [] },
      { default: 'm1', models: [{ id: 'm1', label: 'haiku' }] },
    );

    render(
      <AuthProvider>
        <ChatProvider>
          <Header />
        </ChatProvider>
      </AuthProvider>,
    );

    // The lockup carries both brands; the individual marks are aria-hidden, so
    // assert on the group label that names the partnership.
    expect(await screen.findByLabelText('MongoDB and Mastra')).toBeInTheDocument();
  });

  it('REQ-E-562: the model dropdown lists exactly the two allowed models', async () => {
    mockApi(
      { email: 'a@b.com', username: 'a', groups: [] },
      {
        default: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        models: [
          { id: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'haiku-4-5' },
          { id: 'global.anthropic.claude-sonnet-4-6', label: 'sonnet-4-6' },
        ],
      },
    );

    render(
      <AuthProvider>
        <ChatProvider>
          <Header />
        </ChatProvider>
      </AuthProvider>,
    );

    const select = await screen.findByLabelText('Select Bedrock model');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['haiku-4-5', 'sonnet-4-6']);
  });

  it('REQ-E-070: hides the model picker when switching is locked (AI4 public domain)', async () => {
    mockApi(
      { email: 'a@b.com', username: 'a', groups: [] },
      {
        default: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        models: [{ id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5 (Bedrock, fast)' }],
        allowSwitch: false,
      },
    );

    render(
      <AuthProvider>
        <ChatProvider>
          <Header />
        </ChatProvider>
      </AuthProvider>,
    );

    // The pinned model is shown as a static badge…
    expect(await screen.findByText(/Claude Haiku 4.5/i)).toBeInTheDocument();
    // …and there is NO selectable dropdown.
    expect(screen.queryByLabelText('Select Bedrock model')).toBeNull();
  });
});
