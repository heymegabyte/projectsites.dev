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
 *   5. Real-time reconcile (per `real-time-data-no-manual-refresh`) — NO manual Reconcile button;
 *      drift auto-reconciles via a DEBOUNCED `onReconcile` call, and a quiet "synced" affordance
 *      stands in for the removed button.
 *   6. Drill-in — when `onOpenKind` is provided, every kind tile is a keyboard-operable button that
 *      opens that kind's per-kind surface (even at zero count, so the dark per-site KV / Durable
 *      Objects / Queues / Connections / Observability surfaces are REACHABLE, not orphaned tiles).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
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

  it('renders NO manual Reconcile button and auto-reconciles drift with a DEBOUNCED onReconcile call', () => {
    vi.useFakeTimers();

    try {
      const onReconcile = vi.fn();
      const drifted: ResourceOverviewEntry[] = [
        entry({ id: '1', resource_kind: 'd1', drift_code: 'binding_mismatch' }),
      ];
      render(<NamespaceSummary resources={drifted} environment="production" onReconcile={onReconcile} />);

      // A manual Reconcile/Refresh button is a DEFECT (per `real-time-data-no-manual-refresh`).
      expect(screen.queryByTestId('ns-reconcile')).toBeNull();
      expect(screen.queryByRole('button', { name: /reconcile|refresh/i })).toBeNull();

      // The reconcile is DEBOUNCED — not fired synchronously on render…
      expect(onReconcile).not.toHaveBeenCalled();

      // …but fires automatically (no click) once the debounce elapses.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(onReconcile).toHaveBeenCalledTimes(1);

      // The SAME persistent drift set does not spam repeat reconcile calls.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(onReconcile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a quiet "synced" affordance instead of a button, and never auto-reconciles a clean inventory', () => {
    vi.useFakeTimers();

    try {
      const onReconcile = vi.fn();
      render(
        <NamespaceSummary
          resources={[entry({ id: '2', resource_kind: 'd1', lifecycle_state: 'connected' })]}
          environment="production"
          onReconcile={onReconcile}
        />,
      );

      // The only freshness signal is a quiet status line — never a clickable control.
      const status = screen.getByTestId('ns-sync-status');
      expect(status).toBeTruthy();
      expect(status.tagName).not.toBe('BUTTON');
      expect(screen.queryByTestId('ns-reconcile')).toBeNull();

      // Nothing drifted → nothing to heal → no reconcile call, ever.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      expect(onReconcile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes every kind tile a keyboard-operable button that drills into that kind when onOpenKind is set', () => {
    const onOpenKind = vi.fn();
    // Only a D1 exists; KV / Durable Objects / Connections / Observability have ZERO resources but MUST
    // still be reachable (their per-kind surfaces are dark-flagged, not absent).
    render(
      <NamespaceSummary
        resources={[entry({ id: '1', resource_kind: 'd1', lifecycle_state: 'connected' })]}
        environment="production"
        onOpenKind={onOpenKind}
      />,
    );

    const tiles = screen.getAllByTestId('ns-kind-tile');
    // Reachability: every non-platform-unsupported kind renders as a real <button> (role=button).
    const kv = tiles.find((t) => t.getAttribute('data-kind') === 'kv') as HTMLElement;
    const durable = tiles.find((t) => t.getAttribute('data-kind') === 'durable_object') as HTMLElement;
    const connection = tiles.find((t) => t.getAttribute('data-kind') === 'connection') as HTMLElement;
    const observability = tiles.find((t) => t.getAttribute('data-kind') === 'observability') as HTMLElement;

    for (const tile of [kv, durable, connection, observability]) {
      expect(tile).toBeTruthy();
      expect(tile.tagName).toBe('BUTTON');
      expect(tile.getAttribute('aria-label')).toBeTruthy();
    }

    // Clicking a zero-count KV tile opens the KV per-kind surface with an `available` (provisionable) hint.
    fireEvent.click(kv);
    expect(onOpenKind).toHaveBeenCalledTimes(1);
    expect(onOpenKind).toHaveBeenCalledWith(expect.objectContaining({ kind: 'kv', availability: 'available' }));

    // A connected kind opens with a `connected` hint (leads with read, not provision).
    onOpenKind.mockClear();
    const d1 = tiles.find((t) => t.getAttribute('data-kind') === 'd1') as HTMLElement;
    fireEvent.click(d1);
    expect(onOpenKind).toHaveBeenCalledWith(expect.objectContaining({ kind: 'd1', availability: 'connected' }));
  });

  it('does NOT make a platform-unsupported (Queues, no binding) tile an actionable button', () => {
    const onOpenKind = vi.fn();
    render(
      <NamespaceSummary
        resources={[entry({ id: '1', resource_kind: 'd1' })]}
        environment="production"
        onOpenKind={onOpenKind}
      />,
    );

    const tiles = screen.getAllByTestId('ns-kind-tile');
    const queue = tiles.find((t) => t.getAttribute('data-kind') === 'queue') as HTMLElement;
    // Never a doomed control: an unsupported kind is a non-button tile (no click, honest "Not available").
    expect(queue.tagName).not.toBe('BUTTON');
    expect(within(queue).getByText('Not available')).toBeTruthy();
  });

  it('stays presentational (no buttons) when onOpenKind is omitted — backward compatible', () => {
    render(<NamespaceSummary resources={[entry({ id: '1', resource_kind: 'd1' })]} environment="production" />);
    const tiles = screen.getAllByTestId('ns-kind-tile');
    // Without a handler, tiles are plain divs (the original presentational behavior).
    expect(tiles.every((t) => t.tagName !== 'BUTTON')).toBe(true);
  });
});
