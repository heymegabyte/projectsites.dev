/**
 * @file Resources — the editor "Resources" tab's per-site ASSET overview.
 *
 * @remarks
 * A gorgeous, concise (Airtable/Notion/Linear feel) overview of EVERYTHING a site stores:
 *
 *   1. **Media library** — a grid/gallery of the site's assets (images/video/docs) with a kind + source
 *      filter, a name search, UPLOAD (reads the file locally → base64 → `PS_RES_MEDIA_UPLOAD`), and DELETE
 *      (`PS_RES_MEDIA { action:'delete', id }`). Assets come from `PS_RES_MEDIA { action:'list', … }`.
 *   2. **Site build files** — the files that make up the current published build (`PS_RES_SITE_FILES`),
 *      with byte sizes + open-in-new.
 *   3. **Storage-usage header** — total size + per-kind counts, read from the media `list` response's
 *      `usage` rollup.
 *
 * The embedded editor has no cross-origin session, so it CANNOT fetch the worker directly — it talks to the
 * parent admin (which holds the bearer + `selectedSite`) over `postMessage`, via the typed senders in
 * `embedded-mode.ts` (`requestResMedia`, `requestMediaUpload`, `requestResSiteFiles`). Every CF id is
 * server-resolved for the authed site + environment; this panel never sees or sends one. Dark flags surface
 * as a friendly "not enabled yet" state (a 404 whose message includes "not enabled"), never a scary error.
 *
 * The deeper per-kind Cloudflare-primitive console ({@link ResourceOverviewPanel} → {@link ResourceDetailPanel})
 * stays IMPORTED + reachable from a link in this panel's header, so no proven surface is orphaned
 * (interconnectedness). Loading + empty + error states are all handled per surface.
 *
 * Style mirrors the sibling `./SiteTablesPanel` + `./ResourceOverviewPanel` EXACTLY (UnoCSS `bolt-elements-*`
 * tokens, phosphor `i-ph:*` icons, black + cyan, ≥24px targets, aria-labels, focus-visible rings,
 * `motion-reduce:*` for prefers-reduced-motion).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  postToastToParent,
  requestResMedia,
  requestMediaUpload,
  requestResSiteFiles,
  type MediaAssetEntry,
  type MediaUsageSummary,
  type SiteBuildFileEntry,
} from '~/lib/embed/embedded-mode';
import { ResourceOverviewPanel } from './ResourceOverviewPanel';

// ── Types ────────────────────────────────────────────────────────────────────

type ResourceEnvironment = 'preview' | 'production';

const ENVIRONMENTS: { value: ResourceEnvironment; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'preview', label: 'Preview' },
];

/** The two asset sections this panel surfaces. */
type Section = 'media' | 'files';

type MediaState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; assets: MediaAssetEntry[]; usage?: MediaUsageSummary; cursor?: string };

type FilesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; files: SiteBuildFileEntry[]; prefix?: string };

// ── Constants ────────────────────────────────────────────────────────────────

const DISABLED_404 = 'not enabled';
const KIND_FILTERS: { value: string; label: string; icon: string }[] = [
  { value: '', label: 'All', icon: 'i-ph:squares-four' },
  { value: 'image', label: 'Images', icon: 'i-ph:image' },
  { value: 'video', label: 'Video', icon: 'i-ph:video' },
  { value: 'document', label: 'Docs', icon: 'i-ph:file-text' },
];

/** Human-readable byte size (1 decimal for KB+). */
function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) {
    return '—';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** True when an asset is an image we can thumbnail (by contentType or kind or extension). */
function isImageAsset(asset: MediaAssetEntry): boolean {
  const ct = (asset.contentType || '').toLowerCase();

  if (ct.startsWith('image/')) {
    return true;
  }

  if ((asset.kind || '').toLowerCase() === 'image') {
    return true;
  }

  return /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(asset.name || asset.url || '');
}

/** A phosphor glyph for a non-image asset kind. */
function iconForAsset(asset: MediaAssetEntry): string {
  const ct = (asset.contentType || '').toLowerCase();
  const kind = (asset.kind || '').toLowerCase();

  if (ct.startsWith('video/') || kind === 'video') {
    return 'i-ph:file-video-duotone';
  }

  if (ct.includes('pdf') || /\.pdf$/i.test(asset.name || '')) {
    return 'i-ph:file-pdf-duotone';
  }

  if (kind === 'document' || /\.(docx?|txt|md|csv|json|xml)$/i.test(asset.name || '')) {
    return 'i-ph:file-text-duotone';
  }

  if (ct.startsWith('audio/') || kind === 'audio') {
    return 'i-ph:file-audio-duotone';
  }

  return 'i-ph:file-duotone';
}

/** Read a File into a base64 data URL (for the upload bridge). */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

// ── Component ────────────────────────────────────────────────────────────────

export const ResourcesPanel = memo(() => {
  const [environment, setEnvironment] = useState<ResourceEnvironment>('production');
  const [section, setSection] = useState<Section>('media');

  // Media library state.
  const [media, setMedia] = useState<MediaState>({ status: 'loading' });
  const [kind, setKind] = useState<string>('');
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Build files state (lazy — loaded when the section is first opened).
  const [files, setFiles] = useState<FilesState>({ status: 'idle' });

  // The deeper CF-primitive console overlay (kept reachable — interconnectedness).
  const [showConsole, setShowConsole] = useState(false);

  /** Load (or reload) the media library for the current environment + filters. */
  const loadMedia = useCallback(async () => {
    setMedia({ status: 'loading' });

    if (!isEmbedded) {
      setMedia({ status: 'error', message: 'Open this from the ProjectSites admin to see your media.' });
      return;
    }

    try {
      const reply = await requestResMedia({
        action: 'list',
        environment,
        kind: kind || undefined,
        search: search.trim() || undefined,
      });

      if (!reply.ok) {
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setMedia({ status: 'disabled' });
          return;
        }

        setMedia({ status: 'error', message: reply.error || 'Could not load your media.' });

        return;
      }

      setMedia({ status: 'ready', assets: reply.assets ?? [], usage: reply.usage, cursor: reply.cursor });
    } catch (err) {
      setMedia({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your media.' });
    }
  }, [environment, kind, search]);

  /** Load (or reload) the site's build files for the current environment. */
  const loadFiles = useCallback(async () => {
    setFiles({ status: 'loading' });

    if (!isEmbedded) {
      setFiles({ status: 'error', message: 'Open this from the ProjectSites admin to see your build files.' });
      return;
    }

    try {
      const reply = await requestResSiteFiles({ environment });

      if (!reply.ok) {
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setFiles({ status: 'disabled' });
          return;
        }

        setFiles({ status: 'error', message: reply.error || 'Could not load your build files.' });

        return;
      }

      setFiles({ status: 'ready', files: reply.files ?? [], prefix: reply.prefix });
    } catch (err) {
      setFiles({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your build files.' });
    }
  }, [environment]);

  // Media reloads whenever env/kind/search changes (debounced on search).
  useEffect(() => {
    const t = setTimeout(() => void loadMedia(), 250);

    return () => clearTimeout(t);
  }, [loadMedia]);

  // Build files load when the Files section is opened (and on env change while it's open).
  useEffect(() => {
    if (section === 'files') {
      void loadFiles();
    }
  }, [section, loadFiles]);

  /** Handle a chosen upload file: read → base64 → bridge → prepend the new asset + toast. */
  const onUploadFile = useCallback(
    async (file: File) => {
      if (uploading) {
        return;
      }

      setUploading(true);

      try {
        const dataUrl = await fileToDataUrl(file);
        const reply = await requestMediaUpload({
          name: file.name,
          contentType: file.type || 'application/octet-stream',
          dataUrl,
          environment,
        });

        if (!reply.ok) {
          if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
            setMedia({ status: 'disabled' });
            return;
          }

          postToastToParent('error', reply.error || 'Upload failed.');

          return;
        }

        postToastToParent('success', `Uploaded ${file.name}.`);

        // Prepend optimistically, then reconcile with a fresh list (updates the usage rollup).
        if (reply.asset) {
          setMedia((cur) =>
            cur.status === 'ready' ? { ...cur, assets: [reply.asset as MediaAssetEntry, ...cur.assets] } : cur,
          );
        }

        await loadMedia();
      } catch (err) {
        postToastToParent('error', err instanceof Error ? err.message : 'Upload failed.');
      } finally {
        setUploading(false);
      }
    },
    [uploading, environment, loadMedia],
  );

  /** Delete one asset by id → remove locally + toast. */
  const onDeleteAsset = useCallback(
    async (asset: MediaAssetEntry) => {
      if (deletingId) {
        return;
      }

      setDeletingId(asset.id);

      try {
        const reply = await requestResMedia({ action: 'delete', id: asset.id, environment });

        if (!reply.ok) {
          if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
            setMedia({ status: 'disabled' });
            return;
          }

          postToastToParent('error', reply.error || 'Could not delete the file.');

          return;
        }

        postToastToParent('success', `Deleted ${asset.name || 'the file'}.`);
        setMedia((cur) =>
          cur.status === 'ready' ? { ...cur, assets: cur.assets.filter((a) => a.id !== asset.id) } : cur,
        );
      } catch (err) {
        postToastToParent('error', err instanceof Error ? err.message : 'Could not delete the file.');
      } finally {
        setDeletingId(null);
      }
    },
    [deletingId, environment],
  );

  const onPickFile = useCallback(() => fileInputRef.current?.click(), []);

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];

      if (file) {
        void onUploadFile(file);
      }

      // Reset so the same file can be re-picked.
      e.target.value = '';
    },
    [onUploadFile],
  );

  // Derived usage summary (from the media list response, with a page fallback).
  const usage = useMemo<MediaUsageSummary>(() => {
    if (media.status !== 'ready') {
      return {};
    }

    if (media.usage) {
      return media.usage;
    }

    // Fallback: derive from the loaded page (honest "this page" when the server didn't roll up).
    const totalBytes = media.assets.reduce((sum, a) => sum + (a.size ?? 0), 0);

    return { totalBytes, totalCount: media.assets.length };
  }, [media]);

  // The deeper CF-primitive console — kept reachable so no proven surface is orphaned.
  if (showConsole) {
    return (
      <div className="h-full flex flex-col bg-bolt-elements-background-depth-1">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0">
          <button
            type="button"
            onClick={() => setShowConsole(false)}
            className="min-h-[24px] flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:arrow-left text-sm" /> Back to assets
          </button>
          <span className="text-[11px] text-bolt-elements-textTertiary">Advanced · Cloudflare resources</span>
        </div>
        <div className="flex-1 min-h-0">
          <ResourceOverviewPanel />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <Header
        environment={environment}
        onEnvironment={setEnvironment}
        section={section}
        onSection={setSection}
        usage={usage}
        onRefresh={() => (section === 'media' ? void loadMedia() : void loadFiles())}
        onOpenConsole={() => setShowConsole(true)}
      />

      <div className="relative flex-1 overflow-hidden">
        {section === 'media' ? (
          <MediaLibrary
            state={media}
            kind={kind}
            search={search}
            uploading={uploading}
            deletingId={deletingId}
            onKind={setKind}
            onSearch={setSearch}
            onPickFile={onPickFile}
            onDelete={onDeleteAsset}
            onRetry={() => void loadMedia()}
          />
        ) : (
          <BuildFiles state={files} onRetry={() => void loadFiles()} />
        )}
      </div>

      {/* Hidden file input backing the Upload button. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*,.pdf,.txt,.md,.csv,.json"
        className="hidden"
        onChange={onFileInputChange}
        data-testid="resources-file-input"
      />
    </div>
  );
});

ResourcesPanel.displayName = 'ResourcesPanel';

// ── Header (env selector · section toggle · storage usage · refresh · advanced) ───────────────────

const Header = memo(
  ({
    environment,
    onEnvironment,
    section,
    onSection,
    usage,
    onRefresh,
    onOpenConsole,
  }: {
    environment: ResourceEnvironment;
    onEnvironment: (env: ResourceEnvironment) => void;
    section: Section;
    onSection: (s: Section) => void;
    usage: MediaUsageSummary;
    onRefresh: () => void;
    onOpenConsole: () => void;
  }) => (
    <div className="relative border-b border-bolt-elements-borderColor shrink-0 overflow-hidden">
      {/* Subtle brand wash — sets the cinematic black+cyan tone from the first pixel. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{ background: 'linear-gradient(90deg, color-mix(in oklch, #00e5ff 8%, transparent), transparent 45%)' }}
      />
      <div className="relative flex items-center gap-3 px-4 pt-3">
        <div className="flex items-center justify-center h-9 w-9 rounded-xl border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/[0.08] shrink-0">
          <div className="i-ph:images-square-duotone text-xl text-bolt-elements-item-contentAccent" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-bolt-elements-textPrimary tracking-tight">Resources</h2>
          <p className="text-[10px] text-bolt-elements-textTertiary truncate">
            {usage.totalCount !== undefined ? (
              <>
                {usage.totalCount} asset{usage.totalCount === 1 ? '' : 's'} · {formatBytes(usage.totalBytes)} · your
                site&rsquo;s files
              </>
            ) : (
              'Your site’s media + build files'
            )}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {/* Environment selector */}
          <div
            className="flex items-center rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-0.5"
            role="group"
            aria-label="Environment"
          >
            {ENVIRONMENTS.map((env) => {
              const active = environment === env.value;
              return (
                <button
                  key={env.value}
                  type="button"
                  onClick={() => onEnvironment(env.value)}
                  aria-pressed={active}
                  data-testid={`resources-env-${env.value}`}
                  className={classNames(
                    'min-h-[24px] px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                    active
                      ? 'bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1'
                      : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                  )}
                >
                  {env.label}
                </button>
              );
            })}
          </div>

          {/* Advanced — the deeper per-kind CF-primitive console (kept reachable). */}
          <button
            type="button"
            onClick={onOpenConsole}
            title="Advanced — every Cloudflare resource this site uses"
            data-testid="resources-open-console"
            className="min-h-[24px] flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:stack text-sm" /> Advanced
          </button>

          {/* Refresh */}
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

      {/* Section tabs — Media library | Site files */}
      <div className="relative flex items-center gap-1 px-4 pt-2 pb-2" role="tablist" aria-label="Resource sections">
        {(
          [
            { value: 'media', label: 'Media library', icon: 'i-ph:images-square' },
            { value: 'files', label: 'Site files', icon: 'i-ph:folder-open' },
          ] as const
        ).map((tab) => {
          const active = section === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSection(tab.value)}
              data-testid={`resources-section-${tab.value}`}
              className={classNames(
                'min-h-[24px] flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                active
                  ? 'bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 shadow-sm'
                  : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
              )}
            >
              <div className={classNames(tab.icon, 'text-sm')} aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  ),
);

Header.displayName = 'ResourcesPanel.Header';

// ── Shared states ──────────────────────────────────────────────────────────

const Spinner = memo(({ label }: { label: string }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center"
    role="status"
    aria-live="polite"
  >
    <div className="i-ph:circle-notch text-2xl text-bolt-elements-item-contentAccent animate-spin motion-reduce:animate-none" />
    <p className="text-xs text-bolt-elements-textSecondary">{label}</p>
  </div>
));

Spinner.displayName = 'ResourcesPanel.Spinner';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="resources-error">
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

ErrorCard.displayName = 'ResourcesPanel.ErrorCard';

const DisabledCard = memo(({ what }: { what: string }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="resources-disabled">
    <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
    <p className="text-sm font-medium text-bolt-elements-textSecondary">{what} isn&rsquo;t enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
      This is on the way. Once it&rsquo;s turned on, it shows up here — nothing to set up.
    </p>
  </div>
));

DisabledCard.displayName = 'ResourcesPanel.DisabledCard';

// ── Media library ──────────────────────────────────────────────────────────

const MediaLibrary = memo(
  ({
    state,
    kind,
    search,
    uploading,
    deletingId,
    onKind,
    onSearch,
    onPickFile,
    onDelete,
    onRetry,
  }: {
    state: MediaState;
    kind: string;
    search: string;
    uploading: boolean;
    deletingId: string | null;
    onKind: (k: string) => void;
    onSearch: (s: string) => void;
    onPickFile: () => void;
    onDelete: (asset: MediaAssetEntry) => void;
    onRetry: () => void;
  }) => {
    if (state.status === 'disabled') {
      return <DisabledCard what="Media library" />;
    }

    return (
      <div className="h-full flex flex-col">
        {/* Toolbar — kind filter · search · upload */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-bolt-elements-borderColor/60 shrink-0 overflow-x-auto">
          <div className="flex items-center gap-1 rounded-lg bg-bolt-elements-background-depth-2 p-0.5 shrink-0">
            {KIND_FILTERS.map((f) => {
              const active = kind === f.value;
              return (
                <button
                  key={f.value || 'all'}
                  type="button"
                  onClick={() => onKind(f.value)}
                  aria-pressed={active}
                  data-testid={`resources-kind-${f.value || 'all'}`}
                  className={classNames(
                    'min-h-[24px] flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                    active
                      ? 'bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1'
                      : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                  )}
                >
                  <div className={classNames(f.icon, 'text-xs')} aria-hidden />
                  {f.label}
                </button>
              );
            })}
          </div>

          <div className="relative flex-1 min-w-[120px]">
            <div className="i-ph:magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-xs text-bolt-elements-textTertiary pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search files…"
              aria-label="Search media"
              data-testid="resources-search"
              className="w-full min-h-[24px] pl-7 pr-2 py-1 text-[12px] rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
            />
          </div>

          {/* Upload — label reserves its widest state so it never resizes. */}
          <button
            type="button"
            onClick={onPickFile}
            disabled={uploading}
            data-testid="resources-upload"
            title="Upload a file to your media library"
            className="min-h-[24px] shrink-0 text-[11px] font-semibold px-3 py-1 rounded-md bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 enabled:hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div
              className={classNames(
                uploading ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:upload-simple-bold',
                'text-sm shrink-0',
              )}
              aria-hidden
            />
            <span className="min-w-[9ch] text-center">{uploading ? 'Uploading…' : 'Upload'}</span>
          </button>
        </div>

        {/* Body */}
        {state.status === 'loading' && <MediaSkeleton />}
        {state.status === 'error' && <ErrorCard message={state.message} onRetry={onRetry} />}
        {state.status === 'ready' &&
          (state.assets.length === 0 ? (
            <MediaEmpty hasFilter={Boolean(kind) || Boolean(search.trim())} onUpload={onPickFile} />
          ) : (
            <div className="flex-1 overflow-auto modern-scrollbar p-4" data-testid="resources-media-grid">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {state.assets.map((asset) => (
                  <MediaCard
                    key={asset.id}
                    asset={asset}
                    deleting={deletingId === asset.id}
                    onDelete={() => onDelete(asset)}
                  />
                ))}
              </div>
            </div>
          ))}
      </div>
    );
  },
);

MediaLibrary.displayName = 'ResourcesPanel.MediaLibrary';

const MediaSkeleton = memo(() => (
  <div className="flex-1 overflow-hidden p-4" aria-busy="true" data-testid="resources-media-skeleton">
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 overflow-hidden"
        >
          <div className="aspect-[4/3] bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
          <div className="p-2 space-y-1.5">
            <div className="h-2.5 w-3/4 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
            <div className="h-2 w-1/3 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  </div>
));

MediaSkeleton.displayName = 'ResourcesPanel.MediaSkeleton';

const MediaEmpty = memo(({ hasFilter, onUpload }: { hasFilter: boolean; onUpload: () => void }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center" data-testid="resources-media-empty">
    <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.06]">
      <div className="i-ph:image-duotone text-3xl text-bolt-elements-item-contentAccent" aria-hidden />
    </div>
    <div className="space-y-1">
      <p className="text-sm font-semibold text-bolt-elements-textPrimary">
        {hasFilter ? 'No matching files' : 'No media yet'}
      </p>
      <p className="text-[11px] text-bolt-elements-textTertiary max-w-[280px]">
        {hasFilter
          ? 'Try a different filter or search — or upload a new file.'
          : 'Upload images, video, or documents for your site — they show up here to reuse anywhere.'}
      </p>
    </div>
    <button
      type="button"
      onClick={onUpload}
      data-testid="resources-media-empty-upload"
      className="min-h-[24px] text-[12px] font-semibold px-3.5 py-2 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 hover:opacity-90 transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
    >
      <div className="i-ph:upload-simple-bold" /> Upload a file
    </button>
  </div>
));

MediaEmpty.displayName = 'ResourcesPanel.MediaEmpty';

const MediaCard = memo(
  ({ asset, deleting, onDelete }: { asset: MediaAssetEntry; deleting: boolean; onDelete: () => void }) => {
    const image = isImageAsset(asset);
    const name = asset.name || asset.url.split('/').pop() || 'file';

    return (
      <div
        className="group relative overflow-hidden rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 flex flex-col transition-all duration-150 motion-reduce:transition-none hover:border-bolt-elements-item-contentAccent/50 hover:shadow-lg hover:shadow-bolt-elements-item-contentAccent/5"
        data-testid="resources-media-card"
      >
        {/* Thumbnail / glyph */}
        <div className="relative aspect-[4/3] bg-bolt-elements-background-depth-1 flex items-center justify-center overflow-hidden">
          {image ? (
            <img
              src={asset.url}
              alt={name}
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className={classNames(iconForAsset(asset), 'text-4xl text-bolt-elements-textTertiary')} aria-hidden />
          )}

          {/* Hover actions — open + delete. Keyboard-reachable (focus-within reveals). */}
          <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity motion-reduce:transition-none">
            <a
              href={asset.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${name} in a new tab`}
              title="Open in new tab"
              className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1/90 backdrop-blur text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
            >
              <div className="i-ph:arrow-square-out text-sm" />
            </a>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleting}
              aria-label={`Delete ${name}`}
              title="Delete"
              data-testid="resources-media-delete"
              className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded-md border border-red-400/40 bg-bolt-elements-background-depth-1/90 backdrop-blur text-red-400 enabled:hover:bg-red-400/15 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer"
            >
              <div className={classNames(deleting ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:trash', 'text-sm')} />
            </button>
          </div>
        </div>

        {/* Caption */}
        <div className="p-2 min-w-0">
          <p className="text-[11px] font-medium text-bolt-elements-textPrimary truncate" title={name}>
            {name}
          </p>
          <p className="text-[10px] text-bolt-elements-textTertiary tabular-nums">{formatBytes(asset.size)}</p>
        </div>
      </div>
    );
  },
);

MediaCard.displayName = 'ResourcesPanel.MediaCard';

// ── Build files ────────────────────────────────────────────────────────────

const BuildFiles = memo(({ state, onRetry }: { state: FilesState; onRetry: () => void }) => {
  if (state.status === 'idle' || state.status === 'loading') {
    return <Spinner label="Loading your build files…" />;
  }

  if (state.status === 'disabled') {
    return <DisabledCard what="Build files" />;
  }

  if (state.status === 'error') {
    return <ErrorCard message={state.message} onRetry={onRetry} />;
  }

  if (state.files.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="resources-files-empty">
        <div className="i-ph:folder-dashed text-3xl text-bolt-elements-textTertiary" />
        <p className="text-sm font-medium text-bolt-elements-textSecondary">No build files yet</p>
        <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
          When your site is published, the files that make up its build appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto modern-scrollbar" data-testid="resources-files-list">
      {state.prefix && (
        <div className="px-4 py-2 text-[10px] text-bolt-elements-textTertiary font-mono truncate border-b border-bolt-elements-borderColor/40">
          {state.prefix}
        </div>
      )}
      {state.files.map((file) => (
        <div
          key={file.key}
          className="group flex items-center gap-2.5 px-4 py-2 border-b border-bolt-elements-borderColor/30 hover:bg-bolt-elements-item-backgroundActive transition-colors motion-reduce:transition-none"
          data-testid="resources-file-row"
        >
          <div className="i-ph:file-duotone text-sm text-bolt-elements-textTertiary shrink-0" aria-hidden />
          <span className="text-[12px] font-mono text-bolt-elements-textPrimary truncate flex-1" title={file.name}>
            {file.name}
          </span>
          <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums shrink-0">
            {formatBytes(file.size)}
          </span>
          {file.url && (
            <a
              href={file.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${file.name} in a new tab`}
              title="Open in new tab"
              className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-all motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent shrink-0"
            >
              <div className="i-ph:arrow-square-out text-xs" />
            </a>
          )}
        </div>
      ))}
    </div>
  );
});

BuildFiles.displayName = 'ResourcesPanel.BuildFiles';
