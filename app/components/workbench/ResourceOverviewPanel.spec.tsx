// @vitest-environment jsdom
/**
 * ResourceOverviewPanel.spec.tsx — TDD spec for the editor **Resources** tab surface (FIRE: Resources).
 *
 * The Resources tab mounts {@link ResourceOverviewPanel}: the per-site Cloudflare asset console that
 * lists every primitive the site is wired to (D1/KV/R2/DO/Workflows/Queues/Vectorize/bindings/
 * connections/observability) per kind × environment, with an env selector + Reconcile, drilling into a
 * generic detail + manage surface. It talks to the parent admin over `postMessage`; we mock
 * `~/lib/embed/embedded-mode` so the test drives the bridge deterministically (no real iframe).
 *
 * Covers the WIRING this fire adds:
 *   1. Mounts + requests inventory — on mount it sends `PS_RES_OVERVIEW_REQUEST` for the default env
 *      (production) with a correlationId, proving the tab is live-bridged (not a dead panel).
 *   2. Honest inventory render — a ready reply with real resources renders their concepts + kind groups
 *      (so a business owner sees what they have), and the env selector offers preview + production.
 *   3. Honest dark-flag state — a `{ ok:false, enabled:false }` reply renders the friendly "not enabled
 *      yet" card (INV-3: dark → friendly, never a scary error / never a mock control).
 *
 * `vi.mock` factories hoist above the module body, so the spies they close over are `vi.hoisted`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
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
  for (const handler of handlers) {
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

// The detail drill-in is exercised by ResourceDetailPanel.spec; stub it to a marker so this spec
// stays about the OVERVIEW tab's list + env-selector + dark-flag wiring.
vi.mock('./ResourceDetailPanel', () => ({
  ResourceDetailPanel: () => <div data-testid="stub-detail" />,
}));

import { ResourceOverviewPanel } from './ResourceOverviewPanel';

beforeEach(() => {
  postToParent.mockClear();
  handlers.length = 0;
  lastRequest.value = null;
});

afterEach(() => {
  cleanup();
});

/** The correlationId the panel used for its most recent bridge request. */
function lastCorrelationId(): string {
  const req = lastRequest.value;
  expect(req).toBeTruthy();
  return (req as { correlationId: string }).correlationId;
}

describe('ResourceOverviewPanel — the editor Resources tab surface', () => {
  it('requests the resource inventory for the default (production) environment on mount', async () => {
    render(<ResourceOverviewPanel />);

    await waitFor(() => expect(postToParent).toHaveBeenCalled());

    const req = lastRequest.value as { type: string; environment: string; correlationId: string };
    expect(req.type).toBe('PS_RES_OVERVIEW_REQUEST');
    expect(req.environment).toBe('production');
    expect(typeof req.correlationId).toBe('string');
    expect(req.correlationId.length).toBeGreaterThan(0);
  });

  it('renders the inventory + an env selector when the admin replies with resources', async () => {
    render(<ResourceOverviewPanel />);
    await waitFor(() => expect(postToParent).toHaveBeenCalled());

    await act(async () => {
      emitToChild({
        type: 'PS_RES_OVERVIEW_RESPONSE',
        correlationId: lastCorrelationId(),
        ok: true,
        environment: 'production',
        resources: [
          {
            id: 'r1',
            resource_kind: 'd1',
            resource_concept: 'main_db',
            environment: 'production',
            tenancy: 'dedicated',
            lifecycle_state: 'active',
            binding_name: 'DB',
          },
          {
            id: 'r2',
            resource_kind: 'kv',
            resource_concept: 'cache_kv',
            environment: 'production',
            tenancy: 'dedicated',
            lifecycle_state: 'active',
            binding_name: 'CACHE_KV',
          },
        ],
      });
    });

    // The owner sees the concepts they actually have.
    expect(await screen.findByText('main_db')).toBeTruthy();
    expect(screen.getByText('cache_kv')).toBeTruthy();

    // Env selector offers BOTH environments (preview != production isolation is user-visible).
    expect(screen.getByTestId('resources-env-preview')).toBeTruthy();
    expect(screen.getByTestId('resources-env-production')).toBeTruthy();
  });

  it('renders the honest "not enabled yet" state when the surface flag is dark', async () => {
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

    // A dark flag → friendly disabled card (INV-3), never a scary error and never a mock control.
    expect(await screen.findByTestId('resources-disabled')).toBeTruthy();
  });
});
