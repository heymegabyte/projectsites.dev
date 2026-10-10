// @vitest-environment jsdom
/**
 * @file Resources › Buckets › Bulk-action bar + keyboard multi-select (B3) — DOM-render proof.
 *
 * Mounts the real {@link ObjectBrowser} (with the object-list bridge `requestR2` mocked to return a
 * page of objects) and drives the SELECTION layer the way a user does:
 *
 *   • Selecting ≥1 object reveals the compact bulk-action bar (`buckets-bulk-bar`) with a live count,
 *     a Download action, a Delete action, and a Clear — and Clear empties the selection (bar hides).
 *   • `Cmd/Ctrl+A` selects every loaded object (bar reads "N selected").
 *   • `Shift+click` extends selection across the inclusive range from the last click.
 *   • `Escape` clears the whole selection.
 *   • The bulk bar's entrance is motion-safe with a reduced-motion opt-out (WCAG 2.3.3) and reads as
 *     a `role="toolbar"`.
 *
 * The bridge helpers are mocked (the real ones postMessage a parent absent in jsdom), mirroring the
 * sibling `buckets-object-preview.render.spec.tsx`.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the bridge BEFORE importing the panel (swc hoists vi.mock). ──
const mockR2 = vi.fn();
const mockR2Copy = vi.fn();

vi.mock('~/lib/embed/embedded-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/embed/embedded-mode')>();
  return {
    ...actual,
    isEmbedded: true,
    postToastToParent: vi.fn(),
    requestR2: (...a: unknown[]) => mockR2(...a),
    requestR2Copy: (...a: unknown[]) => mockR2Copy(...a),
    requestBucketDownload: vi.fn(async () => ({ ok: false })),
    requestBucketUpload: vi.fn(async () => ({ ok: false })),
  };
});

import { ObjectBrowser } from '~/components/workbench/BucketsPanel';
import type { BucketEntry } from '~/lib/embed/embedded-mode';

const BUCKET: BucketEntry = { name: 'site-assets', isDefault: true, public: false };

const OBJECTS = [
  { key: 'a.txt', size: 10, uploadedAt: null },
  { key: 'b.png', size: 20, uploadedAt: null },
  { key: 'c.pdf', size: 30, uploadedAt: null },
  { key: 'd.mp4', size: 40, uploadedAt: null },
];

beforeEach(() => {
  mockR2.mockReset();
  mockR2Copy.mockReset();
  // Every listObjects → one full page of objects, no folders, not truncated.
  mockR2.mockResolvedValue({ ok: true, objects: OBJECTS, prefixes: [], truncated: false, cursor: undefined });
  mockR2Copy.mockResolvedValue({ ok: true, destKey: 'renamed.txt' });
});

afterEach(cleanup);

/** Mount the browser and wait for the object list to render. */
async function mountBrowser() {
  await act(async () => {
    render(<ObjectBrowser bucket={BUCKET} objectOpsAvailable onCopyBucketAddress={() => {}} />);
  });
  await waitFor(() => expect(screen.getByTestId('buckets-object-list')).toBeTruthy());
}

/** The list-row checkboxes, in render order (skips the header select-all + sets up stable indexing). */
function rowCheckboxes(): HTMLInputElement[] {
  return screen
    .getAllByTestId('buckets-object-row')
    .map((row) => row.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
    .filter(Boolean);
}

describe('Bulk-action bar — appears with a selection, actions present, Clear empties', () => {
  it('is hidden with no selection, appears on first select with a live count + Download/Delete', async () => {
    await mountBrowser();

    expect(screen.queryByTestId('buckets-bulk-bar')).toBeNull();

    fireEvent.click(rowCheckboxes()[0]);

    const bar = await screen.findByTestId('buckets-bulk-bar');
    expect(bar.textContent).toContain('1 selected');
    expect(screen.getByTestId('buckets-bulk-download')).toBeTruthy();
    expect(screen.getByTestId('buckets-bulk-delete')).toBeTruthy();
    expect(screen.getByTestId('buckets-bulk-clear')).toBeTruthy();
  });

  it('is a role="toolbar" and rises in motion-safe with a reduced-motion opt-out (WCAG 2.3.3)', async () => {
    await mountBrowser();
    fireEvent.click(rowCheckboxes()[0]);

    const bar = await screen.findByTestId('buckets-bulk-bar');
    expect(bar.getAttribute('role')).toBe('toolbar');
    expect(bar.className).toContain('motion-safe:animate-[psBucketRise');
    expect(bar.className).toContain('motion-reduce:animate-none');
  });

  it('Clear empties the selection and hides the bar', async () => {
    await mountBrowser();
    fireEvent.click(rowCheckboxes()[0]);
    await screen.findByTestId('buckets-bulk-bar');

    fireEvent.click(screen.getByTestId('buckets-bulk-clear'));
    await waitFor(() => expect(screen.queryByTestId('buckets-bulk-bar')).toBeNull());
  });
});

describe('Keyboard multi-select — Cmd/Ctrl+A, Shift-range, Escape', () => {
  it('Cmd/Ctrl+A selects every loaded object', async () => {
    await mountBrowser();

    fireEvent.keyDown(screen.getByTestId('buckets-object-list'), { key: 'a', ctrlKey: true });

    const bar = await screen.findByTestId('buckets-bulk-bar');
    expect(bar.textContent).toContain(`${OBJECTS.length} selected`);
    // Every row checkbox is now checked.
    expect(rowCheckboxes().every((c) => c.checked)).toBe(true);
  });

  it('does NOT hijack select-all while typing in the Filter input', async () => {
    await mountBrowser();

    const filter = screen.getByTestId('buckets-object-search');
    fireEvent.keyDown(filter, { key: 'a', ctrlKey: true });

    // No selection → no bar.
    expect(screen.queryByTestId('buckets-bulk-bar')).toBeNull();
  });

  it('Shift+click extends selection across the inclusive range from the last click', async () => {
    await mountBrowser();

    // Query by stable aria-label (survives re-render) rather than a stale positional snapshot.
    const box = (label: string) => screen.getByLabelText(`Select ${label}`) as HTMLInputElement;

    // Click row 0 (anchor), then Shift+click row 2 → the inclusive range a.txt…c.pdf is selected.
    // Shift is captured at mousedown (modifier keys aren't on `change`), so simulate both phases.
    fireEvent.mouseDown(box('a.txt'));
    fireEvent.click(box('a.txt'));
    fireEvent.mouseDown(box('c.pdf'), { shiftKey: true });
    fireEvent.click(box('c.pdf'));

    const bar = await screen.findByTestId('buckets-bulk-bar');
    expect(bar.textContent).toContain('3 selected');

    await waitFor(() => {
      expect(box('a.txt').checked).toBe(true);
      expect(box('b.png').checked).toBe(true);
      expect(box('c.pdf').checked).toBe(true);
      expect(box('d.mp4').checked).toBe(false);
    });
  });

  it('Escape clears the entire selection', async () => {
    await mountBrowser();
    fireEvent.keyDown(screen.getByTestId('buckets-object-list'), { key: 'a', ctrlKey: true });
    await screen.findByTestId('buckets-bulk-bar');

    fireEvent.keyDown(screen.getByTestId('buckets-object-list'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('buckets-bulk-bar')).toBeNull());
  });
});

// ── B8 — copy/move/rename wired end-to-end through the real ObjectBrowser ──────

describe('Object rename/copy/move (B8) — context menu → dialog → bridge → close + reload', () => {
  /** Open a row's context menu + click one of the B8 items. */
  async function openOp(rowLabel: string, itemTestId: string) {
    const row = screen.getAllByTestId('buckets-object-row').find((r) => r.textContent?.includes(rowLabel))!;
    fireEvent.contextMenu(row);
    await screen.findByTestId('buckets-object-context-menu');
    fireEvent.click(screen.getByTestId(itemTestId));
    await screen.findByTestId('buckets-object-op-modal');
  }

  it('Rename → submits the derived destKey + deleteSource:true, closes the dialog, reloads the list', async () => {
    await mountBrowser();
    expect(mockR2).toHaveBeenCalledTimes(1); // initial list

    await openOp('a.txt', 'buckets-object-context-rename');
    const input = screen.getByTestId('buckets-object-op-input') as HTMLInputElement;
    expect(input.value).toBe('a.txt'); // prefilled with the current name
    fireEvent.change(input, { target: { value: 'renamed.txt' } });
    fireEvent.click(screen.getByTestId('buckets-object-op-submit'));

    await waitFor(() =>
      expect(mockR2Copy).toHaveBeenCalledWith({
        bucket: 'site-assets',
        deleteSource: true,
        destKey: 'renamed.txt',
        srcKey: 'a.txt',
      }),
    );
    // On success the parent unmounts the dialog + reloads the object list (a second listObjects).
    await waitFor(() => expect(screen.queryByTestId('buckets-object-op-modal')).toBeNull());
    await waitFor(() => expect(mockR2.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('Copy → submits deleteSource:false (source kept)', async () => {
    mockR2Copy.mockResolvedValue({ ok: true, destKey: 'a-copy.txt' });
    await mountBrowser();

    await openOp('a.txt', 'buckets-object-context-duplicate');
    fireEvent.change(screen.getByTestId('buckets-object-op-input'), { target: { value: 'a-copy.txt' } });
    fireEvent.click(screen.getByTestId('buckets-object-op-submit'));

    await waitFor(() =>
      expect(mockR2Copy).toHaveBeenCalledWith({
        bucket: 'site-assets',
        deleteSource: false,
        destKey: 'a-copy.txt',
        srcKey: 'a.txt',
      }),
    );
  });

  it('a server-side conflict keeps the dialog OPEN (no data loss, owner retries)', async () => {
    mockR2Copy.mockResolvedValue({ ok: false, conflict: true });
    await mountBrowser();

    await openOp('a.txt', 'buckets-object-context-rename');
    // A name NOT in the loaded list (so the client guard passes) that the SERVER rejects (a race).
    fireEvent.change(screen.getByTestId('buckets-object-op-input'), { target: { value: 'unique.png' } });
    fireEvent.click(screen.getByTestId('buckets-object-op-submit'));

    await waitFor(() => expect(mockR2Copy).toHaveBeenCalled());
    // Dialog stays mounted with an inline error.
    await waitFor(() => expect(screen.getByTestId('buckets-object-op-error').textContent).toMatch(/already exists/i));
    expect(screen.getByTestId('buckets-object-op-modal')).toBeTruthy();
  });
});
