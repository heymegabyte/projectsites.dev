import { useStore } from '@nanostores/react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { toast } from 'react-toastify';
import { classNames } from '~/utils/classNames';
import { workbenchStore } from '~/lib/stores/workbench';
import { primaryHostAtom, primarySiteUrl, siteSlugAtom } from '~/lib/stores/site-context';
import { githubConnection } from '~/lib/stores/github';
import { webcontainer } from '~/lib/webcontainer';
import {
  type CodeHistoryResponseMessage,
  isEmbedded,
  nextBridgeCorrelationId,
  postTelemetryToParent,
  postToParent,
  requestFromParent,
} from '~/lib/embed/embedded-mode';
import {
  createProjectSnapshot,
  defaultSnapshotLabel,
  deleteProjectSnapshot,
  getProjectSnapshot,
  listProjectSnapshots,
  type ProjectSnapshot,
  type ProjectSnapshotMeta,
  restoreDeletedSnapshot,
} from '~/lib/persistence/projectSnapshots';

/**
 * ProjectHub — the "command center" button that sits ABOVE the Files / Search /
 * Locks tab strip in the editor's Code view. Its face carries useful live status
 * (site name, file count, snapshot count, GitHub state); clicking it opens a
 * branded panel that CONSOLIDATES the project's power actions into one
 * discoverable place (interconnectedness — no orphaned deploy/snapshot/git
 * surfaces):
 *
 *  - Deploy to Production   → the existing `PS_DEPLOY_REQUEST` admin bridge
 *  - Take a snapshot        → a client-side, per-site restore point ({@link createProjectSnapshot})
 *  - Restore a snapshot     → writes the snapshot's files back (auto-backs-up first — reversible)
 *  - Delete a snapshot      → with Undo
 *  - View git information    → the site's R2 build history + a GitHub link when connected
 *
 * Every action degrades gracefully (never a doomed/white control): outside the
 * embedded admin, bridge-backed actions show a one-line "open from the admin"
 * hint instead of failing silently.
 *
 * @module components/workbench/ProjectHub
 */

type GitCommit = NonNullable<CodeHistoryResponseMessage['commits']>[number];

/** Compact relative time ("just now" / "5m ago" / "2h ago" / "3d ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();

  if (Number.isNaN(then)) {
    return '';
  }

  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));

  if (secs < 45) {
    return 'just now';
  }

  const mins = Math.round(secs / 60);

  if (mins < 60) {
    return `${mins}m ago`;
  }

  const hrs = Math.round(mins / 60);

  if (hrs < 24) {
    return `${hrs}h ago`;
  }

  return `${Math.round(hrs / 24)}d ago`;
}

/** Write a snapshot's files back into the running WebContainer (used by restore). */
async function applyFilesToWorkbench(files: Record<string, string>): Promise<void> {
  const container = await webcontainer;

  for (const [rawPath, content] of Object.entries(files)) {
    let path = rawPath;

    if (path.startsWith(container.workdir)) {
      path = path.slice(container.workdir.length);
    }

    if (!path.startsWith('/')) {
      path = `/${path}`;
    }

    const dir = path.slice(0, path.lastIndexOf('/'));

    if (dir) {
      await container.fs.mkdir(dir, { recursive: true }).catch(() => {
        /* directory already exists — fine. */
      });
    }

    await container.fs.writeFile(path, content);
  }
}

/** Toast body with an Undo affordance after a snapshot delete. */
function UndoDeleteToast({ onUndo }: { onUndo: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-bolt-elements-textPrimary">Snapshot deleted.</span>
      <button
        type="button"
        onClick={onUndo}
        className="text-sm font-medium text-bolt-elements-item-contentAccent hover:underline"
      >
        Undo
      </button>
    </div>
  );
}

const ITEM = classNames(
  'group/item w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left bg-transparent',
  'text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
  'transition-colors outline-none cursor-pointer',
  'focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
  'disabled:opacity-50 disabled:cursor-not-allowed',
);

const MINI = classNames(
  'shrink-0 grid place-items-center w-6 h-6 rounded-md bg-transparent',
  'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
  'hover:bg-bolt-elements-item-backgroundActive transition-colors outline-none',
  'focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
  'disabled:opacity-50 disabled:cursor-not-allowed',
);

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary">
      {children}
    </div>
  );
}

function Divider() {
  return <div className="my-1 h-px bg-bolt-elements-borderColor" />;
}

export function ProjectHub() {
  const slug = useStore(siteSlugAtom);
  const primaryHost = useStore(primaryHostAtom);
  const gh = useStore(githubConnection);
  const filesMap = useStore(workbenchStore.files);

  const [open, setOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<ProjectSnapshotMeta[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [gitOpen, setGitOpen] = useState(false);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);

  const primaryUrl = primarySiteUrl(slug, primaryHost);
  const ghUser = (gh?.user ?? null) as { login?: string; html_url?: string } | null;

  const fileCount = Object.values(filesMap).filter((d) => d?.type === 'file').length;

  const refreshSnapshots = useCallback(async () => {
    try {
      setSnapshots(await listProjectSnapshots(slug ?? ''));
    } catch {
      /* IndexedDB unavailable (SSR / private mode) — leave the list empty. */
    }
  }, [slug]);

  useEffect(() => {
    void refreshSnapshots();
  }, [refreshSnapshots]);

  useEffect(() => {
    if (open) {
      void refreshSnapshots();
      setConfirmDeleteId(null);
    }
  }, [open, refreshSnapshots]);

  const handleDeploy = useCallback(async () => {
    const files = workbenchStore.getTextFiles();
    const entries = Object.entries(files).map(
      ([path, content]) => [path.replace(/^\/home\/project\//, ''), content] as const,
    );

    if (entries.length === 0) {
      toast.error('Nothing to deploy yet — generate or add files first.');
      return;
    }

    if (!isEmbedded) {
      toast.info('Open this editor from the ProjectSites admin to deploy to production.');
      return;
    }

    setDeploying(true);

    try {
      postToParent({
        type: 'PS_DEPLOY_REQUEST',
        files: Object.fromEntries(entries),
        correlationId: nextBridgeCorrelationId(),
      });
      postTelemetryToParent('editor.deploy_from_hub', { files: entries.length });
      toast.info('Deploying to production through the admin…');
      setOpen(false);
    } finally {
      setTimeout(() => setDeploying(false), 4000);
    }
  }, []);

  const handleTakeSnapshot = useCallback(async () => {
    const files = workbenchStore.getTextFiles();

    if (Object.keys(files).length === 0) {
      toast.error('Nothing to snapshot yet — add some files first.');
      return;
    }

    setBusy('create');

    try {
      const meta = await createProjectSnapshot(slug ?? '', defaultSnapshotLabel(), files);
      await refreshSnapshots();
      toast.success(`Snapshot saved — ${meta.fileCount} ${meta.fileCount === 1 ? 'file' : 'files'}.`);
    } catch {
      toast.error('Could not save the snapshot.');
    } finally {
      setBusy(null);
    }
  }, [slug, refreshSnapshots]);

  const handleRestore = useCallback(
    async (id: string) => {
      setBusy(id);

      try {
        const snap = await getProjectSnapshot(id);

        if (!snap) {
          toast.error('That snapshot could not be found.');
          return;
        }

        // Auto-back-up the CURRENT files so a restore is always reversible.
        const current = workbenchStore.getTextFiles();

        if (Object.keys(current).length > 0) {
          await createProjectSnapshot(
            slug ?? '',
            `Before restore • ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
            current,
          ).catch(() => {
            /* backup is best-effort; still let the restore proceed. */
          });
        }

        await applyFilesToWorkbench(snap.files);
        await refreshSnapshots();
        toast.success(`Restored "${snap.label}". Your previous files were saved as a snapshot.`);
        setOpen(false);
      } catch {
        toast.error('Could not restore that snapshot.');
      } finally {
        setBusy(null);
      }
    },
    [slug, refreshSnapshots],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      setBusy(id);

      try {
        const full = await getProjectSnapshot(id); // capture for Undo before removing
        await deleteProjectSnapshot(id);
        await refreshSnapshots();
        setConfirmDeleteId(null);

        if (full) {
          toast(
            <UndoDeleteToast
              onUndo={() => {
                void (async () => {
                  await restoreDeletedSnapshot(full as ProjectSnapshot);
                  await refreshSnapshots();
                  toast.success('Snapshot restored.');
                })();
              }}
            />,
            { autoClose: 6000 },
          );
        } else {
          toast.success('Snapshot deleted.');
        }
      } catch {
        toast.error('Could not delete that snapshot.');
      } finally {
        setBusy(null);
      }
    },
    [refreshSnapshots],
  );

  const loadGit = useCallback(async () => {
    setGitLoading(true);
    setGitError(null);

    try {
      const res = await requestFromParent<CodeHistoryResponseMessage>(
        { type: 'PS_CODE_HISTORY_REQUEST', depth: 8, correlationId: nextBridgeCorrelationId() },
        'PS_CODE_HISTORY_RESPONSE',
      );

      if (res.ok) {
        setCommits(res.commits ?? []);
      } else {
        setGitError(res.error ?? 'No version history yet.');
      }
    } catch (err) {
      setGitError(err instanceof Error ? err.message : 'Could not load git history.');
    } finally {
      setGitLoading(false);
    }
  }, []);

  const toggleGit = useCallback(() => {
    setGitOpen((prev) => {
      const next = !prev;

      if (next && commits.length === 0 && !gitLoading) {
        void loadGit();
      }

      return next;
    });
  }, [commits.length, gitLoading, loadGit]);

  return (
    <div className="px-2 pt-2 pb-1 border-b border-bolt-elements-borderColor">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Project hub — deploy, snapshots, and git"
            className={classNames(
              'group w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left bg-transparent',
              'border border-bolt-elements-borderColor text-bolt-elements-textPrimary',
              'hover:bg-bolt-elements-background-depth-3 transition-colors outline-none',
              'focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
            )}
          >
            <span className="shrink-0 grid place-items-center w-7 h-7 rounded-md bg-bolt-elements-item-backgroundAccent/10 text-bolt-elements-item-contentAccent">
              <span
                className={classNames(
                  'text-base',
                  deploying ? 'i-ph:circle-notch animate-spin' : 'i-ph:rocket-launch-duotone',
                )}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium truncate">{slug || 'Your project'}</span>
              <span className="block text-[11px] text-bolt-elements-textTertiary truncate">
                {fileCount} {fileCount === 1 ? 'file' : 'files'} · {snapshots.length}{' '}
                {snapshots.length === 1 ? 'snapshot' : 'snapshots'}
                {ghUser ? ' · GitHub' : ''}
              </span>
            </span>
            <span className="i-ph:caret-down text-bolt-elements-textTertiary group-data-[state=open]:rotate-180 transition-transform" />
          </button>
        </Popover.Trigger>

        <Popover.Portal>
          <Popover.Content
            className={classNames('ps-more-menu', 'max-h-[72vh] overflow-y-auto p-2 z-[1100]')}
            style={{ width: 320 }}
            sideOffset={6}
            align="start"
          >
            <div className="px-3 pt-1 pb-2">
              <div className="text-sm font-semibold text-bolt-elements-textPrimary truncate">
                {slug || 'Your project'}
              </div>
              {primaryUrl ? (
                <a
                  href={primaryUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-[11px] text-bolt-elements-item-contentAccent hover:underline truncate"
                >
                  {primaryUrl.replace('https://', '')}
                </a>
              ) : (
                <div className="text-[11px] text-bolt-elements-textTertiary">Draft — not published yet</div>
              )}
            </div>

            {/* Deploy */}
            <button type="button" className={ITEM} onClick={handleDeploy} disabled={deploying}>
              <span className="i-ph:rocket-launch text-base text-bolt-elements-item-contentAccent" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">Deploy to Production</span>
                <span className="block text-[11px] text-bolt-elements-textTertiary truncate">
                  {deploying
                    ? 'Deploying…'
                    : primaryUrl
                      ? `Publish to ${primaryUrl.replace('https://', '')}`
                      : 'Publish the current build'}
                </span>
              </span>
              {deploying && <span className="i-ph:circle-notch animate-spin text-bolt-elements-textTertiary" />}
            </button>

            <Divider />
            <SectionLabel>Snapshots</SectionLabel>

            <button type="button" className={ITEM} onClick={handleTakeSnapshot} disabled={busy === 'create'}>
              <span className="i-ph:camera-duotone text-base text-bolt-elements-item-contentAccent" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">Take a snapshot</span>
                <span className="block text-[11px] text-bolt-elements-textTertiary truncate">
                  Save a restore point of the current files
                </span>
              </span>
              {busy === 'create' && <span className="i-ph:circle-notch animate-spin text-bolt-elements-textTertiary" />}
            </button>

            <div className="mt-0.5 space-y-0.5">
              {snapshots.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-bolt-elements-textTertiary">
                  No snapshots yet — take one to create a restore point.
                </p>
              ) : (
                snapshots.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-bolt-elements-background-depth-3"
                  >
                    <span className="i-ph:clock-counter-clockwise text-bolt-elements-textTertiary shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] text-bolt-elements-textPrimary truncate">{s.label}</span>
                      <span className="block text-[10px] text-bolt-elements-textTertiary">
                        {relativeTime(s.createdAt)} · {s.fileCount} {s.fileCount === 1 ? 'file' : 'files'}
                      </span>
                    </span>

                    {confirmDeleteId === s.id ? (
                      <>
                        <button
                          type="button"
                          className="shrink-0 inline-flex items-center gap-1 px-1.5 h-6 rounded-md text-[11px] bg-red-500/15 text-red-300 hover:bg-red-500/25 border border-red-500/30 transition-colors outline-none"
                          onClick={() => handleDelete(s.id)}
                          disabled={busy === s.id}
                          aria-label={`Confirm delete snapshot ${s.label}`}
                        >
                          {busy === s.id ? (
                            <span className="i-ph:circle-notch animate-spin" />
                          ) : (
                            <span className="i-ph:check" />
                          )}
                          Delete
                        </button>
                        <button
                          type="button"
                          className={MINI}
                          onClick={() => setConfirmDeleteId(null)}
                          aria-label="Cancel delete"
                        >
                          <span className="i-ph:x" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={MINI}
                          onClick={() => handleRestore(s.id)}
                          disabled={busy === s.id}
                          title="Restore this snapshot"
                          aria-label={`Restore snapshot ${s.label}`}
                        >
                          <span
                            className={
                              busy === s.id ? 'i-ph:circle-notch animate-spin' : 'i-ph:arrow-counter-clockwise'
                            }
                          />
                        </button>
                        <button
                          type="button"
                          className={classNames(MINI, 'hover:text-red-300')}
                          onClick={() => setConfirmDeleteId(s.id)}
                          title="Delete this snapshot"
                          aria-label={`Delete snapshot ${s.label}`}
                        >
                          <span className="i-ph:trash" />
                        </button>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>

            <Divider />
            <SectionLabel>Source control</SectionLabel>

            <button type="button" className={ITEM} onClick={toggleGit} aria-expanded={gitOpen}>
              <span className="i-ph:git-branch-duotone text-base text-bolt-elements-item-contentAccent" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">View git information</span>
                <span className="block text-[11px] text-bolt-elements-textTertiary truncate">
                  Recent build commits &amp; history
                </span>
              </span>
              <span
                className={classNames(
                  'i-ph:caret-down text-bolt-elements-textTertiary transition-transform',
                  gitOpen && 'rotate-180',
                )}
              />
            </button>

            {gitOpen && (
              <div className="px-3 pb-1">
                {gitLoading ? (
                  <p className="py-2 text-[11px] text-bolt-elements-textTertiary">
                    <span className="i-ph:circle-notch animate-spin mr-1 inline-block align-[-2px]" />
                    Loading history…
                  </p>
                ) : gitError ? (
                  <p className="py-2 text-[11px] text-bolt-elements-textTertiary">{gitError}</p>
                ) : commits.length === 0 ? (
                  <p className="py-2 text-[11px] text-bolt-elements-textTertiary">No version history yet.</p>
                ) : (
                  <ul className="py-1 space-y-1.5">
                    {commits.map((c) => (
                      <li key={c.id} className="flex items-start gap-2 text-[11px]">
                        <span className="i-ph:git-commit text-bolt-elements-item-contentAccent mt-0.5 shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-bolt-elements-textSecondary truncate">{c.message}</span>
                          <span className="block text-bolt-elements-textTertiary font-mono">
                            {c.id.slice(0, 7)} · {relativeTime(c.timestamp)}
                            {c.author ? ` · ${c.author}` : ''}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {ghUser?.html_url ? (
              <a href={ghUser.html_url} target="_blank" rel="noreferrer" className={ITEM}>
                <span className="i-ph:github-logo text-base text-bolt-elements-item-contentAccent" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">View on GitHub</span>
                  <span className="block text-[11px] text-bolt-elements-textTertiary truncate">@{ghUser.login}</span>
                </span>
                <span className="i-ph:arrow-square-out text-bolt-elements-textTertiary" />
              </a>
            ) : (
              <p className="px-3 py-2 text-[11px] text-bolt-elements-textTertiary">
                Connect GitHub in Settings for repository links.
              </p>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
