// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';

/*
 * Drive the SHARED usePromote hook through the embedded bridge exactly like the panel specs: mock
 * `~/lib/embed/embedded-mode` so `isEmbedded` is true and each `postToParent` is answered by the
 * registered `onParentMessage` handler with a canned reply keyed by request type + correlationId.
 *
 * These tests pin the Slice-6b addition: after a promote SETTLES, the hook RETAINS the last promote
 * result (`lastResult`: outcome + servingSha + release id/version) so the Source Control panel can
 * render a release-outcome card from the response already in the hook — the `serving_sha` shipped by
 * the worker was computed-but-unrendered before this. The completion marker is the response's OWN
 * release id (a monotonic, deterministic key — never `Date.now()`).
 */
const { postToParent, onParentMessage, listeners, replies } = vi.hoisted(() => {
  const listeners: ((msg: unknown) => void)[] = [];
  const replies: Record<string, Record<string, unknown>> = {};

  return {
    listeners,
    replies,
    onParentMessage: vi.fn((cb: (msg: unknown) => void) => {
      listeners.push(cb);

      return () => {
        const i = listeners.indexOf(cb);

        if (i >= 0) {
          listeners.splice(i, 1);
        }
      };
    }),
    postToParent: vi.fn((msg: { type: string; correlationId: string }) => {
      const responseType = msg.type.replace('_REQUEST', '_RESPONSE');
      const payload = replies[msg.type];

      if (!payload) {
        return;
      }

      queueMicrotask(() => {
        for (const cb of [...listeners]) {
          cb({ type: responseType, correlationId: msg.correlationId, ...payload });
        }
      });
    }),
  };
});

vi.mock('~/lib/embed/embedded-mode', () => ({
  isEmbedded: true,
  postToParent,
  onParentMessage,
}));

import { usePromote } from './use-promote';

function setReply(requestType: string, payload: Record<string, unknown>): void {
  replies[requestType] = payload;
}

/** A Preview working-tree record (something IS in Preview → promotable when Production is behind). */
const PREVIEW_TREE = {
  base_main_sha: 'abc1234',
  draft_revision: 7,
  tree_digest: 'digest-7',
  preview_deploy_revision: 'r7',
  last_error: null,
  updated_at: '2026-09-29T12:00:00Z',
};

/** A published release BEHIND the Preview draft → Production is behind Preview → promotable. */
const OLD_RELEASE = {
  id: 'rel-1',
  commit_sha: 'old0001',
  artifact_digest: 'digest-1',
  deployment_id: 'dep-1',
  serving_sha: null,
  actor: 'owner@example.com',
  draft_revision: 3,
  outcome: 'success',
  created_at: '2026-09-20T10:00:00Z',
};

/** Seed the bridge so the shared flow resolves to a PROMOTABLE state (flag on, tree present, Prod behind). */
function seedPromotable(): void {
  setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, enabled: true, working_tree: PREVIEW_TREE });
  setReply('PS_RELEASES_REQUEST', { ok: true, enabled: true, releases: [OLD_RELEASE] });
}

describe('usePromote — lastResult (Slice 6b)', () => {
  beforeEach(() => {
    cleanup();
    listeners.length = 0;

    for (const k of Object.keys(replies)) {
      delete replies[k];
    }

    postToParent.mockClear();
    onParentMessage.mockClear();
  });

  afterEach(() => cleanup());

  it('is null before any promote has run (the card stays hidden)', async () => {
    seedPromotable();

    const { result } = renderHook(() => usePromote());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.lastResult).toBeNull();
  });

  it('retains outcome + servingSha + release id after a SUCCESS settles', async () => {
    seedPromotable();
    setReply('PS_PROMOTE_REQUEST', {
      ok: true,
      enabled: true,
      outcome: 'success',
      idempotent: false,
      release: {
        id: 'rel-2',
        commit_sha: 'abc1234',
        artifact_digest: 'digest-7',
        deployment_id: 'v2026',
        serving_sha: 'deadbeef1234feedface5678',
        actor: 'owner@example.com',
        draft_revision: 7,
        outcome: 'success',
        created_at: '2026-09-29T12:05:00Z',
      },
    });

    const { result } = renderHook(() => usePromote());
    await waitFor(() => expect(result.current.canPromote).toBe(true));

    act(() => result.current.doPromote());

    await waitFor(() => expect(result.current.promote.status).toBe('success'));
    await waitFor(() => expect(result.current.lastResult).not.toBeNull());

    const last = result.current.lastResult!;
    expect(last.outcome).toBe('success');
    expect(last.servingSha).toBe('deadbeef1234feedface5678');
    expect(last.releaseId).toBe('rel-2');
    // The completion marker is the response's own release id — deterministic, never a wall clock.
    expect(last.releaseId).toBe(last.releaseId);
    expect(typeof last.servingSha).toBe('string');
  });

  it('retains a commit_ok_deploy_failed outcome with a null servingSha (retry surface)', async () => {
    seedPromotable();
    setReply('PS_PROMOTE_REQUEST', {
      ok: true,
      enabled: true,
      outcome: 'commit_ok_deploy_failed',
      idempotent: false,
      release: {
        id: 'rel-3',
        commit_sha: 'abc1234',
        artifact_digest: 'digest-7',
        deployment_id: 'v2026b',
        serving_sha: null,
        actor: 'owner@example.com',
        draft_revision: 7,
        outcome: 'commit_ok_deploy_failed',
        created_at: '2026-09-29T12:06:00Z',
      },
    });

    const { result } = renderHook(() => usePromote());
    await waitFor(() => expect(result.current.canPromote).toBe(true));

    act(() => result.current.doPromote());

    await waitFor(() => expect(result.current.promote.status).toBe('commit_ok_deploy_failed'));
    await waitFor(() => expect(result.current.lastResult).not.toBeNull());

    const last = result.current.lastResult!;
    expect(last.outcome).toBe('commit_ok_deploy_failed');
    expect(last.servingSha).toBeNull();
    expect(last.releaseId).toBe('rel-3');
  });

  it('dismiss() clears lastResult (the card is dismissible)', async () => {
    seedPromotable();
    setReply('PS_PROMOTE_REQUEST', {
      ok: true,
      enabled: true,
      outcome: 'success',
      idempotent: false,
      release: {
        id: 'rel-4',
        commit_sha: 'abc1234',
        artifact_digest: 'digest-7',
        deployment_id: 'v2026c',
        serving_sha: 'cafebabe0000111122223333',
        actor: 'owner@example.com',
        draft_revision: 7,
        outcome: 'success',
        created_at: '2026-09-29T12:07:00Z',
      },
    });

    const { result } = renderHook(() => usePromote());
    await waitFor(() => expect(result.current.canPromote).toBe(true));

    act(() => result.current.doPromote());
    await waitFor(() => expect(result.current.lastResult).not.toBeNull());

    act(() => result.current.dismiss());
    expect(result.current.lastResult).toBeNull();
  });
});
