import { useStore } from '@nanostores/react';
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import * as Tabs from '@radix-ui/react-tabs';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  CodeMirrorEditor,
  type EditorDocument,
  type EditorSettings,
  type OnChangeCallback as OnEditorChange,
  type OnSaveCallback as OnEditorSave,
  type OnScrollCallback as OnEditorScroll,
} from '~/components/editor/codemirror/CodeMirrorEditor';
import { PanelHeader } from '~/components/ui/PanelHeader';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import type { FileMap } from '~/lib/stores/files';
import type { FileHistory } from '~/types/actions';
import { themeStore } from '~/lib/stores/theme';
import { WORK_DIR } from '~/utils/constants';
import { renderLogger } from '~/utils/logger';
import { isMobile } from '~/utils/mobile';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileTree } from './FileTree';
import { DEFAULT_BOTTOM_PANEL_SIZE } from './extensions/BottomPanelTabs';
import { workbenchStore } from '~/lib/stores/workbench';

/**
 * Item 2 + 7 (perf): Defer the bottom-panel shell + xterm.js (~150KB) until
 * the user actually opens the panel. `BottomPanelTabs` pulls in `@xterm/xterm`,
 * `@xterm/addon-fit`, `@xterm/addon-web-links`, plus the terminal manager
 * AND the 10 extension tabs — each tab is itself lazy, so opening Terminal
 * doesn't pay for the SQL editor or KV browser. The Workbench LCP no longer
 * blocks on any of this; it streams in the first time `showTerminal` flips.
 */
const BottomPanelTabsLazy = lazy(() =>
  import('./extensions/BottomPanelTabs').then((m) => ({ default: m.BottomPanelTabs })),
);
const DEFAULT_TERMINAL_SIZE = DEFAULT_BOTTOM_PANEL_SIZE;
import { Search } from './Search'; // <-- Ensure Search is imported
import { classNames } from '~/utils/classNames'; // <-- Import classNames if not already present
import { LockManager } from './LockManager'; // <-- Import LockManager
import { ProjectHub } from './ProjectHub'; // Code-view command center (deploy / snapshots / git)
import { SourceControlPanel } from './SourceControlPanel'; // Source Control view — Preview diff + releases (Slice 4)
import { isEmbedded, requestR2, type BucketEntry } from '~/lib/embed/embedded-mode'; // B15 — bucket source selector

interface EditorPanelProps {
  files?: FileMap;
  unsavedFiles?: Set<string>;
  editorDocument?: EditorDocument;
  selectedFile?: string | undefined;
  isStreaming?: boolean;
  fileHistory?: Record<string, FileHistory>;
  onEditorChange?: OnEditorChange;
  onEditorScroll?: OnEditorScroll;
  onFileSelect?: (value?: string) => void;
  onFileSave?: OnEditorSave;
  onFileReset?: () => void;
}

const DEFAULT_EDITOR_SIZE = 100 - DEFAULT_TERMINAL_SIZE;

const editorSettings: EditorSettings = { tabSize: 2 };

/*
 * ── B15 — Code-view bucket SOURCE selector ────────────────────────────────────
 * A compact `Source ▾` picker in the Code view's explorer header that toggles the
 * active source between the **website source** (the WebContainer working tree the
 * `FileTree` already renders) and one of the site's **R2 buckets** (Preview /
 * Production / custom). It REUSES the live bucket list (`requestR2({op:'listBuckets'})`
 * — the exact `BucketEntry` shape `BucketsPanel` renders) rather than refetching a
 * parallel tree. This slice ships the SELECTOR + its honest active-source state; the
 * bucket object-tree → explorer load + open/edit/save-back-to-R2 is a backend-wired
 * fast-follow (spec B15 acceptance beyond the selector). Capability gating is honest:
 * when the bucket surface is dark the live list is unavailable and the picker degrades
 * to website-source-only — never a doomed control (`embarrassingly-easy-to-use`).
 */

/** The identifier for the always-present website (WebContainer) source. */
export const WEBSITE_SOURCE_ID = 'website' as const;

/** One selectable source in the Code-view `Source ▾` picker. */
export interface CodeSource {
  /** Stable id — `'website'` or `bucket:{displayName}`. */
  id: string;

  /** Owner-friendly label (the bucket's display name, or "Website source"). */
  label: string;

  /** `website` = the working tree; `bucket` = an R2 bucket. */
  kind: 'website' | 'bucket';

  /** `preview` | `production` for bucket sources (drives the env badge + warn). */
  environment?: string;

  /** Production buckets open read-only here so a prod edit is never a surprise. */
  readOnly?: boolean;
}

/** Load status for the picker's R2 source list. */
export type CodeSourceStatus = 'loading' | 'ready' | 'disabled' | 'error';

/** The stable id for a bucket source, derived from its display name. */
function bucketSourceId(bucket: Pick<BucketEntry, 'name'>): string {
  return `bucket:${bucket.name}`;
}

/**
 * Resolve the Code-view source list from the live bucket inventory. Reuses the SAME
 * `requestR2({op:'listBuckets'})` bridge op `BucketsPanel` uses (no parallel fetch
 * machinery). The website source is ALWAYS present (index 0) so the picker never has a
 * dead/empty menu; buckets append in env order (Production read-only). Dark flag → the
 * bridge replies `{enabled:false}` → status `disabled`, website-source-only.
 */
function useCodeSources(): { sources: CodeSource[]; status: CodeSourceStatus; errorMessage?: string } {
  const [status, setStatus] = useState<CodeSourceStatus>('loading');
  const [buckets, setBuckets] = useState<BucketEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();

  const load = useCallback(async () => {
    // Outside the admin embed there is no bridge — offer the website source only.
    if (!isEmbedded) {
      setStatus('ready');
      setBuckets([]);
      return;
    }

    setStatus('loading');

    try {
      const reply = await requestR2({ op: 'listBuckets' });

      if (!reply.ok) {
        // DARK flag (404 "not enabled") → graceful website-only, not an error wall.
        if (reply.enabled === false || (reply.error && reply.error.includes('not enabled'))) {
          setStatus('disabled');
          setBuckets([]);
          return;
        }

        setStatus('error');
        setErrorMessage(reply.error || 'Could not load your buckets.');
        setBuckets([]);

        return;
      }

      setStatus('ready');
      setBuckets(reply.buckets ?? []);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Could not load your buckets.');
      setBuckets([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sources = useMemo<CodeSource[]>(() => {
    const website: CodeSource = { id: WEBSITE_SOURCE_ID, label: 'Website source', kind: 'website' };

    // Production buckets open read-only here (direct prod edits are destructive) — pin
    // Production after Preview after the default, then the rest, matching the Navigator.
    const bucketSources: CodeSource[] = [...buckets]
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) {
          return a.isDefault ? -1 : 1;
        }

        const rank = (e?: string) => (e === 'preview' ? 0 : e === 'production' ? 1 : 2);
        const byEnv = rank(a.environment) - rank(b.environment);

        return byEnv !== 0 ? byEnv : a.name.localeCompare(b.name);
      })
      .map((b) => ({
        id: bucketSourceId(b),
        label: b.name,
        kind: 'bucket' as const,
        environment: b.environment,
        readOnly: b.environment === 'production',
      }));

    return [website, ...bucketSources];
  }, [buckets]);

  return { sources, status, errorMessage };
}

const SOURCE_MENU_CONTENT =
  'z-[100001] min-w-[220px] max-w-[300px] rounded-xl border border-bolt-elements-borderColor ' +
  'bg-bolt-elements-background-depth-2 p-1 shadow-2xl shadow-black/40 motion-safe:animate-[fadeIn_.12s_ease-out]';
const SOURCE_MENU_ITEM =
  'flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-lg cursor-pointer select-none outline-none ' +
  'text-bolt-elements-textSecondary data-[highlighted]:bg-bolt-elements-item-contentAccent/[0.12] ' +
  'data-[highlighted]:text-bolt-elements-item-contentAccent';

/**
 * The `Source ▾` dropdown. Pure + prop-driven (so it is unit-provable without the
 * postMessage bridge) — the owning panel supplies the resolved `sources`, the
 * `activeSourceId`, the load `status`, and the `onSelect` callback. Radix supplies the
 * menu roles / Escape / focus management; items are `menuitemradio` so the active source
 * is announced as checked.
 */
export const CodeSourcePicker = memo(
  ({
    sources,
    activeSourceId,
    status,
    errorMessage,
    onSelect,
  }: {
    sources: CodeSource[];
    activeSourceId: string;
    status: CodeSourceStatus;
    errorMessage?: string;
    onSelect: (id: string) => void;
  }) => {
    const active = sources.find((s) => s.id === activeSourceId) ?? sources[0];
    const activeLabel = active?.label ?? 'Website source';
    const busy = status === 'loading';
    const hasBuckets = sources.some((s) => s.kind === 'bucket');

    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-testid="code-source-trigger"
            aria-label={`Code source: ${activeLabel}. Choose website source or an R2 bucket.`}
            aria-busy={busy || undefined}
            title="Choose the Code view source — website or an R2 bucket"
            className={classNames(
              'h-full flex items-center gap-1 bg-transparent hover:bg-bolt-elements-background-depth-3',
              'py-0.5 px-2 rounded-lg text-xs font-medium text-bolt-elements-textTertiary',
              'hover:text-bolt-elements-textPrimary data-[state=open]:text-bolt-elements-textPrimary transition-colors',
            )}
          >
            <div
              className={classNames(
                active?.kind === 'bucket' ? 'i-ph:bucket' : 'i-ph:globe-simple',
                'text-sm shrink-0',
                { 'opacity-70': busy },
              )}
              aria-hidden
            />
            <span className="max-w-[120px] truncate">{activeLabel}</span>
            <div className="i-ph:caret-down text-[10px] shrink-0 opacity-70" aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content data-testid="code-source-menu" align="start" sideOffset={4} className={SOURCE_MENU_CONTENT}>
            <DropdownMenu.Label className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-bolt-elements-textTertiary">
              Code source
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={active?.id} onValueChange={onSelect}>
              {sources.map((source) => (
                <DropdownMenu.RadioItem
                  key={source.id}
                  value={source.id}
                  data-testid={`code-source-item-${source.id}`}
                  className={SOURCE_MENU_ITEM}
                >
                  <div
                    className={classNames(
                      source.kind === 'bucket' ? 'i-ph:bucket' : 'i-ph:globe-simple',
                      'text-sm shrink-0',
                    )}
                    aria-hidden
                  />
                  <span className="flex-1 truncate">{source.label}</span>
                  {source.environment === 'production' && (
                    <span className="shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300/90 bg-amber-400/10">
                      Prod · read-only
                    </span>
                  )}
                  {source.environment === 'preview' && (
                    <span className="shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-bolt-elements-item-contentAccent/90 bg-bolt-elements-item-contentAccent/10">
                      Preview
                    </span>
                  )}
                  {source.id === active?.id && <div className="i-ph:check text-xs shrink-0" aria-hidden />}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            {/* Honest, quiet footer explaining why no buckets appear — never a silent dead end. */}
            {!hasBuckets && (
              <div
                className="mt-1 border-t border-bolt-elements-borderColor/60 px-2.5 py-1.5 text-[10px] text-bolt-elements-textTertiary"
                data-testid="code-source-no-buckets"
              >
                {status === 'error'
                  ? errorMessage || 'Buckets are unavailable right now.'
                  : status === 'loading'
                    ? 'Loading your buckets…'
                    : 'No R2 buckets yet — add one in Resources › Buckets to edit it here.'}
              </div>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  },
);

CodeSourcePicker.displayName = 'EditorPanel.CodeSourcePicker';

/**
 * The explorer content shown while a bucket SOURCE is active. Honest + useful (not a
 * stub): it names the bucket, surfaces the read-only warning for Production, points the
 * owner at the full Buckets workspace (Resources › Buckets) for browse/upload/download
 * today, and offers one click back to the website source. The in-explorer bucket object
 * tree + open/edit/save-back-to-R2 is the backend-wired fast-follow.
 */
const BucketSourceNotice = memo(
  ({ source, onBackToWebsite }: { source: CodeSource; onBackToWebsite: () => void }) => {
    const isProd = source.environment === 'production';

    return (
      <div className="h-full flex flex-col items-start gap-3 p-4 text-xs" data-testid="code-source-bucket-notice">
        <div className="flex items-center gap-2 text-bolt-elements-textPrimary">
          <div className="i-ph:bucket text-base text-bolt-elements-item-contentAccent" aria-hidden />
          <span className="font-semibold">{source.label}</span>
          {isProd ? (
            <span className="rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-300/90 bg-amber-400/10">
              Production · read-only
            </span>
          ) : (
            <span className="rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-bolt-elements-item-contentAccent/90 bg-bolt-elements-item-contentAccent/10">
              Preview
            </span>
          )}
        </div>

        {isProd && (
          <p className="flex items-start gap-1.5 text-amber-300/90">
            <div className="i-ph:warning mt-px shrink-0" aria-hidden />
            <span>
              This is your live Production bucket. Editing files here changes your public site directly, so it opens
              read-only. Promote from Preview to publish safely.
            </span>
          </p>
        )}

        <p className="text-bolt-elements-textSecondary leading-relaxed">
          Browse, upload, and download this bucket&apos;s files in{' '}
          <span className="font-medium text-bolt-elements-textPrimary">Resources › Buckets</span>. In-editor open and
          save for bucket files is arriving next.
        </p>

        <button
          type="button"
          onClick={onBackToWebsite}
          data-testid="code-source-back-to-website"
          className={classNames(
            'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium',
            'bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary',
            'hover:bg-bolt-elements-item-backgroundActive transition-colors',
          )}
        >
          <div className="i-ph:arrow-left text-sm" aria-hidden />
          Back to website source
        </button>
      </div>
    );
  },
);

BucketSourceNotice.displayName = 'EditorPanel.BucketSourceNotice';

export const EditorPanel = memo(
  ({
    files,
    unsavedFiles,
    editorDocument,
    selectedFile,
    isStreaming,
    fileHistory,
    onFileSelect,
    onEditorChange,
    onEditorScroll,
    onFileSave,
    onFileReset,
  }: EditorPanelProps) => {
    renderLogger.trace('EditorPanel');

    const theme = useStore(themeStore);
    const showTerminal = useStore(workbenchStore.showTerminal);

    /*
     * Item 7: only mount the heavy `TerminalTabsLazy` chunk after the user
     * has opened the terminal at least once in this session. Once mounted,
     * we keep it mounted (sticky-true) so toggling off + back on doesn't pay
     * the import cost again — xterm holds its own state.
     */
    const [terminalEverOpened, setTerminalEverOpened] = useState(showTerminal);
    useEffect(() => {
      if (showTerminal && !terminalEverOpened) {
        setTerminalEverOpened(true);
      }
    }, [showTerminal, terminalEverOpened]);

    const activeFileSegments = useMemo(() => {
      if (!editorDocument) {
        return undefined;
      }

      return editorDocument.filePath.split('/');
    }, [editorDocument]);

    const activeFileUnsaved = useMemo(() => {
      if (!editorDocument || !unsavedFiles) {
        return false;
      }

      // Make sure unsavedFiles is a Set before calling has()
      return unsavedFiles instanceof Set && unsavedFiles.has(editorDocument.filePath);
    }, [editorDocument, unsavedFiles]);

    /*
     * Editor view-mode toggles — sticky scope header, minimap scroll
     * indicator, inline diff against the AI's original, side-by-side split
     * showing the AI proposal next to current content.
     */
    const [stickyEnabled, setStickyEnabled] = useState(true);
    const [minimapEnabled, setMinimapEnabled] = useState(false);
    const [diffEnabled, setDiffEnabled] = useState(false);
    const [splitEnabled, setSplitEnabled] = useState(false);
    const [stickyScope, setStickyScope] = useState<string>('');
    const editorWrapRef = useRef<HTMLDivElement>(null);

    /*
     * Sticky scope — scan visible-top lines of the document for the
     * nearest function/class header. Cheap O(n) scan against the doc
     * value, no CodeMirror plugin needed.
     */
    useEffect(() => {
      if (!stickyEnabled || !editorDocument || editorDocument.isBinary) {
        setStickyScope('');
        return undefined;
      }

      const wrap = editorWrapRef.current;

      if (!wrap) {
        return undefined;
      }

      const scrollDom = wrap.querySelector('.cm-scroller') as HTMLElement | null;

      if (!scrollDom) {
        return undefined;
      }

      const lines = editorDocument.value.split('\n');
      const headerRegex =
        /^\s*(export\s+)?(async\s+)?(function|class|const|let|interface|type|enum)\s+[A-Za-z_$][\w$]*/;

      const onScroll = () => {
        const lineHeight = parseFloat(getComputedStyle(scrollDom).lineHeight || '20') || 20;
        const topLine = Math.max(0, Math.floor(scrollDom.scrollTop / lineHeight));

        for (let i = topLine; i >= 0; i--) {
          if (headerRegex.test(lines[i] ?? '')) {
            setStickyScope(lines[i].trim().slice(0, 120));
            return;
          }
        }

        setStickyScope('');
      };

      onScroll();
      scrollDom.addEventListener('scroll', onScroll, { passive: true });

      return () => scrollDom.removeEventListener('scroll', onScroll);
    }, [stickyEnabled, editorDocument?.value, editorDocument?.filePath]);

    /*
     * Inline diff — show added/removed line counts and the first 60-line
     * unified diff of the AI's original vs current. Wired BETWEEN AI
     * proposing the file (recorded in fileHistory) and committing.
     */
    const diffPreview = useMemo(() => {
      if (!diffEnabled || !editorDocument || !fileHistory) {
        return null;
      }

      const history = fileHistory[editorDocument.filePath];

      if (!history?.originalContent) {
        return { lines: [] as Array<{ kind: 'add' | 'remove' | 'context'; text: string }>, empty: true };
      }

      const changes = diffLines(history.originalContent, editorDocument.value);
      const out: Array<{ kind: 'add' | 'remove' | 'context'; text: string }> = [];

      for (const change of changes) {
        const kind: 'add' | 'remove' | 'context' = change.added ? 'add' : change.removed ? 'remove' : 'context';
        const lines = change.value.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));

        for (const line of lines.slice(0, 12)) {
          out.push({ kind, text: line });

          if (out.length >= 60) {
            break;
          }
        }

        if (out.length >= 60) {
          break;
        }
      }

      return { lines: out, empty: out.length === 0 };
    }, [diffEnabled, editorDocument, fileHistory]);

    /*
     * B15 — active Code source. Defaults to the website (WebContainer) tree; the owner
     * can point the explorer at an R2 bucket via the `Source ▾` picker. The bucket
     * object-tree → explorer load is the fast-follow; today a bucket selection surfaces
     * an honest source banner with a one-click path back to the website source + a link
     * to the full Buckets workspace, so the control is never a dead end.
     */
    const { sources: codeSources, status: codeSourceStatus, errorMessage: codeSourceError } = useCodeSources();
    const [activeSourceId, setActiveSourceId] = useState<string>(WEBSITE_SOURCE_ID);

    // If the active bucket disappears from the list (deleted/flag flipped), fall back to website.
    useEffect(() => {
      if (activeSourceId !== WEBSITE_SOURCE_ID && !codeSources.some((s) => s.id === activeSourceId)) {
        setActiveSourceId(WEBSITE_SOURCE_ID);
      }
    }, [activeSourceId, codeSources]);

    const activeSource = codeSources.find((s) => s.id === activeSourceId);
    const bucketSourceActive = activeSource?.kind === 'bucket';

    return (
      <PanelGroup direction="vertical" id="editor-vertical">
        <Panel id="editor" order={1} defaultSize={showTerminal ? DEFAULT_EDITOR_SIZE : 100} minSize={20}>
          <PanelGroup direction="horizontal" id="editor-horizontal">
            <Panel
              id="file-tree"
              order={1}
              defaultSize={20}
              minSize={15}
              collapsible
              className="border-r border-bolt-elements-borderColor"
            >
              <div className="h-full flex flex-col">
                {/* Code-view command bar: the ProjectHub (deploy / snapshots / git).
                    Promote -> Production lives in Source Control, Lifecycle, and the ProjectHub itself. */}
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <ProjectHub />
                  </div>
                </div>
                <Tabs.Root defaultValue="files" className="flex flex-col flex-1 min-h-0">
                  <PanelHeader className="w-full text-sm font-medium text-bolt-elements-textSecondary px-1">
                    <div className="h-full flex-shrink-0 flex items-center justify-between w-full gap-1">
                      <Tabs.List className="h-full flex-shrink-0 flex items-center">
                        <Tabs.Trigger
                          value="files"
                          className={classNames(
                            'h-full bg-transparent hover:bg-bolt-elements-background-depth-3 py-0.5 px-2 rounded-lg text-sm font-medium text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary data-[state=active]:text-bolt-elements-textPrimary',
                          )}
                        >
                          Files
                        </Tabs.Trigger>
                        <Tabs.Trigger
                          value="search"
                          className={classNames(
                            'h-full bg-transparent hover:bg-bolt-elements-background-depth-3 py-0.5 px-2 rounded-lg text-sm font-medium text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary data-[state=active]:text-bolt-elements-textPrimary',
                          )}
                        >
                          Search
                        </Tabs.Trigger>
                        <Tabs.Trigger
                          value="locks"
                          className={classNames(
                            'h-full bg-transparent hover:bg-bolt-elements-background-depth-3 py-0.5 px-2 rounded-lg text-sm font-medium text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary data-[state=active]:text-bolt-elements-textPrimary',
                          )}
                        >
                          Locks
                        </Tabs.Trigger>
                        {/* Source Control — Preview working-tree diff + release history (Slice 4). Sits
                            beside the file explorer; inspect/restore only, never commits or Production. */}
                        <Tabs.Trigger
                          value="source-control"
                          title="Source Control — review Preview changes + release history"
                          className={classNames(
                            'h-full bg-transparent hover:bg-bolt-elements-background-depth-3 py-0.5 px-2 rounded-lg text-sm font-medium text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary data-[state=active]:text-bolt-elements-textPrimary',
                          )}
                        >
                          Source
                        </Tabs.Trigger>
                      </Tabs.List>
                      {/* B15 — bucket SOURCE selector. Points the explorer at the website
                          working tree or one of the site's R2 buckets. */}
                      <div className="h-full flex items-center shrink-0">
                        <CodeSourcePicker
                          sources={codeSources}
                          activeSourceId={activeSourceId}
                          status={codeSourceStatus}
                          errorMessage={codeSourceError}
                          onSelect={setActiveSourceId}
                        />
                      </div>
                    </div>
                  </PanelHeader>

                  <Tabs.Content value="files" className="flex-grow overflow-auto focus-visible:outline-none">
                    {bucketSourceActive ? (
                      <BucketSourceNotice
                        source={activeSource!}
                        onBackToWebsite={() => setActiveSourceId(WEBSITE_SOURCE_ID)}
                      />
                    ) : (
                      <FileTree
                        className="h-full"
                        files={files}
                        hideRoot
                        unsavedFiles={unsavedFiles}
                        fileHistory={fileHistory}
                        rootFolder={WORK_DIR}
                        selectedFile={selectedFile}
                        onFileSelect={onFileSelect}
                      />
                    )}
                  </Tabs.Content>

                  <Tabs.Content value="search" className="flex-grow overflow-auto focus-visible:outline-none">
                    <Search />
                  </Tabs.Content>

                  <Tabs.Content value="locks" className="flex-grow overflow-auto focus-visible:outline-none">
                    <LockManager />
                  </Tabs.Content>

                  {/* Source Control owns its own header + scroll, so this slot just fills the column
                      (no extra overflow/padding). It reads Preview vs the published main base + the
                      durable-preview release API over the postMessage bridge. */}
                  <Tabs.Content
                    value="source-control"
                    className="flex-grow min-h-0 flex flex-col focus-visible:outline-none"
                  >
                    <SourceControlPanel />
                  </Tabs.Content>
                </Tabs.Root>
              </div>
            </Panel>

            <PanelResizeHandle />
            <Panel id="editor-main" order={2} className="flex flex-col" defaultSize={80} minSize={20}>
              <PanelHeader className="overflow-x-auto">
                {activeFileSegments?.length && (
                  <div className="flex items-center flex-1 text-sm">
                    <FileBreadcrumb pathSegments={activeFileSegments} files={files} onFileSelect={onFileSelect} />
                    <div className="flex gap-1 ml-auto -mr-1.5">
                      <button
                        type="button"
                        className="px-1.5 py-0.5 rounded-md bg-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive transition-colors"
                        onClick={() => setStickyEnabled((v) => !v)}
                        title="Toggle sticky function/class header"
                        aria-label="Toggle sticky function/class header"
                        aria-pressed={stickyEnabled}
                      >
                        <div className={classNames('i-ph:push-pin text-base', { 'opacity-50': !stickyEnabled })} />
                      </button>
                      <button
                        type="button"
                        className="px-1.5 py-0.5 rounded-md bg-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive transition-colors"
                        onClick={() => setMinimapEnabled((v) => !v)}
                        title="Toggle scroll-position minimap"
                        aria-label="Toggle scroll-position minimap"
                        aria-pressed={minimapEnabled}
                      >
                        <div className={classNames('i-ph:map-trifold text-base', { 'opacity-50': !minimapEnabled })} />
                      </button>
                      <button
                        type="button"
                        className="px-1.5 py-0.5 rounded-md bg-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive transition-colors"
                        onClick={() => setDiffEnabled((v) => !v)}
                        title="Toggle inline diff against AI original"
                        aria-label="Toggle inline diff against AI original"
                        aria-pressed={diffEnabled}
                      >
                        <div className={classNames('i-ph:git-diff text-base', { 'opacity-50': !diffEnabled })} />
                      </button>
                      <button
                        type="button"
                        className="px-1.5 py-0.5 rounded-md bg-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-item-backgroundActive transition-colors"
                        onClick={() => setSplitEnabled((v) => !v)}
                        title="Toggle split-pane (side-by-side editor)"
                        aria-label="Toggle split-pane (side-by-side editor)"
                        aria-pressed={splitEnabled}
                      >
                        <div className={classNames('i-ph:columns text-base', { 'opacity-50': !splitEnabled })} />
                      </button>
                      {activeFileUnsaved && (
                        <>
                          <PanelHeaderButton onClick={onFileSave}>
                            <div className="i-ph:floppy-disk-duotone" />
                            Save
                          </PanelHeaderButton>
                          <PanelHeaderButton onClick={onFileReset}>
                            <div className="i-ph:clock-counter-clockwise-duotone" />
                            Reset
                          </PanelHeaderButton>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </PanelHeader>
              {stickyEnabled && stickyScope && (
                <div className="px-3 py-1 text-xs font-mono text-bolt-elements-textSecondary bg-bolt-elements-background-depth-2 border-b border-bolt-elements-borderColor truncate">
                  {stickyScope}
                </div>
              )}
              {diffPreview && (
                <div className="max-h-[180px] overflow-auto border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-xs font-mono">
                  {diffPreview.empty ? (
                    <div className="px-3 py-2 text-bolt-elements-textTertiary">
                      No AI-tracked changes yet — diff appears once an AI proposal is recorded.
                    </div>
                  ) : (
                    diffPreview.lines.map((l, i) => (
                      <div
                        key={i}
                        className={classNames('px-3 py-0.5 whitespace-pre', {
                          'text-green-500 bg-green-500/10': l.kind === 'add',
                          'text-red-500 bg-red-500/10': l.kind === 'remove',
                          'text-bolt-elements-textSecondary': l.kind === 'context',
                        })}
                      >
                        {l.kind === 'add' ? '+ ' : l.kind === 'remove' ? '- ' : '  '}
                        {l.text}
                      </div>
                    ))
                  )}
                </div>
              )}
              <div
                ref={editorWrapRef}
                className={classNames('h-full flex-1 overflow-hidden modern-scrollbar relative', {
                  'grid grid-cols-2 gap-px bg-bolt-elements-borderColor': splitEnabled,
                })}
              >
                <CodeMirrorEditor
                  theme={theme}
                  editable={!isStreaming && editorDocument !== undefined}
                  settings={editorSettings}
                  doc={editorDocument}
                  autoFocusOnDocumentChange={!isMobile()}
                  onScroll={onEditorScroll}
                  onChange={onEditorChange}
                  onSave={onFileSave}
                />
                {splitEnabled && (
                  <CodeMirrorEditor
                    theme={theme}
                    editable={false}
                    settings={editorSettings}
                    doc={editorDocument}
                    autoFocusOnDocumentChange={false}
                  />
                )}
                {minimapEnabled && editorDocument && !editorDocument.isBinary && (
                  <div className="pointer-events-none absolute top-0 right-0 h-full w-[6px] bg-bolt-elements-borderColor/40">
                    {/*
                     * Minimal scroll-position indicator — vertical strip with
                     * a proportionally-sized thumb tracking the visible
                     * range. Cheap stand-in for a full @replit/minimap.
                     */}
                    <div className="bg-bolt-elements-item-contentAccent/70 w-full h-[12%] mt-[5%] rounded" />
                  </div>
                )}
              </div>
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle />
        {/* Item 7: only mount the xterm chunk once the user has actually
            opened the terminal. Suspense fallback is empty — the panel slot
            stays collapsed until the chunk arrives, which is invisible to
            the user because they just clicked the terminal toggle. */}
        {terminalEverOpened ? (
          <Suspense fallback={null}>
            <BottomPanelTabsLazy />
          </Suspense>
        ) : null}
      </PanelGroup>
    );
  },
);
