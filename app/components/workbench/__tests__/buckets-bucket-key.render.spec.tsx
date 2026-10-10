// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Settings — DOM-render proof for the per-BUCKET Access Keys workspace
 *       (B4-UI). The consuming UI for the per-bucket key backend shipped + PROVEN in fire b4.
 *
 * Context: `BucketWorkspace`'s Settings tab ALREADY renders the SITE-wide `OwnerKeySection`. This slice
 * ADDS a BUCKET-scoped `BucketKeySection` to the SAME Settings tab, for the CURRENTLY-SELECTED bucket.
 * It drives the ALREADY-BUILT per-bucket bridge helpers in `embedded-mode.ts`
 * (`requestBucketOwnerKeyStatus`/`…Create`/`…Rotate`/`…Revoke`, each taking the bucket DISPLAY name,
 * all → `PS_R2_BUCKET_KEY_RESULT`) — NOT the site-wide `requestOwnerKey*` helpers. The section:
 *   1. shows the MASKED access key id + status + created-at on mount (status fetch, scoped to the bucket),
 *   2. reveals the Secret Access Key ONCE inside the shared `ModalShell` dialog after Create, with a
 *      copy-to-clipboard button and honest "shown once — rotate to get a new one" copy,
 *   3. offers Rotate (re-reveal once) and Revoke (confirm first — a doomed control is never one click),
 *   4. makes the SITE-vs-BUCKET distinction CLEAR ("works only for this bucket"),
 *   5. degrades gracefully to a friendly card on the dark flag (`enabled:false`) and the
 *      needs-creds state (`needsCreds:true`) — never a scary error, never a dead button,
 *   6. keeps motion `motion-reduce:`-gated (vestibular a11y).
 *
 * The bridge helpers are mocked (the real ones postMessage to a parent that isn't present in jsdom).
 * `BucketKeySection` is exported from BucketsPanel for this exact falsifiability (mirrors `OwnerKeySection`).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the bridge helpers BEFORE importing the panel (swc hoists vi.mock). ──
// Site-wide (must NOT be called by the bucket-scoped section):
const mockSiteStatus = vi.fn();
const mockSiteCreate = vi.fn();
const mockSiteRotate = vi.fn();
const mockSiteRevoke = vi.fn();
// Per-bucket (the section under test):
const mockBucketStatus = vi.fn();
const mockBucketCreate = vi.fn();
const mockBucketRotate = vi.fn();
const mockBucketRevoke = vi.fn();

vi.mock('~/lib/embed/embedded-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/embed/embedded-mode')>();
  return {
    ...actual,
    isEmbedded: true,
    postToastToParent: vi.fn(),
    requestOwnerKeyStatus: (...a: unknown[]) => mockSiteStatus(...a),
    requestOwnerKeyCreate: (...a: unknown[]) => mockSiteCreate(...a),
    requestOwnerKeyRotate: (...a: unknown[]) => mockSiteRotate(...a),
    requestOwnerKeyRevoke: (...a: unknown[]) => mockSiteRevoke(...a),
    requestBucketOwnerKeyStatus: (...a: unknown[]) => mockBucketStatus(...a),
    requestBucketOwnerKeyCreate: (...a: unknown[]) => mockBucketCreate(...a),
    requestBucketOwnerKeyRotate: (...a: unknown[]) => mockBucketRotate(...a),
    requestBucketOwnerKeyRevoke: (...a: unknown[]) => mockBucketRevoke(...a),
  };
});

import { BucketKeySection } from '~/components/workbench/BucketsPanel';

const BUCKET = 'uploads';

const ACTIVE_STATUS = {
  type: 'PS_R2_BUCKET_KEY_RESULT' as const,
  ok: true,
  op: 'status' as const,
  bucket: BUCKET,
  status: {
    exists: true,
    accessKeyIdMasked: 'abcd…wxyz',
    status: 'active' as const,
    createdAt: '2026-10-01T12:00:00.000Z',
    rotatedAt: null,
  },
};

const NONE_STATUS = {
  type: 'PS_R2_BUCKET_KEY_RESULT' as const,
  ok: true,
  op: 'status' as const,
  bucket: BUCKET,
  status: { exists: false, accessKeyIdMasked: null, status: 'none' as const, createdAt: null, rotatedAt: null },
};

beforeEach(() => {
  mockSiteStatus.mockReset();
  mockSiteCreate.mockReset();
  mockSiteRotate.mockReset();
  mockSiteRevoke.mockReset();
  mockBucketStatus.mockReset();
  mockBucketCreate.mockReset();
  mockBucketRotate.mockReset();
  mockBucketRevoke.mockReset();

  // jsdom lacks the async clipboard API — stub it so the copy button's path runs.
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(cleanup);

describe('BucketKeySection — renders + consumes the PER-BUCKET helpers', () => {
  it('fetches this bucket status (scoped by display name) on mount — NOT the site-wide helper', async () => {
    mockBucketStatus.mockResolvedValue(ACTIVE_STATUS);
    render(<BucketKeySection bucket={BUCKET} />);

    await waitFor(() => expect(mockBucketStatus).toHaveBeenCalledTimes(1));

    // Scoped to the SELECTED bucket's display name.
    expect(mockBucketStatus).toHaveBeenCalledWith(BUCKET);

    // The site-wide helper is NEVER touched by the bucket-scoped section.
    expect(mockSiteStatus).not.toHaveBeenCalled();

    const section = await screen.findByTestId('buckets-bucket-key');
    expect(section.textContent).toContain('abcd…wxyz'); // masked id, never a real secret
    expect(section.textContent).toMatch(/active/i);
    expect(section.textContent).not.toMatch(/secret access key/i);
  });

  it('re-fetches when the selected bucket changes (scopes to the new name)', async () => {
    mockBucketStatus.mockResolvedValue(NONE_STATUS);
    const { rerender } = render(<BucketKeySection bucket={BUCKET} />);

    await waitFor(() => expect(mockBucketStatus).toHaveBeenCalledWith(BUCKET));

    await act(async () => {
      rerender(<BucketKeySection bucket="invoices" />);
    });

    await waitFor(() => expect(mockBucketStatus).toHaveBeenCalledWith('invoices'));
  });

  it('shows the "Create access key" launchpad when this bucket has no key yet', async () => {
    mockBucketStatus.mockResolvedValue(NONE_STATUS);
    render(<BucketKeySection bucket={BUCKET} />);

    const btn = await screen.findByTestId('buckets-bucket-key-create');
    expect(btn.textContent).toMatch(/create/i);
  });
});

describe('BucketKeySection — the site-vs-bucket distinction is CLEAR', () => {
  it('names THIS bucket + says the key works only for this bucket (never confusable with the site key)', async () => {
    mockBucketStatus.mockResolvedValue(NONE_STATUS);
    render(<BucketKeySection bucket={BUCKET} />);

    const section = await screen.findByTestId('buckets-bucket-key');

    // The section is unmistakably about THIS bucket + its scope.
    expect(section.textContent).toContain(BUCKET);
    expect(section.textContent).toMatch(/only this bucket|just this bucket|this bucket only/i);
  });
});

describe('BucketKeySection — show-once reveal (per-bucket helper)', () => {
  it('reveals the secret ONCE in a dialog after Create via the PER-BUCKET create helper', async () => {
    mockBucketStatus.mockResolvedValue(NONE_STATUS);
    mockBucketCreate.mockResolvedValue({
      type: 'PS_R2_BUCKET_KEY_RESULT',
      ok: true,
      op: 'create',
      bucket: BUCKET,
      accessKeyId: 'AKIA-NEW-ID',
      secretAccessKey: 'super-secret-value-shown-once',
      status: { exists: true, accessKeyIdMasked: 'AKIA…-ID', status: 'active', createdAt: 'now', rotatedAt: null },
    });

    render(<BucketKeySection bucket={BUCKET} />);

    const createBtn = await screen.findByTestId('buckets-bucket-key-create');
    await act(async () => {
      fireEvent.click(createBtn);
    });

    // Created via the PER-BUCKET helper (scoped), NOT the site-wide one.
    await waitFor(() => expect(mockBucketCreate).toHaveBeenCalledWith(BUCKET));
    expect(mockSiteCreate).not.toHaveBeenCalled();

    const reveal = await screen.findByTestId('buckets-bucket-key-reveal');
    expect(reveal.textContent).toContain('super-secret-value-shown-once');
    expect(reveal.textContent).toMatch(/shown once/i);
    expect(reveal.textContent).toMatch(/rotate/i);

    const copyBtn = await screen.findByTestId('buckets-bucket-key-copy-secret');
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    await waitFor(() =>
      expect(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        'super-secret-value-shown-once',
      ),
    );
  });
});

describe('BucketKeySection — rotate + revoke (per-bucket helpers)', () => {
  it('rotate re-reveals a fresh secret once via the PER-BUCKET rotate helper', async () => {
    mockBucketStatus.mockResolvedValue(ACTIVE_STATUS);
    mockBucketRotate.mockResolvedValue({
      type: 'PS_R2_BUCKET_KEY_RESULT',
      ok: true,
      op: 'rotate',
      bucket: BUCKET,
      accessKeyId: 'AKIA-ROT',
      secretAccessKey: 'rotated-secret',
      status: { exists: true, accessKeyIdMasked: 'AKIA…ROT', status: 'active', createdAt: 'x', rotatedAt: 'now' },
    });

    render(<BucketKeySection bucket={BUCKET} />);

    const rotateBtn = await screen.findByTestId('buckets-bucket-key-rotate');
    await act(async () => {
      fireEvent.click(rotateBtn);
    });

    const reveal = await screen.findByTestId('buckets-bucket-key-reveal');
    expect(reveal.textContent).toContain('rotated-secret');
    await waitFor(() => expect(mockBucketRotate).toHaveBeenCalledWith(BUCKET));
    expect(mockSiteRotate).not.toHaveBeenCalled();
  });

  it('revoke asks for confirmation FIRST, then calls the PER-BUCKET revoke helper', async () => {
    mockBucketStatus.mockResolvedValue(ACTIVE_STATUS);
    mockBucketRevoke.mockResolvedValue({
      type: 'PS_R2_BUCKET_KEY_RESULT',
      ok: true,
      op: 'revoke',
      bucket: BUCKET,
      revoked: true,
    });

    render(<BucketKeySection bucket={BUCKET} />);

    const revokeBtn = await screen.findByTestId('buckets-bucket-key-revoke');
    await act(async () => {
      fireEvent.click(revokeBtn);
    });

    // First click opens a confirm dialog — revoke has NOT fired yet.
    expect(mockBucketRevoke).not.toHaveBeenCalled();

    const confirm = await screen.findByTestId('buckets-bucket-key-revoke-confirm');
    expect(confirm).toBeTruthy();

    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(mockBucketRevoke).toHaveBeenCalledWith(BUCKET));
    expect(mockSiteRevoke).not.toHaveBeenCalled();
  });
});

describe('BucketKeySection — graceful degraded states', () => {
  it('shows a friendly "not enabled" card on the dark flag (enabled:false), no scary error', async () => {
    mockBucketStatus.mockResolvedValue({
      type: 'PS_R2_BUCKET_KEY_RESULT',
      ok: false,
      op: 'status',
      bucket: BUCKET,
      enabled: false,
    });
    render(<BucketKeySection bucket={BUCKET} />);

    const disabled = await screen.findByTestId('buckets-bucket-key-disabled');
    expect(disabled.textContent).toMatch(/not (enabled|turned on|available)|on the way/i);
    expect(screen.queryByTestId('buckets-bucket-key-create')).toBeNull();
  });

  it('shows an actionable needs-creds card (needsCreds:true), not a dead button', async () => {
    mockBucketStatus.mockResolvedValue({
      type: 'PS_R2_BUCKET_KEY_RESULT',
      ok: false,
      op: 'status',
      bucket: BUCKET,
      needsCreds: true,
    });
    render(<BucketKeySection bucket={BUCKET} />);

    const needs = await screen.findByTestId('buckets-bucket-key-needs-creds');
    expect(needs.textContent).toMatch(/set up|setting up|configured/i);
    expect(screen.queryByTestId('buckets-bucket-key-create')).toBeNull();
  });

  it('shows a retryable error card on a transport failure (never silently blank)', async () => {
    mockBucketStatus.mockRejectedValue(new Error('bridge timed out'));
    render(<BucketKeySection bucket={BUCKET} />);

    const section = await screen.findByTestId('buckets-bucket-key');
    await waitFor(() => expect(section.textContent).toMatch(/bridge timed out|could not load/i));
  });
});

describe('BucketKeySection — reduced-motion a11y', () => {
  it('gates the busy spinner behind motion-reduce (no spin for vestibular users)', async () => {
    mockBucketStatus.mockResolvedValue(NONE_STATUS);
    let createResolve: (v: unknown) => void = () => {};
    mockBucketCreate.mockReturnValue(
      new Promise((res) => {
        createResolve = res;
      }),
    );

    const { container } = render(<BucketKeySection bucket={BUCKET} />);

    const createBtn = await screen.findByTestId('buckets-bucket-key-create');
    await act(async () => {
      fireEvent.click(createBtn);
    });

    // While busy, the spinner carries the reduced-motion opt-out.
    const spinner = container.querySelector('.animate-spin');
    expect(spinner).not.toBeNull();
    expect(spinner?.className).toMatch(/motion-reduce:animate-none/);

    await act(async () => {
      createResolve({ type: 'PS_R2_BUCKET_KEY_RESULT', ok: true, op: 'create', bucket: BUCKET });
    });
  });
});
