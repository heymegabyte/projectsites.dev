// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Clone bucket (B6) — the Settings "Clone" section + the `CloneBucketModal`
 *       dialog (prefill `{src}-copy` · validate · submit → bridge · honest truncation note · no doomed control).
 *
 * Context: B6 adds a CLONE action — create a NEW bucket + server-side-copy the source bucket's objects into
 * it (bounded synchronous; a durable Workflow for huge buckets is a follow-up). It drives the
 * `requestBucketClone` bridge helper (admin proxies to `POST …/r2/buckets/:bucket/clone` →
 * `PS_R2_CLONE_RESULT`). This asserts, WITHOUT a real parent window:
 *   1. the Settings section renders a "Clone" button, DISABLED with an inline reason while object storage is
 *      still being set up (`objectOpsAvailable` false) — no doomed control;
 *   2. clicking opens the dialog, which PREFILLS the new name as `{src}-copy` + validates it;
 *   3. submit calls the bridge with `{ bucket, name }`, toasts an HONEST success ("copied N object(s)"),
 *      and closes;
 *   4. a TRUNCATED clone surfaces an HONEST "copied N of M (capped)" WARNING (never implies a full clone);
 *   5. a 409 name-collision keeps the dialog open with an inline error (pick another name);
 *   6. a `needsCreds` reply is a WARNING toast, not a crash.
 *
 * The bridge helper is mocked (the real one postMessages a parent absent in jsdom). `BucketCloneSection` +
 * `CloneBucketModal` are exported from BucketsPanel for this exact falsifiability (mirrors `BucketExportSection`).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the bridge BEFORE importing the panel (swc hoists vi.mock). ──
const mockClone = vi.fn();
const mockToast = vi.fn();

vi.mock('~/lib/embed/embedded-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/embed/embedded-mode')>();
  return {
    ...actual,
    isEmbedded: true,
    postToastToParent: (...a: unknown[]) => mockToast(...a),
    requestBucketClone: (...a: unknown[]) => mockClone(...a),
  };
});

import { BucketCloneSection, CloneBucketModal } from '~/components/workbench/BucketsPanel';

const BUCKET = { name: 'uploads', isDefault: true } as Parameters<typeof BucketCloneSection>[0]['bucket'];

beforeEach(() => {
  mockClone.mockReset();
  mockToast.mockReset();
});
afterEach(cleanup);

describe('BucketCloneSection — the Settings launchpad (no doomed control)', () => {
  it('renders an enabled "Clone" button when object ops are available', () => {
    render(<BucketCloneSection bucket={BUCKET} objectOpsAvailable onCloned={() => {}} />);
    const btn = screen.getByTestId('buckets-settings-clone') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/clone/i);
    expect(btn.getAttribute('aria-label')).toMatch(/uploads/i);
  });

  it('object ops unavailable → the button is DISABLED with an inline reason (never a click that can only fail)', () => {
    render(<BucketCloneSection bucket={BUCKET} objectOpsAvailable={false} onCloned={() => {}} />);
    const btn = screen.getByTestId('buckets-settings-clone') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const section = btn.closest('section');
    expect(section?.textContent).toMatch(/setting up|set up/i);
  });

  it('clicking the button opens the clone dialog prefilled with {src}-copy', async () => {
    render(<BucketCloneSection bucket={BUCKET} objectOpsAvailable onCloned={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-settings-clone'));
    });
    const input = (await screen.findByTestId('buckets-clone-name')) as HTMLInputElement;
    expect(input.value).toBe('uploads-copy');
  });
});

describe('CloneBucketModal — prefill + validate + submit → bridge', () => {
  it('prefills the name as {src}-copy and enables submit for a valid name', () => {
    render(<CloneBucketModal bucket={BUCKET} onClose={() => {}} onCloned={() => {}} />);
    const input = screen.getByTestId('buckets-clone-name') as HTMLInputElement;
    expect(input.value).toBe('uploads-copy');
    const submit = screen.getByTestId('buckets-clone-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it('an invalid name disables submit (never a doomed request)', () => {
    render(<CloneBucketModal bucket={BUCKET} onClose={() => {}} onCloned={() => {}} />);
    const input = screen.getByTestId('buckets-clone-name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    const submit = screen.getByTestId('buckets-clone-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it('submit → calls requestBucketClone with { bucket, name }, toasts honest success + count, closes', async () => {
    mockClone.mockResolvedValue({
      bucket: { name: 'uploads-copy' },
      copiedCount: 3,
      ok: true,
      totalCount: 3,
      truncated: false,
    });
    const onClose = vi.fn();
    const onCloned = vi.fn();
    render(<CloneBucketModal bucket={BUCKET} onClose={onClose} onCloned={onCloned} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-clone-submit'));
    });

    await waitFor(() => expect(mockClone).toHaveBeenCalledTimes(1));
    expect(mockClone).toHaveBeenCalledWith({ bucket: 'uploads', name: 'uploads-copy' });
    // Honest success toast (count), no truncation warning for a complete clone.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/3 object/i)));
    await waitFor(() => expect(onCloned).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('TRUNCATED clone → still succeeds, but surfaces an HONEST "copied N of M (capped)" WARNING', async () => {
    mockClone.mockResolvedValue({
      bucket: { name: 'uploads-copy' },
      copiedCount: 1000,
      ok: true,
      totalCount: 4096,
      truncated: true,
    });
    render(<CloneBucketModal bucket={BUCKET} onClose={() => {}} onCloned={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-clone-submit'));
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/1000 of 4096/i)));
  });

  it('409 name-collision → dialog STAYS open with an inline error (pick another name); no success toast', async () => {
    mockClone.mockResolvedValue({ conflict: true, ok: false, error: 'A bucket with that name already exists' });
    const onClose = vi.fn();
    render(<CloneBucketModal bucket={BUCKET} onClose={onClose} onCloned={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-clone-submit'));
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already exists/i));
    expect(onClose).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalledWith('success', expect.anything());
  });

  it('needsCreds reply → a WARNING toast, not a crash; dialog can stay (no success)', async () => {
    mockClone.mockResolvedValue({ needsCreds: true, ok: false, error: 'Bucket clone needs R2 S3 credentials.' });
    render(<CloneBucketModal bucket={BUCKET} onClose={() => {}} onCloned={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-clone-submit'));
    });
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/credentials/i)));
  });
});
