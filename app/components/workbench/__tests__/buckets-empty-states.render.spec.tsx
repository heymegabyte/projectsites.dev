// @vitest-environment jsdom
/**
 * @file Resources › Buckets — DOM-render proof for the two launchpad empty states
 *       and the "upload needs R2 creds" doomed-control guard (fire-141, Resources EPIC).
 *
 * Context: `BucketsPanel` is the LAST Resources tab (Media✓ / Automations✓ / Files✓ done).
 * The panel is ~2000 lines and talks to the parent admin over a postMessage bridge
 * (`requestR2`/`requestBucketUpload`), so mounting it whole in jsdom is not falsifiable.
 * Mirroring the DONE Media pattern (`MediaPageStats` extracted from `ResourcesPanel` + a
 * `*.render.spec.tsx`), the two purely-presentational launchpad empty states — `BucketsEmpty`
 * (bucket list) and `ObjectsEmpty` (object list) — are exported so this logic is provable
 * without the bridge:
 *
 *   1. `BucketsEmpty` renders the `buckets-empty` launchpad with a WIRED "create first bucket"
 *      action (per `embarrassingly-easy-to-use` — an empty state is a launchpad, never a wall).
 *   2. `ObjectsEmpty` with creds renders the `buckets-objects-empty` launchpad WITH a wired
 *      upload action, and clicking it calls the real handler (NOT a no-op stub).
 *   3. `ObjectsEmpty` WITHOUT creds shows NO upload action — per
 *      `action-button-must-gate-on-server-precondition`, a control that would fail its
 *      precondition is hidden, never a doomed/dead button.
 *   4. The filter-empty variant ("No matching objects") shows NO upload action either.
 *
 * ASSERT 0 stubbed ops: every rendered primary action carries a real onClick that fires.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BucketsEmpty, ObjectsEmpty } from '../BucketsPanel';

afterEach(cleanup);

// ─── Bucket-list empty — the "create your first bucket" launchpad ─────────────

describe('BucketsEmpty — bucket-list launchpad', () => {
  it('renders the buckets-empty launchpad', () => {
    render(<BucketsEmpty onCreate={() => {}} />);

    const empty = screen.getByTestId('buckets-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('No buckets yet');
  });

  it('wires the create-first-bucket action to a real handler (not a no-op)', () => {
    const onCreate = vi.fn();
    render(<BucketsEmpty onCreate={onCreate} />);

    const btn = screen.getByTestId('buckets-empty-create');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── Object-list empty WITH creds — the "upload a file" launchpad ─────────────

describe('ObjectsEmpty — object-list launchpad (creds available)', () => {
  it('renders the buckets-objects-empty launchpad', () => {
    render(<ObjectsEmpty hasFilter={false} uploading={false} onUpload={() => {}} objectOpsAvailable={true} />);

    const empty = screen.getByTestId('buckets-objects-empty');
    expect(empty).toBeTruthy();
    expect(empty.textContent).toContain('This bucket is empty');
  });

  it('wires the upload action to a real handler (not a no-op)', () => {
    const onUpload = vi.fn();
    render(<ObjectsEmpty hasFilter={false} uploading={false} onUpload={onUpload} objectOpsAvailable={true} />);

    const btn = screen.getByTestId('buckets-objects-empty-upload');
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onUpload).toHaveBeenCalledTimes(1);
  });
});

// ─── Object-list empty WITHOUT creds — doomed control is HIDDEN, not dead ─────

describe('ObjectsEmpty — object-list launchpad (creds missing)', () => {
  it('hides the upload action when object ops are unavailable (no doomed control)', () => {
    render(<ObjectsEmpty hasFilter={false} uploading={false} onUpload={() => {}} objectOpsAvailable={false} />);

    // The empty state still renders...
    expect(screen.getByTestId('buckets-objects-empty')).toBeTruthy();
    // ...but the upload button that would fail its precondition is absent.
    expect(screen.queryByTestId('buckets-objects-empty-upload')).toBeNull();
  });
});

// ─── Filter-empty variant — "No matching objects", no upload action ───────────

describe('ObjectsEmpty — filtered to zero results', () => {
  it('shows the "no matching objects" copy and no upload action', () => {
    render(<ObjectsEmpty hasFilter={true} uploading={false} onUpload={() => {}} objectOpsAvailable={true} />);

    const empty = screen.getByTestId('buckets-objects-empty');
    expect(empty.textContent).toContain('No matching objects');
    expect(screen.queryByTestId('buckets-objects-empty-upload')).toBeNull();
  });
});
