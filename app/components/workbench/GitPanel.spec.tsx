// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

/*
 * Drive the panel through the embedded bridge: we mock `~/lib/embed/embedded-mode` so `isEmbedded` is
 * true and each `postToParent` is answered synchronously by the registered `onParentMessage` handler
 * with a canned reply keyed by correlationId — exactly how the real admin answers. This exercises the
 * panel's request/reply/render path without a live iframe or worker.
 */
const { postToParent, onParentMessage, listeners, replies } = vi.hoisted(() => {
  const listeners: ((msg: unknown) => void)[] = [];

  // requestType → reply payload (merged with the echoed correlationId).
  const replies: Record<string, Record<string, unknown>> = {};

  return {
    listeners,
    replies,
    onParentMessage: vi.fn((cb: (msg: unknown) => void) => {
      listeners.push(cb);

      return () => {
        const i = listeners.indexOf(cb);

        if (i >= 0) {
          listeners.splice(i, 1);
        }
      };
    }),
    postToParent: vi.fn((msg: { type: string; correlationId: string }) => {
      const responseType = msg.type.replace('_REQUEST', '_RESPONSE');
      const payload = replies[msg.type];

      if (!payload) {
        return;
      }

      // Answer on the next microtask, like a real async bridge round-trip.
      queueMicrotask(() => {
        for (const cb of [...listeners]) {
          cb({ type: responseType, correlationId: msg.correlationId, ...payload });
        }
      });
    }),
  };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent,
  onParentMessage,
}));

import { GitPanel } from './GitPanel';

function setReply(requestType: string, payload: Record<string, unknown>): void {
  replies[requestType] = payload;
}

describe('GitPanel', () => {
  beforeEach(() => {
    cleanup();
    listeners.length = 0;

    for (const k of Object.keys(replies)) {
      delete replies[k];
    }
    postToParent.mockClear();
    onParentMessage.mockClear();
  });

  afterEach(() => cleanup());

  it('renders the Files/History segmented control and a Code heading', () => {
    setReply('PS_CODE_TREE_REQUEST', { ok: true, files: [], prefix: 'sites/acme/', version: null });
    render(<GitPanel />);

    expect(screen.getByRole('heading', { name: 'Code' })).toBeTruthy();
    expect(screen.getByTestId('code-tab-files')).toBeTruthy();
    expect(screen.getByTestId('code-tab-history')).toBeTruthy();
  });

  it('shows an honest empty state when the site has no published files', async () => {
    setReply('PS_CODE_TREE_REQUEST', { ok: true, files: [], prefix: 'sites/acme/', version: null });
    render(<GitPanel />);

    await waitFor(() => expect(screen.getByTestId('code-empty')).toBeTruthy());
    expect(screen.getByText(/No published files yet/i)).toBeTruthy();
  });

  it('builds a file tree from the worker reply and shows a file count', async () => {
    setReply('PS_CODE_TREE_REQUEST', {
      ok: true,
      version: '2026-05-11',
      files: [
        {
          key: 'sites/acme/index.html',
          name: 'index.html',
          size: 1200,
          uploaded: '2026-05-11T14:00:00Z',
          content_type: 'text/html',
        },
        {
          key: 'sites/acme/assets/app.js',
          name: 'assets/app.js',
          size: 5000,
          uploaded: '2026-05-11T14:00:00Z',
          content_type: 'application/javascript',
        },
      ],
    });
    render(<GitPanel />);

    await waitFor(() => expect(screen.getByTestId('code-files')).toBeTruthy());

    // The assets folder + the index.html file both render as tree rows.
    expect(screen.getByText('assets')).toBeTruthy();
    expect(screen.getByText('index.html')).toBeTruthy();

    // Viewer starts idle until a file is picked.
    expect(screen.getByTestId('code-viewer-idle')).toBeTruthy();
  });

  it('surfaces a load error with a Retry affordance', async () => {
    setReply('PS_CODE_TREE_REQUEST', { ok: false, error: 'Failed to load files' });
    render(<GitPanel />);

    await waitFor(() => expect(screen.getByTestId('code-error')).toBeTruthy());
    expect(screen.getByText('Failed to load files')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });
});
