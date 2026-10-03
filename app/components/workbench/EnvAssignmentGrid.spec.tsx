// @vitest-environment jsdom
/**
 * EnvAssignmentGrid.spec.tsx — TDD spec for the preview↔production environment grid (FIRE 5).
 *
 * The grid issues TWO PS_RES_OVERVIEW_REQUESTs (preview + production) and resolves each reply by
 * correlationId. We mock the bridge and reply to each request, asserting:
 *   1. it renders a "present" production cell (display name + lifecycle) + a "Not provisioned" preview cell;
 *   2. it filters overview rows to the target kind (an r2 grid ignores a d1 row);
 *   3. a flag-dark reply (enabled:false) hides the grid entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import React from 'react';

const { postToParent, handlers } = vi.hoisted(() => {
  const handlers: Array<(msg: unknown) => void> = [];
  const postToParent = vi.fn();
  return { handlers, postToParent };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  onParentMessage: (fn: (msg: unknown) => void) => {
    handlers.push(fn);
    return () => {
      const i = handlers.indexOf(fn);
      if (i >= 0) handlers.splice(i, 1);
    };
  },
  postToParent,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { EnvAssignmentGrid } from './EnvAssignmentGrid';

/** Deliver a PS_RES_OVERVIEW_RESPONSE for the pending request whose environment matches. */
function replyOverview(env: string, payload: Record<string, unknown>) {
  const call = postToParent.mock.calls.find(
    (c) =>
      (c[0] as { type: string; environment?: string }).type === 'PS_RES_OVERVIEW_REQUEST' &&
      (c[0] as { environment?: string }).environment === env,
  );
  if (!call) throw new Error(`no pending overview request for ${env}`);
  const cid = (call[0] as { correlationId: string }).correlationId;
  for (const h of [...handlers])
    h({ type: 'PS_RES_OVERVIEW_RESPONSE', correlationId: cid, ok: true, environment: env, ...payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('environment assignment grid', () => {
  it('renders a present production cell and a not-provisioned preview cell for the target kind', async () => {
    render(<EnvAssignmentGrid kind="r2" environment="production" />);

    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));

    replyOverview('preview', { resources: [] });
    replyOverview('production', {
      resources: [
        {
          id: '1',
          resource_kind: 'r2',
          resource_concept: 'account_resource',
          environment: 'production',
          tenancy: 'dedicated',
          lifecycle_state: 'active',
          resource_display_name: 'ps-site-abc',
        },
      ],
    });

    await waitFor(() => expect(screen.getByTestId('resource-env-grid')).toBeTruthy());
    const prod = screen.getByTestId('resource-env-cell-production');
    expect(prod.textContent).toContain('ps-site-abc');
    expect(prod.textContent).toContain('active');

    const preview = screen.getByTestId('resource-env-cell-preview');
    expect(preview.textContent).toContain('Not provisioned');
  });

  it('filters overview rows to the target kind (ignores a non-matching kind)', async () => {
    render(<EnvAssignmentGrid kind="r2" environment="production" />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));

    replyOverview('preview', { resources: [] });
    replyOverview('production', {
      resources: [
        {
          id: '2',
          resource_kind: 'd1',
          resource_concept: 'account_resource',
          environment: 'production',
          tenancy: 'dedicated',
          lifecycle_state: 'active',
          resource_display_name: 'a-d1-db',
        },
      ],
    });

    await waitFor(() => expect(screen.getByTestId('resource-env-cell-production')).toBeTruthy());
    // The d1 row must NOT satisfy the r2 grid — production reads as not provisioned.
    expect(screen.getByTestId('resource-env-cell-production').textContent).toContain('Not provisioned');
    expect(screen.getByTestId('resource-env-cell-production').textContent).not.toContain('a-d1-db');
  });

  it('hides the grid when the surface flag is dark (enabled:false)', async () => {
    const { container } = render(<EnvAssignmentGrid kind="kv" environment="preview" />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));

    // Reply flag-dark to both.
    for (const env of ['preview', 'production']) {
      const call = postToParent.mock.calls.find(
        (c) =>
          (c[0] as { type: string; environment?: string }).type === 'PS_RES_OVERVIEW_REQUEST' &&
          (c[0] as { environment?: string }).environment === env,
      );
      const cid = (call![0] as { correlationId: string }).correlationId;
      for (const h of [...handlers])
        h({ type: 'PS_RES_OVERVIEW_RESPONSE', correlationId: cid, ok: false, enabled: false, error: 'not enabled' });
    }

    await waitFor(() => expect(container.querySelector('[data-testid="resource-env-grid"]')).toBeNull());
  });
});

describe('environment assignment grid — real-time, no manual refresh (R1)', () => {
  /** Count how many overview requests (either environment) the grid has posted so far. */
  function overviewCount(): number {
    return postToParent.mock.calls.filter((c) => (c[0] as { type?: string })?.type === 'PS_RES_OVERVIEW_REQUEST')
      .length;
  }

  it('renders NO manual Refresh button — the grid self-updates', async () => {
    render(<EnvAssignmentGrid kind="r2" environment="production" />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));

    replyOverview('preview', { resources: [] });
    replyOverview('production', { resources: [] });

    await waitFor(() => expect(screen.getByTestId('resource-env-grid')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /refresh|reconcile/i })).toBeNull();
  });

  it('re-fetches both environments automatically on a visibility-aware interval (no click)', async () => {
    vi.useFakeTimers();

    try {
      render(<EnvAssignmentGrid kind="r2" environment="production" />);

      await act(async () => {
        await Promise.resolve();
      });

      replyOverview('preview', { resources: [] });
      replyOverview('production', { resources: [] });

      const afterMount = overviewCount();
      expect(afterMount).toBeGreaterThanOrEqual(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });

      expect(overviewCount()).toBeGreaterThan(afterMount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-fetches immediately when the tab returns to the foreground (visibilitychange)', async () => {
    render(<EnvAssignmentGrid kind="kv" environment="preview" />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));

    replyOverview('preview', { resources: [] });
    replyOverview('production', { resources: [] });
    const before = overviewCount();

    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(overviewCount()).toBeGreaterThan(before));
  });
});
