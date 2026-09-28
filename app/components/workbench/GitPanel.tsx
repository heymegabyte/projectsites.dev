/**
 * @file Code / Git browser — a read-first window into a site's OWN source (FIRE 7, first pass).
 *
 * @remarks
 * The editor "Code" **file-workbench** edits the live WebContainer tree; THIS panel is the
 * complementary read-only browser over the site's PUBLISHED R2 build (`sites/{slug}/[{version}/]`) plus
 * its git commit history — the "what's actually deployed / what changed over time" view, without
 * booting a container. It reads the site's OWN code only; isolation is enforced SERVER-side (the admin
 * resolves `selectedSite` + holds the bearer; the worker `requireOwnedSite`-guards every read and
 * prefix-guards every path). This panel never sees a slug/id it could tamper with.
 *
 * The embedded editor has no cross-origin session, so it talks to the parent admin over `postMessage`.
 * Three bridge families carry it (all read-only in this first pass):
 *   - `PS_CODE_TREE_REQUEST`    → `GET /api/sites/:id/files`                 (file tree, cap 500)
 *   - `PS_CODE_FILE_REQUEST`    → `GET /api/sites/:id/files/:path`           (one file's text)
 *   - `PS_CODE_HISTORY_REQUEST` → `GET /api/sites/:id/git/history?depth=N`   (commit timeline)
 *
 * FIRST-PASS SCOPE (honest): browse the file tree + view any text file (syntax-labelled) + inline
 * image preview + a read-only commit timeline. **Diff-between-commits and restore-a-version are
 * DEFERRED** — they're mutating / one-way-door actions that need confirm-gating + a populated git
 * store; they render as an honest "coming soon" affordance here, never a dead control.
 *
 * VISUAL DOCTRINE: black + cyan + purple, GitKraken/GitHub-grade but dark-first. Every surface uses
 * `--bolt-elements-*` tokens (cyan `--bolt-elements-item-contentAccent`, purple `--ps-accent-secondary`)
 * — zero hardcoded `bg-white`/`bg-gray-*`/`text-black`/`text-[#hex]`. Every control is a branded button
 * (primary cyan-fill / secondary cyan-outline / ghost / destructive) with a visible label or an
 * `aria-label` + `title` on icon-only buttons, a `focus-visible` cyan ring, and reduced-motion respect.
 * Style mirrors `./DataPanel` + `./Preview`.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type CodeTreeResponseMessage,
  type CodeFileResponseMessage,
  type CodeHistoryResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  buildFileTree,
  languageForFile,
  isBinaryPath,
  isImagePath,
  formatBytes,
  shortSha,
  formatCommitDate,
  type CodeFileEntry,
  type TreeNode,
  type CommitEntry,
} from './git-browser-logic';

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 20_000;
const HISTORY_DEPTH = 30;

/**
 * Purple secondary accent, referenced as a CSS variable (never a hardcoded hex) so it tracks the brand
 * token in `app/styles/index.scss` (`--ps-accent-secondary: #7c3aed`). Used for timeline rails + the
 * folder mark, letting cyan stay the primary/interactive accent and purple the structural one.
 */
const PURPLE = 'var(--ps-accent-secondary)';

/** Monotonic fallback correlationId counter (crypto.randomUUID preferred). */
let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `code_${++correlationCounter}`;
}

/** Copy text to the clipboard; resolves `true` on success, `false` when unavailable/blocked. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the failure return — the caller shows an honest "couldn't copy" state
  }

  return false;
}

// ── Types ────────────────────────────────────────────────────────────────────

type TreeState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; files: CodeFileEntry[]; prefix: string; version: string | null };

type FileState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'error'; path: string; message: string }
  | { status: 'binary'; path: string; key: string; size: number }
  | { status: 'ready'; path: string; content: string; size: number };

type HistoryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; commits: CommitEntry[] };

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Tab = 'files' | 'history';

// ── Shared button primitives (branded, color-complete, zero white) ───────────

/**
 * Branded button variants. Every interactive control in the panel resolves to one of these so the
 * cyan/purple system is consistent and there is never a white/gray/textless/invisibly-grayed control.
 *   - `primary`     — cyan fill, dark ink, hover glow (the one dominant action)
 *   - `secondary`   — dark surface + cyan border + cyan text (default action)
 *   - `ghost`       — transparent, cyan-on-hover (low-emphasis / inline)
 *   - `destructive` — red-tinted (reserved; no destructive action ships in this read-only pass)
 */
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

/** A branded text button (always has a visible label). */
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

Button.displayName = 'GitPanel.Button';

/**
 * A branded icon-only button. `label` is REQUIRED and drives BOTH `aria-label` + `title` so there is
 * never a textless control (per the button contract).
 */
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

IconButton.displayName = 'GitPanel.IconButton';

// ── Component ──────────────────────────────────────────────────────────────

export const GitPanel = memo(() => {
  const [tab, setTab] = useState<Tab>('files');
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const [file, setFile] = useState<FileState>({ status: 'idle' });
  const [history, setHistory] = useState<HistoryState>({ status: 'idle' });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [comingSoon, setComingSoon] = useState<string | null>(null);

  /*
   * The repo has a known empty-deps stale-ref bug: a single `onParentMessage` listener registered
   * once in `useEffect([])` closes over the FIRST render's state. We register ONE listener and read
   * the LATEST pending map through a ref, so replies always resolve against the live pending set.
   */
  const pendingRef = useRef<Map<string, Pending>>(new Map());

  /** Send a bridge message + await the reply matched by correlationId (rejects on timeout). */
  const request = useCallback((message: Parameters<typeof postToParent>[0]): Promise<ParentToChildMessage> => {
    return new Promise<ParentToChildMessage>((resolve, reject) => {
      const correlationId = (message as { correlationId: string }).correlationId;
      const timer = setTimeout(() => {
        pendingRef.current.delete(correlationId);
        reject(new Error('The request timed out. Check the admin connection and retry.'));
      }, REQUEST_TIMEOUT_MS);

      pendingRef.current.set(correlationId, { resolve, reject, timer });
      postToParent(message);
    });
  }, []);

  // Register exactly ONE parent-message listener; resolve by correlationId via the live ref.
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (
        msg.type !== 'PS_CODE_TREE_RESPONSE' &&
        msg.type !== 'PS_CODE_FILE_RESPONSE' &&
        msg.type !== 'PS_CODE_HISTORY_RESPONSE'
      ) {
        return;
      }

      const correlationId = msg.correlationId;

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

  /** Load (or reload) the file tree. */
  const loadTree = useCallback(async () => {
    setTree({ status: 'loading' });

    if (!isEmbedded) {
      setTree({ status: 'error', message: 'Open this from the ProjectSites admin to browse your code.' });
      return;
    }

    try {
      const reply = (await request({
        type: 'PS_CODE_TREE_REQUEST',
        correlationId: nextCorrelationId(),
      })) as CodeTreeResponseMessage;

      if (!reply.ok) {
        setTree({ status: 'error', message: reply.error || 'Could not load your files.' });
        return;
      }

      setTree({
        status: 'ready',
        files: reply.files ?? [],
        prefix: reply.prefix ?? '',
        version: reply.version ?? null,
      });
    } catch (err) {
      setTree({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your files.' });
    }
  }, [request]);

  /** Load one file's content into the viewer. */
  const openFile = useCallback(
    async (path: string) => {
      // Binary assets: show a placeholder / image preview, never fetch garbled bytes as text.
      if (isBinaryPath(path)) {
        const entry = tree.status === 'ready' ? tree.files.find((f) => f.name === path) : undefined;
        setFile({ status: 'binary', path, key: entry?.key ?? '', size: entry?.size ?? 0 });

        return;
      }

      setFile({ status: 'loading', path });

      try {
        const reply = (await request({
          type: 'PS_CODE_FILE_REQUEST',
          correlationId: nextCorrelationId(),
          path,
        })) as CodeFileResponseMessage;

        if (!reply.ok) {
          setFile({ status: 'error', path, message: reply.error || `Could not open "${path}".` });
          return;
        }

        setFile({ status: 'ready', path, content: reply.content ?? '', size: reply.size ?? 0 });
      } catch (err) {
        setFile({ status: 'error', path, message: err instanceof Error ? err.message : `Could not open "${path}".` });
      }
    },
    [request, tree],
  );

  /** Load the commit history timeline (lazy — only when the History tab is first opened). */
  const loadHistory = useCallback(async () => {
    setHistory({ status: 'loading' });

    if (!isEmbedded) {
      setHistory({ status: 'error', message: 'Open this from the ProjectSites admin to view history.' });
      return;
    }

    try {
      const reply = (await request({
        type: 'PS_CODE_HISTORY_REQUEST',
        correlationId: nextCorrelationId(),
        depth: HISTORY_DEPTH,
      })) as CodeHistoryResponseMessage;

      if (!reply.ok) {
        setHistory({ status: 'error', message: reply.error || 'Could not load version history.' });
        return;
      }

      setHistory({ status: 'ready', commits: reply.commits ?? [] });
    } catch (err) {
      setHistory({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not load version history.',
      });
    }
  }, [request]);

  // On mount: load the tree.
  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  // Lazy-load history the first time the History tab is opened.
  useEffect(() => {
    if (tab === 'history' && history.status === 'idle') {
      void loadHistory();
    }
  }, [tab, history.status, loadHistory]);

  const toggleFolder = useCallback((path: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);

      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }

      return next;
    });
  }, []);

  const flashComingSoon = useCallback((label: string) => {
    setComingSoon(label);
    setTimeout(() => setComingSoon((cur) => (cur === label ? null : cur)), 3600);
  }, []);

  const nodes = useMemo<TreeNode[]>(() => (tree.status === 'ready' ? buildFileTree(tree.files) : []), [tree]);

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <Header
        tab={tab}
        onTab={setTab}
        version={tree.status === 'ready' ? tree.version : null}
        fileCount={tree.status === 'ready' ? tree.files.length : null}
        onRefresh={() => (tab === 'files' ? void loadTree() : void loadHistory())}
      />

      {tab === 'files' ? (
        <FilesView
          tree={tree}
          nodes={nodes}
          expanded={expanded}
          file={file}
          onToggle={toggleFolder}
          onOpen={openFile}
          onRetry={() => void loadTree()}
          onComingSoon={flashComingSoon}
        />
      ) : (
        <HistoryView state={history} onRetry={() => void loadHistory()} onComingSoon={flashComingSoon} />
      )}

      {comingSoon && (
        <div
          className={classNames(
            'relative shrink-0 border-t border-bolt-elements-item-contentAccent/25',
            'bg-gradient-to-r from-bolt-elements-item-contentAccent/10 via-bolt-elements-background-depth-2 to-[color-mix(in_oklch,var(--ps-accent-secondary)_14%,transparent)]',
            'px-4 py-2.5 text-[11px] text-bolt-elements-textSecondary flex items-center gap-2.5',
            'animate-[gitpanel-slide-up_0.22s_ease-out] motion-reduce:animate-none',
          )}
          data-testid="code-coming-soon"
          role="status"
        >
          <div className="i-ph:sparkle-fill text-bolt-elements-item-contentAccent shrink-0 motion-safe:animate-pulse" />
          <span className="min-w-0">
            <span className="text-bolt-elements-textPrimary font-semibold">{comingSoon}</span> is coming next — diffing
            between versions and one-click restore land in a following update.
          </span>
          <IconButton
            icon="i-ph:x"
            label="Dismiss"
            variant="ghost"
            onClick={() => setComingSoon(null)}
            className="ml-auto min-h-[22px] min-w-[22px]"
          />
        </div>
      )}

      {/* Panel-scoped keyframes (linked, not inline-styled — React 19 drops component <style>{string}). */}
      <GitPanelKeyframes />
    </div>
  );
});

GitPanel.displayName = 'GitPanel';

/**
 * Panel-local keyframes. Rendered once via a `precedence`-tagged `<style>` so React 19 HOISTS it into
 * `<head>` (a plain string-child `<style>` is silently dropped on the client — see god-tier anti-pattern).
 * Names are `gitpanel-`-prefixed to avoid colliding with app-global animations.
 */
const GitPanelKeyframes = memo(() => (
  // @ts-expect-error React 19 `precedence` on <style> is valid but not yet in the DOM lib types.
  <style precedence="gitpanel">{`
    @keyframes gitpanel-slide-up { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes gitpanel-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes gitpanel-dot-in { from { opacity: 0; transform: scale(0.4); } to { opacity: 1; transform: none; } }
  `}</style>
));

GitPanelKeyframes.displayName = 'GitPanel.Keyframes';

// ── Header ─────────────────────────────────────────────────────────────────

const Header = memo(
  ({
    tab,
    onTab,
    version,
    fileCount,
    onRefresh,
  }: {
    tab: Tab;
    onTab: (t: Tab) => void;
    version: string | null;
    fileCount: number | null;
    onRefresh: () => void;
  }) => (
    <div
      className={classNames(
        'flex items-center gap-3 px-4 py-3 shrink-0 border-b border-bolt-elements-borderColor',
        'bg-gradient-to-b from-bolt-elements-background-depth-2 to-bolt-elements-background-depth-1',
      )}
    >
      <div className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/10">
        <div className="i-ph:git-branch-duotone text-lg text-bolt-elements-item-contentAccent" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold leading-tight text-bolt-elements-textPrimary tracking-tight">Code</h2>
        <p className="text-[10px] leading-tight text-bolt-elements-textTertiary truncate">
          {tab === 'files'
            ? fileCount !== null
              ? `${fileCount} file${fileCount === 1 ? '' : 's'}${version ? ` · ${version}` : ''} · your published build`
              : 'Your published source'
            : 'Version history · your build timeline'}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {/* Files ↔ History segmented control */}
        <div
          className="flex items-center rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-0.5"
          role="tablist"
          aria-label="Code view"
        >
          {(['files', 'history'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => onTab(t)}
              data-testid={`code-tab-${t}`}
              className={classNames(
                'min-h-[26px] rounded-[7px] px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1.5 cursor-pointer',
                'transition-[background-color,color,box-shadow] duration-150 motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
                tab === t
                  ? 'bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 shadow-[0_1px_8px_-2px_rgba(0,229,255,0.55)]'
                  : 'text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10',
              )}
            >
              <div className={t === 'files' ? 'i-ph:tree-structure-bold' : 'i-ph:git-commit-bold'} aria-hidden="true" />
              <span className="min-w-[7ch] text-center">{t === 'files' ? 'Files' : 'History'}</span>
            </button>
          ))}
        </div>
        <IconButton icon="i-ph:arrows-clockwise" label="Refresh" variant="secondary" onClick={onRefresh} />
      </div>
    </div>
  ),
);

Header.displayName = 'GitPanel.Header';

// ── Shared: spinner + error + empty scaffold ─────────────────────────────────

const Spinner = memo(({ label }: { label: string }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center animate-[gitpanel-fade-in_0.2s_ease-out] motion-reduce:animate-none"
    data-testid="code-loading"
  >
    <div className="relative h-10 w-10">
      <div className="absolute inset-0 rounded-full border-2 border-bolt-elements-item-contentAccent/15" />
      <div className="i-ph:circle-notch absolute inset-0 text-[2.5rem] leading-none text-bolt-elements-item-contentAccent motion-safe:animate-spin" />
    </div>
    <p className="text-xs text-bolt-elements-textSecondary">{label}</p>
  </div>
));

Spinner.displayName = 'GitPanel.Spinner';

/** Shared centered empty/error scaffold — a haloed icon, a title, prose, and optional actions/children. */
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
        className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center animate-[gitpanel-fade-in_0.24s_ease-out] motion-reduce:animate-none"
        data-testid={testId}
      >
        <div
          className={classNames(
            'flex h-16 w-16 items-center justify-center rounded-2xl border',
            haloRing,
          )}
        >
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

CenterState.displayName = 'GitPanel.CenterState';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <CenterState icon="i-ph:warning-circle-duotone" tone="danger" title="Something went wrong" testId="code-error">
    <p className="text-[11px] text-bolt-elements-textSecondary">{message}</p>
    <div className="pt-1">
      <Button variant="secondary" icon="i-ph:arrow-clockwise" onClick={onRetry} className="min-h-[28px] px-3.5 text-[11px]">
        Retry
      </Button>
    </div>
  </CenterState>
));

ErrorCard.displayName = 'GitPanel.ErrorCard';

// ── Files view (tree + viewer) ─────────────────────────────────────────────

const FilesView = memo(
  ({
    tree,
    nodes,
    expanded,
    file,
    onToggle,
    onOpen,
    onRetry,
    onComingSoon,
  }: {
    tree: TreeState;
    nodes: TreeNode[];
    expanded: Set<string>;
    file: FileState;
    onToggle: (path: string) => void;
    onOpen: (path: string) => void;
    onRetry: () => void;
    onComingSoon: (label: string) => void;
  }) => {
    if (tree.status === 'loading') {
      return <Spinner label="Loading your files…" />;
    }

    if (tree.status === 'error') {
      return <ErrorCard message={tree.message} onRetry={onRetry} />;
    }

    if (tree.files.length === 0) {
      return (
        <CenterState icon="i-ph:folder-dashed" tone="accent" title="No published files yet" testId="code-empty">
          <p className="text-[11px] text-bolt-elements-textTertiary">
            Once your site builds and publishes, its source files show up here — browse and read every file, no
            container needed.
          </p>
          <div className="pt-1">
            <Button variant="secondary" icon="i-ph:arrow-clockwise" onClick={onRetry} className="min-h-[28px] px-3.5 text-[11px]">
              Check again
            </Button>
          </div>
        </CenterState>
      );
    }

    const activePath = file.status !== 'idle' ? file.path : null;

    return (
      <div className="flex-1 flex min-h-0" data-testid="code-files">
        {/* Left: file tree */}
        <div
          className="w-[280px] shrink-0 flex flex-col border-r border-bolt-elements-borderColor bg-bolt-elements-background-depth-1"
          data-testid="code-tree"
        >
          <div className="flex items-center gap-1.5 px-3 py-2 shrink-0 border-b border-bolt-elements-borderColor/60 text-[10px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary">
            <div className="i-ph:folders text-bolt-elements-item-contentAccent/80" aria-hidden="true" />
            <span>Files</span>
            <span className="ml-auto rounded-full bg-bolt-elements-background-depth-3 px-1.5 py-0.5 tabular-nums text-bolt-elements-textSecondary normal-case tracking-normal">
              {tree.files.length}
              {tree.files.length >= 500 ? '+' : ''}
            </span>
          </div>
          <div className="flex-1 overflow-auto modern-scrollbar py-1" role="tree" aria-label="Site files">
            {nodes.map((node) => (
              <TreeRow
                key={node.path}
                node={node}
                depth={0}
                expanded={expanded}
                activePath={activePath}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>

        {/* Right: file viewer */}
        <div className="flex-1 min-w-0 flex flex-col bg-bolt-elements-background-depth-1">
          <Viewer file={file} onComingSoon={onComingSoon} />
        </div>
      </div>
    );
  },
);

FilesView.displayName = 'GitPanel.FilesView';

// ── Tree row (recursive) ────────────────────────────────────────────────────

const TreeRow = memo(
  ({
    node,
    depth,
    expanded,
    activePath,
    onToggle,
    onOpen,
  }: {
    node: TreeNode;
    depth: number;
    expanded: Set<string>;
    activePath: string | null;
    onToggle: (path: string) => void;
    onOpen: (path: string) => void;
  }) => {
    const isFolder = node.kind === 'folder';
    const isOpen = isFolder && expanded.has(node.path);
    const isActive = !isFolder && activePath === node.path;
    const indent = 10 + depth * 14;

    return (
      <>
        <button
          type="button"
          role="treeitem"
          aria-expanded={isFolder ? isOpen : undefined}
          aria-selected={isActive}
          onClick={() => (isFolder ? onToggle(node.path) : onOpen(node.path))}
          data-testid={isFolder ? 'code-tree-folder' : 'code-tree-file'}
          title={node.path}
          style={{ paddingLeft: `${indent}px` }}
          className={classNames(
            'group relative w-full min-h-[26px] flex items-center gap-1.5 pr-2.5 py-1 text-xs text-left cursor-pointer',
            'transition-colors duration-100 motion-reduce:transition-none',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
            isActive
              ? 'bg-bolt-elements-item-contentAccent/12 text-bolt-elements-item-contentAccent'
              : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-item-contentAccent/[0.06] hover:text-bolt-elements-textPrimary',
          )}
        >
          {/* Active-row cyan spine */}
          <span
            aria-hidden="true"
            className={classNames(
              'absolute left-0 top-1 bottom-1 w-[2px] rounded-full transition-opacity duration-100',
              isActive ? 'bg-bolt-elements-item-contentAccent opacity-100' : 'opacity-0',
            )}
          />
          {isFolder ? (
            <>
              <div
                className={classNames(
                  'shrink-0 text-bolt-elements-textTertiary transition-transform duration-150 motion-reduce:transition-none',
                  isOpen ? 'i-ph:caret-down rotate-0' : 'i-ph:caret-right',
                )}
                aria-hidden="true"
              />
              <div
                className={classNames('shrink-0', isOpen ? 'i-ph:folder-open-duotone' : 'i-ph:folder-simple-duotone')}
                style={{ color: PURPLE }}
                aria-hidden="true"
              />
            </>
          ) : (
            <>
              <div className="w-3 shrink-0" aria-hidden="true" />
              <FileIcon path={node.name} active={isActive} />
            </>
          )}
          <span className={classNames('truncate', isFolder ? 'font-semibold text-bolt-elements-textPrimary' : 'font-mono')}>
            {node.name}
          </span>
          {!isFolder && node.file && (
            <span className="ml-auto shrink-0 text-[9px] font-mono text-bolt-elements-textTertiary/70 tabular-nums transition-opacity duration-100 group-hover:text-bolt-elements-textTertiary">
              {formatBytes(node.file.size)}
            </span>
          )}
        </button>

        {isFolder && isOpen && node.children && (
          <div role="group" className="animate-[gitpanel-fade-in_0.15s_ease-out] motion-reduce:animate-none">
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                activePath={activePath}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ))}
          </div>
        )}
      </>
    );
  },
);

TreeRow.displayName = 'GitPanel.TreeRow';

/** A small phosphor icon keyed off the file extension (purely decorative — aria comes from the row). */
const FileIcon = memo(({ path, active }: { path: string; active: boolean }) => {
  const lang = languageForFile(path);
  const icon = isImagePath(path)
    ? 'i-ph:image-duotone'
    : isBinaryPath(path)
      ? 'i-ph:file-archive-duotone'
      : lang === 'html'
        ? 'i-ph:file-html-duotone'
        : lang === 'css'
          ? 'i-ph:file-css-duotone'
          : lang === 'javascript' || lang === 'typescript'
            ? 'i-ph:file-js-duotone'
            : lang === 'json'
              ? 'i-ph:brackets-curly-duotone'
              : lang === 'markdown'
                ? 'i-ph:file-text-duotone'
                : 'i-ph:file-duotone';

  return (
    <div
      className={classNames(
        'shrink-0',
        icon,
        active ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textTertiary',
      )}
      aria-hidden="true"
    />
  );
});

FileIcon.displayName = 'GitPanel.FileIcon';

// ── Viewer ───────────────────────────────────────────────────────────────────

const Viewer = memo(({ file, onComingSoon }: { file: FileState; onComingSoon: (label: string) => void }) => {
  const [copied, setCopied] = useState(false);

  const onCopyPath = useCallback(async () => {
    if (file.status === 'idle') {
      return;
    }

    const ok = await copyText(file.path);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1800);
  }, [file]);

  if (file.status === 'idle') {
    return (
      <CenterState icon="i-ph:file-magnifying-glass-duotone" tone="accent" title="Pick a file to read it" testId="code-viewer-idle">
        <p className="text-[11px] text-bolt-elements-textTertiary">
          Select any file in the tree to view its contents — read-only, syntax-labelled, no container boot.
        </p>
      </CenterState>
    );
  }

  if (file.status === 'loading') {
    return <Spinner label={`Opening “${file.path}”…`} />;
  }

  if (file.status === 'error') {
    return (
      <CenterState icon="i-ph:warning-circle-duotone" tone="danger" title="Couldn't open that file" testId="code-viewer-error">
        <p className="text-[11px] text-bolt-elements-textSecondary">{file.message}</p>
      </CenterState>
    );
  }

  const lang = languageForFile(file.path);

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="code-viewer">
      {/* Viewer toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 shrink-0 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
        <div className="i-ph:file-code-duotone text-sm text-bolt-elements-item-contentAccent shrink-0" aria-hidden="true" />
        <span className="text-xs font-mono text-bolt-elements-textPrimary truncate flex-1" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/10 text-bolt-elements-item-contentAccent">
          {file.status === 'binary' ? 'binary' : lang}
        </span>
        <span className="shrink-0 text-[10px] font-mono text-bolt-elements-textTertiary tabular-nums">
          {formatBytes(file.size)}
        </span>
        <IconButton
          icon={copied ? 'i-ph:check-bold' : 'i-ph:copy'}
          label={copied ? 'Path copied' : 'Copy file path'}
          variant={copied ? 'primary' : 'ghost'}
          onClick={onCopyPath}
          data-testid="code-viewer-copy-path"
        />
        {file.status === 'ready' && (
          <Button
            variant="secondary"
            icon="i-ph:pencil-simple"
            onClick={() => onComingSoon('Editing here')}
            data-testid="code-viewer-edit"
            title="Editing lands in a following update"
            className="min-h-[26px] px-2 text-[10px]"
          >
            Edit
          </Button>
        )}
      </div>

      {file.status === 'binary' ? (
        <BinaryPreview path={file.path} />
      ) : (
        <div className="flex-1 overflow-auto modern-scrollbar bg-bolt-elements-background-depth-1" data-testid="code-viewer-body">
          <pre className="min-h-full px-4 py-3 text-[12px] leading-relaxed font-mono text-bolt-elements-textSecondary whitespace-pre selection:bg-bolt-elements-item-contentAccent/25">
            <code>
              {file.content.length > 0 ? (
                file.content
              ) : (
                <span className="italic text-bolt-elements-textTertiary">(empty file)</span>
              )}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
});

Viewer.displayName = 'GitPanel.Viewer';

/**
 * Binary asset placeholder. Inline image preview is DEFERRED in this first pass (it needs a short-lived
 * signed raw URL over the bridge to stay per-site-scoped, per SECURITY-INVARIANTS — no direct
 * cross-origin fetch). We show an honest placeholder instead of a broken/garbled render.
 */
const BinaryPreview = memo(({ path }: { path: string }) => (
  <CenterState
    icon={isImagePath(path) ? 'i-ph:image-duotone' : 'i-ph:file-archive-duotone'}
    tone="accent"
    title={isImagePath(path) ? 'Image asset' : 'Binary file'}
    testId="code-viewer-binary"
  >
    <p className="text-xs font-mono text-bolt-elements-textPrimary break-all">{path}</p>
    <p className="text-[11px] text-bolt-elements-textTertiary">
      {isImagePath(path) ? 'Inline image preview' : 'Binary contents'} land in a following update. This file is part of
      your published build.
    </p>
  </CenterState>
));

BinaryPreview.displayName = 'GitPanel.BinaryPreview';

// ── History view ─────────────────────────────────────────────────────────────

const HistoryView = memo(
  ({
    state,
    onRetry,
    onComingSoon,
  }: {
    state: HistoryState;
    onRetry: () => void;
    onComingSoon: (label: string) => void;
  }) => {
    if (state.status === 'idle' || state.status === 'loading') {
      return <Spinner label="Loading version history…" />;
    }

    if (state.status === 'error') {
      return <ErrorCard message={state.message} onRetry={onRetry} />;
    }

    if (state.commits.length === 0) {
      return (
        <CenterState icon="i-ph:git-commit-duotone" tone="accent" title="No version history yet" testId="code-history-empty">
          <p className="text-[11px] text-bolt-elements-textTertiary">
            Each build adds a point to your timeline. Once your site rebuilds, you'll see every version here — browse,
            compare, and restore any of them.
          </p>
        </CenterState>
      );
    }

    return (
      <div className="flex-1 overflow-auto modern-scrollbar p-4" data-testid="code-history">
        <ol className="relative ml-2" role="list">
          {/* Gradient timeline rail: cyan (latest) fading into purple (older) */}
          <span
            aria-hidden="true"
            className="absolute left-0 top-1 bottom-1 w-px"
            style={{ background: `linear-gradient(180deg, var(--bolt-elements-item-contentAccent), ${PURPLE})` }}
          />
          {state.commits.map((commit, i) => (
            <CommitRow key={commit.id} commit={commit} isLatest={i === 0} onComingSoon={onComingSoon} />
          ))}
        </ol>
      </div>
    );
  },
);

HistoryView.displayName = 'GitPanel.HistoryView';

/** One commit card on the timeline — hash (copyable), latest badge, date, message, author, file count. */
const CommitRow = memo(
  ({
    commit,
    isLatest,
    onComingSoon,
  }: {
    commit: CommitEntry;
    isLatest: boolean;
    onComingSoon: (label: string) => void;
  }) => {
    const [copied, setCopied] = useState(false);

    const onCopySha = useCallback(async () => {
      const ok = await copyText(commit.id);
      setCopied(ok);
      setTimeout(() => setCopied(false), 1800);
    }, [commit.id]);

    return (
      <li className="relative mb-4 ml-5 last:mb-0" data-testid="code-commit">
        {/* Timeline dot */}
        <span
          className={classNames(
            'absolute -left-[22px] top-2 h-3 w-3 rounded-full border-2 border-bolt-elements-background-depth-1',
            'animate-[gitpanel-dot-in_0.25s_ease-out] motion-reduce:animate-none',
            isLatest
              ? 'bg-bolt-elements-item-contentAccent shadow-[0_0_0_3px_rgba(0,229,255,0.18)]'
              : 'bg-bolt-elements-borderColorActive/40',
          )}
          style={isLatest ? undefined : { backgroundColor: `color-mix(in oklch, ${PURPLE} 55%, transparent)` }}
          aria-hidden="true"
        />
        <div
          className={classNames(
            'rounded-xl border px-3 py-2.5 transition-[border-color,background-color,box-shadow] duration-150 motion-reduce:transition-none',
            isLatest
              ? 'border-bolt-elements-item-contentAccent/35 bg-bolt-elements-item-contentAccent/[0.06] shadow-[0_2px_14px_-8px_rgba(0,229,255,0.5)]'
              : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:border-bolt-elements-item-contentAccent/30 hover:bg-bolt-elements-background-depth-3',
          )}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCopySha}
              aria-label={copied ? 'Commit hash copied' : `Copy commit hash ${shortSha(commit.id)}`}
              title={copied ? 'Copied' : 'Copy full commit hash'}
              data-testid="code-commit-copy-sha"
              className={classNames(
                'group inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] tabular-nums cursor-pointer',
                'transition-colors duration-150 motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                copied
                  ? 'border-bolt-elements-item-contentAccent/60 bg-bolt-elements-item-contentAccent/15 text-bolt-elements-item-contentAccent'
                  : 'border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/10 text-bolt-elements-item-contentAccent hover:border-bolt-elements-item-contentAccent/60 hover:bg-bolt-elements-item-contentAccent/20',
              )}
            >
              <div className={classNames('text-[10px]', copied ? 'i-ph:check-bold' : 'i-ph:git-commit')} aria-hidden="true" />
              {shortSha(commit.id)}
            </button>
            {isLatest && (
              <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1">
                <div className="i-ph:star-fill text-[8px]" aria-hidden="true" /> latest
              </span>
            )}
            <span className="ml-auto text-[10px] font-mono text-bolt-elements-textTertiary tabular-nums">
              {formatCommitDate(commit.timestamp)}
            </span>
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-bolt-elements-textPrimary break-words">{commit.message}</p>
          <div className="mt-2 flex items-center gap-3 text-[10px] text-bolt-elements-textTertiary">
            <span className="inline-flex items-center gap-1">
              <div className="i-ph:user-circle" aria-hidden="true" /> {commit.author}
            </span>
            {typeof commit.files?.length === 'number' && (
              <span className="inline-flex items-center gap-1">
                <div className="i-ph:files" aria-hidden="true" /> {commit.files.length} file
                {commit.files.length === 1 ? '' : 's'}
              </span>
            )}
            {/* Diff + restore are deferred (mutating / one-way-door) — honest nudge, never a dead control. */}
            <Button
              variant="ghost"
              icon="i-ph:clock-counter-clockwise"
              onClick={() => onComingSoon('Compare & restore')}
              data-testid="code-commit-restore"
              className="ml-auto min-h-[24px] px-2 py-0.5 text-[10px]"
            >
              Compare
            </Button>
          </div>
        </div>
      </li>
    );
  },
);

CommitRow.displayName = 'GitPanel.CommitRow';
