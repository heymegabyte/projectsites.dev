// @vitest-environment jsdom
/**
 * BucketsPanel.spec.tsx — spec for the per-site R2 Buckets tab (editor Resources → Buckets).
 *
 * The panel talks to the parent admin via the typed `requestR2` / `requestBucketUpload` /
 * `requestBucketDownload` senders (mocked here). We assert the golden-path-adjacent behaviors:
 *   1. DARK flag → a friendly "not enabled" disabled card (never a scary error);
 *   2. no buckets → an empty-state launchpad ("Create your first bucket");
 *   3. a bucket list renders with the object browser + object-ops-unavailable banner;
 *   4. the object browser lists objects for the selected bucket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

const { requestR2, requestBucketUpload, requestBucketDownload, postToastToParent } = vi.hoisted(() => ({
  requestR2: vi.fn(),
  requestBucketUpload: vi.fn(),
  requestBucketDownload: vi.fn(),
  postToastToParent: vi.fn(),
}));

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToastToParent,
  requestBucketDownload,
  requestBucketUpload,
  requestR2,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { BucketsPanel } from './BucketsPanel';

beforeEach(() => {
  requestR2.mockReset();
  requestBucketUpload.mockReset();
  requestBucketDownload.mockReset();
  postToastToParent.mockReset();
});

afterEach(() => cleanup());

describe('BucketsPanel', () => {
  it('shows a friendly disabled card when the r2_buckets flag is DARK', async () => {
    requestR2.mockResolvedValue({ type: 'PS_R2_RESULT', ok: false, enabled: false });
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-disabled')).toBeTruthy());
    expect(screen.getByText(/aren.t enabled yet/i)).toBeTruthy();
  });

  it('shows the empty-state launchpad when the site has no buckets', async () => {
    requestR2.mockResolvedValue({ type: 'PS_R2_RESULT', ok: true, buckets: [], objectOpsAvailable: true });
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-empty')).toBeTruthy());
    expect(screen.getByTestId('buckets-empty-create')).toBeTruthy();
  });

  it('renders the bucket list + a needs-creds banner when object ops are unavailable', async () => {
    requestR2.mockImplementation(async (input: { op: string }) => {
      if (input.op === 'listBuckets') {
        return {
          type: 'PS_R2_RESULT',
          ok: true,
          objectOpsAvailable: false,
          buckets: [{ name: 'uploads', isDefault: true, public: false, environment: 'preview' }],
        };
      }

      return { type: 'PS_R2_RESULT', ok: true, objects: [], prefixes: [], truncated: false };
    });
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-list-item')).toBeTruthy());
    expect(screen.getByTestId('buckets-needs-creds')).toBeTruthy();

    // The default bucket auto-selects → the object browser mounts + shows the needs-creds object state.
    await waitFor(() => expect(screen.getByTestId('buckets-objects-needs-creds')).toBeTruthy());
  });

  it('lists objects for the selected bucket when object ops are available', async () => {
    requestR2.mockImplementation(async (input: { op: string }) => {
      if (input.op === 'listBuckets') {
        return {
          type: 'PS_R2_RESULT',
          ok: true,
          objectOpsAvailable: true,
          buckets: [{ name: 'uploads', isDefault: true, public: false, environment: 'preview' }],
        };
      }

      if (input.op === 'listObjects') {
        return {
          type: 'PS_R2_RESULT',
          ok: true,
          objects: [{ key: 'logo.png', size: 2048, uploadedAt: new Date().toISOString() }],
          prefixes: [],
          truncated: false,
        };
      }

      return { type: 'PS_R2_RESULT', ok: true };
    });
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-object-list')).toBeTruthy());
    expect(screen.getByText('logo.png')).toBeTruthy();
  });
});

describe('BucketsPanel — real-time, no manual refresh (R1)', () => {
  /** Count how many bucket-list reads the panel has issued so far. */
  function listBucketsCount(): number {
    return requestR2.mock.calls.filter((c) => (c[0] as { op?: string })?.op === 'listBuckets').length;
  }

  /** A ready single-bucket world (object ops on) for the real-time tests. */
  function mockReadyWorld() {
    requestR2.mockImplementation(async (input: { op: string }) => {
      if (input.op === 'listBuckets') {
        return {
          type: 'PS_R2_RESULT',
          ok: true,
          objectOpsAvailable: true,
          buckets: [{ name: 'uploads', isDefault: true, public: false, environment: 'preview' }],
        };
      }

      return { type: 'PS_R2_RESULT', ok: true, objects: [], prefixes: [], truncated: false };
    });
  }

  it('renders NO manual Refresh button — the bucket inventory self-updates', async () => {
    mockReadyWorld();
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-list-item')).toBeTruthy());

    expect(screen.queryByRole('button', { name: /refresh|reconcile/i })).toBeNull();
  });

  it('re-fetches the bucket list automatically on a visibility-aware interval (no click)', async () => {
    vi.useFakeTimers();

    try {
      mockReadyWorld();
      render(<BucketsPanel />);

      await act(async () => {
        await Promise.resolve();
      });

      const afterMount = listBucketsCount();
      expect(afterMount).toBeGreaterThanOrEqual(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(listBucketsCount()).toBeGreaterThan(afterMount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-fetches immediately when the tab returns to the foreground (visibilitychange)', async () => {
    mockReadyWorld();
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-list-item')).toBeTruthy());

    const before = listBucketsCount();

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(listBucketsCount()).toBeGreaterThan(before));
  });
});

describe('BucketsPanel — B1 premium shell (grouped navigator + per-bucket workspace tabs)', () => {
  /** A ready world with one bucket per group: preview (default), production (public), custom. */
  function mockMultiWorld() {
    requestR2.mockImplementation(async (input: { op: string }) => {
      if (input.op === 'listBuckets') {
        return {
          type: 'PS_R2_RESULT',
          ok: true,
          objectOpsAvailable: true,
          buckets: [
            { name: 'uploads', isDefault: true, public: false, environment: 'preview' },
            { name: 'prod-assets', public: true, publicUrl: 'https://cdn.example.com/x', environment: 'production' },
            { name: 'exports', public: false },
          ],
        };
      }

      if (input.op === 'listObjects') {
        return { type: 'PS_R2_RESULT', ok: true, objects: [], prefixes: [], truncated: false };
      }

      return { type: 'PS_R2_RESULT', ok: true };
    });
  }

  it('groups buckets into pinned Preview + Production groups plus a Custom group', async () => {
    mockMultiWorld();
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-nav-group-preview')).toBeTruthy());
    expect(screen.getByTestId('buckets-nav-group-production')).toBeTruthy();
    expect(screen.getByTestId('buckets-nav-group-custom')).toBeTruthy();
  });

  it('renders a per-bucket workspace with Files + Settings tabs, Files active first', async () => {
    mockMultiWorld();
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-workspace-tab-files')).toBeTruthy());
    expect(screen.getByTestId('buckets-workspace-tab-settings')).toBeTruthy();

    // Files is the default tab → the (empty) object browser renders, not the Settings surface.
    await waitFor(() => expect(screen.getByTestId('buckets-objects-empty')).toBeTruthy());
    expect(screen.queryByTestId('buckets-settings')).toBeNull();
  });

  it('Settings tab exposes a live visibility toggle, address, promote and delete for a non-default bucket', async () => {
    mockMultiWorld();
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getAllByTestId('buckets-list-item').length).toBeGreaterThan(0));

    // Select the custom, non-default bucket then open its Settings tab.
    fireEvent.click(within(screen.getByTestId('buckets-nav-group-custom')).getByTestId('buckets-list-item'));
    fireEvent.click(screen.getByTestId('buckets-workspace-tab-settings'));

    expect(screen.getByTestId('buckets-settings')).toBeTruthy();
    expect(screen.getByTestId('buckets-settings-visibility')).toBeTruthy();
    expect(screen.getByTestId('buckets-settings-address')).toBeTruthy();
    expect(screen.getByTestId('buckets-settings-promote')).toBeTruthy();
    expect(screen.getByTestId('buckets-settings-delete')).toBeTruthy();

    // The visibility control is LIVE — it issues the setPublic op (not a stub).
    fireEvent.click(screen.getByTestId('buckets-settings-visibility'));
    await waitFor(() =>
      expect(requestR2.mock.calls.some((c) => (c[0] as { op?: string })?.op === 'setPublic')).toBe(true),
    );
  });

  it('hides the destructive delete control for the site default bucket', async () => {
    mockMultiWorld();
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getAllByTestId('buckets-list-item').length).toBeGreaterThan(0));

    fireEvent.click(within(screen.getByTestId('buckets-nav-group-preview')).getByTestId('buckets-list-item')); // the default (preview) bucket
    fireEvent.click(screen.getByTestId('buckets-workspace-tab-settings'));

    expect(screen.getByTestId('buckets-settings')).toBeTruthy();
    expect(screen.queryByTestId('buckets-settings-delete')).toBeNull();
  });
});

describe('BucketsPanel — B1-polish: Files list/grid view toggle', () => {
  beforeEach(() => {
    try {
      sessionStorage.clear();
    } catch {
      /* jsdom opaque-origin storage — the component guards this too */
    }
  });

  /** A ready single-bucket world with two objects (object ops on). */
  function mockObjectsWorld() {
    requestR2.mockImplementation(async (input: { op: string }) => {
      if (input.op === 'listBuckets') {
        return {
          type: 'PS_R2_RESULT',
          ok: true,
          objectOpsAvailable: true,
          buckets: [{ name: 'uploads', isDefault: true, public: false, environment: 'preview' }],
        };
      }

      if (input.op === 'listObjects') {
        return {
          type: 'PS_R2_RESULT',
          ok: true,
          objects: [
            { key: 'logo.png', size: 2048, uploadedAt: new Date().toISOString() },
            { key: 'notes.txt', size: 120, uploadedAt: new Date().toISOString() },
          ],
          prefixes: [],
          truncated: false,
        };
      }

      return { type: 'PS_R2_RESULT', ok: true };
    });
  }

  it('defaults to list view and offers both list + grid toggle controls', async () => {
    mockObjectsWorld();
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-object-list')).toBeTruthy());
    expect(screen.getByTestId('buckets-view-list')).toBeTruthy();
    expect(screen.getByTestId('buckets-view-grid')).toBeTruthy();
    expect(screen.queryByTestId('buckets-object-grid')).toBeNull();
  });

  it('switches to a grid of object tiles when grid is selected', async () => {
    mockObjectsWorld();
    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-object-list')).toBeTruthy());

    fireEvent.click(screen.getByTestId('buckets-view-grid'));

    await waitFor(() => expect(screen.getByTestId('buckets-object-grid')).toBeTruthy());
    expect(screen.getAllByTestId('buckets-object-tile').length).toBe(2);
    expect(screen.getByText('logo.png')).toBeTruthy();
    expect(screen.queryByTestId('buckets-object-list')).toBeNull();
  });

  it('persists the chosen view across remounts (session)', async () => {
    mockObjectsWorld();

    const first = render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-object-list')).toBeTruthy());

    fireEvent.click(screen.getByTestId('buckets-view-grid'));
    await waitFor(() => expect(screen.getByTestId('buckets-object-grid')).toBeTruthy());
    first.unmount();

    render(<BucketsPanel />);
    await waitFor(() => expect(screen.getByTestId('buckets-object-grid')).toBeTruthy());
  });
});
