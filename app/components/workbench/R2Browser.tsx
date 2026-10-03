/**
 * @module app/components/workbench/R2Browser
 * @description An S3-style object browser for a site's OWN per-site R2 bucket (Data & Resource Platform,
 * FIRE 5). Renders inside {@link ./ResourceDetailPanel} when the open resource is R2. Capabilities:
 *
 *   - **List** objects with PREFIX navigation (folder-like breadcrumbs derived from `/`-delimited keys),
 *     paginated via the R2 list cursor — rides the existing `PS_RES_DETAIL_REQUEST { action:'list', prefix }`.
 *   - **Download** an object via a short-lived SCOPED presigned GET URL minted server-side
 *     (`PS_RES_MUTATE_REQUEST { action:'preview_url', key }`). The browser opens the URL directly — the
 *     account R2 credentials NEVER reach the client (INV-6). When minting isn't wired the UI shows an honest
 *     note (no fake link).
 *   - **Upload** a file via a short-lived SCOPED presigned PUT URL (`{ action:'upload_url', key, contentType }`);
 *     the browser PUTs the bytes straight to R2 with that URL — again, no account credentials client-side.
 *     (Falls back to an inline `put` for small text-ish files when a scoped URL isn't available.)
 *   - **Delete** an object (`PS_RES_MUTATE_REQUEST { action:'delete', key, confirm:true }`), confirm-gated.
 *
 * Every operation names ONLY a key/prefix — never a bucket name or CF id (server-resolved). Black + cyan,
 * keyboard-operable, honest empty/error states.
 *
 * @packageDocumentation
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader } from './panel';
import { PanelEmpty } from './panel/PanelEmpty';
import { ConfirmationDialog } from '~/components/ui/Dialog';
import { isEmbedded, onParentMessage, postToParent, type ResDetailResponseMessage } from '~/lib/embed/embedded-mode';

import type { ResourceDetailTarget, ResourceMutateFn } from './ResourceDetailPanel';

const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'not enabled';

/** Files at/under this size can fall back to an inline `put` (base64/text) when a scoped URL isn't wired. */
const INLINE_FALLBACK_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Visibility-aware poll cadence (per `real-time-data-no-manual-refresh`): the listing silently
 * re-fetches the current prefix every 30s while foregrounded — there is NO manual Refresh control.
 * Pauses while `document.hidden` (and mid-upload), refreshes immediately on foreground.
 */
const POLL_INTERVAL_MS = 30_000;

/** One R2 object row as the list surfaces it (from the R2 adapter's `objects[]`). */
interface R2ObjectRow {
  key: string;
  size?: number;
  uploaded?: string;
  etag?: string;
}

type ListState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; objects: R2ObjectRow[]; truncated: boolean; cursor?: string };

let correlationCounter = 0;

function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `r2browser_${++correlationCounter}`;
}

/** Format a byte count compactly (—, 512 B, 4.2 KB, 3.1 MB). */
function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return '—';
  }

  if (n < 1024) {
    return `${n} B`;
  }

  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }

  if (n < 1024 * 1024 * 1024) {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Split a listing into immediate sub-"folders" + leaf objects, relative to the current prefix. */
function splitByPrefix(objects: R2ObjectRow[], prefix: string): { folders: string[]; files: R2ObjectRow[] } {
  const folderSet = new Set<string>();
  const files: R2ObjectRow[] = [];

  for (const obj of objects) {
    const rest = obj.key.startsWith(prefix) ? obj.key.slice(prefix.length) : obj.key;
    const slash = rest.indexOf('/');

    if (slash >= 0) {
      folderSet.add(rest.slice(0, slash + 1)); // keep trailing slash to mark a folder
    } else {
      files.push(obj);
    }
  }

  return { files, folders: [...folderSet].sort() };
}

export interface R2BrowserProps {
  /** The R2 resource target (kind + environment). Never carries a bucket name — the server resolves it. */
  target: ResourceDetailTarget;

  /** The uniform mutate function the panel owns (rides `PS_RES_MUTATE_REQUEST`; never names a CF id). */
  mutate: ResourceMutateFn;
}

/** The S3-style R2 object browser. Prefix nav + upload + download + delete over the site's OWN bucket. */
export const R2Browser = memo(({ target, mutate }: R2BrowserProps) => {
  const [prefix, setPrefix] = useState('');
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [banner, setBanner] = useState<{ tone: 'ok' | 'warn' | 'err'; message: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pendingRef = useRef<
    Map<
      string,
      {
        resolve: (m: ResDetailResponseMessage) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >
  >(new Map());

  /*
   * ONE listener resolving list replies by correlationId (repo []-deps stale-ref rule). Mutate replies are
   * resolved by the panel's own listener via the `mutate` prop — we only own list here.
   */
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_DETAIL_RESPONSE') {
        return;
      }

      const cid = msg.correlationId;

      if (!cid) {
        return;
      }

      const pending = pendingRef.current.get(cid);

      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      pendingRef.current.delete(cid);
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

  const requestList = useCallback(
    (listPrefix: string, cursor?: string): Promise<ResDetailResponseMessage> => {
      return new Promise((resolve, reject) => {
        const cid = nextCorrelationId();
        const timer = setTimeout(() => {
          pendingRef.current.delete(cid);
          reject(new Error('The request timed out.'));
        }, REQUEST_TIMEOUT_MS);
        pendingRef.current.set(cid, { reject, resolve, timer });
        postToParent({
          type: 'PS_RES_DETAIL_REQUEST',
          correlationId: cid,
          kind: target.kind,
          action: 'list',
          environment: target.environment,
          params: { ...(listPrefix ? { prefix: listPrefix } : {}), ...(cursor ? { cursor } : {}), limit: 1000 },
        });
      });
    },
    [target.kind, target.environment],
  );

  /**
   * Load (or silently reload) the listing for a prefix.
   *
   * @param silent - when `true` (a background poll / foreground refresh), the current listing stays
   *   on-screen (no loading flash) and a transient failure keeps the last good view — freshness is
   *   invisible, per `real-time-data-no-manual-refresh`.
   */
  const load = useCallback(
    async (listPrefix: string, silent = false) => {
      if (!silent) {
        setState({ status: 'loading' });
      }

      if (!isEmbedded) {
        setState({ status: 'error', message: 'Open this from the ProjectSites admin to browse your files.' });
        return;
      }

      try {
        const reply = await requestList(listPrefix);

        if (!reply.ok) {
          if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
            setState({ status: 'disabled' });
            return;
          }

          if (!silent) {
            setState({ status: 'error', message: reply.error || 'Could not list objects.' });
          }

          return;
        }

        const result = reply.result;

        if (!result || !result.ok) {
          if (!silent) {
            setState({ status: 'error', message: result?.error?.message || 'Could not list objects.' });
          }

          return;
        }

        const data = (result.data ?? {}) as { objects?: R2ObjectRow[]; truncated?: boolean; cursor?: string };
        setState({
          cursor: data.cursor,
          objects: Array.isArray(data.objects) ? data.objects : [],
          status: 'ready',
          truncated: data.truncated === true,
        });
      } catch (err) {
        if (!silent) {
          setState({ status: 'error', message: err instanceof Error ? err.message : 'Could not list objects.' });
        }
      }
    },
    [requestList],
  );

  useEffect(() => {
    void load(prefix);
  }, [prefix, load]);

  /*
   * Visibility-aware real-time poll (per `real-time-data-no-manual-refresh`) — the manual Refresh
   * button is gone; the listing keeps ITSELF current. Registered once; the tick reads the latest
   * loader/prefix through refs so prefix navigation never tears down the timer. It skips while the
   * tab is hidden or an upload is in flight, refreshes immediately on foreground, cleans up on
   * unmount.
   */
  const loadRef = useRef(load);
  loadRef.current = load;

  const prefixRef = useRef(prefix);
  prefixRef.current = prefix;

  const uploadingRef = useRef(uploading);
  uploadingRef.current = uploading;
  useEffect(() => {
    if (!isEmbedded) {
      return undefined;
    }

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      if (uploadingRef.current) {
        return;
      }

      void loadRef.current(prefixRef.current, true);
    };

    const interval = setInterval(tick, POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        tick();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const { folders, files } = useMemo(
    () => (state.status === 'ready' ? splitByPrefix(state.objects, prefix) : { files: [], folders: [] }),
    [state, prefix],
  );

  /** Breadcrumb segments for the current prefix (each clickable to jump up the tree). */
  const crumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean);
    const acc: { label: string; prefix: string }[] = [{ label: 'root', prefix: '' }];
    let cur = '';

    for (const part of parts) {
      cur += `${part}/`;
      acc.push({ label: part, prefix: cur });
    }

    return acc;
  }, [prefix]);

  /** Download an object via a short-lived SCOPED presigned GET URL (never account credentials — INV-6). */
  const download = useCallback(
    async (key: string) => {
      setBusyKey(key);
      setBanner(null);

      const outcome = await mutate('preview_url', { key });
      setBusyKey(null);

      if (outcome.kind === 'success') {
        const url = typeof outcome.result.url === 'string' ? outcome.result.url : undefined;

        if (url) {
          window.open(url, '_blank', 'noopener,noreferrer');
          return;
        }

        const approach = typeof outcome.result.approach === 'string' ? outcome.result.approach : undefined;
        setBanner({
          message: approach ?? 'A scoped download link is not available for this object yet.',
          tone: 'warn',
        });

        return;
      }

      setBanner({ message: outcome.message, tone: outcome.kind === 'not_available' ? 'warn' : 'err' });
    },
    [mutate],
  );

  /** Delete an object (confirm-gated) — rides the panel's mutate with confirm:true. */
  const doDelete = useCallback(
    async (key: string) => {
      setBusyKey(key);
      setBanner(null);

      const outcome = await mutate('delete', { key }, true);
      setBusyKey(null);

      if (outcome.kind === 'success') {
        setBanner({ message: `Deleted “${key}”.`, tone: 'ok' });
        void load(prefix);

        return;
      }

      setBanner({ message: outcome.message, tone: outcome.kind === 'not_available' ? 'warn' : 'err' });
    },
    [mutate, load, prefix],
  );

  /** Upload a file: mint a SCOPED presigned PUT URL and PUT the bytes straight to R2 (never creds client-side). */
  const upload = useCallback(
    async (file: File) => {
      const key = `${prefix}${file.name}`;
      setUploading(true);
      setBanner(null);

      try {
        const outcome = await mutate('upload_url', { contentType: file.type || 'application/octet-stream', key });

        if (outcome.kind === 'success' && typeof outcome.result.url === 'string') {
          const putRes = await fetch(outcome.result.url, {
            body: file,
            headers: { 'content-type': file.type || 'application/octet-stream' },
            method: 'PUT',
          });

          if (!putRes.ok) {
            setBanner({ message: `Upload failed (HTTP ${putRes.status}).`, tone: 'err' });
          } else {
            setBanner({ message: `Uploaded “${file.name}”.`, tone: 'ok' });
            void load(prefix);
          }

          return;
        }

        // No scoped URL — fall back to an inline put for a small text-ish file; otherwise honest note.
        if (
          file.size <= INLINE_FALLBACK_MAX_BYTES &&
          (file.type.startsWith('text/') || file.type === 'application/json')
        ) {
          const body = await file.text();
          const put = await mutate('put', { body, contentType: file.type, key }, true);

          if (put.kind === 'success') {
            setBanner({ message: `Uploaded “${file.name}”.`, tone: 'ok' });
            void load(prefix);
          } else {
            setBanner({ message: put.message, tone: put.kind === 'not_available' ? 'warn' : 'err' });
          }

          return;
        }

        const approach =
          outcome.kind === 'success' && typeof outcome.result.approach === 'string'
            ? outcome.result.approach
            : outcome.kind !== 'success'
              ? outcome.message
              : 'A scoped upload link is not available yet — large/binary uploads need it.';
        setBanner({ message: approach, tone: 'warn' });
      } catch (err) {
        setBanner({ message: err instanceof Error ? err.message : 'Upload failed.', tone: 'err' });
      } finally {
        setUploading(false);

        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [mutate, prefix, load],
  );

  if (state.status === 'disabled') {
    return (
      <PanelShell className="!h-auto flex-1 min-h-0">
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-bolt-elements-textTertiary">This surface isn’t enabled for your site.</p>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell className="!h-auto flex-1 min-h-0" testId="r2-browser">
      {/* Canonical header: breadcrumbs as subtitle + upload + the quiet live affordance (self-updating; no manual refresh). */}
      <PanelHeader
        icon="i-ph:folder-duotone"
        title="R2 storage"
        subtitle={
          <nav className="flex items-center gap-1 min-w-0 overflow-x-auto" aria-label="Folder path">
            {crumbs.map((c, i) => (
              <React.Fragment key={c.prefix}>
                {i > 0 && <span className="text-bolt-elements-textTertiary text-xs shrink-0">/</span>}
                <button
                  type="button"
                  onClick={() => setPrefix(c.prefix)}
                  className={classNames(
                    'text-xs rounded px-1.5 py-0.5 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                    c.prefix === prefix
                      ? 'text-bolt-elements-item-contentAccent font-semibold'
                      : 'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary',
                  )}
                >
                  {c.label}
                </button>
              </React.Fragment>
            ))}
          </nav>
        }
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              data-testid="r2-upload-input"
              onChange={(e) => {
                const f = e.target.files?.[0];

                if (f) {
                  void upload(f);
                }
              }}
            />
            <button
              type="button"
              data-testid="r2-upload-button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="min-h-[28px] inline-flex items-center gap-1.5 rounded-lg bg-bolt-elements-item-backgroundAccent px-2.5 py-1 text-xs font-semibold text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              <div
                className={classNames(
                  uploading
                    ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                    : 'i-ph:upload-simple-duotone',
                  'text-sm',
                )}
              />
              <span className="inline-block text-center">{uploading ? 'Uploading' : 'Upload'}</span>
            </button>
            {/* Live affordance — the listing self-updates on a visibility-aware poll; no manual Refresh
                (per `real-time-data-no-manual-refresh`). */}
            <span
              className="hidden sm:inline-flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary select-none shrink-0"
              role="status"
              aria-live="off"
              title="This view updates itself automatically"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-bolt-elements-item-contentAccent animate-pulse motion-reduce:animate-none"
              />
              Live
            </span>
          </>
        }
      />

      {banner && (
        <div
          role="status"
          data-testid="r2-browser-banner"
          className={classNames(
            'shrink-0 flex items-start gap-2 px-4 py-2 text-xs border-b',
            banner.tone === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
              : banner.tone === 'warn'
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                : 'border-red-500/30 bg-red-500/10 text-red-300',
          )}
        >
          <div
            className={classNames(
              banner.tone === 'ok'
                ? 'i-ph:check-circle-duotone'
                : banner.tone === 'warn'
                  ? 'i-ph:info-duotone'
                  : 'i-ph:x-circle-duotone',
              'text-base shrink-0 mt-0.5',
            )}
          />
          <p className="min-w-0 flex-1 leading-relaxed">{banner.message}</p>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label="Dismiss"
            className="i-ph:x text-sm shrink-0 opacity-70 hover:opacity-100 cursor-pointer"
          />
        </div>
      )}

      {/* Object listing. */}
      <div className="flex-1 overflow-auto">
        {state.status === 'loading' && (
          <div className="flex items-center gap-2 px-4 py-6 text-sm text-bolt-elements-textTertiary">
            <div className="i-ph:circle-notch animate-spin motion-reduce:animate-none text-base" />
            Loading files…
          </div>
        )}

        {state.status === 'error' && (
          <div className="px-4 py-6">
            <p className="text-sm text-red-300">{state.message}</p>
            <button
              type="button"
              onClick={() => void load(prefix)}
              className="mt-2 text-xs text-bolt-elements-item-contentAccent hover:underline cursor-pointer"
            >
              Try again
            </button>
          </div>
        )}

        {state.status === 'ready' && folders.length === 0 && files.length === 0 && (
          <PanelEmpty
            testId="r2-browser-empty"
            icon="i-ph:folder-open-duotone"
            title="This bucket is empty"
            description="Upload a file to get started — images, documents, exports, anything your site needs."
            action={
              <button
                type="button"
                data-testid="r2-empty-upload"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[30px] inline-flex items-center gap-1.5 rounded-lg bg-bolt-elements-item-backgroundAccent px-4 py-2 text-[12px] font-semibold text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div
                  className={classNames(
                    uploading
                      ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                      : 'i-ph:upload-simple-duotone',
                    'text-sm',
                  )}
                  aria-hidden
                />
                Upload your first file
              </button>
            }
          />
        )}

        {state.status === 'ready' && (folders.length > 0 || files.length > 0) && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-bolt-elements-background-depth-1 z-10">
              <tr className="border-b border-bolt-elements-borderColor text-bolt-elements-textTertiary">
                <th className="text-left font-medium px-4 py-2">Name</th>
                <th className="text-right font-medium px-3 py-2 w-24">Size</th>
                <th className="text-right font-medium px-4 py-2 w-28">Actions</th>
              </tr>
            </thead>
            <tbody>
              {folders.map((folder) => (
                <tr
                  key={`dir:${folder}`}
                  className="border-b border-bolt-elements-borderColor/50 hover:bg-bolt-elements-background-depth-2/50 cursor-pointer"
                  onClick={() => setPrefix(`${prefix}${folder}`)}
                  data-testid="r2-folder-row"
                >
                  <td className="px-4 py-1.5">
                    <span className="inline-flex items-center gap-1.5 text-bolt-elements-textPrimary">
                      <div className="i-ph:folder-duotone text-base text-bolt-elements-item-contentAccent" />
                      {folder.replace(/\/$/, '')}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-bolt-elements-textTertiary">—</td>
                  <td className="px-4 py-1.5 text-right text-bolt-elements-textTertiary">
                    <div className="i-ph:caret-right inline-block text-sm" />
                  </td>
                </tr>
              ))}

              {files.map((file) => {
                const name = file.key.startsWith(prefix) ? file.key.slice(prefix.length) : file.key;
                const rowBusy = busyKey === file.key;

                return (
                  <tr
                    key={`file:${file.key}`}
                    className="border-b border-bolt-elements-borderColor/50 hover:bg-bolt-elements-background-depth-2/50"
                    data-testid="r2-file-row"
                  >
                    <td className="px-4 py-1.5">
                      <span className="inline-flex items-center gap-1.5 text-bolt-elements-textPrimary min-w-0">
                        <div className="i-ph:file-duotone text-base text-bolt-elements-textTertiary shrink-0" />
                        <span className="truncate" title={name}>
                          {name}
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right text-bolt-elements-textTertiary tabular-nums">
                      {formatBytes(file.size)}
                    </td>
                    <td className="px-4 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          data-testid="r2-download"
                          disabled={rowBusy}
                          onClick={() => void download(file.key)}
                          aria-label={`Download ${name}`}
                          title="Download"
                          className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer disabled:opacity-40"
                        >
                          <div
                            className={classNames(
                              rowBusy
                                ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                                : 'i-ph:download-simple',
                              'text-sm',
                            )}
                          />
                        </button>
                        <button
                          type="button"
                          data-testid="r2-delete"
                          disabled={rowBusy}
                          onClick={() => setConfirmDelete(file.key)}
                          aria-label={`Delete ${name}`}
                          title="Delete"
                          className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-red-400 hover:bg-red-500/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer disabled:opacity-40"
                        >
                          <div className="i-ph:trash text-sm" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {state.status === 'ready' && state.truncated && (
          <p className="px-4 py-2 text-[11px] text-bolt-elements-textTertiary">
            Showing the first 1000 objects. Narrow with a folder to see more.
          </p>
        )}
      </div>

      {confirmDelete && (
        <ConfirmationDialog
          isOpen={true}
          title="Delete this object?"
          description={`This permanently deletes “${confirmDelete}” from your bucket. This can’t be undone. Continue?`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          variant="destructive"
          isLoading={busyKey === confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onConfirm={() => {
            const key = confirmDelete;
            setConfirmDelete(null);
            void doDelete(key);
          }}
        />
      )}
    </PanelShell>
  );
});
