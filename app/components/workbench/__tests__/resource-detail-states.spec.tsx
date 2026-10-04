// @vitest-environment jsdom
/**
 * @file Resource detail — drill-in STATE render proof (RES-DETAIL-STATES, fire-142; Resources EPIC).
 *
 * The sibling `ResourceDetailPanel.spec.tsx` proves the WRITE-UI logic (provision/delete/confirm) and the
 * flag-dark honesty. This spec proves the drill-in renders its READ states honestly into the DOM — the
 * four a business owner actually meets:
 *
 *   1. LOADING — before any bridge reply, the in-panel loading affordance shows (`resource-detail-loading`).
 *   2. EMPTY-COLLECTION — a `list` with an empty collection (`keys:[]`) renders the honest "Nothing here
 *      yet" empty state, NEVER a crash or a blank pane.
 *   3. TYPED ERROR `not_registered` → PROVISION CTA — a not-connected resource renders the friendly
 *      "Nothing here yet" adapter-error card AND leads with the Provision button (the one active CTA),
 *      never a doomed write form.
 *   4. EMPTY payload (no collection, no scalars) — renders the raw-JSON fallback, never a dead end.
 *
 * The bridge + heavy ConfirmationDialog are mocked so this stays about the read-state render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
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

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent,
  onParentMessage: (fn: (msg: unknown) => void) => {
    handlers.push(fn);

    return () => {
      const i = handlers.indexOf(fn);

      if (i >= 0) {
        handlers.splice(i, 1);
      }
    };
  },
}));

// Stub the heavy ConfirmationDialog (framer-motion + react-window).
vi.mock('~/components/ui/Dialog', () => ({
  ConfirmationDialog: ({ isOpen, title }: { isOpen: boolean; title: string }) =>
    isOpen ? React.createElement('div', { role: 'dialog', 'aria-label': title }) : null,
}));

import { ResourceDetailPanel } from '../ResourceDetailPanel';

/** Reply to the last-posted request by correlationId with a PS_RES_*_RESPONSE. */
function replyToLast(type: string, extra: Record<string, unknown>) {
  const cid = lastRequest.value?.correlationId as string | undefined;
  act(() => {
    for (const h of [...handlers]) {
      h({ type, correlationId: cid, ...extra });
    }
  });
}

/** The last request the panel posted. */
function last(): Record<string, unknown> | null {
  return lastRequest.value;
}

beforeEach(() => {
  postToParent.mockClear();
  handlers.length = 0;
  lastRequest.value = null;
});

afterEach(() => cleanup());

describe('RES-DETAIL-STATES — drill-in read states', () => {
  it('renders the LOADING state before any reply arrives', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    // The mount posts a `list` request; until it's answered, the loading affordance is shown.
    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    expect(screen.getByTestId('resource-detail-loading')).toBeTruthy();
  });

  it('renders the honest EMPTY-COLLECTION state for an empty list', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', { ok: true, result: { ok: true, data: { keys: [], listComplete: true } } });

    const empty = await screen.findByTestId('resource-detail-empty');
    expect(empty.textContent).toMatch(/nothing here yet/i);
    // No crash, no error card for an honest-empty result.
    expect(screen.queryByTestId('resource-detail-error')).toBeNull();
    expect(screen.queryByTestId('resource-detail-adapter-error')).toBeNull();
  });

  it('renders the typed `not_registered` error AND leads with the Provision CTA', async () => {
    render(
      <ResourceDetailPanel
        target={{ kind: 'kv', environment: 'production', availability: 'available' }}
        onBack={() => {}}
      />,
    );

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    replyToLast('PS_RES_DETAIL_RESPONSE', {
      ok: true,
      result: { ok: false, error: { code: 'not_registered', message: 'Not connected yet.' } },
    });

    // The friendly typed-error card renders (not a raw code dump) …
    const adapterError = await screen.findByTestId('resource-detail-adapter-error');
    expect(adapterError.textContent).toMatch(/nothing here yet/i);

    // … and the Provision button is the one active primary CTA (not_registered ⇒ provision-first).
    const provision = screen.getByTestId('resource-mutate-provision') as HTMLButtonElement;
    expect(provision).toBeTruthy();
    expect(provision.disabled).toBe(false);
  });

  it('renders the raw-JSON fallback for a payload with no collection and no scalars (never a dead end)', async () => {
    render(<ResourceDetailPanel target={{ kind: 'kv', environment: 'production' }} onBack={() => {}} />);

    await waitFor(() => expect(last()?.type).toBe('PS_RES_DETAIL_REQUEST'));
    // An object with only nested-object fields → no scalar summary, no array collection.
    replyToLast('PS_RES_DETAIL_RESPONSE', { ok: true, result: { ok: true, data: { config: { nested: true } } } });

    expect(await screen.findByTestId('resource-detail-raw')).toBeTruthy();
  });
});
