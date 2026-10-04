/**
 * @file Resources — the editor "Resources" tab's per-site ASSET overview.
 *
 * @remarks
 * A gorgeous, concise (Cloudinary / Notion-gallery / Airtable feel) overview of EVERYTHING a site stores:
 *
 *   1. **Media library** — a gallery grid of the site's assets (images/video/docs) with a kind + source
 *      filter, a name search, UPLOAD (reads the file locally → base64 → `PS_RES_MEDIA_UPLOAD`, drag-and-drop
 *      too), and DELETE (`PS_RES_MEDIA { action:'delete', id }`). Assets come from `PS_RES_MEDIA { action:'list', … }`.
 *   2. **Site build files** — the files that make up the current published build (`PS_RES_SITE_FILES`),
 *      with byte sizes + type glyphs + open-in-new.
 *   3. **Storage-usage header** — total size + a cyan/purple per-kind data-viz bar + per-kind count chips,
 *      read from the media `list` response's `usage` rollup.
 *
 * The embedded editor has no cross-origin session, so it CANNOT fetch the worker directly — it talks to the
 * parent admin (which holds the bearer + `selectedSite`) over `postMessage`, via the typed senders in
 * `embedded-mode.ts` (`requestResMedia`, `requestMediaUpload`, `requestResSiteFiles`). Every CF id is
 * server-resolved for the authed site + environment; this panel never sees or sends one. Dark flags surface
 * as a friendly "not enabled yet" state (a 404 whose message includes "not enabled"), never a scary error.
 *
 * The deeper per-kind Cloudflare-primitive console ({@link ResourceOverviewPanel} → {@link ResourceDetailPanel})
 * stays IMPORTED + reachable from a link in this panel's header, so no proven surface is orphaned
 * (interconnectedness). Loading + empty + error + upload-in-progress states are all handled per surface.
 *
 * BRAND: black + cyan (#00E5FF, primary) + purple (#7C3AED, secondary), zero white/gray hard-codes — every
 * surface uses `--bolt-elements-*` tokens / UnoCSS `bolt-elements-*` classes. Every button carries visible
 * text OR an `aria-label` + `title`; disabled controls stay a clearly-visible muted brand surface
 * (`opacity-60 cursor-not-allowed`), never blank/white. Motion is `motion-reduce:*`-gated; every control
 * gets a cyan `focus-visible` ring. Style mirrors the sibling `./SiteTablesPanel` + `./ResourceOverviewPanel`.
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
import { BucketsPanel } from './BucketsPanel';
import { AutomationsPanel } from './AutomationsPanel';
import { PanelLoading, PanelShell } from './panel';

// ── Types ────────────────────────────────────────────────────────────────────

type ResourceEnvironment = 'preview' | 'production';

const ENVIRONMENTS: { value: ResourceEnvironment; label: string }[] = [
  { value: 'production', label: 'Production' },
  { value: 'preview', label: 'Preview' },
];

/**
 * localStorage key for the persisted Resources env selection (RES-ENV-STICKY). Persisting the choice
 * means it survives a section change, a tab remount, and a fresh editor boot — an owner who's working
 * in Preview never silently snaps back to Production on navigation (per `real-time-data-no-manual-refresh`
 * sibling: the surface remembers its own state, the user never re-sets it).
 */
export const RES_ENV_STORAGE_KEY = 'ps_resources_env';

/** The default env when nothing is persisted (production = the live site, the safest first view). */
const DEFAULT_RES_ENV: ResourceEnvironment = 'production';

/**
 * Read the persisted Resources environment, SSR/quota/private-mode safe (mirrors the AppShellService
 * guard pattern). Returns {@link DEFAULT_RES_ENV} when storage is unavailable OR the stored value isn't a
 * recognized environment — a corrupt/stale value never strands the panel on an invalid selection.
 *
 * @returns the persisted environment, or the default.
 * @example readPersistedResEnv() // 'production' (nothing stored)
 */
export function readPersistedResEnv(): ResourceEnvironment {
  try {
    const stored = localStorage.getItem(RES_ENV_STORAGE_KEY);

    if (stored === 'preview' || stored === 'production') {
      return stored;
    }
  } catch {
    /* SSR / private mode / quota — fall back to the default */
  }

  return DEFAULT_RES_ENV;
}

/**
 * Persist the Resources environment, SSR/quota/private-mode safe (mirrors the AppShellService guard).
 * A failed write is swallowed — the UI still works for the session, just doesn't remember next boot.
 *
 * @param env - the environment the user selected.
 */
export function persistResEnv(env: ResourceEnvironment): void {
  try {
    localStorage.setItem(RES_ENV_STORAGE_KEY, env);
  } catch {
    /* SSR / private mode / quota — ignore; selection still applies for this session */
  }
}

/** The asset sections this panel surfaces. */
type Section = 'media' | 'files' | 'buckets' | 'automations';

type MediaState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      assets: MediaAssetEntry[];
      usage?: MediaUsageSummary;
      cursor?: string;
      /** FILTERED total match count for the active filter (undefined → fall back to usage.totalCount). */
      filteredTotal?: number;
    };

type FilesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      files: SiteBuildFileEntry[];
      prefix?: string;
      /** True when the R2 listing was WINDOWED (more objects than `cap`) → the count is a partial "first N". */
      truncated?: boolean;
      /** The server per-page object cap (set only when `truncated`) — for the honest "first N of many" label. */
      cap?: number;
      /** Opaque R2 cursor to the NEXT page — present only while there's more to fetch (FILES-PAGING). */
      cursor?: string;
    };

/**
 * Append the next media page onto the current list, deduping by `id` (prev wins, order stable).
 * The "Load more" path APPENDS — it never replaces — so earlier pages stay on screen as the user
 * pages through the filtered total. Exported so the component and its test share one source of truth.
 */
export function mergeMediaAssets(prev: MediaAssetEntry[], next: MediaAssetEntry[]): MediaAssetEntry[] {
  if (next.length === 0) {
    return prev;
  }

  const seen = new Set(prev.map((a) => a.id));
  const merged = [...prev];

  for (const asset of next) {
    if (!seen.has(asset.id)) {
      seen.add(asset.id);
      merged.push(asset);
    }
  }

  return merged;
}

/**
 * Is there another media page to fetch? True only when the known filtered total exceeds the number
 * currently shown. Drives both the honest "N of total" affordance and the "Load more" control's
 * visibility — so the control HIDES the instant `shown === total` (or when the total is unknown).
 */
export function hasMoreMedia(shown: number, total: number | undefined): boolean {
  return typeof total === 'number' && total > shown;
}

/**
 * Append the next build-files page onto the current list, deduping by `key` (prev wins, order stable).
 * The "Load more" path APPENDS — never replaces — so earlier pages stay on screen as the user pages
 * past the windowed first 1000 (FILES-PAGING). Mirrors {@link mergeMediaAssets}; exported so the
 * component and its test share one source of truth.
 */
export function mergeBuildFiles(prev: SiteBuildFileEntry[], next: SiteBuildFileEntry[]): SiteBuildFileEntry[] {
  if (next.length === 0) {
    return prev;
  }

  const seen = new Set(prev.map((f) => f.key));
  const merged = [...prev];

  for (const file of next) {
    if (!seen.has(file.key)) {
      seen.add(file.key);
      merged.push(file);
    }
  }

  return merged;
}

/**
 * Is there another build-files page to fetch? True only when the listing was WINDOWED (`truncated`)
 * AND the server handed back a `cursor` to the next page. Drives the "Load more" control's visibility
 * — it HIDES the instant the last page arrives (no cursor), so it can never offer a doomed fetch.
 * Mirrors {@link hasMoreMedia} (cursor-paged instead of offset/total-paged, since R2 is cursor-based).
 */
export function hasMoreFiles(truncated: boolean | undefined, cursor: string | undefined): boolean {
  return truncated === true && typeof cursor === 'string' && cursor.length > 0;
}

/**
 * Pagination footer for the media grid — the honest "Showing N of total" count + the "Load more"
 * control, together below the grid. PURE + presentational so the render is unit-falsifiable WITHOUT
 * booting the WebContainer editor (closes MEDIA-UI-VERIFY-LIVE, fire-137 — the live browser pass
 * blocked on the cross-origin iframe twice). `total` = `filteredTotal ?? usage.totalCount` — the
 * FILTERED match count first (fire-135), org-wide rollup as fallback. The count HIDES when
 * `total <= shown` so it can never lie "50 of 50"; renders nothing when there's no count AND no next page.
 */
export function MediaPageStats({
  shown,
  filteredTotal,
  usage,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  shown: number;
  filteredTotal: number | undefined;
  usage: MediaUsageSummary | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const total = filteredTotal ?? usage?.totalCount;
  const showCount = total !== undefined && total > shown;

  if (!showCount && !hasMore) {
    return null;
  }

  return (
    <div className="flex items-center justify-center gap-3 pt-3">
      {showCount && (
        <span
          className="shrink-0 text-[10px] text-bolt-elements-textTertiary tabular-nums whitespace-nowrap"
          data-testid="resources-media-count"
          title={`Showing ${shown} of ${total} matching file${total === 1 ? '' : 's'}`}
        >
          <span className="text-bolt-elements-textSecondary font-medium">{shown}</span> of{' '}
          <span className="text-bolt-elements-textSecondary font-medium">{total}</span>
        </span>
      )}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          data-testid="resources-media-load-more"
          title={`Load more — showing ${shown} of ${total ?? '?'}`}
          className={classNames(BTN_SECONDARY, 'min-h-[26px] px-3 py-1 text-[11px]')}
        >
          <div
            className={classNames(
              loadingMore ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:arrow-down-bold',
              'text-sm shrink-0',
            )}
            aria-hidden
          />
          <span className="min-w-[9ch] text-center">{loadingMore ? 'Loading…' : 'Load more'}</span>
        </button>
      )}
    </div>
  );
}

/**
 * The honest build-files count label. When the R2 listing was WINDOWED (`truncated`), the shown count
 * is a PARTIAL "first N" — so we say "first N of many" (or "first N of cap+") instead of presenting it
 * as the complete total, mirroring {@link MediaPageStats}'s "N of total" honesty. When NOT truncated,
 * `shown` IS the complete file set, so a bare "N files" count is honest and locked. Exported pure so the
 * render is unit-falsifiable WITHOUT booting the WebContainer editor (closes FILES-COUNT-1, fire-140).
 */
export function buildFilesCountLabel(shown: number, truncated: boolean | undefined, cap?: number): string {
  const unit = shown === 1 ? 'file' : 'files';
  if (truncated) {
    // Partial window — never claim this is the total. "first N of many" is the honest framing;
    // when the cap is known, "first cap+ files" conveys there are at least `cap` + more.
    return cap && cap > 0 ? `first ${cap}+ ${unit}` : `first ${shown} of many`;
  }
  return `${shown} ${unit}`;
}

/**
 * Count/size summary for the build-files list — the HONEST file count (`buildFilesCountLabel`) + total
 * size, together in the sticky header. PURE + presentational so it's unit-testable without the
 * WebContainer. When `truncated`, the count reads "first N of many" (the R2 window was capped), never a
 * silently-under-counted total; otherwise it's the complete "N files". Mirrors {@link MediaPageStats}.
 */
export function FilesCountSummary({
  shown,
  totalBytes,
  truncated,
  cap,
}: {
  shown: number;
  totalBytes: number;
  truncated?: boolean;
  cap?: number;
}) {
  const countLabel = buildFilesCountLabel(shown, truncated, cap);
  return (
    <span
      className="text-[10px] text-bolt-elements-textSecondary tabular-nums shrink-0"
      data-testid="resources-files-count"
      title={
        truncated
          ? `Showing the first ${cap ?? shown} build files — this build has more. ${formatBytes(totalBytes)} shown.`
          : `${shown} build file${shown === 1 ? '' : 's'} · ${formatBytes(totalBytes)}`
      }
    >
      {countLabel} · {formatBytes(totalBytes)}
    </span>
  );
}

/**
 * Pagination footer for the build-files list — a "Load more" control that fetches the next R2 page
 * past the windowed first 1000 (FILES-PAGING). PURE + presentational so the render is unit-falsifiable
 * WITHOUT booting the WebContainer (mirrors {@link MediaPageStats}). It renders ONLY while there's a
 * next page (`hasMore`) — so once the last page arrives it vanishes, never offering a doomed fetch.
 * The button is sized for its LONGEST label ("Loading…") so it never resizes on state change.
 */
export function FilesPageStats({
  shown,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  shown: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) {
    return null;
  }

  return (
    <div className="flex items-center justify-center pt-3 pb-1">
      <button
        type="button"
        onClick={onLoadMore}
        disabled={loadingMore}
        data-testid="resources-files-load-more"
        title={`Load more build files — ${shown} shown so far`}
        className={classNames(BTN_SECONDARY, 'min-h-[26px] px-3 py-1 text-[11px]')}
      >
        <div
          className={classNames(
            loadingMore ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:arrow-down-bold',
            'text-sm shrink-0',
          )}
          aria-hidden
        />
        <span className="min-w-[9ch] text-center">{loadingMore ? 'Loading…' : 'Load more'}</span>
      </button>
    </div>
  );
}

/*
 * ── Branded control primitives (the button contract, one source of truth) ────────────────────────
 *
 * Every control in this panel composes one of these. Shared: min 24px target, cyan focus-visible ring,
 * motion-reduce-safe transitions, cursor-pointer, and a clearly-visible muted disabled state (never blank).
 */

/** Shared base every branded control extends. */
const CTRL_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 ' +
  'motion-reduce:transition-none cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-bolt-elements-background-depth-1 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed';

/** Cyan-fill primary — the one dominant action per surface (dark ink on cyan, hover glow). */
const BTN_PRIMARY = classNames(
  CTRL_BASE,
  'bg-bolt-elements-item-contentAccent text-[#061018] font-semibold',
  'shadow-sm shadow-bolt-elements-item-contentAccent/20',
  'enabled:hover:shadow-md enabled:hover:shadow-bolt-elements-item-contentAccent/40 enabled:hover:brightness-110',
  'enabled:active:brightness-95 focus-visible:ring-bolt-elements-item-contentAccent',
);

/** Dark surface + cyan border + cyan text — the calm secondary action. */
const BTN_SECONDARY = classNames(
  CTRL_BASE,
  'border border-bolt-elements-item-contentAccent/35 bg-bolt-elements-item-contentAccent/[0.06]',
  'text-bolt-elements-item-contentAccent',
  'enabled:hover:bg-bolt-elements-item-contentAccent/[0.14] enabled:hover:border-bolt-elements-item-contentAccent/60',
  'focus-visible:ring-bolt-elements-item-contentAccent',
);

/** Transparent → cyan-tinted on hover — quiet, for dense toolbars + tertiary actions. */
const BTN_GHOST = classNames(
  CTRL_BASE,
  'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary',
  'enabled:hover:text-bolt-elements-item-contentAccent enabled:hover:border-bolt-elements-item-contentAccent/40',
  'enabled:hover:bg-bolt-elements-background-depth-3 focus-visible:ring-bolt-elements-item-contentAccent',
);

/** Red-tinted destructive — visible-but-muted at rest, redder on hover. */
const BTN_DESTRUCTIVE = classNames(
  CTRL_BASE,
  'border border-red-400/40 bg-bolt-elements-background-depth-1/90 text-red-400 backdrop-blur',
  'enabled:hover:bg-red-500/20 enabled:hover:border-red-400/70 focus-visible:ring-red-400',
);

// ── Constants ────────────────────────────────────────────────────────────────

const DISABLED_404 = 'not enabled';

const KIND_FILTERS: { value: string; label: string; icon: string }[] = [
  { value: '', label: 'All', icon: 'i-ph:squares-four' },
  { value: 'image', label: 'Images', icon: 'i-ph:image' },
  { value: 'video', label: 'Video', icon: 'i-ph:video' },
  { value: 'document', label: 'Docs', icon: 'i-ph:file-text' },
];

/**
 * Brand accents — cyan is the theme token (`--bolt-elements-item-contentAccent` = #00e5ff); purple + teal
 * are the sanctioned secondary/tertiary accents, applied via inline `style` (no hard-coded `text-[#hex]`
 * UnoCSS classes per the brand contract). One source of truth for both the data-viz and the badges.
 */
const CYAN = 'var(--bolt-elements-item-contentAccent)';
const PURPLE = '#7C3AED';
const PURPLE_INK = '#a97bff';
const TEAL = '#22d3ee';

/**
 * Per-kind accent so the data-viz + badges read at a glance — cyan/purple-forward, on-brand.
 * `image` = cyan (primary), `video` = purple (secondary), `document` = a muted teal, `other` = ink-tint.
 * `color`/`bg` are inline-style values; `neutral` marks kinds that use theme tokens instead.
 */
const KIND_META: Record<string, { label: string; icon: string; color: string; ink: string; neutral?: boolean }> = {
  image: { label: 'Images', icon: 'i-ph:image-duotone', color: CYAN, ink: CYAN },
  video: { label: 'Video', icon: 'i-ph:film-slate-duotone', color: PURPLE, ink: PURPLE_INK },
  document: { label: 'Docs', icon: 'i-ph:file-text-duotone', color: TEAL, ink: TEAL },
  other: { label: 'Other', icon: 'i-ph:file-duotone', color: '', ink: '', neutral: true },
};

const KIND_ORDER = ['image', 'video', 'document', 'other'] as const;

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

/** Compact relative time ("3d", "2h", "just now") from an ISO string — fills the caption's dead space. */
function formatRelativeTime(iso: string | undefined): string | undefined {
  if (!iso) {
    return undefined;
  }

  const then = Date.parse(iso);

  if (Number.isNaN(then)) {
    return undefined;
  }

  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));

  if (secs < 45) {
    return 'just now';
  }

  const mins = Math.round(secs / 60);

  if (mins < 60) {
    return `${mins}m ago`;
  }

  const hours = Math.round(mins / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.round(hours / 24);

  if (days < 30) {
    return `${days}d ago`;
  }

  const months = Math.round(days / 30);

  if (months < 12) {
    return `${months}mo ago`;
  }

  return `${Math.round(months / 12)}y ago`;
}

/** The coarse kind for an asset (falls back to a MIME/extension sniff when the backend didn't classify). */
function kindOf(asset: MediaAssetEntry): 'image' | 'video' | 'document' | 'other' {
  const k = (asset.kind || '').toLowerCase();

  if (k === 'image' || k === 'video' || k === 'document') {
    return k;
  }

  const ct = (asset.contentType || '').toLowerCase();

  if (ct.startsWith('image/')) {
    return 'image';
  }

  if (ct.startsWith('video/')) {
    return 'video';
  }

  if (ct.includes('pdf') || /\.(pdf|docx?|txt|md|csv|json|xml)$/i.test(asset.name || '')) {
    return 'document';
  }

  if (/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(asset.name || asset.url || '')) {
    return 'image';
  }

  if (/\.(mp4|mov|webm|mkv|avi)$/i.test(asset.name || asset.url || '')) {
    return 'video';
  }

  return 'other';
}

/** True when an asset is an image we can thumbnail (by contentType or kind or extension). */
function isImageAsset(asset: MediaAssetEntry): boolean {
  return kindOf(asset) === 'image';
}

/** A phosphor glyph for a non-image asset kind. */
function iconForAsset(asset: MediaAssetEntry): string {
  const ct = (asset.contentType || '').toLowerCase();
  const kind = kindOf(asset);

  if (kind === 'video') {
    return 'i-ph:file-video-duotone';
  }

  if (ct.includes('pdf') || /\.pdf$/i.test(asset.name || '')) {
    return 'i-ph:file-pdf-duotone';
  }

  if (kind === 'document' || /\.(docx?|txt|md|csv|json|xml)$/i.test(asset.name || '')) {
    return 'i-ph:file-text-duotone';
  }

  if (ct.startsWith('audio/')) {
    return 'i-ph:file-audio-duotone';
  }

  return 'i-ph:file-duotone';
}

/** A friendly extension token (`PNG`, `MP4`, `PDF`) for the kind badge — uppercased, ≤4 chars. */
function extOf(asset: MediaAssetEntry): string | undefined {
  const src = asset.name || asset.url || '';
  const m = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(src);

  if (m) {
    return m[1].toUpperCase();
  }

  const ct = (asset.contentType || '').split('/')[1];

  return ct ? ct.replace('+xml', '').slice(0, 4).toUpperCase() : undefined;
}

/** A glyph for a build file by its extension/content type. */
function iconForBuildFile(file: SiteBuildFileEntry): string {
  const name = (file.name || '').toLowerCase();
  const ct = (file.contentType || '').toLowerCase();

  if (/\.(html?|htm)$/.test(name) || ct.includes('html')) {
    return 'i-ph:file-html-duotone';
  }

  if (/\.css$/.test(name) || ct.includes('css')) {
    return 'i-ph:file-css-duotone';
  }

  if (/\.(js|mjs|cjs|jsx)$/.test(name) || ct.includes('javascript')) {
    return 'i-ph:file-js-duotone';
  }

  if (/\.(ts|tsx)$/.test(name)) {
    return 'i-ph:file-ts-duotone';
  }

  if (/\.json$/.test(name) || ct.includes('json')) {
    return 'i-ph:brackets-curly-duotone';
  }

  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(name) || ct.startsWith('image/')) {
    return 'i-ph:image-duotone';
  }

  if (/\.(woff2?|ttf|otf|eot)$/.test(name) || ct.includes('font')) {
    return 'i-ph:text-aa-duotone';
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
  /*
   * Env selection is PERSISTED (RES-ENV-STICKY): the lazy initializer reads the last choice from
   * localStorage (SSR/quota-safe), and an effect writes it back on every change — so Preview↔Production
   * survives a section switch, a tab remount, and a fresh editor boot. No manual re-set, ever.
   */
  const [environment, setEnvironment] = useState<ResourceEnvironment>(readPersistedResEnv);
  const [section, setSection] = useState<Section>('media');

  useEffect(() => {
    persistResEnv(environment);
  }, [environment]);

  // Media library state.
  const [media, setMedia] = useState<MediaState>({ status: 'loading' });
  // Latest-ref so the "Load more" closure reads the current page without widening its deps
  // (per the datapanel empty-deps-needs-latest-ref incident — never a stale snapshot).
  const mediaRef = useRef<MediaState>(media);
  mediaRef.current = media;
  const [kind, setKind] = useState<string>('');
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // True while a "Load more" page is in flight (disables the control + shows "Loading…").
  const [loadingMore, setLoadingMore] = useState(false);

  // Build files state (lazy — loaded when the section is first opened).
  const [files, setFiles] = useState<FilesState>({ status: 'idle' });
  // Latest-ref so the files "Load more" closure reads the current page without widening its deps
  // (mirrors mediaRef — never a stale snapshot, per the datapanel empty-deps-needs-latest-ref incident).
  const filesRef = useRef<FilesState>(files);
  filesRef.current = files;
  // True while a files "Load more" page is in flight (separate from media's — the two sections page
  // independently, so one's spinner never disables the other's control).
  const [loadingMoreFiles, setLoadingMoreFiles] = useState(false);

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

      setMedia({
        status: 'ready',
        assets: reply.assets ?? [],
        usage: reply.usage,
        cursor: reply.cursor,
        filteredTotal: reply.filteredTotal,
      });
    } catch (err) {
      setMedia({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your media.' });
    }
  }, [environment, kind, search]);

  /**
   * Load the NEXT media page and APPEND it (dedupe by id via {@link mergeMediaAssets}) — never replace.
   * Requests `offset = assets.length` (the admin bridge clamps + forwards it to `/media/assets`), keeping
   * the active filter, so "N of total" converges toward the filtered total as the user pages through.
   */
  const loadMoreMedia = useCallback(async () => {
    if (loadingMore) {
      return;
    }

    // Guard: only page when loaded AND there's genuinely more to fetch (same predicate the control uses).
    const cur = mediaRef.current;

    if (cur.status !== 'ready') {
      return;
    }

    const total = cur.filteredTotal ?? cur.usage?.totalCount;

    if (!hasMoreMedia(cur.assets.length, total)) {
      return;
    }

    setLoadingMore(true);

    try {
      const reply = await requestResMedia({
        action: 'list',
        environment,
        kind: kind || undefined,
        search: search.trim() || undefined,
        offset: cur.assets.length,
      });

      if (!reply.ok) {
        postToastToParent('error', reply.error || 'Could not load more files.');

        return;
      }

      const page = reply.assets ?? [];

      setMedia((prev) =>
        prev.status === 'ready'
          ? {
              ...prev,
              assets: mergeMediaAssets(prev.assets, page),
              // Prefer the freshest server totals if the page carried them.
              usage: reply.usage ?? prev.usage,
              cursor: reply.cursor,
              filteredTotal: reply.filteredTotal ?? prev.filteredTotal,
            }
          : prev,
      );
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not load more files.');
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, environment, kind, search]);

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

      setFiles({
        status: 'ready',
        files: reply.files ?? [],
        prefix: reply.prefix,
        truncated: reply.truncated,
        cap: reply.cap,
        cursor: reply.cursor,
      });
    } catch (err) {
      setFiles({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your build files.' });
    }
  }, [environment]);

  /**
   * Load the NEXT build-files page and APPEND it (dedupe by key via {@link mergeBuildFiles}) — never
   * replace — so the user can page PAST the windowed first 1000 (FILES-PAGING). Sends the current
   * `cursor` back to the worker; the new reply's `truncated`+`cursor` converge the count toward "all
   * N files" and HIDE the "Load more" control the instant the last page (no cursor) arrives.
   */
  const loadMoreFiles = useCallback(async () => {
    if (loadingMoreFiles) {
      return;
    }

    // Guard: only page when loaded AND there's genuinely a next page (same predicate the control uses).
    const cur = filesRef.current;

    if (cur.status !== 'ready' || !hasMoreFiles(cur.truncated, cur.cursor)) {
      return;
    }

    setLoadingMoreFiles(true);

    try {
      const reply = await requestResSiteFiles({ environment, cursor: cur.cursor });

      if (!reply.ok) {
        postToastToParent('error', reply.error || 'Could not load more build files.');

        return;
      }

      const page = reply.files ?? [];

      setFiles((prev) =>
        prev.status === 'ready'
          ? {
              ...prev,
              files: mergeBuildFiles(prev.files, page),
              // The freshest windowing signal from the appended page drives the count + control:
              // when this page is the last (truncated:false / no cursor), "Load more" disappears and
              // the count converges from "first N of many" to the honest complete "N files".
              truncated: reply.truncated,
              cap: reply.cap,
              cursor: reply.cursor,
            }
          : prev,
      );
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not load more build files.');
    } finally {
      setLoadingMoreFiles(false);
    }
  }, [loadingMoreFiles, environment]);

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
      setUploadName(file.name);

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
        setUploadName(null);
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
    const countsByKind = media.assets.reduce<Record<string, number>>((acc, a) => {
      const k = kindOf(a);
      acc[k] = (acc[k] ?? 0) + 1;

      return acc;
    }, {});

    return { totalBytes, totalCount: media.assets.length, countsByKind };
  }, [media]);

  /*
   * Real-time contract: the panel SELF-updates — no manual Refresh button (the
   * fire-55 explorer probe caught the header button the fire-54 sweep missed).
   * Visibility-aware 30s poll on the section-appropriate reload; latest-ref so the
   * inline closure never goes stale (empty-deps effect + ref pattern).
   */
  const onRefreshRef = useRef<() => void>(() => {});
  onRefreshRef.current = () => (section === 'media' ? void loadMedia() : void loadFiles());
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) {
        onRefreshRef.current();
      }
    };
    const id = setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  // The deeper CF-primitive console — kept reachable so no proven surface is orphaned.
  if (showConsole) {
    return (
      <PanelShell testId="resources-panel">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0">
          <button
            type="button"
            onClick={() => setShowConsole(false)}
            className={classNames(BTN_GHOST, 'min-h-[26px] px-2.5 py-1 text-[11px]')}
          >
            <div className="i-ph:arrow-left text-sm" /> Back to assets
          </button>
          <span className="text-[11px] text-bolt-elements-textTertiary">Advanced · Cloudflare resources</span>
        </div>
        <div className="flex-1 min-h-0">
          <ResourceOverviewPanel />
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell testId="resources-panel">
      <Header
        environment={environment}
        onEnvironment={setEnvironment}
        section={section}
        onSection={setSection}
        usage={usage}
        onOpenConsole={() => setShowConsole(true)}
      />

      <div className="relative flex-1 overflow-hidden">
        {section === 'media' ? (
          <MediaLibrary
            state={media}
            kind={kind}
            search={search}
            uploading={uploading}
            uploadName={uploadName}
            deletingId={deletingId}
            loadingMore={loadingMore}
            onKind={setKind}
            onSearch={setSearch}
            onPickFile={onPickFile}
            onUploadFile={onUploadFile}
            onDelete={onDeleteAsset}
            onLoadMore={() => void loadMoreMedia()}
            onRetry={() => void loadMedia()}
          />
        ) : section === 'files' ? (
          <BuildFiles
            state={files}
            onRetry={() => void loadFiles()}
            loadingMore={loadingMoreFiles}
            onLoadMore={() => void loadMoreFiles()}
          />
        ) : section === 'buckets' ? (
          // Buckets — the per-site R2 manager. Self-managing (its own load/refresh + object browser).
          <BucketsPanel />
        ) : (
          // Automations — the per-site workflow/automation log. Self-managing (own load/refresh).
          <AutomationsPanel />
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
    </PanelShell>
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
    onOpenConsole,
  }: {
    environment: ResourceEnvironment;
    onEnvironment: (env: ResourceEnvironment) => void;
    section: Section;
    onSection: (s: Section) => void;
    usage: MediaUsageSummary;
    onOpenConsole: () => void;
  }) => (
    <div className="relative border-b border-bolt-elements-borderColor shrink-0 overflow-hidden">
      {/* Cinematic brand wash — cyan → purple, sets the black+cyan tone from the first pixel. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 140% at 0% 0%, color-mix(in oklch, #00e5ff 12%, transparent), transparent 42%), ' +
            'radial-gradient(90% 120% at 100% 0%, color-mix(in oklch, #7c3aed 10%, transparent), transparent 46%)',
        }}
      />
      {/* Top chrome (icon · title · storage · env · Advanced) is media/files-specific — the
          Buckets AND Automations tabs render their OWN full header, so hide this row there to avoid
          a double header. The tab strip below stays on every tab. Data stays current via the
          panel's visibility-aware poll — no manual Refresh control (real-time rule). */}
      {section !== 'buckets' && section !== 'automations' && (
        <div className="relative flex items-center gap-3 px-4 pt-3">
          <div className="flex items-center justify-center h-9 w-9 rounded-xl border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/[0.08] shadow-inner shadow-bolt-elements-item-contentAccent/10 shrink-0">
            <div className="i-ph:images-square-duotone text-xl text-bolt-elements-item-contentAccent" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-bolt-elements-textPrimary tracking-tight">Resources</h2>
            <StorageSummaryLine usage={usage} />
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
                        ? 'bg-bolt-elements-item-contentAccent text-[#061018] shadow-sm shadow-bolt-elements-item-contentAccent/25'
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
              className={classNames(BTN_GHOST, 'min-h-[26px] px-2.5 py-1 text-[11px]')}
            >
              <div className="i-ph:stack text-sm" /> Advanced
            </button>
          </div>
        </div>
      )}

      {/* Section tabs — Media library | Site files | Buckets */}
      <div
        className={classNames(
          'relative flex items-center gap-1 px-4 pb-2',
          section === 'buckets' || section === 'automations' ? 'pt-3' : 'pt-2.5',
        )}
        role="tablist"
        aria-label="Resource sections"
      >
        {(
          [
            { value: 'media', label: 'Media library', icon: 'i-ph:images-square' },
            { value: 'files', label: 'Site files', icon: 'i-ph:folder-open' },
            { value: 'buckets', label: 'Buckets', icon: 'i-ph:hard-drives' },
            { value: 'automations', label: 'Automations', icon: 'i-ph:lightning' },
          ] as const
        ).map((tab) => {
          const active = section === tab.value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              data-filled-pill=""
              aria-selected={active}
              onClick={() => onSection(tab.value)}
              data-testid={`resources-section-${tab.value}`}
              className={classNames(
                'group relative min-h-[26px] flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                active
                  ? 'bg-bolt-elements-item-contentAccent text-[#061018] shadow-sm shadow-bolt-elements-item-contentAccent/25'
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

// ── Storage-usage summary — count · size · a cyan/purple per-kind data-viz bar + chips ────────────

const StorageSummaryLine = memo(({ usage }: { usage: MediaUsageSummary }) => {
  const counts = usage.countsByKind ?? {};
  const segments = KIND_ORDER.map((k) => ({ k, n: counts[k] ?? 0 })).filter((s) => s.n > 0);
  const total = usage.totalCount ?? segments.reduce((sum, s) => sum + s.n, 0);

  if (usage.totalCount === undefined && segments.length === 0) {
    return <p className="text-[10px] text-bolt-elements-textTertiary truncate">Your site’s media + build files</p>;
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <p className="text-[10px] text-bolt-elements-textTertiary truncate tabular-nums">
        <span className="text-bolt-elements-textSecondary font-medium">{total}</span> asset{total === 1 ? '' : 's'}
        {usage.totalBytes !== undefined && (
          <>
            {' · '}
            <span className="text-bolt-elements-textSecondary font-medium">{formatBytes(usage.totalBytes)}</span>
          </>
        )}
      </p>

      {segments.length > 0 && (
        <>
          {/* Stacked per-kind bar — cyan/purple/teal proportions of the library at a glance. */}
          <div
            className="hidden sm:flex h-1.5 w-24 rounded-full overflow-hidden bg-bolt-elements-background-depth-3 shrink-0"
            role="img"
            aria-label={segments.map((s) => `${s.n} ${KIND_META[s.k].label}`).join(', ')}
            title={segments.map((s) => `${s.n} ${KIND_META[s.k].label}`).join(' · ')}
          >
            {segments.map((s) => {
              const m = KIND_META[s.k];
              return (
                <div
                  key={s.k}
                  className={classNames('h-full', m.neutral && 'bg-bolt-elements-textTertiary')}
                  style={{ width: `${(s.n / total) * 100}%`, ...(m.neutral ? {} : { backgroundColor: m.color }) }}
                />
              );
            })}
          </div>

          {/* Per-kind count chips. */}
          <div className="hidden md:flex items-center gap-1 shrink-0">
            {segments.map((s) => {
              const m = KIND_META[s.k];
              return (
                <span
                  key={s.k}
                  className={classNames(
                    'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[9px] font-medium tabular-nums',
                    m.neutral && 'border-bolt-elements-borderColor text-bolt-elements-textSecondary',
                  )}
                  style={
                    m.neutral ? {} : { borderColor: `color-mix(in oklch, ${m.color} 40%, transparent)`, color: m.ink }
                  }
                >
                  <span
                    className={classNames('h-1.5 w-1.5 rounded-full', m.neutral && 'bg-bolt-elements-textTertiary')}
                    style={m.neutral ? {} : { backgroundColor: m.color }}
                    aria-hidden
                  />
                  {s.n}
                </span>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
});

StorageSummaryLine.displayName = 'ResourcesPanel.StorageSummaryLine';

// ── Shared states ──────────────────────────────────────────────────────────

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="resources-error">
    <div className="flex items-center justify-center h-12 w-12 rounded-2xl border border-red-400/30 bg-red-500/[0.07]">
      <div className="i-ph:warning-circle-duotone text-2xl text-red-400" aria-hidden />
    </div>
    <p className="text-xs text-bolt-elements-textSecondary max-w-[280px] leading-relaxed">{message}</p>
    <button
      type="button"
      onClick={onRetry}
      className={classNames(BTN_SECONDARY, 'min-h-[28px] mt-1 px-3 py-1.5 text-[11px]')}
    >
      <div className="i-ph:arrow-clockwise text-sm" /> Try again
    </button>
  </div>
));

ErrorCard.displayName = 'ResourcesPanel.ErrorCard';

const DisabledCard = memo(({ what }: { what: string }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="resources-disabled"
  >
    <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
      <div className="i-ph:lock-key-duotone text-3xl text-bolt-elements-textTertiary" aria-hidden />
    </div>
    <p className="text-sm font-semibold text-bolt-elements-textSecondary">{what} isn&rsquo;t enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px] leading-relaxed">
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
    uploadName,
    deletingId,
    loadingMore,
    onKind,
    onSearch,
    onPickFile,
    onUploadFile,
    onDelete,
    onLoadMore,
    onRetry,
  }: {
    state: MediaState;
    kind: string;
    search: string;
    uploading: boolean;
    uploadName: string | null;
    deletingId: string | null;
    loadingMore: boolean;
    onKind: (k: string) => void;
    onSearch: (s: string) => void;
    onPickFile: () => void;
    onUploadFile: (file: File) => void;
    onDelete: (asset: MediaAssetEntry) => void;
    onLoadMore: () => void;
    onRetry: () => void;
  }) => {
    const [dragging, setDragging] = useState(false);
    const dragDepth = useRef(0);

    // Drag-and-drop upload affordance — depth-counted so nested enter/leave doesn't flicker.
    const onDragEnter = useCallback((e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) {
        return;
      }

      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    }, []);

    const onDragOver = useCallback((e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    }, []);

    const onDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      dragDepth.current = Math.max(0, dragDepth.current - 1);

      if (dragDepth.current === 0) {
        setDragging(false);
      }
    }, []);

    const onDrop = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);

        const file = e.dataTransfer.files?.[0];

        if (file) {
          onUploadFile(file);
        }
      },
      [onUploadFile],
    );

    if (state.status === 'disabled') {
      return <DisabledCard what="Media library" />;
    }

    return (
      <div
        className="relative h-full flex flex-col"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Toolbar — kind filter · search · upload */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-bolt-elements-borderColor/60 shrink-0 overflow-x-auto">
          <div className="flex items-center gap-0.5 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-0.5 shrink-0">
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
                      ? 'bg-bolt-elements-item-contentAccent text-[#061018] shadow-sm shadow-bolt-elements-item-contentAccent/20'
                      : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
                  )}
                >
                  <div className={classNames(f.icon, 'text-xs')} aria-hidden />
                  {f.label}
                </button>
              );
            })}
          </div>

          <div className="relative flex-1 min-w-[120px] group">
            <div className="i-ph:magnifying-glass absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-bolt-elements-textTertiary group-focus-within:text-bolt-elements-item-contentAccent transition-colors pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search files…"
              aria-label="Search media"
              data-testid="resources-search"
              className="w-full min-h-[26px] pl-8 pr-2.5 py-1 text-[12px] rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/50"
            />
          </div>

          {/* Upload — label span reserves its widest state (`Uploading…`) so it never resizes. */}
          <button
            type="button"
            onClick={onPickFile}
            disabled={uploading}
            data-testid="resources-upload"
            title="Upload a file to your media library"
            className={classNames(BTN_PRIMARY, 'min-h-[26px] shrink-0 px-3 py-1 text-[11px]')}
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
            <MediaEmpty
              hasFilter={Boolean(kind) || Boolean(search.trim())}
              uploading={uploading}
              onUpload={onPickFile}
            />
          ) : (
            <div className="flex-1 overflow-auto modern-scrollbar p-3" data-testid="resources-media-grid">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                {/* Live upload placeholder card — reads as "in progress", not a broken tile. */}
                {uploading && <UploadingCard name={uploadName} />}
                {state.assets.map((asset) => (
                  <MediaCard
                    key={asset.id}
                    asset={asset}
                    deleting={deletingId === asset.id}
                    onDelete={() => onDelete(asset)}
                  />
                ))}
              </div>

              {/* Pagination footer — the honest "N of total" count + "Load more", together below the
                  grid. Extracted to <MediaPageStats> so the render is unit-testable without the
                  WebContainer (resources-media-count.render.spec). */}
              <MediaPageStats
                shown={state.assets.length}
                filteredTotal={state.filteredTotal}
                usage={state.usage}
                hasMore={hasMoreMedia(state.assets.length, state.filteredTotal ?? state.usage?.totalCount)}
                loadingMore={loadingMore}
                onLoadMore={onLoadMore}
              />
            </div>
          ))}

        {/* Drag-and-drop overlay — cyan dashed drop target over the whole library. */}
        {dragging && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg m-2 border-2 border-dashed border-bolt-elements-item-contentAccent bg-bolt-elements-background-depth-1/85 backdrop-blur-sm pointer-events-none"
            data-testid="resources-drop-overlay"
          >
            <div
              className="i-ph:upload-simple-duotone text-4xl text-bolt-elements-item-contentAccent motion-safe:animate-bounce motion-reduce:animate-none"
              aria-hidden
            />
            <p className="text-sm font-semibold text-bolt-elements-textPrimary">Drop to upload</p>
            <p className="text-[11px] text-bolt-elements-textTertiary">
              Release the file to add it to your media library
            </p>
          </div>
        )}
      </div>
    );
  },
);

MediaLibrary.displayName = 'ResourcesPanel.MediaLibrary';

const MediaSkeleton = memo(() => (
  <div className="flex-1 overflow-hidden p-3" aria-busy="true" data-testid="resources-media-skeleton">
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 overflow-hidden"
        >
          <div className="aspect-[4/3] bg-gradient-to-br from-bolt-elements-background-depth-3 to-bolt-elements-background-depth-2 motion-safe:animate-pulse" />
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

const MediaEmpty = memo(
  ({ hasFilter, uploading, onUpload }: { hasFilter: boolean; uploading: boolean; onUpload: () => void }) => (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="resources-media-empty"
    >
      <div className="relative flex items-center justify-center h-16 w-16 rounded-2xl border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.06]">
        <div
          aria-hidden
          className="absolute inset-0 rounded-2xl opacity-60"
          style={{
            background:
              'radial-gradient(60% 60% at 50% 30%, color-mix(in oklch, #7c3aed 22%, transparent), transparent)',
          }}
        />
        <div className="relative i-ph:image-duotone text-3xl text-bolt-elements-item-contentAccent" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-bolt-elements-textPrimary">
          {hasFilter ? 'No matching files' : 'No media yet'}
        </p>
        <p className="text-[11px] text-bolt-elements-textTertiary max-w-[290px] leading-relaxed">
          {hasFilter
            ? 'Try a different filter or search — or drag a file here to upload.'
            : 'Drag a file here, or upload images, video, or documents — they show up here to reuse anywhere on your site.'}
        </p>
      </div>
      <button
        type="button"
        onClick={onUpload}
        disabled={uploading}
        data-testid="resources-media-empty-upload"
        className={classNames(BTN_PRIMARY, 'min-h-[30px] px-4 py-2 text-[12px]')}
      >
        <div
          className={classNames(
            uploading ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:upload-simple-bold',
            'text-sm',
          )}
          aria-hidden
        />
        <span className="min-w-[10ch] text-center">{uploading ? 'Uploading…' : 'Upload a file'}</span>
      </button>
    </div>
  ),
);

MediaEmpty.displayName = 'ResourcesPanel.MediaEmpty';

/** An in-flight upload tile — cyan pulse + name, so the grid reflects progress immediately. */
const UploadingCard = memo(({ name }: { name: string | null }) => (
  <div
    className="relative overflow-hidden rounded-xl border border-bolt-elements-item-contentAccent/40 bg-bolt-elements-item-contentAccent/[0.05] flex flex-col"
    data-testid="resources-uploading-card"
    aria-busy="true"
  >
    <div className="relative aspect-[4/3] flex items-center justify-center overflow-hidden bg-bolt-elements-background-depth-1">
      <div
        className="i-ph:circle-notch text-3xl text-bolt-elements-item-contentAccent animate-spin motion-reduce:animate-none"
        aria-hidden
      />
      {/* Indeterminate cyan progress sweep (uses the built-in pulse keyframe — no bespoke CSS). */}
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-bolt-elements-background-depth-3 overflow-hidden">
        <div className="h-full w-2/3 bg-bolt-elements-item-contentAccent motion-safe:animate-pulse" />
      </div>
    </div>
    <div className="p-2 min-w-0">
      <p className="text-[11px] font-medium text-bolt-elements-item-contentAccent truncate" title={name ?? undefined}>
        {name ?? 'Uploading…'}
      </p>
      <p className="text-[10px] text-bolt-elements-textTertiary">Uploading…</p>
    </div>
  </div>
));

UploadingCard.displayName = 'ResourcesPanel.UploadingCard';

const MediaCard = memo(
  ({ asset, deleting, onDelete }: { asset: MediaAssetEntry; deleting: boolean; onDelete: () => void }) => {
    const image = isImageAsset(asset);
    const name = asset.name || asset.url.split('/').pop() || 'file';
    const kind = kindOf(asset);
    const meta = KIND_META[kind];
    const ext = extOf(asset);
    const when = formatRelativeTime(asset.uploaded);
    const isGenerated = (asset.source || '').toLowerCase() === 'generated';

    return (
      <div
        className="group relative overflow-hidden rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 flex flex-col transition-all duration-200 motion-reduce:transition-none hover:border-bolt-elements-item-contentAccent/50 hover:shadow-lg hover:shadow-bolt-elements-item-contentAccent/10 motion-safe:hover:-translate-y-0.5"
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
              className="h-full w-full object-cover transition-transform duration-300 motion-reduce:transition-none motion-safe:group-hover:scale-[1.04]"
            />
          ) : (
            <>
              {/* Kind-tinted radial backdrop so non-image tiles aren't flat black. */}
              <div
                aria-hidden
                className={classNames('absolute inset-0 opacity-30', meta.neutral && 'text-bolt-elements-textTertiary')}
                style={{
                  background: 'radial-gradient(70% 70% at 50% 40%, currentColor, transparent)',
                  ...(meta.neutral ? {} : { color: meta.color }),
                }}
              />
              <div
                className={classNames(
                  iconForAsset(asset),
                  'relative text-4xl',
                  meta.neutral && 'text-bolt-elements-textSecondary',
                )}
                style={meta.neutral ? {} : { color: meta.ink }}
                aria-hidden
              />
            </>
          )}

          {/* Kind badge — top-left, always visible; identifies the file type at a glance. */}
          <span
            className={classNames(
              'absolute top-1.5 left-1.5 inline-flex items-center gap-0.5 rounded-md border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide backdrop-blur-sm bg-bolt-elements-background-depth-1/80',
              meta.neutral && 'border-bolt-elements-borderColor text-bolt-elements-textSecondary',
            )}
            style={
              meta.neutral
                ? {}
                : { borderColor: `color-mix(in oklch, ${meta.color} 45%, transparent)`, color: meta.ink }
            }
            title={`${meta.label}${ext ? ` · ${ext}` : ''}`}
          >
            <div className={classNames(meta.icon, 'text-[11px]')} aria-hidden />
            {ext || meta.label}
          </span>

          {/* Source badge — bottom-left, only when generated (distinguishes AI-made assets). */}
          {isGenerated && (
            <span
              className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-0.5 rounded-md border bg-bolt-elements-background-depth-1/80 backdrop-blur-sm px-1.5 py-px text-[9px] font-medium"
              style={{ borderColor: `color-mix(in oklch, ${PURPLE} 45%, transparent)`, color: PURPLE_INK }}
              title="Generated by AI"
            >
              <div className="i-ph:sparkle-duotone text-[11px]" aria-hidden /> AI
            </span>
          )}

          {/* Hover actions — open + delete. Keyboard-reachable (focus-within reveals). */}
          <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity motion-reduce:transition-none">
            <a
              href={asset.url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open ${name} in a new tab`}
              title="Open in new tab"
              className={classNames(
                BTN_GHOST,
                'min-h-[24px] min-w-[24px] p-1 bg-bolt-elements-background-depth-1/90 backdrop-blur text-bolt-elements-textSecondary',
              )}
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
              className={classNames(BTN_DESTRUCTIVE, 'min-h-[24px] min-w-[24px] p-1')}
            >
              <div
                className={classNames(
                  deleting ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:trash',
                  'text-sm',
                )}
              />
            </button>
          </div>
        </div>

        {/* Caption — name + size · relative time. */}
        <div className="p-2 min-w-0">
          <p className="text-[11px] font-medium text-bolt-elements-textPrimary truncate" title={name}>
            {name}
          </p>
          <p className="text-[10px] text-bolt-elements-textTertiary tabular-nums flex items-center gap-1">
            <span>{formatBytes(asset.size)}</span>
            {when && (
              <>
                <span className="text-bolt-elements-textTertiary/50" aria-hidden>
                  ·
                </span>
                <span>{when}</span>
              </>
            )}
          </p>
        </div>
      </div>
    );
  },
);

MediaCard.displayName = 'ResourcesPanel.MediaCard';

// ── Build files ────────────────────────────────────────────────────────────

/**
 * Copy a build file's path to the clipboard. Always-available row action (no backend), so every file row
 * has a working control even when the backend minted no open-URL. Icon swaps to a cyan check for ~1.4s on
 * success — the button is icon-only + fixed-size so it never resizes between states
 * (buttons-accommodate-largest-text).
 */
const CopyFilePathButton = memo(({ path }: { path: string }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      postToastToParent('error', 'Could not copy the file path.');
    }
  }, [path]);

  return (
    <button
      type="button"
      onClick={() => void onCopy()}
      aria-label={copied ? `Copied ${path}` : `Copy path ${path}`}
      title={copied ? 'Copied!' : 'Copy file path'}
      data-testid="resources-file-copy"
      className={classNames(BTN_GHOST, 'min-h-[24px] min-w-[24px] p-1')}
    >
      <div
        className={classNames(
          copied ? 'i-ph:check-bold text-bolt-elements-item-contentAccent' : 'i-ph:copy',
          'text-xs',
        )}
        aria-hidden
      />
    </button>
  );
});

CopyFilePathButton.displayName = 'ResourcesPanel.CopyFilePathButton';

export const BuildFiles = memo(
  ({
    state,
    onRetry,
    loadingMore,
    onLoadMore,
  }: {
    state: FilesState;
    onRetry: () => void;
    loadingMore: boolean;
    onLoadMore: () => void;
  }) => {
    if (state.status === 'idle' || state.status === 'loading') {
      return <PanelLoading label="Loading your build files…" />;
    }

    if (state.status === 'disabled') {
      return <DisabledCard what="Build files" />;
    }

    if (state.status === 'error') {
      return <ErrorCard message={state.message} onRetry={onRetry} />;
    }

    if (state.files.length === 0) {
      return (
        <div
          className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
          data-testid="resources-files-empty"
        >
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
            <div className="i-ph:folder-dashed-duotone text-3xl text-bolt-elements-textTertiary" aria-hidden />
          </div>
          <p className="text-sm font-semibold text-bolt-elements-textSecondary">No build files yet</p>
          <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px] leading-relaxed">
            When your site is published, the files that make up its build appear here.
          </p>
        </div>
      );
    }

    const totalBytes = state.files.reduce((sum, f) => sum + (f.size ?? 0), 0);

    return (
      <div className="flex-1 overflow-auto modern-scrollbar" data-testid="resources-files-list">
        {/* Prefix + count/size summary bar. */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-bolt-elements-borderColor/40 sticky top-0 z-[1] bg-bolt-elements-background-depth-1/90 backdrop-blur">
          <div
            className="i-ph:folder-open-duotone text-sm text-bolt-elements-item-contentAccent shrink-0"
            aria-hidden
          />
          {state.prefix ? (
            <span
              className="text-[10px] text-bolt-elements-textTertiary font-mono truncate flex-1"
              title={state.prefix}
            >
              {state.prefix}
            </span>
          ) : (
            <span className="text-[10px] text-bolt-elements-textTertiary flex-1">Published build files</span>
          )}
          <FilesCountSummary
            shown={state.files.length}
            totalBytes={totalBytes}
            truncated={state.truncated}
            cap={state.cap}
          />
        </div>

        {state.files.map((file) => (
          <div
            key={file.key}
            className="group flex items-center gap-2.5 px-4 py-2 border-b border-bolt-elements-borderColor/25 hover:bg-bolt-elements-item-backgroundActive transition-colors motion-reduce:transition-none"
            data-testid="resources-file-row"
          >
            <div
              className={classNames(
                iconForBuildFile(file),
                'text-base text-bolt-elements-textTertiary group-hover:text-bolt-elements-item-contentAccent transition-colors shrink-0',
              )}
              aria-hidden
            />
            <span className="text-[12px] font-mono text-bolt-elements-textPrimary truncate flex-1" title={file.name}>
              {file.name}
            </span>
            <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums shrink-0">
              {formatBytes(file.size)}
            </span>
            {/* Row actions — reveal on hover/focus. Copy-path is ALWAYS available (no backend needed), so
              every row has a working control even when the backend didn't mint a URL (never a dead row). */}
            <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity motion-reduce:transition-none">
              <CopyFilePathButton path={file.name} />
              {file.url && (
                <a
                  href={file.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`Open ${file.name} in a new tab`}
                  title="Open in new tab"
                  className={classNames(BTN_GHOST, 'min-h-[24px] min-w-[24px] p-1')}
                >
                  <div className="i-ph:arrow-square-out text-xs" aria-hidden />
                </a>
              )}
            </div>
          </div>
        ))}

        {/* Page past the windowed first 1000 (FILES-PAGING) — appends the next R2 page, hides at the end. */}
        <FilesPageStats
          shown={state.files.length}
          hasMore={hasMoreFiles(state.truncated, state.cursor)}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
        />
      </div>
    );
  },
);

BuildFiles.displayName = 'ResourcesPanel.BuildFiles';
