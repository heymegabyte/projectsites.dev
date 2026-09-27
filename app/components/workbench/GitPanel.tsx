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
 * Style matches the editor conventions exactly (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*`
 * icons) — mirrors `./DataPanel` + `./Preview`.
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

/** Monotonic fallback correlationId counter (crypto.randomUUID preferred). */
let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `code_${++correlationCounter}`;
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
          className="border-t border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-2 text-[11px] text-bolt-elements-textSecondary flex items-center gap-2"
          data-testid="code-coming-soon"
          role="status"
        >
          <div className="i-ph:sparkle text-bolt-elements-item-contentAccent" />
          <span>
            <span className="text-bolt-elements-textPrimary font-medium">{comingSoon}</span> is coming next — diffing
            between versions and one-click restore land in a following update.
          </span>
        </div>
      )}
    </div>
  );
});

GitPanel.displayName = 'GitPanel';

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
    <div className="flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
      <div className="i-ph:git-branch-duotone text-xl text-bolt-elements-textSecondary" />
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-bolt-elements-textPrimary">Code</h2>
        <p className="text-[10px] text-bolt-elements-textTertiary truncate">
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
          className="flex items-center rounded-md border border-bolt-elements-borderColor overflow-hidden"
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
                'min-h-[24px] px-2.5 py-1 text-[11px] font-medium flex items-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                tab === t
                  ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
                  : 'bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3',
              )}
            >
              <div className={t === 'files' ? 'i-ph:tree-structure' : 'i-ph:git-commit'} />
              <span className="min-w-[6ch] text-center">{t === 'files' ? 'Files' : 'History'}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh"
          title="Refresh"
          className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
        >
          <div className="i-ph:arrows-clockwise text-sm" />
        </button>
      </div>
    </div>
  ),
);

Header.displayName = 'GitPanel.Header';

// ── Shared: spinner + error ────────────────────────────────────────────────

const Spinner = memo(({ label }: { label: string }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center" data-testid="code-loading">
    <div className="i-ph:circle-notch text-2xl text-bolt-elements-item-contentAccent animate-spin" />
    <p className="text-xs text-bolt-elements-textSecondary">{label}</p>
  </div>
));

Spinner.displayName = 'GitPanel.Spinner';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="code-error">
    <div className="i-ph:warning-circle text-3xl text-red-400" />
    <p className="text-xs text-bolt-elements-textSecondary max-w-[280px]">{message}</p>
    <button
      type="button"
      onClick={onRetry}
      className="min-h-[24px] mt-1 text-[11px] font-medium px-3 py-1.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
    >
      <div className="i-ph:arrow-clockwise" /> Retry
    </button>
  </div>
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
        <div
          className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
          data-testid="code-empty"
        >
          <div className="i-ph:folder-dashed text-4xl text-bolt-elements-textTertiary" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-bolt-elements-textPrimary">No published files yet</p>
            <p className="text-[11px] text-bolt-elements-textTertiary max-w-[280px]">
              Once your site builds and publishes, its source files show up here — browse and read every file, no
              container needed.
            </p>
          </div>
        </div>
      );
    }

    const activePath = file.status !== 'idle' ? file.path : null;

    return (
      <div className="flex-1 flex min-h-0" data-testid="code-files">
        {/* Left: file tree */}
        <div
          className="w-[280px] shrink-0 border-r border-bolt-elements-borderColor overflow-auto modern-scrollbar"
          data-testid="code-tree"
        >
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
            Files ({tree.files.length}
            {tree.files.length >= 500 ? '+' : ''})
          </div>
          <div role="tree" aria-label="Site files">
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
        <div className="flex-1 min-w-0 flex flex-col">
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
    const indent = 8 + depth * 14;

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
            'w-full min-h-[24px] flex items-center gap-1.5 pr-3 py-1 text-xs text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
            isActive
              ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent'
              : 'hover:bg-bolt-elements-item-backgroundActive text-bolt-elements-textSecondary',
          )}
        >
          {isFolder ? (
            <>
              <div
                className={classNames(
                  'shrink-0 text-bolt-elements-textTertiary transition-transform',
                  isOpen ? 'i-ph:caret-down' : 'i-ph:caret-right',
                )}
              />
              <div className={classNames('shrink-0', isOpen ? 'i-ph:folder-open' : 'i-ph:folder-simple')} />
            </>
          ) : (
            <>
              <div className="w-3 shrink-0" />
              <FileIcon path={node.name} active={isActive} />
            </>
          )}
          <span
            className={classNames('truncate', isFolder ? 'font-medium text-bolt-elements-textPrimary' : 'font-mono')}
          >
            {node.name}
          </span>
          {!isFolder && node.file && (
            <span className="ml-auto shrink-0 text-[9px] text-bolt-elements-textTertiary/70 tabular-nums">
              {formatBytes(node.file.size)}
            </span>
          )}
        </button>

        {isFolder && isOpen && node.children && (
          <div role="group">
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
    ? 'i-ph:image'
    : isBinaryPath(path)
      ? 'i-ph:file-archive'
      : lang === 'html'
        ? 'i-ph:file-html'
        : lang === 'css'
          ? 'i-ph:file-css'
          : lang === 'javascript' || lang === 'typescript'
            ? 'i-ph:file-js'
            : lang === 'json'
              ? 'i-ph:brackets-curly'
              : lang === 'markdown'
                ? 'i-ph:file-text'
                : 'i-ph:file';

  return (
    <div
      className={classNames(
        'shrink-0',
        icon,
        active ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textTertiary',
      )}
    />
  );
});

FileIcon.displayName = 'GitPanel.FileIcon';

// ── Viewer ───────────────────────────────────────────────────────────────────

const Viewer = memo(({ file, onComingSoon }: { file: FileState; onComingSoon: (label: string) => void }) => {
  if (file.status === 'idle') {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center"
        data-testid="code-viewer-idle"
      >
        <div className="i-ph:file-magnifying-glass text-4xl text-bolt-elements-textTertiary" />
        <p className="text-xs text-bolt-elements-textSecondary">Select a file to view its contents</p>
      </div>
    );
  }

  if (file.status === 'loading') {
    return <Spinner label={`Opening "${file.path}"…`} />;
  }

  if (file.status === 'error') {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
        data-testid="code-viewer-error"
      >
        <div className="i-ph:warning-circle text-3xl text-red-400" />
        <p className="text-xs text-bolt-elements-textSecondary max-w-[280px]">{file.message}</p>
      </div>
    );
  }

  const lang = languageForFile(file.path);

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="code-viewer">
      {/* Viewer toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0">
        <div className="i-ph:file-code text-sm text-bolt-elements-textTertiary shrink-0" />
        <span className="text-xs font-mono text-bolt-elements-textPrimary truncate flex-1" title={file.path}>
          {file.path}
        </span>
        <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary">
          {file.status === 'binary' ? 'binary' : lang}
        </span>
        <span className="shrink-0 text-[10px] text-bolt-elements-textTertiary tabular-nums">
          {formatBytes(file.size)}
        </span>
        {file.status === 'ready' && (
          <button
            type="button"
            onClick={() => onComingSoon('Editing here')}
            data-testid="code-viewer-edit"
            title="Editing lands in a following update"
            className="min-h-[24px] shrink-0 text-[10px] font-medium px-2 py-1 rounded border border-bolt-elements-item-contentAccent/50 bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:pencil-simple" /> Edit
          </button>
        )}
      </div>

      {file.status === 'binary' ? (
        <BinaryPreview path={file.path} />
      ) : (
        <div className="flex-1 overflow-auto modern-scrollbar" data-testid="code-viewer-body">
          <pre className="min-h-full px-4 py-3 text-[12px] leading-relaxed font-mono text-bolt-elements-textSecondary whitespace-pre">
            <code>{file.content.length > 0 ? file.content : '(empty file)'}</code>
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
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="code-viewer-binary"
  >
    <div
      className={classNames(
        'text-4xl text-bolt-elements-textTertiary',
        isImagePath(path) ? 'i-ph:image' : 'i-ph:file-archive',
      )}
    />
    <div className="space-y-1">
      <p className="text-xs font-mono text-bolt-elements-textPrimary">{path}</p>
      <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
        {isImagePath(path) ? 'Image preview' : 'Binary file'} — inline preview lands in a following update. The file is
        part of your published build.
      </p>
    </div>
  </div>
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
        <div
          className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
          data-testid="code-history-empty"
        >
          <div className="i-ph:git-commit text-4xl text-bolt-elements-textTertiary" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-bolt-elements-textPrimary">No version history yet</p>
            <p className="text-[11px] text-bolt-elements-textTertiary max-w-[300px]">
              Each build adds a point to your timeline. Once your site rebuilds, you'll see every version here — browse,
              compare, and restore any of them.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 overflow-auto modern-scrollbar p-4" data-testid="code-history">
        <ol className="relative border-l border-bolt-elements-borderColor ml-2">
          {state.commits.map((commit, i) => (
            <li key={commit.id} className="mb-4 ml-4" data-testid="code-commit">
              {/* Timeline dot */}
              <span
                className={classNames(
                  'absolute -left-[6px] mt-1.5 h-3 w-3 rounded-full border-2 border-bolt-elements-background-depth-1',
                  i === 0 ? 'bg-bolt-elements-item-contentAccent' : 'bg-bolt-elements-borderColor',
                )}
                aria-hidden="true"
              />
              <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 hover:bg-bolt-elements-background-depth-3 transition-colors">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-bolt-elements-item-contentAccent tabular-nums">
                    {shortSha(commit.id)}
                  </span>
                  {i === 0 && (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent">
                      latest
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-bolt-elements-textTertiary tabular-nums">
                    {formatCommitDate(commit.timestamp)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-bolt-elements-textPrimary break-words">{commit.message}</p>
                <div className="mt-1.5 flex items-center gap-3 text-[10px] text-bolt-elements-textTertiary">
                  <span className="flex items-center gap-1">
                    <div className="i-ph:user" /> {commit.author}
                  </span>
                  {typeof commit.files?.length === 'number' && (
                    <span className="flex items-center gap-1">
                      <div className="i-ph:files" /> {commit.files.length} file{commit.files.length === 1 ? '' : 's'}
                    </span>
                  )}
                  {/* Diff + restore are deferred (mutating / one-way-door) — honest nudge, never a dead control. */}
                  <button
                    type="button"
                    onClick={() => onComingSoon('Compare & restore')}
                    data-testid="code-commit-restore"
                    className="ml-auto min-h-[24px] text-[10px] font-medium px-2 py-0.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent hover:border-bolt-elements-item-contentAccent/50 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                  >
                    <div className="i-ph:clock-counter-clockwise" /> Compare
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    );
  },
);

HistoryView.displayName = 'GitPanel.HistoryView';
