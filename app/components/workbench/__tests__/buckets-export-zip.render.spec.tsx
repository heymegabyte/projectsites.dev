// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Settings — DOM-render proof for the "Download as ZIP" export (B7).
 *
 * Context: `BucketSettings` gains a self-contained `BucketExportSection` that downloads the WHOLE bucket as
 * one `.zip`. It drives the `requestBucketZip` bridge helper (admin GETs `application/zip` + forwards the
 * honest `x-ps-zip-*` truncation accounting → `PS_R2_ZIP_RESULT`). The section:
 *   1. on click, calls the bridge with the bucket name, then triggers a browser download from the returned
 *      base64 data URL via a temporary anchor (the SAME mechanism the single-object download uses),
 *   2. surfaces an HONEST "capped at N of M files" WARNING when the worker reports `truncated` (never
 *      implies the archive is complete),
 *   3. is DISABLED with an inline explanation while object storage is still being set up
 *      (`objectOpsAvailable` false) — no doomed control,
 *   4. toasts a WARNING (not a crash) on a `needsCreds` reply.
 *
 * The bridge helper is mocked (the real one postMessages to a parent absent in jsdom). `BucketExportSection`
 * is exported from BucketsPanel for this exact falsifiability (mirrors `OwnerKeySection`).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the bridge BEFORE importing the panel (swc hoists vi.mock). ──
const mockZip = vi.fn();
const mockToast = vi.fn();

vi.mock('~/lib/embed/embedded-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/embed/embedded-mode')>();
  return {
    ...actual,
    isEmbedded: true,
    postToastToParent: (...a: unknown[]) => mockToast(...a),
    requestBucketZip: (...a: unknown[]) => mockZip(...a),
  };
});

import { BucketExportSection } from '~/components/workbench/BucketsPanel';

const BUCKET = { name: 'uploads', isDefault: true } as Parameters<typeof BucketExportSection>[0]['bucket'];

/** Spy on anchor clicks so we can assert a download was triggered (jsdom has no real navigation). */
let anchorClicks: Array<{ href: string; download: string }>;
function installAnchorSpy(): void {
  anchorClicks = [];
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = realCreate(tag) as HTMLElement;
    if (tag === 'a') {
      (el as HTMLAnchorElement).click = () =>
        anchorClicks.push({ download: (el as HTMLAnchorElement).download, href: (el as HTMLAnchorElement).href });
    }
    return el;
  });
}

beforeEach(() => {
  mockZip.mockReset();
  mockToast.mockReset();
  installAnchorSpy();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('BucketExportSection — triggers the bridge + browser download', () => {
  it('renders an enabled "Download .zip" button when object ops are available', () => {
    render(<BucketExportSection bucket={BUCKET} objectOpsAvailable />);
    const btn = screen.getByTestId('buckets-settings-zip') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toMatch(/zip/i);
    expect(btn.getAttribute('aria-label')).toMatch(/uploads/i);
  });

  it('click → calls requestBucketZip with the bucket, then downloads the returned data URL', async () => {
    mockZip.mockResolvedValue({
      bytesIncluded: 2048,
      dataUrl: 'data:application/zip;base64,UEsFBgAA',
      filename: 'uploads.zip',
      includedCount: 3,
      ok: true,
      totalCount: 3,
      truncated: false,
    });

    render(<BucketExportSection bucket={BUCKET} objectOpsAvailable />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-settings-zip'));
    });

    await waitFor(() => expect(mockZip).toHaveBeenCalledTimes(1));
    expect(mockZip).toHaveBeenCalledWith({ bucket: 'uploads' });

    // A browser download was triggered with the server's suggested filename + the returned data URL.
    await waitFor(() => expect(anchorClicks.length).toBe(1));
    expect(anchorClicks[0]!.download).toBe('uploads.zip');
    expect(anchorClicks[0]!.href).toBe('data:application/zip;base64,UEsFBgAA');

    // Honest success toast (count + size), never a truncation warning for a complete archive.
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/3 files/i)));
  });

  it('truncated export → still downloads, but surfaces an HONEST "first N of M" WARNING', async () => {
    mockZip.mockResolvedValue({
      bytesIncluded: 100 * 1024 * 1024,
      dataUrl: 'data:application/zip;base64,UEsFBgAA',
      filename: 'uploads.zip',
      includedCount: 1000,
      ok: true,
      totalCount: 4096,
      truncated: true,
    });

    render(<BucketExportSection bucket={BUCKET} objectOpsAvailable />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-settings-zip'));
    });

    await waitFor(() => expect(anchorClicks.length).toBe(1)); // the partial archive still downloads
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/first 1000 of 4096 files/i)),
    );
  });

  it('empty bucket → downloads an empty archive with an honest "empty" note', async () => {
    mockZip.mockResolvedValue({
      bytesIncluded: 0,
      dataUrl: 'data:application/zip;base64,UEsFBgAA',
      filename: 'uploads.zip',
      includedCount: 0,
      ok: true,
      totalCount: 0,
      truncated: false,
    });

    render(<BucketExportSection bucket={BUCKET} objectOpsAvailable />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-settings-zip'));
    });

    await waitFor(() => expect(anchorClicks.length).toBe(1));
    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('success', expect.stringMatching(/empty/i)));
  });
});

describe('BucketExportSection — no doomed control + honest failure', () => {
  it('object ops unavailable → the button is DISABLED (never a click that can only fail)', () => {
    render(<BucketExportSection bucket={BUCKET} objectOpsAvailable={false} />);
    const btn = screen.getByTestId('buckets-settings-zip') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // Inline explanation, never a dead control with no reason (the hint lives in the enclosing section).
    const section = btn.closest('section');
    expect(section?.textContent).toMatch(/setting up|set up/i);
  });

  it('needsCreds reply → a WARNING toast, not a crash; no download', async () => {
    mockZip.mockResolvedValue({ ok: false, needsCreds: true, error: 'Bucket export needs R2 S3 credentials.' });

    render(<BucketExportSection bucket={BUCKET} objectOpsAvailable />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('buckets-settings-zip'));
    });

    await waitFor(() => expect(mockToast).toHaveBeenCalledWith('warning', expect.stringMatching(/credentials/i)));
    expect(anchorClicks.length).toBe(0); // nothing downloaded on failure
  });
});
