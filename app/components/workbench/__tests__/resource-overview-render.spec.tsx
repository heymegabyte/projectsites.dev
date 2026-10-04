// @vitest-environment jsdom
/**
 * @file Resources › Overview — render proof (RES-OVERVIEW-RENDER, fire-142; Resources EPIC cross-cut).
 *
 * The sibling `ResourceOverviewPanel.spec.tsx` proves the BRIDGE wiring (mount → request, env selector,
 * self-updating poll). This spec proves the panel RENDERS its honest states into the DOM:
 *
 *   1. READY → the per-kind inventory GROUPS render (not just a concept string) — a business owner sees
 *      their resources organized by kind × environment (`resources-groups` + a `resources-group` per kind).
 *   2. `enabled:false` (dark flag) → the FRIENDLY disabled card renders with reassuring copy
 *      ("isn't enabled yet" + "nothing to set up") — never a scary error, never a mock control.
 *   3. NO manual Refresh/Reconcile button anywhere (per `real-time-data-no-manual-refresh`) — the only
 *      freshness affordance is the subtle live "Updated … ago" chip.
 *   4. EMPTY (ready, zero resources) → the empty-state LAUNCHPAD renders (self-detecting, no button).
 *
 * The bridge is mocked (no real iframe); the detail drill-in is stubbed so this stays about the overview.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor, fireEvent, within } from '@testing-library/react';
import React from 'react';

// ─── Hoisted bridge spies + a controllable message bus ──────────────────────────
const { postToParent, handlers, lastRequest } = vi.hoisted(() => {
  const handlers: Array<(msg: unknown) => void> = [];
  const lastRequest: { value: Record<string, unknown> | null } = { value: null };
  const postToParent = vi.fn((message: Record<string, unknown>) => {
    lastRequest.value = message;
  });

  return { postToParent, handlers, lastRequest };
});

/** Deliver a parent→child reply to every registered listener (mirrors the real bridge fan-out). */
function emitToChild(message: Record<string, unknown>): void {
  for (const handler of [...handlers]) {
    handler(message);
  }
}

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent,
  onParentMessage: (handler: (msg: unknown) => void) => {
    handlers.push(handler);

    return () => {
      const idx = handlers.indexOf(handler);

      if (idx >= 0) {
        handlers.splice(idx, 1);
      }
    };
  },
}));

// The detail drill-in has its own spec; stub it so this spec stays about the OVERVIEW render.
// NOTE: the path is `../ResourceDetailPanel` (this spec lives in __tests__/, the component is one
// level up) — `./ResourceDetailPanel` would resolve to a nonexistent __tests__/ file and silently
// NOT mock, so the REAL panel (with its loading NebulaLoader) would render on drill-in.
vi.mock('../ResourceDetailPanel', () => ({
  ResourceDetailPanel: () => <div data-testid="stub-detail" />,
}));

import { ResourceOverviewPanel } from '../ResourceOverviewPanel';

beforeEach(() => {
  postToParent.mockClear();
  handlers.length = 0;
  lastRequest.value = null;
});

afterEach(() => cleanup());

/** The correlationId the panel used for its most recent bridge request. */
function lastCorrelationId(): string {
  const req = lastRequest.value;
  expect(req).toBeTruthy();

  return (req as { correlationId: string }).correlationId;
}

/** Reply to the panel's latest inventory request with a ready inventory. */
async function replyReady(resources: Array<Record<string, unknown>> = []): Promise<void> {
  await act(async () => {
    emitToChild({
      type: 'PS_RES_OVERVIEW_RESPONSE',
      correlationId: lastCorrelationId(),
      ok: true,
      environment: 'production',
      resources,
    });
  });
}

const D1_ROW = {
  id: 'r1',
  resource_kind: 'd1',
  resource_concept: 'main_db',
  environment: 'production',
  tenancy: 'dedicated',
  lifecycle_state: 'active',
  binding_name: 'DB',
};
const KV_ROW = {
  id: 'r2',
  resource_kind: 'kv',
  resource_concept: 'cache_kv',
  environment: 'production',
  tenancy: 'dedicated',
  lifecycle_state: 'active',
  binding_name: 'CACHE_KV',
};
// A connected but NON-drillable owner-wire kind (hostname ∉ DETAIL_KINDS) — must never be a
// doomed click into a 400; its ids live behind the in-card Advanced disclosure instead.
const HOSTNAME_ROW = {
  id: 'r3',
  resource_kind: 'hostname',
  resource_concept: 'yoursite.com',
  environment: 'production',
  tenancy: 'dedicated',
  lifecycle_state: 'active',
  binding_name: '',
};

describe('ResourceOverviewPanel — render proof (RES-OVERVIEW-RENDER)', () => {
  it('renders the per-kind inventory GROUPS when the admin replies with resources', async () => {
    render(<ResourceOverviewPanel />);
    await waitFor(() => expect(postToParent).toHaveBeenCalled());
    await replyReady([D1_ROW, KV_ROW]);

    // The grouped container renders, with one group section per distinct kind × environment.
    const groups = await screen.findByTestId('resources-groups');
    expect(groups).toBeTruthy();

    const groupSections = screen.getAllByTestId('resources-group');
    expect(groupSections.length).toBe(2); // d1 + kv

    // The owner sees the concepts they actually have inside the groups.
    expect(screen.getByText('main_db')).toBeTruthy();
    expect(screen.getByText('cache_kv')).toBeTruthy();
  });

  it('renders the FRIENDLY disabled card (reassuring copy, no error) when the flag is dark', async () => {
    render(<ResourceOverviewPanel />);
    await waitFor(() => expect(postToParent).toHaveBeenCalled());

    await act(async () => {
      emitToChild({
        type: 'PS_RES_OVERVIEW_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: false,
        enabled: false,
        error: 'Resources is not enabled',
      });
    });

    const card = await screen.findByTestId('resources-disabled');
    // Friendly, reassuring copy — never a scary error.
    expect(card.textContent).toMatch(/isn.?t enabled yet/i);
    expect(card.textContent).toMatch(/nothing to set up/i);
    // It is NOT the error card, and carries no Retry.
    expect(screen.queryByTestId('resources-error')).toBeNull();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('renders NO manual Refresh/Reconcile button — only the live freshness chip', async () => {
    render(<ResourceOverviewPanel />);
    await waitFor(() => expect(postToParent).toHaveBeenCalled());
    await replyReady([D1_ROW]);

    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /reconcile/i })).toBeNull();
    expect(screen.getByTestId('resources-live-freshness')).toBeTruthy();
  });

  it('renders the empty-state launchpad (self-detecting, no button) when there are zero resources', async () => {
    render(<ResourceOverviewPanel />);
    await waitFor(() => expect(postToParent).toHaveBeenCalled());
    await replyReady([]);

    const empty = await screen.findByTestId('resources-empty');
    expect(empty.textContent).toMatch(/no resources yet/i);
    // The empty state is a launchpad, not a dead end — but there is NO button to press (self-detecting).
    expect(screen.queryByRole('button', { name: /reconcile/i })).toBeNull();
  });

  // ─── Drill-in: clicking a connected, drillable card opens the detail (fire-158) ──────────────
  // The fire-153 visual walkthrough questioned whether a card click opens the detail; it does —
  // for a CONNECTED card of a DETAIL_KIND, as a keyboard-accessible button that replaces the
  // overview with ResourceDetailPanel. Non-drillable wire kinds are correctly NOT a doomed click.

  it('renders a connected, drillable card as an accessible button and opens the detail on click', async () => {
    render(<ResourceOverviewPanel />);
    await waitFor(() => expect(postToParent).toHaveBeenCalled());
    await replyReady([D1_ROW]);

    // Scope to the GROUP card (its onClick is openDetail); the namespace rollup tiles above use a
    // separate openKind path and would muddy the assertion.
    const group = await screen.findByTestId('resources-group');
    const openable = within(group).getByTestId('resources-card');
    // The connected d1 card (a DETAIL_KIND) is an accessible button, not a dead tile.
    expect(openable.getAttribute('data-availability')).toBe('connected');
    expect(openable.getAttribute('role')).toBe('button');
    expect(openable.getAttribute('aria-label')).toMatch(/^Open /);
    expect(openable.getAttribute('tabindex')).toBe('0');
    expect(screen.queryByTestId('stub-detail')).toBeNull(); // overview first, not the detail

    await act(async () => {
      fireEvent.click(openable);
    });
    // Clicking replaces the overview with the (stubbed) ResourceDetailPanel — the drill-in opens.
    expect(await screen.findByTestId('stub-detail')).toBeTruthy();
  });

  it('opens the detail via keyboard (Enter) on the drillable card too', async () => {
    render(<ResourceOverviewPanel />);
    await waitFor(() => expect(postToParent).toHaveBeenCalled());
    await replyReady([D1_ROW]);

    const group = await screen.findByTestId('resources-group');
    const openable = within(group).getByTestId('resources-card');
    await act(async () => {
      fireEvent.keyDown(openable, { key: 'Enter' });
    });
    expect(await screen.findByTestId('stub-detail')).toBeTruthy();
  });

  it('does NOT make a non-drillable wire-kind card a doomed click (no button role, no detail)', async () => {
    render(<ResourceOverviewPanel />);
    await waitFor(() => expect(postToParent).toHaveBeenCalled());
    await replyReady([HOSTNAME_ROW]);

    const hostnameCard = (await screen.findAllByTestId('resources-card'))[0];
    // hostname ∉ DETAIL_KINDS → never an accessible button, never opens a detail.
    expect(hostnameCard.getAttribute('role')).not.toBe('button');
    await act(async () => {
      fireEvent.click(hostnameCard);
    });
    expect(screen.queryByTestId('stub-detail')).toBeNull();
  });
});
