// @vitest-environment jsdom
/**
 * R2Browser.spec.tsx — TDD spec for the S3-style per-site R2 object browser (FIRE 5).
 *
 * The browser lists via PS_RES_DETAIL_REQUEST { action:'list', prefix } (resolved by correlationId) and
 * downloads/deletes via the `mutate` prop. We mock the bridge + `mutate` and assert:
 *   1. it lists objects, deriving folders (from `/`-delimited keys) + leaf files at the current prefix;
 *   2. clicking a folder navigates into it (re-lists with the folder prefix);
 *   3. Download calls mutate('preview_url', {key}); a scoped URL opens via window.open (never a credential);
 *   4. an honest not-wired preview_url (available:false) shows the approach banner, no window.open;
 *   5. Delete opens the confirm dialog, then calls mutate('delete', {key}, true).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

const { postToParent, handlers } = vi.hoisted(() => {
  const handlers: Array<(msg: unknown) => void> = [];
  const postToParent = vi.fn();
  return { handlers, postToParent };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  onParentMessage: (fn: (msg: unknown) => void) => {
    handlers.push(fn);
    return () => {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    };
  },
  postToParent,
}));

vi.mock('~/components/ui/Dialog', () => ({
  ConfirmationDialog: ({
    isOpen,
    title,
    onConfirm,
    onClose,
    confirmLabel,
  }: {
    isOpen: boolean;
    title: string;
    onConfirm: () => void;
    onClose: () => void;
    confirmLabel?: string;
  }) =>
    isOpen
      ? React.createElement('div', { role: 'dialog', 'aria-label': title }, [
          React.createElement(
            'button',
            { key: 'ok', 'data-testid': 'confirm-ok', onClick: onConfirm },
            confirmLabel ?? 'Confirm',
          ),
          React.createElement('button', { key: 'no', 'data-testid': 'confirm-cancel', onClick: onClose }, 'Cancel'),
        ])
      : null,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { R2Browser } from './R2Browser';
import type { MutateOutcome } from './ResourceDetailPanel';

const TARGET = { kind: 'r2' as const, environment: 'production' as const };

/** Reply to the LAST pending list request with the given objects. */
function replyList(objects: Array<{ key: string; size?: number }>, opts: { truncated?: boolean } = {}) {
  const call = [...postToParent.mock.calls]
    .reverse()
    .find((c) => (c[0] as { type: string }).type === 'PS_RES_DETAIL_REQUEST');
  if (!call) throw new Error('no pending list request');
  const cid = (call[0] as { correlationId: string }).correlationId;
  for (const h of [...handlers]) {
    h({
      type: 'PS_RES_DETAIL_RESPONSE',
      correlationId: cid,
      ok: true,
      kind: 'r2',
      action: 'list',
      result: { ok: true, data: { objects, truncated: opts.truncated ?? false } },
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('R2 object browser', () => {
  it('lists objects, deriving folders + leaf files at the current prefix', async () => {
    render(<R2Browser target={TARGET} mutate={vi.fn()} />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));

    replyList([
      { key: 'logo.png', size: 2048 },
      { key: 'images/hero.jpg', size: 4096 },
    ]);

    await waitFor(() => expect(screen.getByTestId('r2-browser')).toBeTruthy());
    // One leaf file at root + one folder (images/).
    expect(screen.getAllByTestId('r2-file-row').length).toBe(1);
    expect(screen.getAllByTestId('r2-folder-row').length).toBe(1);
    expect(screen.getByTestId('r2-browser').textContent).toContain('logo.png');
    expect(screen.getByTestId('r2-browser').textContent).toContain('images');
  });

  it('navigates into a folder (re-lists with the folder prefix)', async () => {
    render(<R2Browser target={TARGET} mutate={vi.fn()} />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));
    replyList([{ key: 'images/hero.jpg', size: 4096 }]);

    await waitFor(() => expect(screen.getByTestId('r2-folder-row')).toBeTruthy());
    const before = postToParent.mock.calls.length;
    fireEvent.click(screen.getByTestId('r2-folder-row'));

    // A new list request fires carrying the folder prefix.
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThan(before));
    const last = postToParent.mock.calls.at(-1)![0] as { params?: { prefix?: string } };
    expect(last.params?.prefix).toBe('images/');
  });

  it('Download mints a scoped preview_url and opens it (never a credential in the client)', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const mutate = vi.fn(
      async (): Promise<MutateOutcome> => ({
        action: 'preview_url',
        kind: 'success',
        result: { available: true, url: 'https://acct.r2.cloudflarestorage.com/bucket/logo.png?X-Amz-Signature=abc' },
      }),
    );
    render(<R2Browser target={TARGET} mutate={mutate} />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));
    replyList([{ key: 'logo.png', size: 2048 }]);

    await waitFor(() => expect(screen.getByTestId('r2-download')).toBeTruthy());
    fireEvent.click(screen.getByTestId('r2-download'));

    await waitFor(() => expect(mutate).toHaveBeenCalledWith('preview_url', { key: 'logo.png' }));
    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    // The opened URL is a scoped presigned handle, not a raw credential.
    expect(openSpy.mock.calls[0][0] as string).toContain('X-Amz-Signature');
    openSpy.mockRestore();
  });

  it('shows an honest banner (no window.open) when scoped URL minting is not wired', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const mutate = vi.fn(
      async (): Promise<MutateOutcome> => ({
        action: 'preview_url',
        kind: 'success',
        result: { available: false, approach: 'A server-streamed proxy is used instead.' },
      }),
    );
    render(<R2Browser target={TARGET} mutate={mutate} />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));
    replyList([{ key: 'logo.png', size: 2048 }]);

    await waitFor(() => expect(screen.getByTestId('r2-download')).toBeTruthy());
    fireEvent.click(screen.getByTestId('r2-download'));

    await waitFor(() => expect(screen.getByTestId('r2-browser-banner')).toBeTruthy());
    expect(screen.getByTestId('r2-browser-banner').textContent).toContain('server-streamed proxy');
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('Delete opens the confirm dialog then calls mutate(delete, {key}, true)', async () => {
    const mutate = vi.fn(
      async (): Promise<MutateOutcome> => ({
        action: 'delete',
        kind: 'success',
        result: { existed: true, key: 'logo.png' },
      }),
    );
    render(<R2Browser target={TARGET} mutate={mutate} />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));
    replyList([{ key: 'logo.png', size: 2048 }]);

    await waitFor(() => expect(screen.getByTestId('r2-delete')).toBeTruthy());
    fireEvent.click(screen.getByTestId('r2-delete'));
    await waitFor(() => expect(screen.getByTestId('confirm-ok')).toBeTruthy());
    fireEvent.click(screen.getByTestId('confirm-ok'));

    await waitFor(() => expect(mutate).toHaveBeenCalledWith('delete', { key: 'logo.png' }, true));
  });
});

describe('R2 object browser — real-time, no manual refresh (R1)', () => {
  /** Count how many list requests the browser has posted so far. */
  function listCount(): number {
    return postToParent.mock.calls.filter((c) => (c[0] as { type?: string })?.type === 'PS_RES_DETAIL_REQUEST').length;
  }

  it('renders NO manual Refresh button — the listing self-updates', async () => {
    render(<R2Browser target={TARGET} mutate={vi.fn()} />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));
    replyList([{ key: 'logo.png', size: 2048 }]);

    await waitFor(() => expect(screen.getByTestId('r2-browser')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /refresh|reconcile/i })).toBeNull();
  });

  it('re-lists the current prefix automatically on a visibility-aware interval (no click)', async () => {
    vi.useFakeTimers();

    try {
      render(<R2Browser target={TARGET} mutate={vi.fn()} />);

      await act(async () => {
        await Promise.resolve();
      });

      replyList([{ key: 'logo.png', size: 2048 }]);

      const afterMount = listCount();
      expect(afterMount).toBeGreaterThanOrEqual(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(listCount()).toBeGreaterThan(afterMount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-lists immediately when the tab returns to the foreground (visibilitychange)', async () => {
    render(<R2Browser target={TARGET} mutate={vi.fn()} />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(1));
    replyList([{ key: 'logo.png', size: 2048 }]);

    const before = listCount();

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(listCount()).toBeGreaterThan(before));
  });
});
