import { useStore } from '@nanostores/react';
import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import * as Tabs from '@radix-ui/react-tabs';
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
                <ProjectHub />
                <Tabs.Root defaultValue="files" className="flex flex-col flex-1 min-h-0">
                  <PanelHeader className="w-full text-sm font-medium text-bolt-elements-textSecondary px-1">
                    <div className="h-full flex-shrink-0 flex items-center justify-between w-full">
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
                      </Tabs.List>
                    </div>
                  </PanelHeader>

                  <Tabs.Content value="files" className="flex-grow overflow-auto focus-visible:outline-none">
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
                  </Tabs.Content>

                  <Tabs.Content value="search" className="flex-grow overflow-auto focus-visible:outline-none">
                    <Search />
                  </Tabs.Content>

                  <Tabs.Content value="locks" className="flex-grow overflow-auto focus-visible:outline-none">
                    <LockManager />
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
