/**
 * @file Source Control — an inspect + restore window on the site's PREVIEW working tree (Slice 4).
 *
 * @remarks
 * This panel sits BESIDE the file explorer in the Code view (a fourth tab next to Files · Search ·
 * Locks in {@link EditorPanel}). It is the "what have I changed, and what's live?" surface of the
 * Preview → Promote → Production release model — a READ/INSPECT + RESTORE view only.
 *
 * INVARIANTS (never violated here):
 *   - The editor always presents `main`. Preview is an UNCOMMITTED working tree based on main (not a branch).
 *   - Save/generate → Preview only; Restore targets PREVIEW only (opens the last-published main-base copy
 *     back into the workbench, exactly like picking it in the tree — no commit, no deploy).
 *   - The ONLY Production mutation is the Promote button, whose state machine + gate + `PS_PROMOTE_REQUEST`
 *     write live in the SHARED {@link ./use-promote} hook — the SAME hook the editor's main-header
 *     {@link ./PromoteHeaderControl} consumes, so the two never diverge (one promote path, never forked).
 *
 * DATA SOURCES:
 *   - CHANGED FILES = a diff of the PREVIEW working tree against the last-published MAIN BASE. The Preview
 *     side is the editor's OWN live `workbenchStore.files` (read locally — no bridge — so the diff recomputes
 *     as the user edits); the base comes over the existing read-only `PS_CODE_TREE_REQUEST` bridge. The pure
 *     diff lives in {@link diffWorkingTree} (unit-tested in `git-browser-logic.spec.ts`). Byte-size is the
 *     change signal (a conservative, honest "changed" — never a false positive when sizes match).
 *   - RELEASE HISTORY + PREVIEW STATE = the new durable-preview worker API, fetched through the
 *     `PS_RELEASES_REQUEST` / `PS_PREVIEW_STATE_REQUEST` bridges (parent-session bridge pattern, like the
 *     Database tab — the embedded editor has no cross-origin session, so the admin makes the authed call and
 *     replies; never a direct cross-origin worker call). DARK behind `durable_preview` (a 404 whose message
 *     includes "not enabled" → an honest "not published yet", never a scary error).
 *   - RESTORE = fetch the last-published copy over the read-only `PS_CODE_FILE_REQUEST` bridge, then write it
 *     into Preview via `workbenchStore.setVirtualFile` (embedded-safe local write). Preview-only, never a commit.
 *
 * REUSE (per the DatabasePanel precedent): all branchy logic is the preserved {@link ./git-browser-logic}
 * (diff, counts, badges, sync summary, `shortSha`, `formatCommitDate`, `formatBytes`); the branded
 * button/state primitives + bridge request pattern mirror {@link ./GitPanel}. Zero new hardcoded colors —
 * cyan `--bolt-elements-item-contentAccent` is the accent, purple `--ps-accent-secondary` the structural one.
 */
import { useStore } from '@nanostores/react';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { classNames } from '~/utils/classNames';
import { workbenchStore } from '~/lib/stores/workbench';
import { WORK_DIR } from '~/utils/constants';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ChildToParentMessage,
  type ParentToChildMessage,
  type CodeTreeResponseMessage,
  type CodeFileResponseMessage,
  type PreviewStateResponseMessage,
  type ReleasesResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  diffWorkingTree,
  countChanges,
  statusBadge,
  statusLabel,
  summarizePreviewSync,
  syncLabel,
  releaseOutcomeLabel,
  shortSha,
  formatCommitDate,
  formatBytes,
  type CodeFileEntry,
  type WorkingFile,
  type FileChange,
  type ChangeStatus,
  type PreviewWorkingTree,
  type ReleaseRecord,
  type SyncSummary,
} from './git-browser-logic';
import { usePromote, type PromoteState, type PromoteLastResult } from './use-promote';

// ── Constants ────────────────────────────────────────────────────────────────

/** Purple structural accent (never a hardcoded hex) — mirrors GitPanel; tracks `--ps-accent-secondary`. */
const PURPLE = 'var(--ps-accent-secondary)';

/** How long to wait for a bridge reply before rejecting (mirrors GitPanel). */
const REQUEST_TIMEOUT_MS = 20_000;

/** Monotonic fallback correlationId counter (crypto.randomUUID preferred). */
let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `sc_${++correlationCounter}`;
}

/**
 * Response-type each request awaits — the bridge answers async, matched by `correlationId`. The Preview
 * working tree comes from the editor's OWN `workbenchStore` (not the bridge), so only the base tree, one
 * base file (for restore), and the durable-preview API travel over the bridge.
 */
const RESPONSE_FOR: Record<string, ParentToChildMessage['type']> = {
  PS_CODE_TREE_REQUEST: 'PS_CODE_TREE_RESPONSE',
  PS_CODE_FILE_REQUEST: 'PS_CODE_FILE_RESPONSE',
  PS_PREVIEW_STATE_REQUEST: 'PS_PREVIEW_STATE_RESPONSE',
  PS_RELEASES_REQUEST: 'PS_RELEASES_RESPONSE',
  PS_PROMOTE_REQUEST: 'PS_PROMOTE_RESPONSE',
};

/**
 * Read the editor's Preview working tree from its OWN `workbenchStore.files` (a `FileMap`). Strips the
 * `WORK_DIR/` prefix so paths line up with the published base, computes the UTF-8 byte size of each text
 * file's content (the diff's change signal), and skips folders + binary/undefined entries.
 */
function workingFilesFromStore(
  files: Record<string, { type?: string; content?: string; isBinary?: boolean } | undefined>,
): {
  path: string;
  size: number;
}[] {
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const out: { path: string; size: number }[] = [];
  const prefix = `${WORK_DIR}/`;

  for (const [key, dirent] of Object.entries(files)) {
    if (!dirent || dirent.type !== 'file') {
      continue;
    }

    const path = key.startsWith(prefix) ? key.slice(prefix.length) : key.replace(/^\/+/, '');

    if (!path) {
      continue;
    }

    const content = dirent.content ?? '';
    const size = encoder ? encoder.encode(content).length : content.length;
    out.push({ path, size });
  }

  return out;
}

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Shared branded button primitives (mirrors GitPanel — color-complete, zero white) ──────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

const BASE_BTN =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium select-none ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 ' +
  'focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent ' +
  'active:translate-y-px disabled:cursor-not-allowed disabled:active:translate-y-0 ' +
  'motion-reduce:transition-none motion-reduce:active:translate-y-0';

const VARIANT_BTN: Record<ButtonVariant, string> = {
  primary:
    'cursor-pointer bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 ' +
    'shadow-[0_2px_10px_-3px_rgba(0,229,255,0.55)] hover:shadow-[0_4px_18px_-4px_rgba(0,229,255,0.7)] ' +
    'hover:brightness-110 disabled:opacity-60 disabled:shadow-none disabled:hover:brightness-100',
  secondary:
    'cursor-pointer border border-bolt-elements-item-contentAccent/45 bg-bolt-elements-background-depth-2 ' +
    'text-bolt-elements-item-contentAccent hover:border-bolt-elements-item-contentAccent ' +
    'hover:bg-bolt-elements-item-contentAccent/10 disabled:opacity-60 disabled:border-bolt-elements-borderColor ' +
    'disabled:bg-bolt-elements-background-depth-2 disabled:text-bolt-elements-textTertiary disabled:hover:bg-bolt-elements-background-depth-2',
  ghost:
    'cursor-pointer border border-transparent bg-transparent text-bolt-elements-textSecondary ' +
    'hover:text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 ' +
    'hover:border-bolt-elements-item-contentAccent/30 disabled:opacity-60 disabled:text-bolt-elements-textTertiary ' +
    'disabled:hover:bg-transparent disabled:hover:border-transparent',
  destructive:
    'cursor-pointer border border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/70 ' +
    'hover:bg-red-500/20 disabled:opacity-60',
};

const Button = memo(
  ({
    variant = 'secondary',
    icon,
    children,
    className,
    ...rest
  }: {
    variant?: ButtonVariant;
    icon?: string;
    children: React.ReactNode;
    className?: string;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" className={classNames(BASE_BTN, VARIANT_BTN[variant], className)} {...rest}>
      {icon && <div className={classNames(icon, 'shrink-0')} aria-hidden="true" />}
      {children}
    </button>
  ),
);

Button.displayName = 'SourceControl.Button';

const IconButton = memo(
  ({
    variant = 'ghost',
    icon,
    label,
    className,
    ...rest
  }: {
    variant?: ButtonVariant;
    icon: string;
    label: string;
    className?: string;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'>) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={classNames(BASE_BTN, VARIANT_BTN[variant], 'min-h-[26px] min-w-[26px] p-0', className)}
      {...rest}
    >
      <div className={classNames(icon, 'text-sm')} aria-hidden="true" />
    </button>
  ),
);

IconButton.displayName = 'SourceControl.IconButton';

// ── State machines ─────────────────────────────────────────────────────────────

type Tab = 'changes' | 'history';

type ChangesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; changes: FileChange[]; version: string | null };

type HistoryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; releases: ReleaseRecord[]; previewTree: PreviewWorkingTree | null; disabled: boolean };

/*
 * The Promote → Production state machine ({@link PromoteState}) + gate + `doPromote` now live in the
 * SHARED {@link usePromote} hook, consumed by BOTH this panel and the editor's main-header
 * {@link PromoteHeaderControl}. There is exactly one promote path — it is never forked here.
 */

// ── Per-status color tokens for the change badges (cyan/green/red/purple — no raw hex) ─────────────

const STATUS_TONE: Record<ChangeStatus, string> = {
  added: 'text-emerald-300 border-emerald-400/40 bg-emerald-400/10',
  modified:
    'text-bolt-elements-item-contentAccent border-bolt-elements-item-contentAccent/40 bg-bolt-elements-item-contentAccent/10',
  deleted: 'text-red-300 border-red-400/40 bg-red-400/10',
  renamed: 'text-violet-300 border-violet-400/40 bg-violet-400/10',
};

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * Source Control view — changed-file inspection + release history + Preview↔Production sync, beside the
 * file explorer. Read/inspect + restore-to-Preview only; NO Promote here (later slice).
 */
export const SourceControlPanel = memo(() => {
  const [tab, setTab] = useState<Tab>('changes');
  const [changes, setChanges] = useState<ChangesState>({ status: 'loading' });
  const [history, setHistory] = useState<HistoryState>({ status: 'idle' });

  /**
   * The editor's OWN Preview working tree (its live in-memory files). This is the authoritative Preview
   * source — save/generate mutate THIS, so the diff recomputes automatically as the user edits.
   */
  const workbenchFiles = useStore(workbenchStore.files);

  /** Preview↔Production sync summary (loaded alongside history; header badge). */
  const [sync, setSync] = useState<SyncSummary | null>(null);

  /** The path currently being restored (disables its row button + shows a spinner). */
  const [restoring, setRestoring] = useState<string | null>(null);

  /** Transient "restored" confirmation path (optimistic feedback). */
  const [restored, setRestored] = useState<string | null>(null);

  /*
   * The SHARED promote flow — the SAME hook the editor's main-header {@link PromoteHeaderControl}
   * consumes. It owns the state machine + the disabled-WITH-reason gate + the `PS_PROMOTE_REQUEST` write,
   * so this panel and the header can never diverge. `promoteSync` is the hook's own sync summary; the
   * panel keeps its `sync` state for the header badge but reconciles the two below.
   */
  const { promote, lastResult, canPromote, promoteReason, doPromote, dismiss: dismissPromote } = usePromote();

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  /*
   * ONE parent-message listener + a live pending map (mirrors GitPanel — avoids the repo's known
   * empty-deps stale-ref bug). Each request awaits the reply whose `type` matches the request's expected
   * response AND whose `correlationId` matches.
   */
  const pendingRef = useRef<Map<string, Pending>>(new Map());

  /** Send a bridge message + await the reply matched by correlationId (rejects on timeout). */
  const request = useCallback(
    (message: ChildToParentMessage & { correlationId: string }): Promise<ParentToChildMessage> => {
      return new Promise<ParentToChildMessage>((resolve, reject) => {
        const { correlationId } = message;
        const timer = setTimeout(() => {
          pendingRef.current.delete(correlationId);
          reject(new Error('The request timed out. Check the admin connection and retry.'));
        }, REQUEST_TIMEOUT_MS);

        pendingRef.current.set(correlationId, { resolve, reject, timer });
        postToParent(message);
      });
    },
    [],
  );

  useEffect(() => {
    const wanted = new Set(Object.values(RESPONSE_FOR));

    const unsubscribe = onParentMessage((msg) => {
      if (!wanted.has(msg.type)) {
        return;
      }

      const correlationId = (msg as { correlationId?: string }).correlationId;

      if (!correlationId) {
        return;
      }

      const pending = pendingRef.current.get(correlationId);

      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      pendingRef.current.delete(correlationId);
      pending.resolve(msg);
    });

    return () => {
      unsubscribe();

      for (const [, pending] of pendingRef.current) {
        clearTimeout(pending.timer);
        pending.reject(new Error('cancelled'));
      }

      pendingRef.current.clear();
    };
  }, []);

  /**
   * Load the change set: fetch the published MAIN BASE (`PS_CODE_TREE_REQUEST`) over the bridge, then diff
   * it against the editor's OWN live Preview working tree (`workbenchStore.files`). The working side is
   * read locally (no bridge) because the editor already holds it — and re-diffs whenever the user edits.
   */
  const loadChanges = useCallback(async () => {
    setChanges({ status: 'loading' });

    if (!isEmbedded) {
      setChanges({ status: 'error', message: 'Open this from the ProjectSites admin to review changes.' });
      return;
    }

    try {
      const baseReply = (await request({
        type: 'PS_CODE_TREE_REQUEST',
        correlationId: nextCorrelationId(),
      })) as CodeTreeResponseMessage;

      if (!baseReply.ok) {
        if (!mounted.current) {
          return;
        }

        setChanges({ status: 'error', message: baseReply.error || 'Could not load your published build.' });

        return;
      }

      const base: CodeFileEntry[] = (baseReply.files ?? []).map((f) => ({
        key: f.key,
        name: f.name,
        size: f.size,
        uploaded: f.uploaded,
        content_type: f.content_type,
      }));
      const working: WorkingFile[] = workingFilesFromStore(workbenchFiles);

      if (!mounted.current) {
        return;
      }

      setChanges({ status: 'ready', changes: diffWorkingTree(working, base), version: baseReply.version ?? null });
    } catch (err) {
      if (!mounted.current) {
        return;
      }

      setChanges({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your changes.' });
    }
  }, [request, workbenchFiles]);

  /**
   * Load release history + the Preview working-tree record from the durable-preview API (both via the
   * parent-session bridge). A dark `durable_preview` flag (`enabled:false`) → an honest "not published"
   * empty, never an error.
   */
  const loadHistory = useCallback(async () => {
    setHistory({ status: 'loading' });

    if (!isEmbedded) {
      setHistory({ status: 'error', message: 'Open this from the ProjectSites admin to view history.' });
      return;
    }

    try {
      const [releasesReply, previewReply] = (await Promise.all([
        request({ type: 'PS_RELEASES_REQUEST', correlationId: nextCorrelationId() }),
        request({ type: 'PS_PREVIEW_STATE_REQUEST', correlationId: nextCorrelationId() }),
      ])) as [ReleasesResponseMessage, PreviewStateResponseMessage];

      // A dark flag (enabled:false) is NOT an error — it's an honest "not published yet".
      const disabled = releasesReply.enabled === false || previewReply.enabled === false;

      if (!releasesReply.ok && !disabled) {
        if (!mounted.current) {
          return;
        }

        setHistory({ status: 'error', message: releasesReply.error || 'Could not load release history.' });

        return;
      }

      const releases: ReleaseRecord[] = (releasesReply.releases ?? []).map((r) => ({ ...r }));
      const previewTree: PreviewWorkingTree | null = previewReply.working_tree
        ? { ...previewReply.working_tree }
        : null;

      if (!mounted.current) {
        return;
      }

      setHistory({ status: 'ready', releases, previewTree, disabled });
      setSync(summarizePreviewSync(previewTree, releases));
    } catch (err) {
      if (!mounted.current) {
        return;
      }

      setHistory({ status: 'error', message: err instanceof Error ? err.message : 'Could not load history.' });
    }
  }, [request]);

  // On mount: load changes AND (eagerly) the sync summary so the header badge is populated immediately.
  useEffect(() => {
    void loadChanges();
    void loadHistory();
  }, [loadChanges, loadHistory]);

  /**
   * Restore a file to PREVIEW — fetch the last-published (main-base) copy over the read-only
   * `PS_CODE_FILE_REQUEST` bridge, then write it into the editor's OWN working tree via
   * `workbenchStore.setVirtualFile` (the embedded-safe local write that bypasses the container). This is a
   * Preview-ONLY action: it mutates the uncommitted working tree, and NEVER commits, deploys, or changes
   * Production. (Deleted files can't be restored this way — the button is only offered for added/modified/renamed.)
   */
  const restoreToPreview = useCallback(
    async (path: string) => {
      setRestoring(path);

      try {
        const reply = (await request({
          type: 'PS_CODE_FILE_REQUEST',
          correlationId: nextCorrelationId(),
          path,
        })) as CodeFileResponseMessage;

        if (!mounted.current) {
          return;
        }

        if (!reply.ok) {
          // Surface the failure inline on the row's transient slot; the change list itself stays intact.
          setRestoring((cur) => (cur === path ? null : cur));
          return;
        }

        // Preview-only write: the working tree now matches the last-published copy. No commit, no deploy.
        workbenchStore.setVirtualFile(path, reply.content ?? '');

        setRestoring((cur) => (cur === path ? null : cur));
        setRestored(path);
        window.setTimeout(() => {
          if (mounted.current) {
            setRestored((cur) => (cur === path ? null : cur));
          }
        }, 1800);
      } catch {
        if (!mounted.current) {
          return;
        }

        setRestoring((cur) => (cur === path ? null : cur));
      }
    },
    [request],
  );

  /*
   * When the SHARED promote flow lands a Production-affecting outcome, refresh THIS panel's own timeline
   * + sync badge so the new release + Preview↔Production state show immediately (the hook already
   * reloaded its OWN state). Keyed on the terminal status so it fires once per settle, not every render.
   */
  const lastPromoteStatus = useRef<PromoteState['status']>('idle');
  useEffect(() => {
    if (
      promote.status !== lastPromoteStatus.current &&
      (promote.status === 'success' || promote.status === 'commit_ok_deploy_failed')
    ) {
      void loadHistory();
    }

    lastPromoteStatus.current = promote.status;
  }, [promote.status, loadHistory]);

  const counts = useMemo(() => (changes.status === 'ready' ? countChanges(changes.changes) : null), [changes]);

  return (
    <div
      className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary"
      data-testid="source-control-panel"
    >
      <Header
        tab={tab}
        onTab={setTab}
        count={counts?.total ?? null}
        version={changes.status === 'ready' ? changes.version : null}
        sync={sync}
        onRefresh={() => (tab === 'changes' ? void loadChanges() : void loadHistory())}
        promote={promote}
        canPromote={canPromote}
        promoteReason={promoteReason}
        onPromote={doPromote}
        onPromoteRetry={doPromote}
        onPromoteDismiss={dismissPromote}
      />

      {/* Release-outcome card (Slice 6b) — renders the settled promote response; Retry re-fires the SAME hook. */}
      <ReleaseOutcomeCard result={lastResult} onRetry={doPromote} onDismiss={dismissPromote} />

      {tab === 'changes' ? (
        <ChangesView
          state={changes}
          counts={counts}
          restoring={restoring}
          restored={restored}
          onRestore={restoreToPreview}
          onRetry={() => void loadChanges()}
        />
      ) : (
        <HistoryView state={history} onRetry={() => void loadHistory()} />
      )}

      {/* Panel-scoped keyframes — precedence-tagged so React 19 hoists them (never a string-child <style>). */}
      <SourceControlKeyframes />
    </div>
  );
});

SourceControlPanel.displayName = 'SourceControlPanel';

const SourceControlKeyframes = memo(() => (
  // @ts-expect-error React 19 `precedence` on <style> is valid but not yet in the DOM lib types.
  <style precedence="sourcecontrol">{`
    @keyframes sc-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes sc-slide-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes sc-dot-in { from { opacity: 0; transform: scale(0.4); } to { opacity: 1; transform: none; } }
  `}</style>
));

SourceControlKeyframes.displayName = 'SourceControl.Keyframes';

// ── Header (title + Changes/History control + refresh + sync badge) ───────────

const Header = memo(
  ({
    tab,
    onTab,
    count,
    version,
    sync,
    onRefresh,
    promote,
    canPromote,
    promoteReason,
    onPromote,
    onPromoteRetry,
    onPromoteDismiss,
  }: {
    tab: Tab;
    onTab: (t: Tab) => void;
    count: number | null;
    version: string | null;
    sync: SyncSummary | null;
    onRefresh: () => void;
    promote: PromoteState;
    canPromote: boolean;
    promoteReason: string;
    onPromote: () => void;
    onPromoteRetry: () => void;
    onPromoteDismiss: () => void;
  }) => (
    <div
      className={classNames(
        'flex flex-col gap-2 px-3 py-2.5 shrink-0 border-b border-bolt-elements-borderColor',
        'bg-gradient-to-b from-bolt-elements-background-depth-2 to-bolt-elements-background-depth-1',
      )}
    >
      <div className="flex items-center gap-2.5">
        <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/10">
          <div className="i-ph:git-diff-duotone text-base text-bolt-elements-item-contentAccent" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold leading-tight text-bolt-elements-textPrimary tracking-tight">
            Source Control
          </h2>
          <p className="text-[10px] leading-tight text-bolt-elements-textTertiary truncate">
            {tab === 'changes'
              ? count !== null
                ? count > 0
                  ? `${count} change${count === 1 ? '' : 's'} in Preview${version ? ` · vs ${version}` : ''}`
                  : `Preview matches your published build${version ? ` · ${version}` : ''}`
                : 'Your Preview working tree'
              : 'Release history · your Production timeline'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <div
            className="flex items-center rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-0.5"
            role="tablist"
            aria-label="Source Control view"
          >
            {(['changes', 'history'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => onTab(t)}
                data-testid={`sc-tab-${t}`}
                className={classNames(
                  'min-h-[26px] rounded-[7px] px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer',
                  'transition-[background-color,color,box-shadow] duration-150 motion-reduce:transition-none',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
                  tab === t
                    ? 'bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 shadow-[0_1px_8px_-2px_rgba(0,229,255,0.55)]'
                    : 'text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10',
                )}
              >
                <div
                  className={t === 'changes' ? 'i-ph:git-diff-bold' : 'i-ph:rocket-launch-bold'}
                  aria-hidden="true"
                />
                <span className="min-w-[7ch] text-center">{t === 'changes' ? 'Changes' : 'History'}</span>
              </button>
            ))}
          </div>
          <PromoteButton
            promote={promote}
            canPromote={canPromote}
            promoteReason={promoteReason}
            onPromote={onPromote}
          />
          <IconButton icon="i-ph:arrows-clockwise" label="Refresh" variant="secondary" onClick={onRefresh} />
        </div>
      </div>

      <SyncIndicator sync={sync} />
      <PromoteStatus promote={promote} onRetry={onPromoteRetry} onDismiss={onPromoteDismiss} />
    </div>
  ),
);

Header.displayName = 'SourceControl.Header';

/**
 * The cyan "Promote to Production" button (Slice 5). One obvious primary action; disabled WITH a reason
 * (title + aria) when nothing is promotable — never a dead/doomed control (embarrassingly-easy-to-use).
 * The label reserves its widest width so it never resizes between idle/submitting.
 */
const PromoteButton = memo(
  ({
    promote,
    canPromote,
    promoteReason,
    onPromote,
  }: {
    promote: PromoteState;
    canPromote: boolean;
    promoteReason: string;
    onPromote: () => void;
  }) => {
    const submitting = promote.status === 'submitting';
    const disabled = submitting || !canPromote;

    // Disabled → surface WHY (title + aria) so the control is never a silent dead end.
    const reason = submitting
      ? 'Publishing to Production…'
      : canPromote
        ? 'Publish your Preview to Production'
        : promoteReason;

    return (
      <Button
        variant="primary"
        icon={submitting ? 'i-svg-spinners:90-ring-with-bg' : 'i-ph:rocket-launch-bold'}
        onClick={onPromote}
        disabled={disabled}
        aria-disabled={disabled}
        title={reason}
        aria-label={reason}
        data-testid="promote-to-production"
        className="min-h-[26px] px-2.5 text-[11px]"
      >
        {/* Reserve the widest label ("Promote" | "Publishing…") so the button never resizes. */}
        <span className="min-w-[9ch] text-center">{submitting ? 'Publishing…' : 'Promote'}</span>
      </Button>
    );
  },
);

PromoteButton.displayName = 'SourceControl.PromoteButton';

/**
 * The Promote status region (Slice 5) — the honest terminal outcome. Success is a quiet confirmation;
 * `failed` / `commit_ok_deploy_failed` show an inline Retry (per the honest-outcome retry surface).
 * Renders nothing while idle. `role="status"` + `aria-live` so screen readers announce the result.
 */
const PromoteStatus = memo(
  ({ promote, onRetry, onDismiss }: { promote: PromoteState; onRetry: () => void; onDismiss: () => void }) => {
    if (promote.status === 'idle') {
      return null;
    }

    const submitting = promote.status === 'submitting';
    const success = promote.status === 'success';
    const retryable = promote.status === 'failed' || promote.status === 'commit_ok_deploy_failed';

    const tone = submitting
      ? 'border-bolt-elements-item-contentAccent/40 bg-bolt-elements-item-contentAccent/10 text-bolt-elements-item-contentAccent'
      : success
        ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
        : promote.status === 'commit_ok_deploy_failed'
          ? 'border-amber-400/40 bg-amber-400/10 text-amber-200'
          : 'border-red-400/40 bg-red-400/10 text-red-300';

    const icon = submitting
      ? 'i-svg-spinners:90-ring-with-bg'
      : success
        ? 'i-ph:check-circle-fill'
        : promote.status === 'commit_ok_deploy_failed'
          ? 'i-ph:warning-fill'
          : 'i-ph:x-circle-fill';

    const message = submitting
      ? 'Publishing your Preview to Production…'
      : success
        ? promote.idempotent
          ? 'Already live — Production is up to date.'
          : 'Published! Production is now serving your Preview.'
        : promote.message;

    return (
      <div
        data-testid="promote-status"
        role="status"
        aria-live="polite"
        className={classNames(
          'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium',
          'animate-[sc-fade-in_0.2s_ease-out] motion-reduce:animate-none',
          tone,
        )}
      >
        <div className={classNames(icon, 'shrink-0 text-sm')} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{message}</span>
        {retryable && (
          <button
            type="button"
            onClick={onRetry}
            data-testid="promote-retry"
            className={classNames(
              'shrink-0 inline-flex items-center gap-1 rounded-md border border-current/40 px-1.5 py-0.5',
              'text-[10px] font-semibold uppercase tracking-wide cursor-pointer',
              'hover:bg-current/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current',
              'transition-[background-color] duration-150 motion-reduce:transition-none',
            )}
          >
            <div className="i-ph:arrow-clockwise-bold text-[10px]" aria-hidden="true" /> Retry
          </button>
        )}
        {success && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            title="Dismiss"
            className="shrink-0 i-ph:x text-sm opacity-70 hover:opacity-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current rounded"
          />
        )}
      </div>
    );
  },
);

PromoteStatus.displayName = 'SourceControl.PromoteStatus';

/** Copy `text` to the clipboard (async API, guarded) → true on success. Never throws to the caller. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);

      return true;
    }
  } catch {
    // fall through — a copy failure is non-fatal; the sha stays visible + selectable.
  }

  return false;
}

/**
 * Release-outcome card (Slice 6b) — RENDERS the settled promote response so the worker's proof-of-serving
 * `serving_sha` is finally surfaced (it was computed-but-unrendered). Hidden until a promote settles.
 *   - success → green "Live" badge + a 12-char serving_sha prefix chip (monospace, click-to-copy) +
 *     "Production serving <sha>".
 *   - commit_ok_deploy_failed → amber badge + a Retry that re-fires the SAME promote via the hook action.
 *   - failed → red badge + Retry.
 * Dark cyan, keyboard-reachable, aria-labelled. Behind the SAME durable_preview gate the panel uses (the
 * gate lives in usePromote; a dark flag never yields a lastResult).
 */
const ReleaseOutcomeCard = memo(
  ({
    result,
    onRetry,
    onDismiss,
  }: {
    result: PromoteLastResult | null;
    onRetry: () => void;
    onDismiss: () => void;
  }) => {
    const [copied, setCopied] = useState(false);
    const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
      () => () => {
        if (copyResetRef.current) {
          clearTimeout(copyResetRef.current);
        }
      },
      [],
    );

    const servingSha = result?.servingSha ?? null;

    const onCopy = useCallback(async () => {
      if (!servingSha) {
        return;
      }

      const ok = await copyToClipboard(servingSha);

      if (ok) {
        setCopied(true);

        if (copyResetRef.current) {
          clearTimeout(copyResetRef.current);
        }

        copyResetRef.current = setTimeout(() => setCopied(false), 1600);
      }
    }, [servingSha]);

    // Hidden until a promote has settled (the empty state — no dead/doomed control).
    if (!result) {
      return null;
    }

    const success = result.outcome === 'success';
    const deployFailed = result.outcome === 'commit_ok_deploy_failed';
    const retryable = !success;

    const tone = success
      ? 'border-emerald-400/40 bg-emerald-400/[0.08]'
      : deployFailed
        ? 'border-amber-400/40 bg-amber-400/[0.08]'
        : 'border-red-400/40 bg-red-400/[0.08]';

    const badgeTone = success
      ? 'border-emerald-400/50 bg-emerald-400/15 text-emerald-300'
      : deployFailed
        ? 'border-amber-400/50 bg-amber-400/15 text-amber-200'
        : 'border-red-400/50 bg-red-400/15 text-red-300';

    const badgeIcon = success ? 'i-ph:broadcast-fill' : deployFailed ? 'i-ph:warning-fill' : 'i-ph:x-circle-fill';
    const badgeLabel = success ? 'Live' : deployFailed ? 'Deploy failed' : 'Failed';

    // The serving-SHA proof is a 12-char prefix (a proof-of-serving receipt, distinct from a 7-char git shortSha).
    const shaPrefix = servingSha ? servingSha.slice(0, 12) : null;

    return (
      <div
        data-testid="sc-release-outcome"
        role="status"
        aria-live="polite"
        className={classNames(
          'mx-3 mt-2 flex flex-col gap-2 rounded-xl border px-3 py-2.5 shrink-0',
          'animate-[sc-slide-up_0.22s_ease-out] motion-reduce:animate-none',
          tone,
        )}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={classNames(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
              badgeTone,
            )}
          >
            <div className={classNames(badgeIcon, 'text-[11px]')} aria-hidden="true" />
            {badgeLabel}
          </span>

          {success && shaPrefix && (
            <span className="inline-flex items-center gap-1 text-[11px] text-bolt-elements-textSecondary">
              Production serving
            </span>
          )}

          {success && shaPrefix && (
            <span
              data-testid="sc-serving-sha"
              className="inline-flex items-center gap-1.5 rounded-md border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/10 pl-1.5 pr-1 py-0.5"
            >
              <code
                className="font-mono text-[11px] tabular-nums text-bolt-elements-item-contentAccent"
                title={servingSha ?? undefined}
              >
                {shaPrefix}
              </code>
              <button
                type="button"
                onClick={() => void onCopy()}
                data-testid="sc-serving-sha-copy"
                aria-label={copied ? 'Serving SHA copied' : 'Copy the full serving SHA'}
                title={copied ? 'Copied' : 'Copy the full serving SHA'}
                className={classNames(
                  'inline-flex h-[18px] w-[18px] items-center justify-center rounded cursor-pointer',
                  'text-bolt-elements-item-contentAccent/80 hover:text-bolt-elements-item-contentAccent',
                  'hover:bg-bolt-elements-item-contentAccent/15 focus-visible:outline-none focus-visible:ring-2',
                  'focus-visible:ring-bolt-elements-item-contentAccent transition-colors duration-150 motion-reduce:transition-none',
                )}
              >
                <div className={classNames(copied ? 'i-ph:check-bold' : 'i-ph:copy', 'text-[11px]')} aria-hidden="true" />
              </button>
            </span>
          )}

          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss release outcome"
            title="Dismiss"
            data-testid="sc-release-outcome-dismiss"
            className="ml-auto shrink-0 i-ph:x text-sm opacity-70 hover:opacity-100 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current rounded"
          />
        </div>

        {retryable && (
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-[11px] text-bolt-elements-textSecondary">
              {deployFailed
                ? 'Your changes committed but the deploy did not go live. Retry to finish publishing.'
                : 'The promotion did not complete. Retry to publish to Production.'}
            </span>
            <button
              type="button"
              onClick={onRetry}
              data-testid="sc-release-outcome-retry"
              aria-label="Retry publishing to Production"
              title="Retry publishing to Production"
              className={classNames(
                'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-0.5',
                'text-[10px] font-semibold uppercase tracking-wide cursor-pointer',
                deployFailed
                  ? 'border-amber-400/50 text-amber-200 hover:bg-amber-400/15'
                  : 'border-red-400/50 text-red-300 hover:bg-red-400/15',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current',
                'transition-[background-color] duration-150 motion-reduce:transition-none',
              )}
            >
              <div className="i-ph:arrow-clockwise-bold text-[10px]" aria-hidden="true" /> Retry
            </button>
          </div>
        )}
      </div>
    );
  },
);

ReleaseOutcomeCard.displayName = 'SourceControl.ReleaseOutcomeCard';

/** Preview↔Production sync badge — always honest (never a false "in sync"), + a deploy-failed retry hint. */
const SyncIndicator = memo(({ sync }: { sync: SyncSummary | null }) => {
  const tone =
    !sync || sync.state === 'unknown'
      ? 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary'
      : sync.state === 'in_sync'
        ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
        : sync.state === 'preview_ahead'
          ? 'border-bolt-elements-item-contentAccent/40 bg-bolt-elements-item-contentAccent/10 text-bolt-elements-item-contentAccent'
          : 'border-violet-400/40 bg-violet-400/10 text-violet-200';

  const icon =
    !sync || sync.state === 'unknown'
      ? 'i-ph:question'
      : sync.state === 'in_sync'
        ? 'i-ph:check-circle-fill'
        : sync.state === 'preview_ahead'
          ? 'i-ph:arrow-fat-lines-up-fill'
          : 'i-ph:cloud-slash';

  return (
    <div
      data-testid="sc-sync-indicator"
      role="status"
      className={classNames(
        'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium',
        'animate-[sc-fade-in_0.2s_ease-out] motion-reduce:animate-none',
        tone,
      )}
    >
      <div className={classNames(icon, 'shrink-0 text-sm')} aria-hidden="true" />
      <span className="min-w-0 truncate">{syncLabel(sync?.state ?? 'unknown')}</span>
      {sync?.previewSha && (
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums opacity-90" title="Preview base commit">
          Preview {shortSha(sync.previewSha)}
        </span>
      )}
      {sync?.productionSha && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums opacity-75" title="Live Production commit">
          → Prod {shortSha(sync.productionSha)}
        </span>
      )}
      {sync?.deployFailed && (
        <span
          className="shrink-0 inline-flex items-center gap-1 rounded-full border border-red-400/40 bg-red-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-300"
          title="The last release committed but its deploy failed"
        >
          <div className="i-ph:warning-fill text-[9px]" aria-hidden="true" /> deploy failed
        </span>
      )}
    </div>
  );
});

SyncIndicator.displayName = 'SourceControl.SyncIndicator';

// ── Shared spinner + error + empty scaffold (mirrors GitPanel) ────────────────

const Spinner = memo(({ label, testId }: { label: string; testId?: string }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center animate-[sc-fade-in_0.2s_ease-out] motion-reduce:animate-none"
    data-testid={testId}
  >
    <div className="relative h-10 w-10">
      <div className="absolute inset-0 rounded-full border-2 border-bolt-elements-item-contentAccent/15" />
      <div className="i-ph:circle-notch absolute inset-0 text-[2.5rem] leading-none text-bolt-elements-item-contentAccent motion-safe:animate-spin" />
    </div>
    <p className="text-xs text-bolt-elements-textSecondary">{label}</p>
  </div>
));

Spinner.displayName = 'SourceControl.Spinner';

const CenterState = memo(
  ({
    icon,
    tone = 'neutral',
    title,
    children,
    testId,
  }: {
    icon: string;
    tone?: 'neutral' | 'accent' | 'danger';
    title: string;
    children?: React.ReactNode;
    testId?: string;
  }) => {
    const haloRing =
      tone === 'danger'
        ? 'border-red-500/30 bg-red-500/10'
        : tone === 'accent'
          ? 'border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/10'
          : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2';
    const iconTint =
      tone === 'danger'
        ? 'text-red-400'
        : tone === 'accent'
          ? 'text-bolt-elements-item-contentAccent'
          : 'text-bolt-elements-textTertiary';

    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center animate-[sc-fade-in_0.24s_ease-out] motion-reduce:animate-none"
        data-testid={testId}
      >
        <div className={classNames('flex h-16 w-16 items-center justify-center rounded-2xl border', haloRing)}>
          <div className={classNames(icon, 'text-3xl', iconTint)} aria-hidden="true" />
        </div>
        <div className="space-y-1.5 max-w-[300px]">
          <p className="text-sm font-semibold text-bolt-elements-textPrimary">{title}</p>
          {children}
        </div>
      </div>
    );
  },
);

CenterState.displayName = 'SourceControl.CenterState';

const ErrorCard = memo(({ message, onRetry, testId }: { message: string; onRetry: () => void; testId: string }) => (
  <CenterState icon="i-ph:warning-circle-duotone" tone="danger" title="Something went wrong" testId={testId}>
    <p className="text-[11px] text-bolt-elements-textSecondary">{message}</p>
    <div className="pt-1">
      <Button
        variant="secondary"
        icon="i-ph:arrow-clockwise"
        onClick={onRetry}
        className="min-h-[28px] px-3.5 text-[11px]"
      >
        Retry
      </Button>
    </div>
  </CenterState>
));

ErrorCard.displayName = 'SourceControl.ErrorCard';

// ── Changes view (the working-tree diff list) ─────────────────────────────────

const ChangesView = memo(
  ({
    state,
    counts,
    restoring,
    restored,
    onRestore,
    onRetry,
  }: {
    state: ChangesState;
    counts: ReturnType<typeof countChanges> | null;
    restoring: string | null;
    restored: string | null;
    onRestore: (path: string) => void;
    onRetry: () => void;
  }) => {
    if (state.status === 'loading') {
      return <Spinner label="Comparing Preview to your published build…" testId="sc-changes-loading" />;
    }

    if (state.status === 'error') {
      return <ErrorCard message={state.message} onRetry={onRetry} testId="sc-changes-error" />;
    }

    if (state.changes.length === 0) {
      return (
        <CenterState
          icon="i-ph:check-circle-duotone"
          tone="accent"
          title="No changes in Preview"
          testId="sc-changes-empty"
        >
          <p className="text-[11px] text-bolt-elements-textTertiary">
            Your Preview matches your last published build. Edit or generate to see changes here — they stay in Preview
            until you publish.
          </p>
          <div className="pt-1">
            <Button
              variant="secondary"
              icon="i-ph:arrow-clockwise"
              onClick={onRetry}
              className="min-h-[28px] px-3.5 text-[11px]"
            >
              Check again
            </Button>
          </div>
        </CenterState>
      );
    }

    return (
      <div className="flex-1 flex flex-col min-h-0" data-testid="sc-changes-list">
        {/* Count strip: total + per-status pills */}
        <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-bolt-elements-borderColor/60">
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-bolt-elements-item-contentAccent/10 border border-bolt-elements-item-contentAccent/25 px-2 py-0.5 text-[11px] font-semibold text-bolt-elements-item-contentAccent tabular-nums"
            data-testid="sc-change-count"
          >
            <div className="i-ph:files-duotone text-[13px]" aria-hidden="true" />
            {counts?.total ?? state.changes.length} change{(counts?.total ?? 0) === 1 ? '' : 's'}
          </span>
          {counts && counts.modified > 0 && <CountPill n={counts.modified} label="M" status="modified" />}
          {counts && counts.added > 0 && <CountPill n={counts.added} label="A" status="added" />}
          {counts && counts.renamed > 0 && <CountPill n={counts.renamed} label="R" status="renamed" />}
          {counts && counts.deleted > 0 && <CountPill n={counts.deleted} label="D" status="deleted" />}
        </div>

        <div className="flex-1 overflow-auto modern-scrollbar py-1" role="list" aria-label="Changed files">
          {state.changes.map((change) => (
            <ChangeRow
              key={`${change.status}:${change.path}`}
              change={change}
              restoring={restoring === change.path}
              restored={restored === change.path}
              onRestore={onRestore}
            />
          ))}
        </div>
      </div>
    );
  },
);

ChangesView.displayName = 'SourceControl.ChangesView';

const CountPill = memo(({ n, label, status }: { n: number; label: string; status: ChangeStatus }) => (
  <span
    className={classNames(
      'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
      STATUS_TONE[status],
    )}
    title={`${n} ${statusLabel(status).toLowerCase()}`}
  >
    <span className="font-mono">{label}</span>
    {n}
  </span>
));

CountPill.displayName = 'SourceControl.CountPill';

/** One changed-file row — status badge + path + size hint + (for add/modified) a "Restore to Preview" button. */
const ChangeRow = memo(
  ({
    change,
    restoring,
    restored,
    onRestore,
  }: {
    change: FileChange;
    restoring: boolean;
    restored: boolean;
    onRestore: (path: string) => void;
  }) => {
    // Deleted files have nothing to open into the workbench; restore is offered for added/modified/renamed.
    const canRestore = change.status !== 'deleted';

    return (
      <div
        role="listitem"
        data-testid="sc-change-row"
        className="group relative w-full min-h-[30px] flex items-center gap-2 pl-3 pr-2 py-1.5 text-xs hover:bg-bolt-elements-item-contentAccent/[0.06] transition-colors duration-100 motion-reduce:transition-none"
      >
        <span
          className={classNames(
            'shrink-0 inline-flex h-5 w-5 items-center justify-center rounded border font-mono text-[11px] font-bold',
            STATUS_TONE[change.status],
          )}
          aria-label={statusLabel(change.status)}
          title={statusLabel(change.status)}
        >
          {statusBadge(change.status)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-bolt-elements-textPrimary" title={change.path}>
            {change.path}
          </div>
          {change.status === 'renamed' && change.fromPath && (
            <div className="truncate font-mono text-[10px] text-bolt-elements-textTertiary" title={change.fromPath}>
              ← {change.fromPath}
            </div>
          )}
        </div>

        <span className="shrink-0 font-mono text-[10px] text-bolt-elements-textTertiary tabular-nums">
          {change.status === 'deleted' ? formatBytes(change.baseSize ?? 0) : formatBytes(change.size ?? 0)}
        </span>

        {canRestore &&
          (restored ? (
            <span
              className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-300"
              data-testid={`sc-restored-${change.path}`}
            >
              <div className="i-ph:check-bold" aria-hidden="true" /> Restored
            </span>
          ) : (
            <Button
              variant="ghost"
              icon={restoring ? 'i-ph:circle-notch' : 'i-ph:arrow-counter-clockwise'}
              onClick={() => onRestore(change.path)}
              disabled={restoring}
              data-testid={`sc-restore-${change.path}`}
              title="Open the last-published copy back into Preview (never touches Production)"
              className={classNames(
                'shrink-0 min-h-[24px] px-2 py-0.5 text-[10px] opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                restoring && 'opacity-100',
              )}
            >
              <span className="min-w-[7ch] text-center">{restoring ? 'Restoring…' : 'Restore'}</span>
            </Button>
          ))}
      </div>
    );
  },
);

ChangeRow.displayName = 'SourceControl.ChangeRow';

// ── History view (immutable release timeline) ─────────────────────────────────

const HistoryView = memo(({ state, onRetry }: { state: HistoryState; onRetry: () => void }) => {
  if (state.status === 'idle' || state.status === 'loading') {
    return <Spinner label="Loading release history…" testId="sc-history-loading" />;
  }

  if (state.status === 'error') {
    return <ErrorCard message={state.message} onRetry={onRetry} testId="sc-history-error" />;
  }

  if (state.releases.length === 0) {
    return (
      <CenterState icon="i-ph:rocket-launch-duotone" tone="accent" title="No releases yet" testId="sc-history-empty">
        <p className="text-[11px] text-bolt-elements-textTertiary">
          {state.disabled
            ? 'Publishing to Production is coming soon for your site. Your edits are safely saved in Preview.'
            : 'Once you publish your Preview to Production, every release shows up here — commit, artifact, and outcome.'}
        </p>
      </CenterState>
    );
  }

  return (
    <div className="flex-1 overflow-auto modern-scrollbar p-4" data-testid="sc-history-list">
      <ol className="relative ml-2" role="list">
        <span
          aria-hidden="true"
          className="absolute left-0 top-1 bottom-1 w-px"
          style={{ background: `linear-gradient(180deg, var(--bolt-elements-item-contentAccent), ${PURPLE})` }}
        />
        {state.releases.map((release, i) => (
          <ReleaseRow key={release.id} release={release} isLatest={i === 0} />
        ))}
      </ol>
    </div>
  );
});

HistoryView.displayName = 'SourceControl.HistoryView';

/** One release card on the timeline — SHA + outcome badge + date + actor + artifact digest. */
const ReleaseRow = memo(({ release, isLatest }: { release: ReleaseRecord; isLatest: boolean }) => {
  const failed = release.outcome === 'failed';
  const deployFailed = release.outcome === 'commit_ok_deploy_failed';

  const outcomeTone = failed
    ? 'border-red-400/40 bg-red-400/10 text-red-300'
    : deployFailed
      ? 'border-amber-400/40 bg-amber-400/10 text-amber-200'
      : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300';

  return (
    <li className="relative mb-4 ml-5 last:mb-0" data-testid="sc-release-row">
      <span
        className={classNames(
          'absolute -left-[22px] top-2 h-3 w-3 rounded-full border-2 border-bolt-elements-background-depth-1',
          'animate-[sc-dot-in_0.25s_ease-out] motion-reduce:animate-none',
          isLatest
            ? 'bg-bolt-elements-item-contentAccent shadow-[0_0_0_3px_rgba(0,229,255,0.18)]'
            : 'bg-bolt-elements-borderColorActive/40',
        )}
        style={isLatest ? undefined : { backgroundColor: `color-mix(in oklch, ${PURPLE} 55%, transparent)` }}
        aria-hidden="true"
      />
      <div
        className={classNames(
          'rounded-xl border px-3 py-2.5 transition-[border-color,background-color] duration-150 motion-reduce:transition-none',
          isLatest
            ? 'border-bolt-elements-item-contentAccent/35 bg-bolt-elements-item-contentAccent/[0.06]'
            : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:border-bolt-elements-item-contentAccent/30',
        )}
      >
        <div className="flex items-center gap-2 flex-wrap">
          {release.commit_sha ? (
            <span className="inline-flex items-center gap-1 rounded border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/10 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-bolt-elements-item-contentAccent">
              <div className="i-ph:git-commit text-[10px]" aria-hidden="true" />
              {shortSha(release.commit_sha)}
            </span>
          ) : (
            <span className="font-mono text-[11px] text-bolt-elements-textTertiary">(no commit)</span>
          )}
          <span
            className={classNames(
              'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
              outcomeTone,
            )}
          >
            <div
              className={classNames(
                failed ? 'i-ph:x-circle-fill' : deployFailed ? 'i-ph:warning-fill' : 'i-ph:check-circle-fill',
                'text-[9px]',
              )}
              aria-hidden="true"
            />
            {releaseOutcomeLabel(release.outcome)}
          </span>
          {isLatest && (
            <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1">
              <div className="i-ph:star-fill text-[8px]" aria-hidden="true" /> latest
            </span>
          )}
          <span className="ml-auto text-[10px] font-mono text-bolt-elements-textTertiary tabular-nums">
            {formatCommitDate(release.created_at)}
          </span>
        </div>
        <div className="mt-2 flex items-center gap-3 text-[10px] text-bolt-elements-textTertiary flex-wrap">
          {release.actor && (
            <span className="inline-flex items-center gap-1">
              <div className="i-ph:user-circle" aria-hidden="true" /> {release.actor}
            </span>
          )}
          {release.artifact_digest && (
            <span className="inline-flex items-center gap-1 font-mono" title="Frozen artifact digest">
              <div className="i-ph:package" aria-hidden="true" /> {shortSha(release.artifact_digest)}
            </span>
          )}
          {typeof release.draft_revision === 'number' && (
            <span className="inline-flex items-center gap-1" title="Preview draft revision this release was cut from">
              <div className="i-ph:git-branch" aria-hidden="true" /> r{release.draft_revision}
            </span>
          )}
        </div>
      </div>
    </li>
  );
});

ReleaseRow.displayName = 'SourceControl.ReleaseRow';
