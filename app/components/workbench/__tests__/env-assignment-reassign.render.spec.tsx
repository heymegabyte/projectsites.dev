// @vitest-environment jsdom
/**
 * @file Resources › Environments › B10 reversible env reassignment (EnvAssignmentGrid, kind="r2").
 *
 * The grid is read-only for every kind EXCEPT r2, where B10 adds a per-bucket reassign control. Because
 * a bucket's `environment` affects which bucket serves that environment, the flow is SAFE:
 *   1. a NON-default bucket in an environment renders a "Move to {other}" control; the DEFAULT bucket does
 *      NOT (it can't move without breaking the two-default model — no doomed control);
 *   2. clicking it opens a CONFIRM dialog that names the consequence ("changes which bucket serves …");
 *   3. confirming calls `requestR2SetEnv(bucket, targetEnv)`; on success the grid shows an UNDO affordance
 *      that re-assigns back to the `previousEnvironment` the reply carried;
 *   4. a rejected move (the two-default conflict) surfaces the server message, grid state unchanged.
 *
 * The bridge helpers are mocked (the real ones postMessage a parent absent in jsdom). The grid resolves
 * the r2 bucket list via `requestR2({op:'listBuckets'})` (display name + isDefault per env) and reassigns
 * via `requestR2SetEnv`. Overview requests still flow through the mocked `postToParent`/`onParentMessage`.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { postToParent, handlers, requestR2, requestR2SetEnv } = vi.hoisted(() => {
  const handlers: Array<(msg: unknown) => void> = [];

  return {
    handlers,
    postToParent: vi.fn(),
    requestR2: vi.fn(),
    requestR2SetEnv: vi.fn(),
  };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  onParentMessage: (fn: (msg: unknown) => void) => {
    handlers.push(fn);

    return () => {
      const i = handlers.indexOf(fn);

      if (i >= 0) {
        handlers.splice(i, 1);
      }
    };
  },
  postToParent,
  requestR2,
  requestR2SetEnv,
}));

vi.mock('~/utils/classNames', () => ({
  classNames: (...a: unknown[]) => a.filter((x) => typeof x === 'string').join(' '),
}));

import { EnvAssignmentGrid } from '../EnvAssignmentGrid';

/** Reply to BOTH pending overview requests so the grid reaches `ready` (present cells both envs). */
function replyBothOverviews() {
  for (const env of ['preview', 'production']) {
    const call = postToParent.mock.calls.find(
      (c) =>
        (c[0] as { type: string; environment?: string }).type === 'PS_RES_OVERVIEW_REQUEST' &&
        (c[0] as { environment?: string }).environment === env,
    );

    if (!call) {
      continue;
    }

    const cid = (call[0] as { correlationId: string }).correlationId;

    for (const h of [...handlers]) {
      h({
        type: 'PS_RES_OVERVIEW_RESPONSE',
        correlationId: cid,
        ok: true,
        environment: env,
        resources: [
          {
            id: env,
            resource_kind: 'r2',
            resource_concept: 'account_resource',
            environment: env,
            tenancy: 'dedicated',
            lifecycle_state: 'active',
            resource_display_name: `ps-site-${env}`,
          },
        ],
      });
    }
  }
}

/** The bucket list the r2 grid resolves — Preview default + Production default + a custom preview bucket. */
const BUCKET_LIST = {
  type: 'PS_R2_RESULT' as const,
  ok: true as const,
  buckets: [
    { name: 'Preview', environment: 'preview', isDefault: true },
    { name: 'Production', environment: 'production', isDefault: true },
    { name: 'Media', environment: 'preview', isDefault: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  handlers.length = 0;
  requestR2.mockResolvedValue(BUCKET_LIST);
});

afterEach(cleanup);

describe('EnvAssignmentGrid — B10 reversible env reassignment (r2)', () => {
  it('renders a "Move to production" control for the NON-default preview bucket, and NONE for a default', async () => {
    render(<EnvAssignmentGrid kind="r2" environment="preview" />);

    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));
    replyBothOverviews();

    // The reassign control for the custom (non-default) Media bucket appears once the bucket list loads.
    const moveBtn = await screen.findByTestId('env-reassign-Media');
    expect(moveBtn).toBeTruthy();
    expect(moveBtn.textContent?.toLowerCase()).toContain('production');

    // The default buckets carry NO reassign control (they can't move — no doomed control).
    expect(screen.queryByTestId('env-reassign-Preview')).toBeNull();
    expect(screen.queryByTestId('env-reassign-Production')).toBeNull();
  });

  it('confirms before reassigning, then calls requestR2SetEnv and offers Undo on success', async () => {
    requestR2SetEnv.mockResolvedValue({ type: 'PS_R2_RESULT', ok: true, previousEnvironment: 'preview' });

    render(<EnvAssignmentGrid kind="r2" environment="preview" />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));
    replyBothOverviews();

    const moveBtn = await screen.findByTestId('env-reassign-Media');
    fireEvent.click(moveBtn);

    // A confirm dialog names the serving consequence BEFORE any mutation.
    const dialog = await screen.findByTestId('env-reassign-confirm');
    expect(dialog.textContent?.toLowerCase()).toContain('which bucket serves');
    expect(requestR2SetEnv).not.toHaveBeenCalled();

    // Confirm → the reassign fires with the target environment.
    fireEvent.click(screen.getByTestId('env-reassign-confirm-apply'));
    await waitFor(() => expect(requestR2SetEnv).toHaveBeenCalledTimes(1));
    expect(requestR2SetEnv).toHaveBeenCalledWith({ bucket: 'Media', environment: 'production' });

    // On success an Undo affordance appears.
    const undo = await screen.findByTestId('env-reassign-undo');
    expect(undo).toBeTruthy();

    // Undo re-assigns back to the previousEnvironment the reply carried.
    requestR2SetEnv.mockResolvedValue({ type: 'PS_R2_RESULT', ok: true, previousEnvironment: 'production' });
    fireEvent.click(undo);
    await waitFor(() => expect(requestR2SetEnv).toHaveBeenCalledTimes(2));
    expect(requestR2SetEnv).toHaveBeenLastCalledWith({ bucket: 'Media', environment: 'preview' });
  });

  it('cancelling the confirm dialog does NOT reassign', async () => {
    render(<EnvAssignmentGrid kind="r2" environment="preview" />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));
    replyBothOverviews();

    fireEvent.click(await screen.findByTestId('env-reassign-Media'));
    fireEvent.click(await screen.findByTestId('env-reassign-confirm-cancel'));

    await waitFor(() => expect(screen.queryByTestId('env-reassign-confirm')).toBeNull());
    expect(requestR2SetEnv).not.toHaveBeenCalled();
  });

  it('surfaces the server message when a reassignment is rejected (two-default conflict)', async () => {
    requestR2SetEnv.mockResolvedValue({
      type: 'PS_R2_RESULT',
      ok: false,
      error: 'That is this environment’s default bucket',
    });

    render(<EnvAssignmentGrid kind="r2" environment="preview" />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));
    replyBothOverviews();

    fireEvent.click(await screen.findByTestId('env-reassign-Media'));
    fireEvent.click(await screen.findByTestId('env-reassign-confirm-apply'));

    const err = await screen.findByTestId('env-reassign-error');
    expect(err.textContent).toContain('default bucket');
    // No Undo on a failed move.
    expect(screen.queryByTestId('env-reassign-undo')).toBeNull();
  });

  it('does NOT fetch the bucket list or render a control for a non-r2 kind (kv stays read-only)', async () => {
    render(<EnvAssignmentGrid kind="kv" environment="preview" />);
    await waitFor(() => expect(postToParent.mock.calls.length).toBeGreaterThanOrEqual(2));
    replyBothOverviews();

    await waitFor(() => expect(screen.getByTestId('resource-env-grid')).toBeTruthy());
    expect(requestR2).not.toHaveBeenCalled();
    expect(screen.queryByTestId('env-reassign-Media')).toBeNull();
  });
});
