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

/** Status-icon glyph + brand color per action lifecycle state. */
function actionIcon(status: ActionState['status']): { icon: string; color: string } {
  switch (status) {
    case 'running': {
      return { icon: 'i-svg-spinners:90-ring-with-bg', color: 'text-[#00e5ff]' };
    }
    case 'complete': {
      return { icon: 'i-ph:check', color: 'text-[#5af78e]' };
    }
    case 'failed': {
      return { icon: 'i-ph:x', color: 'text-[#ff5c79]' };
    }
    case 'aborted': {
      return { icon: 'i-ph:x', color: 'text-[rgba(244,244,255,0.5)]' };
    }
    default: {
      return { icon: 'i-ph:circle-duotone', color: 'text-[rgba(244,244,255,0.4)]' };
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
    <div className="border-t border-[rgba(0,229,255,0.14)] bg-[rgba(0,0,0,0.22)] px-5 py-3">
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
                <div className="text-[11px] leading-4 text-[rgba(244,244,255,0.55)]">{label}</div>
                <code className="ps-import-cmd block font-mono text-xs break-all">
                  <span className="ps-import-cmd-prompt select-none">$ </span>
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
 * header opens the Workbench. Below the header, {@link ImportCommands} prints the
 * terminal commands the import runs.
 *
 * @remarks Styled with EXPLICIT projectsites brand colors (cyan on near-black) so
 * the headline is always legible light-on-dark — never white-on-white — regardless
 * of the embedded editor's bolt theme. `role="status"` + `aria-live="polite"`
 * announce the transition to AT.
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
    <div className="ps-import-card w-full" data-testid="site-import-status" data-state={done ? 'loaded' : 'loading'}>
      <button
        type="button"
        onClick={() => {
          // Open the Code tab + ensure the Workbench is visible. NEVER toggle it
          // off (the old `set(!get())` could hide + push the Workbench off-screen).
          workbenchStore.currentView.set('code');
          workbenchStore.showWorkbench.set(true);
        }}
        title="Click to open Code"
        className="w-full text-left transition-colors duration-150 hover:bg-[rgba(0,229,255,0.05)]"
      >
        <div className="flex items-center gap-3 px-5 py-3.5">
          <div
            className={classNames('text-lg shrink-0 ps-import-glow', done ? 'text-[#5af78e]' : 'text-[#00e5ff]')}
            aria-hidden="true"
          >
            {done ? <div className="i-ph:check-circle-duotone" /> : <div className="i-svg-spinners:90-ring-with-bg" />}
          </div>
          <div className="min-w-0 flex-1">
            <div role="status" aria-live="polite" className="ps-import-headline text-sm leading-5 truncate">
              {headline}
            </div>
            <div className="ps-import-sub text-xs mt-0.5 truncate">{done ? 'Click to open Code' : detail}</div>
          </div>
          {!done && (
            <div className="ps-import-count shrink-0 font-mono text-[11px] tabular-nums">
              {loaded}/{expectedFileCount}
            </div>
          )}
        </div>
        {!done && (
          <div className="h-0.5 w-full bg-[rgba(0,229,255,0.12)]" aria-hidden="true">
            <div
              className="h-full bg-[#00e5ff] transition-[width] duration-300 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
      </button>
      {artifact && <ImportCommands artifact={artifact} />}
    </div>
  );
});
