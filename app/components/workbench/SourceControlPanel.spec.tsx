// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

/*
 * Drive the Source Control panel through the embedded bridge: mock
 * `~/lib/embed/embedded-mode` so `isEmbedded` is true and each `postToParent` is answered by the
 * registered `onParentMessage` handler with a canned reply keyed by request type + correlationId.
 * `sent` records every outbound message so we can assert restore targets Preview only (never a
 * commit / Production mutation).
 *
 * The PREVIEW working tree is the editor's OWN `workbenchStore.files` (NOT a bridge call), so we mock
 * the store: `files` is a nanostores map we seed per-test, and `setVirtualFile` is a spy the restore
 * test asserts against (restore writes Preview locally — never commits, never deploys).
 */
const { postToParent, onParentMessage, listeners, replies, sent } = vi.hoisted(() => {
  const listeners: ((msg: unknown) => void)[] = [];
  const replies: Record<string, Record<string, unknown>> = {};
  const sent: { type: string; [k: string]: unknown }[] = [];

  return {
    listeners,
    replies,
    sent,
    onParentMessage: vi.fn((cb: (msg: unknown) => void) => {
      listeners.push(cb);

      return () => {
        const i = listeners.indexOf(cb);

        if (i >= 0) {
          listeners.splice(i, 1);
        }
      };
    }),
    postToParent: vi.fn((msg: { type: string; correlationId?: string }) => {
      sent.push(msg as { type: string });

      const payload = replies[msg.type];

      if (!payload) {
        return;
      }

      const responseType = msg.type.replace('_REQUEST', '_RESPONSE');

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

/**
 * A REAL nanostores map (so `useStore` in the panel works) + a `setVirtualFile` spy, both created inside
 * `vi.hoisted` — the only place a `vi.mock` factory may safely reference. `nanostores` is `require`d here
 * (not top-imported) because hoisted runs before ESM imports resolve.
 */
const { filesStore, setVirtualFile } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { map } = require('nanostores') as typeof import('nanostores');

  return {
    filesStore: map<Record<string, { type: string; content: string; isBinary: boolean } | undefined>>({}),
    setVirtualFile: vi.fn(),
  };
});

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    get files() {
      return filesStore;
    },
    setVirtualFile,
  },
}));

// WORK_DIR is imported by the panel to strip the prefix off working-tree paths.
vi.mock('~/utils/constants', () => ({ WORK_DIR: '/home/project' }));

import { SourceControlPanel } from './SourceControlPanel';

function setReply(requestType: string, payload: Record<string, unknown>): void {
  replies[requestType] = payload;
}

/** Base build (main) reply — the published R2 build, over the bridge. */
function baseReply(files: { name: string; size: number }[]): void {
  setReply('PS_CODE_TREE_REQUEST', {
    ok: true,
    version: '2026-05-11',
    prefix: 'sites/acme/',
    files: files.map((f) => ({
      key: `sites/acme/${f.name}`,
      name: f.name,
      size: f.size,
      uploaded: '2026-05-11T14:00:00Z',
      content_type: null,
    })),
  });
}

/**
 * Seed the editor's Preview working tree (`workbenchStore.files`). Sizes are derived from a content
 * string of the requested byte length so the panel's UTF-8 byte-size diff is exercised for real.
 */
function seedWorkingTree(files: { path: string; size: number }[]): void {
  const next: Record<string, { type: string; content: string; isBinary: boolean }> = {};

  for (const f of files) {
    next[`/home/project/${f.path}`] = { type: 'file', content: 'x'.repeat(f.size), isBinary: false };
  }

  filesStore.set(next);
}

describe('SourceControlPanel', () => {
  beforeEach(() => {
    cleanup();
    listeners.length = 0;
    sent.length = 0;

    for (const k of Object.keys(replies)) {
      delete replies[k];
    }

    filesStore.set({});
    setVirtualFile.mockClear();
    postToParent.mockClear();
    onParentMessage.mockClear();
  });

  afterEach(() => cleanup());

  it('renders the Source Control heading and the Changes/History control', () => {
    baseReply([]);
    seedWorkingTree([]);
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', { ok: true, releases: [] });

    render(<SourceControlPanel />);

    expect(screen.getByRole('heading', { name: /Source Control/i })).toBeTruthy();
    expect(screen.getByTestId('sc-tab-changes')).toBeTruthy();
    expect(screen.getByTestId('sc-tab-history')).toBeTruthy();
  });

  it('shows an honest "no changes" empty state when Preview matches the main base', async () => {
    baseReply([{ name: 'index.html', size: 1000 }]);
    seedWorkingTree([{ path: 'index.html', size: 1000 }]);
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', { ok: true, releases: [] });

    render(<SourceControlPanel />);

    await waitFor(() => expect(screen.getByTestId('sc-changes-empty')).toBeTruthy());
    expect(screen.getByText(/no changes/i)).toBeTruthy();
  });

  it('renders changed-file status (A/M/D) derived from the working-tree vs base diff', async () => {
    baseReply([
      { name: 'index.html', size: 1000 },
      { name: 'old.js', size: 200 },
    ]);
    seedWorkingTree([
      { path: 'index.html', size: 1200 }, // modified
      { path: 'src/App.tsx', size: 500 }, // added
      // old.js deleted (absent from working tree)
    ]);
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', { ok: true, releases: [] });

    render(<SourceControlPanel />);

    await waitFor(() => expect(screen.getByTestId('sc-changes-list')).toBeTruthy());

    const rows = screen.getAllByTestId('sc-change-row');
    expect(rows).toHaveLength(3);
    expect(screen.getByText('src/App.tsx')).toBeTruthy();
    expect(screen.getByText('index.html')).toBeTruthy();
    expect(screen.getByText('old.js')).toBeTruthy();

    // The header count reflects the 3 changes.
    expect(screen.getByTestId('sc-change-count').textContent).toContain('3');
  });

  it('renders release history from the mocked releases payload', async () => {
    baseReply([]);
    seedWorkingTree([]);
    setReply('PS_PREVIEW_STATE_REQUEST', {
      ok: true,
      working_tree: {
        base_main_sha: 'abc1234',
        draft_revision: 3,
        tree_digest: 'd',
        preview_deploy_revision: null,
        last_error: null,
        updated_at: '2026-05-11T14:00:00Z',
      },
    });
    setReply('PS_RELEASES_REQUEST', {
      ok: true,
      releases: [
        {
          id: 'r1',
          commit_sha: 'abc1234',
          artifact_digest: 'art',
          deployment_id: 'dep-1',
          actor: 'owner@example.com',
          draft_revision: 3,
          outcome: 'success',
          created_at: '2026-05-11T13:00:00Z',
        },
      ],
    });

    render(<SourceControlPanel />);

    // Switch to the History tab.
    fireEvent.click(screen.getByTestId('sc-tab-history'));

    await waitFor(() => expect(screen.getByTestId('sc-history-list')).toBeTruthy());
    expect(screen.getAllByTestId('sc-release-row')).toHaveLength(1);
    expect(screen.getByText(/Deployed/i)).toBeTruthy();

    // The short SHA renders.
    expect(screen.getByText('abc1234')).toBeTruthy();
  });

  it('shows an honest empty release history when nothing has been published', async () => {
    baseReply([]);
    seedWorkingTree([]);
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', { ok: true, releases: [] });

    render(<SourceControlPanel />);
    fireEvent.click(screen.getByTestId('sc-tab-history'));

    await waitFor(() => expect(screen.getByTestId('sc-history-empty')).toBeTruthy());
  });

  it('shows the Preview↔Production sync indicator', async () => {
    baseReply([]);
    seedWorkingTree([]);
    setReply('PS_PREVIEW_STATE_REQUEST', {
      ok: true,
      working_tree: {
        base_main_sha: 'sha2',
        draft_revision: 5,
        tree_digest: 'd',
        preview_deploy_revision: null,
        last_error: null,
        updated_at: '2026-05-11T14:00:00Z',
      },
    });
    setReply('PS_RELEASES_REQUEST', {
      ok: true,
      releases: [
        {
          id: 'r1',
          commit_sha: 'sha1',
          artifact_digest: 'art',
          deployment_id: 'dep-1',
          actor: 'owner@example.com',
          draft_revision: 5,
          outcome: 'success',
          created_at: '2026-05-11T13:00:00Z',
        },
      ],
    });

    render(<SourceControlPanel />);

    await waitFor(() => expect(screen.getByTestId('sc-sync-indicator')).toBeTruthy());

    // Preview SHA differs from Production → "ahead".
    expect(screen.getByTestId('sc-sync-indicator').textContent).toMatch(/ahead/i);
  });

  it('restore targets PREVIEW ONLY — fetches the base file + writes the working tree, never commits/deploys', async () => {
    baseReply([{ name: 'index.html', size: 1000 }]);
    seedWorkingTree([{ path: 'index.html', size: 1200 }]); // modified → restorable
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', { ok: true, releases: [] });

    // Restore reads the last-published copy over the read-only file bridge.
    setReply('PS_CODE_FILE_REQUEST', { ok: true, path: 'index.html', content: '<html>base</html>', size: 1000 });

    render(<SourceControlPanel />);

    await waitFor(() => expect(screen.getByTestId('sc-changes-list')).toBeTruthy());

    fireEvent.click(screen.getByTestId('sc-restore-index.html'));

    // Restore reads the base file (read-only) …
    await waitFor(() => expect(sent.some((m) => m.type === 'PS_CODE_FILE_REQUEST')).toBe(true));

    // … then writes it into the Preview working tree locally (never a commit / deploy / Production change).
    await waitFor(() => expect(setVirtualFile).toHaveBeenCalledWith('index.html', '<html>base</html>'));

    // HARD INVARIANT: the Source Control view NEVER commits or changes Production.
    const forbidden = ['PS_DEPLOY_REQUEST', 'PS_COMMIT', 'PS_PROMOTE', 'PS_PUBLISH', 'PS_PUBLISH_BOLT'];

    for (const m of sent) {
      expect(forbidden).not.toContain(m.type);
    }
  });

  it('surfaces a load error with a Retry affordance when the base fails to load', async () => {
    setReply('PS_CODE_TREE_REQUEST', { ok: false, error: 'Failed to load base' });
    seedWorkingTree([]);
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', { ok: true, releases: [] });

    render(<SourceControlPanel />);

    await waitFor(() => expect(screen.getByTestId('sc-changes-error')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });

  /*
   * Release-outcome card (Slice 6b) — RENDERS the promote response already in the shared hook so the
   * worker's `serving_sha` proof is surfaced (was computed-but-unrendered). Hidden until a promote runs;
   * success → a 12-char serving_sha chip with click-to-copy; commit_ok_deploy_failed → a Retry that
   * re-fires the SAME promote via the existing hook action (never a new call path).
   */
  function seedPromotable(): void {
    baseReply([{ name: 'index.html', size: 1000 }]);
    seedWorkingTree([{ path: 'index.html', size: 1200 }]);
    setReply('PS_PREVIEW_STATE_REQUEST', {
      ok: true,
      enabled: true,
      working_tree: {
        base_main_sha: 'abc1234',
        draft_revision: 7,
        tree_digest: 'digest-7',
        preview_deploy_revision: 'r7',
        last_error: null,
        updated_at: '2026-09-29T12:00:00Z',
      },
    });
    setReply('PS_RELEASES_REQUEST', {
      ok: true,
      enabled: true,
      releases: [
        {
          id: 'rel-1',
          commit_sha: 'old0001',
          artifact_digest: 'digest-1',
          deployment_id: 'dep-1',
          serving_sha: null,
          actor: 'owner@example.com',
          draft_revision: 3,
          outcome: 'success',
          created_at: '2026-09-20T10:00:00Z',
        },
      ],
    });
  }

  it('hides the release-outcome card until a promote has run', async () => {
    seedPromotable();

    render(<SourceControlPanel />);

    await waitFor(() => expect(screen.getByTestId('sc-changes-list')).toBeTruthy());

    // No promote yet → the outcome card is absent.
    expect(screen.queryByTestId('sc-release-outcome')).toBeNull();
  });

  it('renders a Live badge + a 12-char serving_sha chip after a successful promote', async () => {
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

    render(<SourceControlPanel />);

    // Promote from the header button (the SHARED hook action).
    const promoteBtn = await screen.findByTestId('promote-to-production');
    await waitFor(() => expect(promoteBtn.hasAttribute('disabled')).toBe(false));
    fireEvent.click(promoteBtn);

    // The outcome card appears with a Live badge + the 12-char serving_sha prefix.
    const card = await screen.findByTestId('sc-release-outcome');
    expect(card.textContent).toMatch(/Live/i);

    const shaChip = await screen.findByTestId('sc-serving-sha');

    // 12-char prefix of the 24-char serving_sha.
    expect(shaChip.textContent).toContain('deadbeef1234');

    // The full sha never renders truncated-wrong: only the 12-char prefix shows.
    expect(shaChip.textContent).not.toContain('feedface5678');

    // Click-to-copy is keyboard-reachable + labelled.
    const copyBtn = screen.getByTestId('sc-serving-sha-copy');
    expect(copyBtn.getAttribute('aria-label')).toMatch(/copy/i);
  });

  it('renders a Retry on commit_ok_deploy_failed that re-fires the SAME promote via the hook', async () => {
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

    render(<SourceControlPanel />);

    const promoteBtn = await screen.findByTestId('promote-to-production');
    await waitFor(() => expect(promoteBtn.hasAttribute('disabled')).toBe(false));
    fireEvent.click(promoteBtn);

    // The card shows the deploy-failed outcome + a Retry (the retry surface).
    const card = await screen.findByTestId('sc-release-outcome');
    await waitFor(() => expect(card.textContent).toMatch(/deploy failed/i));

    const retry = screen.getByTestId('sc-release-outcome-retry');
    expect(retry.getAttribute('aria-label')).toMatch(/retry|publish/i);

    // Count PS_PROMOTE_REQUEST calls before Retry.
    const before = postToParent.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'PS_PROMOTE_REQUEST',
    ).length;

    fireEvent.click(retry);

    // Retry re-fires the SAME promote bridge message (the existing hook action) — never a new call path.
    await waitFor(() => {
      const after = postToParent.mock.calls.filter(
        (c) => (c[0] as { type?: string }).type === 'PS_PROMOTE_REQUEST',
      ).length;
      expect(after).toBe(before + 1);
    });

    // The retried message carries the SAME frozen draft revision + tree digest (idempotent replay).
    const promoteCalls = postToParent.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'PS_PROMOTE_REQUEST',
    );
    const lastMsg = promoteCalls[promoteCalls.length - 1][0] as { draftRevision: number; treeDigest: string };
    expect(lastMsg.draftRevision).toBe(7);
    expect(lastMsg.treeDigest).toBe('digest-7');
  });

  /*
   * History-tab serving_sha chip (Lane 1 Slice 6b, editor half) — each release row that carries a
   * `serving_sha` renders a 12-char proof-of-serving chip (monospace, click-to-copy, aria-labelled),
   * reusing the ReleaseOutcomeCard chip styling. A row WITHOUT a sha (older / pre-migration / deploy-failed)
   * renders NO chip — never a dead/empty chip.
   */
  it('renders a 12-char serving_sha chip on a History release row that has one', async () => {
    baseReply([]);
    seedWorkingTree([]);
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', {
      ok: true,
      releases: [
        {
          id: 'r-served',
          commit_sha: 'abc1234',
          artifact_digest: 'art',
          deployment_id: 'v2026',
          serving_sha: 'deadbeef1234feedface5678',
          actor: 'owner@example.com',
          draft_revision: 4,
          outcome: 'success',
          created_at: '2026-09-29T13:00:00Z',
        },
      ],
    });

    render(<SourceControlPanel />);
    fireEvent.click(screen.getByTestId('sc-tab-history'));

    await waitFor(() => expect(screen.getByTestId('sc-history-list')).toBeTruthy());

    const chip = await screen.findByTestId('sc-release-sha');

    // Only the 12-char prefix shows — never the trailing half.
    expect(chip.textContent).toContain('deadbeef1234');
    expect(chip.textContent).not.toContain('feedface5678');

    // Click-to-copy is keyboard-reachable + labelled.
    const copyBtn = screen.getByTestId('sc-release-sha-copy');
    expect(copyBtn.getAttribute('aria-label')).toMatch(/copy/i);
  });

  it('renders NO serving_sha chip on a History row whose serving_sha is null', async () => {
    baseReply([]);
    seedWorkingTree([]);
    setReply('PS_PREVIEW_STATE_REQUEST', { ok: true, working_tree: null });
    setReply('PS_RELEASES_REQUEST', {
      ok: true,
      releases: [
        {
          id: 'r-nosha',
          commit_sha: 'abc1234',
          artifact_digest: 'art',
          deployment_id: 'v2026',
          serving_sha: null,
          actor: 'owner@example.com',
          draft_revision: 4,
          outcome: 'commit_ok_deploy_failed',
          created_at: '2026-09-29T13:00:00Z',
        },
      ],
    });

    render(<SourceControlPanel />);
    fireEvent.click(screen.getByTestId('sc-tab-history'));

    await waitFor(() => expect(screen.getByTestId('sc-history-list')).toBeTruthy());
    expect(screen.getAllByTestId('sc-release-row')).toHaveLength(1);

    // A null serving_sha row renders NO chip (never a dead/empty chip).
    expect(screen.queryByTestId('sc-release-sha')).toBeNull();
  });
});
