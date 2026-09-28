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
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
