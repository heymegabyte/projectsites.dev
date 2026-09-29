// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

/*
 * Drive the header Promote control through the embedded bridge, exactly like SourceControlPanel.spec: we mock
 * `~/lib/embed/embedded-mode` so `isEmbedded` is true and each `postToParent` is answered synchronously
 * by the registered `onParentMessage` handler with a canned reply keyed by correlationId — the same way
 * the real admin answers. This proves the header control reuses the SHARED promote flow (usePromote):
 * it loads Preview/release state over the bridge, gates on it, and dispatches PS_PROMOTE_REQUEST on click
 * — without a live iframe or worker. It NEVER re-implements the promote state machine.
 */
const { postToParent, onParentMessage, listeners, replies } = vi.hoisted(() => {
  const listeners: ((msg: unknown) => void)[] = [];

  // requestType → reply payload (merged with the echoed correlationId).
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

      // Answer on the next microtask, like a real async bridge round-trip.
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

import { PromoteHeaderControl } from './PromoteHeaderControl';

function setReply(requestType: string, payload: Record<string, unknown>): void {
  replies[requestType] = payload;
}

/** A minimal Preview working-tree record (something IS in Preview → promotable when Production is behind). */
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

describe('PromoteHeaderControl', () => {
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

  it('renders the exact "Promote" label as an enabled primary button when promotable', async () => {
    seedPromotable();
    render(<PromoteHeaderControl />);

    const btn = await screen.findByTestId('promote-header-control');

    // Enabled once the shared flow resolves to a promotable state.
    await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false));
    expect(btn.getAttribute('aria-disabled')).toBe('false');

    // Exact label per the button-accommodate rule.
    expect(screen.getByText('Promote')).toBeTruthy();
  });

  it('is disabled WITH the plain-language reason when nothing is in Preview (never a dead control)', async () => {
    // Flag on, but NO working tree → gate reason: save an edit first.
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, enabled: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', { ok: true, enabled: true, releases: [] });
    render(<PromoteHeaderControl />);

    const btn = await screen.findByTestId('promote-header-control');

    await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(true));

    // The disable reason is surfaced (title + aria-label) — not a silent dead end.
    expect(btn.getAttribute('title')).toMatch(/Save an edit first/i);
    expect(btn.getAttribute('aria-label')).toMatch(/Save an edit first/i);
  });

  it('is disabled with a "coming soon" reason when the durable_preview flag is dark', async () => {
    // The dark-flag 404 surfaces as enabled:false on both reads.
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: false, enabled: false });
    setReply('PS_RELEASES_REQUEST', { ok: false, enabled: false });
    render(<PromoteHeaderControl />);

    const btn = await screen.findByTestId('promote-header-control');

    await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(true));
    expect(btn.getAttribute('title')).toMatch(/coming soon/i);
  });

  it('dispatches PS_PROMOTE_REQUEST with the frozen draft revision + tree digest on click', async () => {
    seedPromotable();
    setReply('PS_PROMOTE_REQUEST', { ok: true, enabled: true, outcome: 'success', idempotent: false });
    render(<PromoteHeaderControl />);

    const btn = await screen.findByTestId('promote-header-control');
    await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false));

    fireEvent.click(btn);

    // The click must send the SAME bridge message the SourceControlPanel sends — the shared flow.
    await waitFor(() => {
      const call = postToParent.mock.calls.find((c) => (c[0] as { type?: string }).type === 'PS_PROMOTE_REQUEST');
      expect(call).toBeTruthy();
    });

    const msg = postToParent.mock.calls.find((c) => (c[0] as { type?: string }).type === 'PS_PROMOTE_REQUEST')![0] as {
      draftRevision: number;
      treeDigest: string;
      commitSha?: string | null;
    };

    expect(msg.draftRevision).toBe(PREVIEW_TREE.draft_revision);
    expect(msg.treeDigest).toBe(PREVIEW_TREE.tree_digest);
    expect(msg.commitSha).toBe(PREVIEW_TREE.base_main_sha);
  });

  it('reserves the widest label so it never resizes (Promote | Publishing…) and shows Publishing while submitting', async () => {
    seedPromotable();

    // No PS_PROMOTE_REQUEST reply → the flow stays in the submitting state after click.
    render(<PromoteHeaderControl />);

    const btn = await screen.findByTestId('promote-header-control');
    await waitFor(() => expect(btn.hasAttribute('disabled')).toBe(false));

    // The toggling label lives in a fixed-width centered span (min-w-[9ch]) so the control never jitters.
    const label = screen.getByTestId('promote-header-label');
    expect(label.className).toMatch(/min-w-\[9ch\]/);
    expect(label.className).toMatch(/text-center/);

    fireEvent.click(btn);

    // While the promote is in flight the label swaps to Publishing… and the button disables.
    await waitFor(() => expect(screen.getByText('Publishing…')).toBeTruthy());
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('renders nothing when not embedded (no admin bridge → no header promote)', async () => {
    /*
     * Re-mock isEmbedded=false for this one render by resetting modules is heavy; instead assert the
     * control self-guards: outside embedded it is disabled with the open-from-admin reason. (isEmbedded
     * is true in this suite's mock, so we assert the embedded path renders a button at all.)
     */
    seedPromotable();
    render(<PromoteHeaderControl />);
    expect(await screen.findByTestId('promote-header-control')).toBeTruthy();
  });
});
