// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Object browser — B11 server-side WHOLE-BUCKET search.
 *
 * Context: the object browser's search box previously filtered ONLY the already-loaded page
 * (`listObjects` returns one page), so a bucket with thousands of objects across pages could not be
 * searched. B11 makes the search box issue a DEBOUNCED SERVER search (`requestR2({op:'listObjects',
 * search})`) that scans the whole bucket, while keeping instant client filtering of loaded rows for
 * responsiveness. This asserts, by mounting the real `ObjectBrowser` with a mocked bridge:
 *
 *   1. typing in the search box issues a SERVER `listObjects` with the `search` term (debounced — one
 *      request after the user stops typing, not one per keystroke);
 *   2. the rendered rows are the SERVER's whole-bucket matches (incl. keys never on the loaded page);
 *   3. an HONEST truncation note renders when the server reports `scannedAll:false` / `truncated:true`
 *      ("scanned up to N" / "showing N of all matches") — the UI never over-claims completeness;
 *   4. a server search that matches nothing renders the "No matching objects" empty state;
 *   5. clearing the search returns to the plain (non-search) listing.
 *
 * The bridge is mocked (the real `requestR2` postMessages a parent absent in jsdom). Fake timers drive
 * the debounce deterministically.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestR2 } = vi.hoisted(() => ({ requestR2: vi.fn() }));

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToastToParent: vi.fn(),
  requestBucketDownload: vi.fn(),
  requestBucketOwnerKeyCreate: vi.fn(),
  requestBucketOwnerKeyRevoke: vi.fn(),
  requestBucketOwnerKeyRotate: vi.fn(),
  requestBucketOwnerKeyStatus: vi.fn(),
  requestBucketUpload: vi.fn(),
  requestOwnerKeyCreate: vi.fn(),
  requestOwnerKeyRevoke: vi.fn(),
  requestOwnerKeyRotate: vi.fn(),
  requestOwnerKeyStatus: vi.fn(),
  requestR2,
  requestR2Copy: vi.fn(),
}));

import { ObjectBrowser } from '~/components/workbench/BucketsPanel';

const bucket = {
  name: 'uploads',
  environment: 'preview' as const,
  isDefault: true,
  public: false,
  createdAt: '2026-09-27T00:00:00.000Z',
} as never;

/** A plain (non-search) listObjects reply. */
const listReply = (keys: string[]) => ({
  ok: true,
  op: 'listObjects',
  objects: keys.map((key) => ({ key, size: 10, uploadedAt: '2026-10-10T00:00:00Z' })),
  prefixes: [],
  truncated: false,
});

function renderBrowser() {
  return render(<ObjectBrowser bucket={bucket} objectOpsAvailable onCopyBucketAddress={() => {}} />);
}

/**
 * Flush the debounce timer + the chain of promise microtasks the async `requestR2` resolution schedules.
 * With fake timers, `@testing-library`'s `waitFor`/`findBy*` helpers hang (their polling clock is frozen),
 * so we advance deterministically and settle microtasks, then assert synchronously.
 */
async function flush(ms = 400) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  // Several awaits deep (requestR2 promise → setState → effect) — settle a handful of microtask turns.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  requestR2.mockReset();
  // The initial mount load (no search) returns a small loaded page.
  requestR2.mockResolvedValue(listReply(['images/hero.jpg', 'docs/readme.md']));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('ObjectBrowser — B11 whole-bucket server search', () => {
  it('typing issues a DEBOUNCED server listObjects carrying the search term (not one call per keystroke)', async () => {
    renderBrowser();
    await flush(0); // initial (no-search) load settles

    const initialCalls = requestR2.mock.calls.length;

    // The server search reply contains a key that was NOT on the loaded page.
    requestR2.mockResolvedValue({
      ok: true,
      op: 'listObjects',
      objects: [{ key: 'deep/nested/logo-final.png', size: 20, uploadedAt: '2026-10-10T00:00:00Z' }],
      prefixes: [],
      scannedAll: true,
      scanned: 1234,
      truncated: false,
    });

    const input = screen.getByTestId('buckets-object-search') as HTMLInputElement;
    // Three quick keystrokes — the debounce must coalesce them into ONE server search.
    fireEvent.change(input, { target: { value: 'l' } });
    fireEvent.change(input, { target: { value: 'lo' } });
    fireEvent.change(input, { target: { value: 'logo' } });

    await flush(400);

    const searchCalls = requestR2.mock.calls
      .slice(initialCalls)
      .filter(
        (c) => (c[0] as { op?: string; search?: string }).op === 'listObjects' && (c[0] as { search?: string }).search,
      );
    expect(searchCalls).toHaveLength(1); // debounced → exactly one server search
    expect((searchCalls[0]![0] as { search?: string }).search).toBe('logo');

    // The whole-bucket match (a key that was NEVER on the loaded page) renders with its FULL path, so the
    // user sees WHERE in the bucket the match lives (search is flat — no current-folder prefix to strip).
    expect(screen.getByText('deep/nested/logo-final.png')).toBeTruthy();
  });

  it('renders an HONEST note when the server did not scan the whole bucket (scannedAll:false)', async () => {
    renderBrowser();
    await flush(0);

    requestR2.mockResolvedValue({
      ok: true,
      op: 'listObjects',
      objects: [{ key: 'a/logo.png', size: 5, uploadedAt: null }],
      prefixes: [],
      scannedAll: false, // the scan stopped short of the bucket's end
      scanned: 20000,
      truncated: true, // more matches than the cap
    });

    fireEvent.change(screen.getByTestId('buckets-object-search'), { target: { value: 'logo' } });
    await flush(400);

    const note = screen.getByTestId('buckets-search-truncated');
    // The note must be HONEST: it names the scan ceiling, never claims "all".
    expect(note.textContent?.toLowerCase()).toMatch(/scanned|showing|matches/);
    expect(note.textContent).toContain('20,000');
  });

  it('a server search that matches nothing renders the "No matching objects" empty state', async () => {
    renderBrowser();
    await flush(0);

    requestR2.mockResolvedValue({
      ok: true,
      op: 'listObjects',
      objects: [],
      prefixes: [],
      scannedAll: true,
      scanned: 500,
      truncated: false,
    });

    fireEvent.change(screen.getByTestId('buckets-object-search'), { target: { value: 'zzznope' } });
    await flush(400);

    expect(screen.getByText('No matching objects')).toBeTruthy();
  });

  it('clearing the search returns to the plain (non-search) listing', async () => {
    renderBrowser();
    await flush(0);

    requestR2.mockResolvedValue({
      ok: true,
      op: 'listObjects',
      objects: [],
      prefixes: [],
      scannedAll: true,
      scanned: 0,
      truncated: false,
    });
    fireEvent.change(screen.getByTestId('buckets-object-search'), { target: { value: 'logo' } });
    await flush(400);

    // Clearing should re-issue a listObjects WITHOUT a search term (back to the folder listing).
    requestR2.mockResolvedValue(listReply(['images/hero.jpg']));
    const callsBeforeClear = requestR2.mock.calls.length;
    fireEvent.change(screen.getByTestId('buckets-object-search'), { target: { value: '' } });
    await flush(400);

    const afterClear = requestR2.mock.calls
      .slice(callsBeforeClear)
      .map((c) => c[0] as { op?: string; search?: string });
    const plainList = afterClear.find((m) => m.op === 'listObjects' && !m.search);
    expect(plainList).toBeTruthy();
  });
});
