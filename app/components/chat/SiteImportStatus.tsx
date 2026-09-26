import { useStore } from '@nanostores/react';
import { memo, useEffect } from 'react';
import type { ArtifactState } from '~/lib/stores/workbench';
import { workbenchStore } from '~/lib/stores/workbench';
import { markEditorFilesReady } from '~/lib/stores/editor-boot';
import { siteSlugAtom } from '~/lib/stores/site-context';
import type { ActionState } from '~/lib/runtime/action-runner';
import { classNames } from '~/utils/classNames';
import { countProjectFiles, siteImportStatusView } from './site-import-status';

interface SiteImportStatusProps {
  /** File count the worker reported for this imported site ("with N files"). */
  expectedFileCount: number;
}

/** Status-icon glyph + color per action lifecycle state (mirrors the Artifact list). */
function actionIcon(status: ActionState['status']): { icon: string; color: string } {
  switch (status) {
    case 'running': {
      return { icon: 'i-svg-spinners:90-ring-with-bg', color: 'text-bolt-elements-loader-progress' };
    }
    case 'complete': {
      return { icon: 'i-ph:check', color: 'text-bolt-elements-icon-success' };
    }
    case 'failed': {
      return { icon: 'i-ph:x', color: 'text-bolt-elements-icon-error' };
    }
    case 'aborted': {
      return { icon: 'i-ph:x', color: 'text-bolt-elements-textSecondary' };
    }
    default: {
      return { icon: 'i-ph:circle-duotone', color: 'text-bolt-elements-textTertiary' };
    }
  }
}

/**
 * The terminal commands the import runs (`npm install …`, `npm run dev`), printed
 * the "old way" — one `$ command` line each with a live run indicator — even though
 * the verbose per-file "Create …" list is collapsed into the status card above.
 * File-import builds (compiled output, no package.json) have no commands → renders
 * nothing.
 *
 * @remarks Subscribes to the artifact's action runner so each line flips
 *   pending → running → complete as the command executes.
 */
const ImportCommands = memo(({ artifact }: { artifact: ArtifactState }) => {
  const actions = useStore(artifact.runner.actions);
  const commands = Object.values(actions).filter((a) => a.type === 'shell' || a.type === 'start');

  if (commands.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-bolt-elements-artifacts-borderColor bg-bolt-elements-actions-background px-5 py-3">
      <ul className="list-none space-y-2">
        {commands.map((action, index) => {
          const { icon, color } = actionIcon(action.status);
          const label = action.type === 'start' ? 'Start dev server' : 'Run command';

          return (
            <li key={index} className="flex items-start gap-2">
              <span className={classNames('text-base shrink-0 mt-px', color)} aria-hidden="true">
                <span className={icon} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-bolt-elements-textSecondary text-[11px] leading-4">{label}</div>
                <code className="block font-mono text-xs text-bolt-elements-textPrimary break-all">
                  <span className="text-bolt-elements-textTertiary select-none">$ </span>
                  {(action.content ?? '').trim()}
                </code>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
});

/**
 * Compact, self-updating status card rendered IN PLACE of the verbose
 * "I've built a professional website for … The project files are: <long list>"
 * assistant message and its per-file "Create <path>" artifact notifications.
 *
 * It watches the live editor file map (`workbenchStore.files`, a nanostore) and
 * shows **"Loading N files…"** with a live sub-count + progress rail, flipping to
 * **"Loaded N files"** the moment the editor holds every project file. Clicking the
 * header opens the Workbench — parity with the artifact card it replaces. Below the
 * header, {@link ImportCommands} prints the terminal commands the import runs.
 *
 * @remarks `role="status"` + `aria-live="polite"` announce the transition to AT.
 * @example
 * <SiteImportStatus expectedFileCount={49} />
 */
export const SiteImportStatus = memo(({ expectedFileCount }: SiteImportStatusProps) => {
  const files = useStore(workbenchStore.files);
  const artifacts = useStore(workbenchStore.artifacts);
  const slug = useStore(siteSlugAtom);
  const loadedCount = countProjectFiles(files);
  const { done, loaded, headline, detail } = siteImportStatusView(expectedFileCount, loadedCount);
  const pct = expectedFileCount > 0 ? Math.min(100, Math.round((loaded / expectedFileCount) * 100)) : 0;

  /*
   * The worker builds the import artifact with id `site-<slug>` (site_by_slug
   * handler). Target it directly so we surface ONLY this import's commands; fall
   * back to the first artifact that actually has shell/start actions when the slug
   * isn't known yet (standalone editor).
   */
  const artifact =
    (slug ? artifacts[`site-${slug}`] : undefined) ??
    Object.values(artifacts).find((a) =>
      Object.values(a.runner.actions.get()).some((act) => act.type === 'shell' || act.type === 'start'),
    );

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
    <div
      className={classNames(
        'artifact w-full overflow-hidden rounded-lg border border-bolt-elements-borderColor',
        'bg-bolt-elements-artifacts-background transition-colors duration-150',
      )}
      data-testid="site-import-status"
      data-state={done ? 'loaded' : 'loading'}
    >
      <button
        type="button"
        onClick={() => workbenchStore.showWorkbench.set(!workbenchStore.showWorkbench.get())}
        title="Click to open Workbench"
        className="w-full text-left hover:bg-bolt-elements-artifacts-backgroundHover transition-colors duration-150"
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
      {artifact && <ImportCommands artifact={artifact} />}
    </div>
  );
});
