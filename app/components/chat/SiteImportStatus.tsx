import { useStore } from '@nanostores/react';
import { memo, useEffect } from 'react';
import { workbenchStore } from '~/lib/stores/workbench';
import { markEditorFilesReady } from '~/lib/stores/editor-boot';
import { classNames } from '~/utils/classNames';
import { countProjectFiles, siteImportStatusView } from './site-import-status';

interface SiteImportStatusProps {
  /** File count the worker reported for this imported site ("with N files"). */
  expectedFileCount: number;
}

/**
 * Compact, self-updating status card rendered IN PLACE of the verbose
 * "I've built a professional website for … The project files are: <long list>"
 * assistant message and its per-file "Create <path>" artifact notifications.
 *
 * It watches the live editor file map (`workbenchStore.files`, a nanostore) and
 * shows **"Loading N files…"** with a live sub-count + progress rail, flipping to
 * **"Loaded N files"** the moment the editor holds every project file. Clicking it
 * opens the Workbench — parity with the artifact card it replaces.
 *
 * @remarks `role="status"` + `aria-live="polite"` announce the transition to AT.
 * @example
 * <SiteImportStatus expectedFileCount={49} />
 */
export const SiteImportStatus = memo(({ expectedFileCount }: SiteImportStatusProps) => {
  const files = useStore(workbenchStore.files);
  const loadedCount = countProjectFiles(files);
  const { done, loaded, headline, detail } = siteImportStatusView(expectedFileCount, loadedCount);
  const pct = expectedFileCount > 0 ? Math.min(100, Math.round((loaded / expectedFileCount) * 100)) : 0;

  /*
   * Publish the precise "all project files are in the editor" signal so the
   * full-surface boot overlay (EditorLoadingScreen) fades out exactly now.
   */
  useEffect(() => {
    if (done) {
      markEditorFilesReady();
    }
  }, [done]);

  return (
    <button
      type="button"
      data-testid="site-import-status"
      data-state={done ? 'loaded' : 'loading'}
      onClick={() => workbenchStore.showWorkbench.set(!workbenchStore.showWorkbench.get())}
      title="Click to open Workbench"
      className={classNames(
        'artifact w-full text-left overflow-hidden rounded-lg border border-bolt-elements-borderColor',
        'bg-bolt-elements-artifacts-background hover:bg-bolt-elements-artifacts-backgroundHover',
        'transition-colors duration-150',
      )}
    >
      <div className="flex items-center gap-3 px-5 py-3.5">
        <div
          className={classNames(
            'text-lg shrink-0',
            done ? 'text-bolt-elements-icon-success' : 'text-bolt-elements-loader-progress',
          )}
          aria-hidden="true"
        >
          {done ? <div className="i-ph:check-circle-duotone" /> : <div className="i-svg-spinners:90-ring-with-bg" />}
        </div>
        <div className="min-w-0 flex-1">
          <div
            role="status"
            aria-live="polite"
            className="text-bolt-elements-textPrimary font-medium leading-5 text-sm truncate"
          >
            {headline}
          </div>
          <div className="text-bolt-elements-textSecondary text-xs mt-0.5 truncate">
            {done ? 'Click to open Workbench' : detail}
          </div>
        </div>
        {!done && (
          <div className="shrink-0 font-mono text-[11px] tabular-nums text-bolt-elements-textTertiary">
            {loaded}/{expectedFileCount}
          </div>
        )}
      </div>
      {!done && (
        <div className="h-0.5 w-full bg-bolt-elements-artifacts-borderColor" aria-hidden="true">
          <div
            className="h-full bg-bolt-elements-item-contentAccent transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </button>
  );
});
