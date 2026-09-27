// @vitest-environment jsdom
/**
 * NamespaceSummary.spec.tsx — spec for the Resources tab's per-site WfP-namespace rollup.
 *
 * The summary is PURE + presentational: it derives the whole accounting from the inventory the
 * Resources tab already loaded (no bridge, no fetch), so these tests just render it with fixture
 * `ResourceOverviewEntry[]` and assert the rollup is honest.
 *
 * Covers:
 *   1. Headline accounting — total / connected / drift reflect the inventory.
 *   2. Complete per-kind breakdown — every canonical kind renders a tile (accounting is complete, not
 *      just what exists), with correct counts bucketed by `resource_kind`.
 *   3. Honest "not available" — a kind CF can't expose (Queues, no binding) with zero resources shows
 *      the unsupported treatment, never a fake count.
 *   4. Namespace label — derived from a WfP/function entry when present, else an honest fallback (never
 *      a fabricated name).
 *   5. Reconcile nudge — appears only when there's drift or available-to-add, and calls back.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import React from 'react';
import { NamespaceSummary } from './NamespaceSummary';
import type { ResourceOverviewEntry } from '~/lib/embed/embedded-mode';

afterEach(() => cleanup());

/** Build a minimal inventory entry (only the fields the summary reads). */
function entry(partial: Partial<ResourceOverviewEntry> & { id: string; resource_kind: string }): ResourceOverviewEntry {
  return {
    resource_concept: '',
    environment: 'production',
    tenancy: 'dedicated',
    lifecycle_state: 'connected',
    ...partial,
  } as ResourceOverviewEntry;
}

describe('NamespaceSummary', () => {
  it('renders headline accounting from the inventory (total / connected / drift)', () => {
    const resources: ResourceOverviewEntry[] = [
      entry({ id: '1', resource_kind: 'd1', lifecycle_state: 'connected' }),
      entry({ id: '2', resource_kind: 'kv', lifecycle_state: 'connected' }),
      entry({ id: '3', resource_kind: 'r2', lifecycle_state: 'available' }),
      entry({ id: '4', resource_kind: 'workflow', lifecycle_state: 'connected', drift_code: 'binding_mismatch' }),
    ];

    render(<NamespaceSummary resources={resources} environment="production" />);

    // Total resources = 4, connected = 3, drifted = 1.
    expect(within(screen.getByTestId('ns-stat-total')).getByText('4')).toBeTruthy();
    expect(within(screen.getByTestId('ns-stat-connected')).getByText('3')).toBeTruthy();
    expect(within(screen.getByTestId('ns-stat-drift')).getByText('1')).toBeTruthy();
  });

  it('accounts for EVERY canonical kind (complete breakdown), with correct per-kind counts', () => {
    const resources: ResourceOverviewEntry[] = [
      entry({ id: '1', resource_kind: 'd1', lifecycle_state: 'connected' }),
      entry({ id: '2', resource_kind: 'd1', lifecycle_state: 'connected' }),
      entry({ id: '3', resource_kind: 'kv', lifecycle_state: 'connected' }),
    ];

    render(<NamespaceSummary resources={resources} environment="production" />);

    const tiles = screen.getAllByTestId('ns-kind-tile');
    // At least the 10 canonical kinds always render — accounting is complete, not just what exists.
    expect(tiles.length).toBeGreaterThanOrEqual(10);

    const d1 = tiles.find((t) => t.getAttribute('data-kind') === 'd1');
    const kv = tiles.find((t) => t.getAttribute('data-kind') === 'kv');
    const r2 = tiles.find((t) => t.getAttribute('data-kind') === 'r2');
    expect(d1?.getAttribute('data-count')).toBe('2');
    expect(kv?.getAttribute('data-count')).toBe('1');
    // A kind with nothing still renders, at zero.
    expect(r2?.getAttribute('data-count')).toBe('0');
  });

  it('shows an honest "Not available" for a platform-unsupported kind with zero resources', () => {
    // No queue binding on this deployment → the Queues tile is unsupported, never a fake count.
    render(<NamespaceSummary resources={[entry({ id: '1', resource_kind: 'd1' })]} environment="production" />);

    const tiles = screen.getAllByTestId('ns-kind-tile');
    const queue = tiles.find((t) => t.getAttribute('data-kind') === 'queue');
    expect(queue).toBeTruthy();
    expect(queue?.getAttribute('data-count')).toBe('0');
    expect(within(queue as HTMLElement).getByText('Not available')).toBeTruthy();
  });

  it('derives the namespace label from a WfP/function entry, else an honest fallback', () => {
    const withWfp: ResourceOverviewEntry[] = [
      entry({ id: '1', resource_kind: 'wfp_function', resource_concept: 'project-sites-endpoints' }),
    ];
    const { rerender } = render(<NamespaceSummary resources={withWfp} environment="production" />);
    expect(screen.getByText('project-sites-endpoints')).toBeTruthy();

    // No WfP entry → an honest "resolved server-side" label, never a fabricated name.
    rerender(<NamespaceSummary resources={[entry({ id: '2', resource_kind: 'd1' })]} environment="production" />);
    expect(screen.getByText(/resolved server-side/i)).toBeTruthy();
  });

  it('shows the reconcile nudge only when there is drift or available-to-add, and calls back', () => {
    const onReconcile = vi.fn();
    const drifted: ResourceOverviewEntry[] = [
      entry({ id: '1', resource_kind: 'd1', drift_code: 'binding_mismatch' }),
    ];
    const { rerender } = render(
      <NamespaceSummary resources={drifted} environment="production" onReconcile={onReconcile} />,
    );

    const btn = screen.getByTestId('ns-reconcile');
    fireEvent.click(btn);
    expect(onReconcile).toHaveBeenCalledTimes(1);

    // All-connected, nothing to heal → no nudge.
    rerender(
      <NamespaceSummary
        resources={[entry({ id: '2', resource_kind: 'd1', lifecycle_state: 'connected' })]}
        environment="production"
        onReconcile={onReconcile}
      />,
    );
    expect(screen.queryByTestId('ns-reconcile')).toBeNull();
  });
});
