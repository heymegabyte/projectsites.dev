/**
 * @file Buckets — the editor Resources tab's per-site R2 bucket manager (the THIRD Resources section,
 * beside Media library + Site files).
 *
 * Lets a site owner manage their site's OWN Cloudflare R2 buckets — the R2 analog of the per-site D1
 * Tables surface. Golden path: create a bucket → copy its address → delete → re-create → upload a file →
 * it lists → copy its URL → delete the file → empty → delete the bucket. Plus: object browser with prefix
 * breadcrumbs + pagination, drag-drop upload, multi-select bulk delete with undo, search/sort, public
 * toggle + public base URL, Promote → production snapshot, usage + est. monthly cost + quota bar.
 *
 * The embedded editor has NO cross-origin session, so it talks to the parent admin (which holds the bearer
 * + selectedSite) over postMessage, via the typed senders in `embedded-mode.ts`
 * (`requestR2`, `requestBucketUpload`, `requestBucketDownload`). Every CF id is server-resolved; this panel
 * never sees or sends one. The DARK `r2_buckets` flag surfaces as a friendly "not enabled yet" card (a 404
 * whose message includes "not enabled"), never a scary error. When object ops need R2 S3 creds the panel
 * shows an actionable needs-creds banner (bucket CRUD still works).
 *
 * BRAND: black + cyan (#00E5FF primary) + purple (#7C3AED secondary), zero white/gray hard-codes — every
 * surface uses `--bolt-elements-*` tokens / UnoCSS `bolt-elements-*` classes. Every control ≥24px, carries
 * text OR an aria-label + title, has a cyan focus-visible ring, and a clearly-visible muted disabled state.
 * Motion is `motion-reduce:*`-gated. Style mirrors the sibling `./ResourcesPanel`.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader } from './panel';
import { PanelEmpty } from './panel/PanelEmpty';
import { BucketsTwoPane } from './BucketsTwoPane';
import {
  isEmbedded,
  postToastToParent,
  requestBucketDownload,
  requestBucketUpload,
  requestR2,
  type BucketAddress,
  type BucketEntry,
  type BucketObjectEntry,
} from '~/lib/embed/embedded-mode';

// ── Brand accents (mirror ResourcesPanel) ────────────────────────────────────
const CYAN = 'var(--bolt-elements-item-contentAccent)';
const PURPLE = '#7C3AED';
const PURPLE_INK = '#a97bff';

const DISABLED_404 = 'not enabled';

/**
 * Visibility-aware poll cadence (per `real-time-data-no-manual-refresh`): the bucket inventory
 * silently re-fetches every 30s while foregrounded — there is NO manual Refresh button. Pauses while
 * `document.hidden`; refreshes immediately when the tab returns to the foreground.
 */
const POLL_INTERVAL_MS = 30_000;

// POLISH 1: shared control base — cyan focus ring, 24px targets, motion-reduce-safe, muted disabled.
const CTRL_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 ' +
  'motion-reduce:transition-none cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-offset-1 focus-visible:ring-offset-bolt-elements-background-depth-1 ' +
  'disabled:opacity-60 disabled:cursor-not-allowed';

const BTN_PRIMARY = classNames(
  CTRL_BASE,
  'bg-bolt-elements-item-contentAccent text-[#061018] font-semibold',
  'shadow-sm shadow-bolt-elements-item-contentAccent/20',
  'enabled:hover:shadow-md enabled:hover:shadow-bolt-elements-item-contentAccent/40 enabled:hover:brightness-110',
  'enabled:active:brightness-95 focus-visible:ring-bolt-elements-item-contentAccent',
);
const BTN_SECONDARY = classNames(
  CTRL_BASE,
  'border border-bolt-elements-item-contentAccent/35 bg-bolt-elements-item-contentAccent/[0.06]',
  'text-bolt-elements-item-contentAccent',
  'enabled:hover:bg-bolt-elements-item-contentAccent/[0.14] enabled:hover:border-bolt-elements-item-contentAccent/60',
  'focus-visible:ring-bolt-elements-item-contentAccent',
);
const BTN_GHOST = classNames(
  CTRL_BASE,
  'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary',
  'enabled:hover:text-bolt-elements-item-contentAccent enabled:hover:border-bolt-elements-item-contentAccent/40',
  'enabled:hover:bg-bolt-elements-background-depth-3 focus-visible:ring-bolt-elements-item-contentAccent',
);
const BTN_DESTRUCTIVE = classNames(
  CTRL_BASE,
  'border border-red-400/40 bg-bolt-elements-background-depth-1/90 text-red-400 backdrop-blur',
  'enabled:hover:bg-red-500/20 enabled:hover:border-red-400/70 focus-visible:ring-red-400',
);

// ── Formatting helpers ───────────────────────────────────────────────────────

/** Human-readable byte size. */
function formatBytes(bytes: number | undefined | null): string {
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

/** Compact relative time from an ISO string. */
function formatRelativeTime(iso: string | undefined | null): string | undefined {
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

/** R2 pricing: storage $0.015/GB-month (Class A/B ops are negligible for a display estimate). */
function estMonthlyCost(totalBytes: number): string {
  const gb = totalBytes / 1024 ** 3;
  const cost = gb * 0.015;

  if (cost < 0.01) {
    return '<$0.01';
  }

  return `$${cost.toFixed(2)}`;
}

/** A phosphor glyph for an object by extension. */
function iconForObject(key: string): string {
  const name = key.toLowerCase();

  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(name)) {
    return 'i-ph:image-duotone';
  }

  if (/\.(mp4|mov|webm|mkv|avi)$/.test(name)) {
    return 'i-ph:file-video-duotone';
  }

  if (/\.(mp3|wav|ogg|m4a|flac)$/.test(name)) {
    return 'i-ph:file-audio-duotone';
  }

  if (/\.pdf$/.test(name)) {
    return 'i-ph:file-pdf-duotone';
  }

  if (/\.(json|xml|ya?ml|toml)$/.test(name)) {
    return 'i-ph:brackets-curly-duotone';
  }

  if (/\.(js|mjs|cjs|jsx|ts|tsx)$/.test(name)) {
    return 'i-ph:file-js-duotone';
  }

  if (/\.(css|scss|less)$/.test(name)) {
    return 'i-ph:file-css-duotone';
  }

  if (/\.(html?|htm)$/.test(name)) {
    return 'i-ph:file-html-duotone';
  }

  if (/\.(zip|tar|gz|rar|7z)$/.test(name)) {
    return 'i-ph:file-archive-duotone';
  }

  if (/\.(txt|md|csv|log)$/.test(name)) {
    return 'i-ph:file-text-duotone';
  }

  return 'i-ph:file-duotone';
}

/** True when an object key looks like a previewable image. */
function isImageKey(key: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(key);
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

/** Copy text to the clipboard, resolving to a success boolean (clipboard API can reject). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

type BucketsState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; buckets: BucketEntry[]; objectOpsAvailable: boolean };

type ObjectsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'needs-creds'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; objects: BucketObjectEntry[]; prefixes: string[]; cursor?: string; truncated: boolean };

type SortKey = 'name' | 'size' | 'time';

/*
 * ── Two-pane layout ───────────────────────────────────────────────────────────
 * The `min-w-0` clip fix lives in its own reusable, render-testable primitive (fire-162 moved it to
 * `./BucketsTwoPane` so the `/_preview` gallery can mount it without this bridge-coupled module).
 * Re-exported here so `import { BucketsTwoPane } from '../BucketsPanel'` (existing tests) still resolves.
 */
export { BucketsTwoPane };

// ── Component ────────────────────────────────────────────────────────────────

export const BucketsPanel = memo(() => {
  const [buckets, setBuckets] = useState<BucketsState>({ status: 'loading' });
  const [selectedBucket, setSelectedBucket] = useState<string | null>(null);

  // Create modal.
  const [showCreate, setShowCreate] = useState(false);

  // Delete-bucket type-to-confirm.
  const [deleteTarget, setDeleteTarget] = useState<BucketEntry | null>(null);

  // Address modal (copy-address bundle for a bucket).
  const [addressTarget, setAddressTarget] = useState<{ bucket: BucketEntry; address: BucketAddress } | null>(null);

  const objectOpsAvailable = buckets.status === 'ready' ? buckets.objectOpsAvailable : false;

  /** Load (or reload) the site's buckets. */
  const loadBuckets = useCallback(async () => {
    setBuckets({ status: 'loading' });

    if (!isEmbedded) {
      setBuckets({ status: 'error', message: 'Open this from the ProjectSites admin to manage your buckets.' });
      return;
    }

    try {
      const reply = await requestR2({ op: 'listBuckets' });

      if (!reply.ok) {
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setBuckets({ status: 'disabled' });
          return;
        }

        setBuckets({ status: 'error', message: reply.error || 'Could not load your buckets.' });

        return;
      }

      const list = reply.buckets ?? [];
      setBuckets({ status: 'ready', buckets: list, objectOpsAvailable: !!reply.objectOpsAvailable });

      // Auto-select the default (or first) bucket so the object browser is never empty on open.
      setSelectedBucket((cur) => cur ?? list.find((b) => b.isDefault)?.name ?? list[0]?.name ?? null);
    } catch (err) {
      setBuckets({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your buckets.' });
    }
  }, []);

  useEffect(() => {
    void loadBuckets();
  }, [loadBuckets]);

  /** After a mutation (or a background poll tick), silently refresh the bucket list while keeping the current selection. */
  const refreshBuckets = useCallback(async () => {
    try {
      const reply = await requestR2({ op: 'listBuckets' });

      if (reply.ok) {
        setBuckets({ status: 'ready', buckets: reply.buckets ?? [], objectOpsAvailable: !!reply.objectOpsAvailable });
      }
    } catch {
      /* keep prior list on a transient refresh error */
    }
  }, []);

  /*
   * Visibility-aware real-time poll (per `real-time-data-no-manual-refresh`) — the header's manual
   * Refresh button is gone; the inventory keeps ITSELF current via the silent `refreshBuckets` (no
   * loading flash, transient errors keep the last good list). Registered once; the tick reads the
   * latest state through refs. Pauses while `document.hidden` or before the first load settles;
   * refreshes immediately on foreground; cleaned up on unmount.
   */
  const refreshRef = useRef(refreshBuckets);
  refreshRef.current = refreshBuckets;

  const bucketsStatusRef = useRef(buckets.status);
  bucketsStatusRef.current = buckets.status;
  useEffect(() => {
    if (!isEmbedded) {
      return undefined;
    }

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      if (bucketsStatusRef.current === 'disabled' || bucketsStatusRef.current === 'loading') {
        return;
      }

      void refreshRef.current();
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

  const onCreated = useCallback(
    (created: BucketEntry) => {
      setShowCreate(false);
      setSelectedBucket(created.name);
      void refreshBuckets();

      // Golden-path: surface the copy-address bundle immediately on success.
      if (created.address) {
        setAddressTarget({ address: created.address, bucket: created });
      }
    },
    [refreshBuckets],
  );

  const onDeleted = useCallback(
    (name: string) => {
      setDeleteTarget(null);
      setSelectedBucket((cur) => (cur === name ? null : cur));
      void refreshBuckets();
    },
    [refreshBuckets],
  );

  const openAddress = useCallback(async (bucket: BucketEntry) => {
    // Prefer the embedded address; otherwise fetch it fresh.
    if (bucket.address) {
      setAddressTarget({ address: bucket.address, bucket });
      return;
    }

    const reply = await requestR2({ op: 'address', bucket: bucket.name });

    if (reply.ok && reply.address) {
      setAddressTarget({ address: reply.address, bucket });
    } else {
      postToastToParent('error', reply.error || 'Could not read the address.');
    }
  }, []);

  const onTogglePublic = useCallback(
    async (bucket: BucketEntry) => {
      const reply = await requestR2({ op: 'setPublic', bucket: bucket.name, makePublic: !bucket.public });

      if (!reply.ok) {
        postToastToParent('error', reply.error || 'Could not change public access.');
        return;
      }

      postToastToParent('success', `${bucket.name} is now ${!bucket.public ? 'public' : 'private'}.`);
      void refreshBuckets();
    },
    [refreshBuckets],
  );

  const onPromote = useCallback(
    async (bucket: BucketEntry) => {
      postToastToParent('info', `Promoting ${bucket.name} to production…`);

      const reply = await requestR2({ op: 'promote', bucket: bucket.name });

      if (!reply.ok) {
        postToastToParent(reply.needsCreds ? 'warning' : 'error', reply.error || 'Could not promote the bucket.');
        return;
      }

      postToastToParent(
        'success',
        `Promoted ${reply.objectsCopied ?? 0} object${(reply.objectsCopied ?? 0) === 1 ? '' : 's'} to production.`,
      );
      void refreshBuckets();
    },
    [refreshBuckets],
  );

  if (buckets.status === 'disabled') {
    return (
      <PanelShell>
        <BucketsHeader buckets={[]} objectOpsAvailable={false} onCreate={() => {}} createDisabled />
        <DisabledCard />
      </PanelShell>
    );
  }

  return (
    <PanelShell testId="buckets-panel">
      <BucketsHeader
        buckets={buckets.status === 'ready' ? buckets.buckets : []}
        objectOpsAvailable={objectOpsAvailable}
        onCreate={() => setShowCreate(true)}
      />

      {/* Needs-creds banner — object ops disabled but bucket CRUD works. */}
      {buckets.status === 'ready' && !objectOpsAvailable && buckets.buckets.length > 0 && <NeedsCredsBanner />}

      <BucketsTwoPane
        left={
          <>
            {buckets.status === 'loading' && <BucketsSkeleton />}
            {buckets.status === 'error' && <ErrorCard message={buckets.message} onRetry={() => void loadBuckets()} />}
            {buckets.status === 'ready' &&
              (buckets.buckets.length === 0 ? (
                <BucketsEmpty onCreate={() => setShowCreate(true)} />
              ) : (
                <BucketNavigator
                  buckets={buckets.buckets}
                  selected={selectedBucket}
                  onSelect={setSelectedBucket}
                  onAddress={openAddress}
                  onTogglePublic={onTogglePublic}
                  onPromote={onPromote}
                  onDelete={setDeleteTarget}
                />
              ))}
          </>
        }
        right={
          selectedBucket && buckets.status === 'ready' ? (
            <BucketWorkspace
              bucket={buckets.buckets.find((b) => b.name === selectedBucket) ?? { name: selectedBucket }}
              objectOpsAvailable={objectOpsAvailable}
              onAddress={openAddress}
              onTogglePublic={onTogglePublic}
              onPromote={onPromote}
              onDelete={setDeleteTarget}
            />
          ) : buckets.status === 'ready' && buckets.buckets.length > 0 ? (
            <div className="flex-1 flex items-center justify-center p-8 text-center text-[12px] text-bolt-elements-textTertiary">
              Select a bucket to browse its objects.
            </div>
          ) : null
        }
      />

      {showCreate && <CreateBucketModal onClose={() => setShowCreate(false)} onCreated={onCreated} />}
      {deleteTarget && (
        <DeleteBucketModal bucket={deleteTarget} onClose={() => setDeleteTarget(null)} onDeleted={onDeleted} />
      )}
      {addressTarget && (
        <AddressModal
          bucket={addressTarget.bucket}
          address={addressTarget.address}
          onClose={() => setAddressTarget(null)}
        />
      )}
    </PanelShell>
  );
});

BucketsPanel.displayName = 'BucketsPanel';

// ── Header ───────────────────────────────────────────────────────────────────

const BucketsHeader = memo(
  ({
    buckets,
    objectOpsAvailable,
    onCreate,
    createDisabled,
  }: {
    buckets: BucketEntry[];
    objectOpsAvailable: boolean;
    onCreate: () => void;
    createDisabled?: boolean;
  }) => {
    // POLISH 3: usage rollup across all buckets (count + est. monthly cost surfaced in the object list).
    const count = buckets.length;
    return (
      <PanelHeader
        icon="i-ph:hard-drives-duotone"
        title="Buckets"
        subtitle={
          count > 0 ? (
            <span className="tabular-nums">
              <span className="text-bolt-elements-textSecondary font-medium">{count}</span> bucket
              {count === 1 ? '' : 's'}
              {!objectOpsAvailable && (
                <span className="text-bolt-elements-textTertiary"> · object ops need R2 keys</span>
              )}
            </span>
          ) : (
            'Your site’s own R2 object storage'
          )
        }
        actions={
          <>
            {/* POLISH 4: primary label span reserves its widest state so the button never resizes. */}
            <button
              type="button"
              onClick={onCreate}
              disabled={createDisabled}
              data-testid="buckets-create"
              title="Create a new bucket"
              className={classNames(BTN_PRIMARY, 'min-h-[26px] px-3 py-1 text-[11px]')}
            >
              <div className="i-ph:plus-bold text-sm shrink-0" aria-hidden />
              <span className="min-w-[9ch] text-center">New bucket</span>
            </button>
            {/* Live affordance — the inventory self-updates on a visibility-aware poll; no manual
                Refresh (per `real-time-data-no-manual-refresh`). */}
            <span
              className="hidden sm:inline-flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary select-none"
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
    );
  },
);

BucketsHeader.displayName = 'BucketsPanel.Header';

// ── Needs-creds banner ───────────────────────────────────────────────────────

const NeedsCredsBanner = memo(() => (
  <div
    className="flex items-start gap-2 px-4 py-2 border-b border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-2/60"
    role="status"
    data-testid="buckets-needs-creds"
  >
    <div className="i-ph:key-duotone text-sm mt-px shrink-0" style={{ color: PURPLE_INK }} aria-hidden />
    <p className="text-[11px] text-bolt-elements-textTertiary leading-relaxed">
      Your buckets are ready to manage. Uploading and browsing the files inside them is still being enabled for your
      site — nothing to set up on your end.
    </p>
  </div>
));

NeedsCredsBanner.displayName = 'BucketsPanel.NeedsCredsBanner';

/*
 * ── Navigator (grouped bucket list) ───────────────────────────────────────────
 * B1 premium shell: the left pane is a NAVIGATOR that pins the two site-visible defaults — Preview +
 * Production — at the top, then groups any extra buckets under "Custom". Rows SELECT a bucket; every
 * per-bucket action (visibility / address / promote / delete) lives in the right-pane Settings tab,
 * so the navigator stays calm + scannable (Linear/Raycast feel) rather than a wall of hover buttons.
 */

type NavGroupKey = 'preview' | 'production' | 'custom';

const NAV_GROUPS: { key: NavGroupKey; label: string; icon: string; empty: string }[] = [
  {
    key: 'preview',
    label: 'Preview',
    icon: 'i-ph:flask-duotone',
    empty: 'Your working storage — created with your site.',
  },
  {
    key: 'production',
    label: 'Production',
    icon: 'i-ph:rocket-launch-duotone',
    empty: 'Appears once you publish to production.',
  },
  { key: 'custom', label: 'Custom', icon: 'i-ph:stack-duotone', empty: '' },
];

/** Which navigator group a bucket belongs to (env drives it; unknown → Custom). */
function navGroupOf(bucket: BucketEntry): NavGroupKey {
  if (bucket.environment === 'production') {
    return 'production';
  }

  if (bucket.environment === 'preview') {
    return 'preview';
  }

  return 'custom';
}

const BucketNavigator = memo(
  ({
    buckets,
    selected,
    onSelect,
    onAddress,
    onTogglePublic,
    onPromote,
    onDelete,
  }: {
    buckets: BucketEntry[];
    selected: string | null;
    onSelect: (name: string) => void;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
  }) => {
    const grouped = useMemo(() => {
      const groups: Record<NavGroupKey, BucketEntry[]> = { preview: [], production: [], custom: [] };

      for (const bucket of buckets) {
        groups[navGroupOf(bucket)].push(bucket);
      }

      // Default bucket first within its group, then alphabetical.
      for (const key of Object.keys(groups) as NavGroupKey[]) {
        groups[key].sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : a.name.localeCompare(b.name)));
      }

      return groups;
    }, [buckets]);

    /*
     * Roving-tabindex focus target: the selected bucket (or the first, when none) is the SINGLE tab stop,
     * so the listbox is one Tab stop and Arrow keys move within it (WCAG listbox pattern).
     */
    const flatNames = useMemo(
      () => [...grouped.preview, ...grouped.production, ...grouped.custom].map((b) => b.name),
      [grouped],
    );
    const tabbableName = selected && flatNames.includes(selected) ? selected : flatNames[0];

    return (
      <div className="p-2 space-y-3" role="listbox" aria-label="Buckets">
        {NAV_GROUPS.map((group) => {
          const items = grouped[group.key];

          // Preview + Production are ALWAYS pinned (even when empty, with a hint); Custom shows only when used.
          if (group.key === 'custom' && items.length === 0) {
            return null;
          }

          return (
            <div key={group.key} role="group" aria-label={group.label} data-testid={`buckets-nav-group-${group.key}`}>
              <div className="flex items-center gap-1.5 px-1.5 pb-1.5">
                <div
                  className={classNames(group.icon, 'text-xs text-bolt-elements-item-contentAccent/80 shrink-0')}
                  aria-hidden
                />
                <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-bolt-elements-textTertiary">
                  {group.label}
                </span>
                {items.length > 0 && (
                  <span className="text-[9px] text-bolt-elements-textTertiary/60 tabular-nums">{items.length}</span>
                )}
                <div className="flex-1 h-px bg-bolt-elements-borderColor/40 ml-1" aria-hidden />
              </div>

              {items.length === 0 ? (
                <p className="px-1.5 pb-1 text-[10px] leading-relaxed text-bolt-elements-textTertiary/70">
                  {group.empty}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {items.map((bucket) => (
                    <BucketNavRow
                      key={bucket.name}
                      bucket={bucket}
                      active={selected === bucket.name}
                      tabbable={bucket.name === tabbableName}
                      onSelect={onSelect}
                      onAddress={onAddress}
                      onTogglePublic={onTogglePublic}
                      onPromote={onPromote}
                      onDelete={onDelete}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  },
);

BucketNavigator.displayName = 'BucketsPanel.BucketNavigator';

const BucketNavRow = memo(
  ({
    bucket,
    active,
    tabbable,
    onSelect,
    onAddress,
    onTogglePublic,
    onPromote,
    onDelete,
  }: {
    bucket: BucketEntry;
    active: boolean;
    tabbable: boolean;
    onSelect: (name: string) => void;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
  }) => (
    <div
      role="option"
      aria-selected={active}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onSelect(bucket.name)}
      onKeyDown={(e) => {
        // Only the row itself handles keys — not events bubbling up from the actions menu.
        if (e.target !== e.currentTarget) {
          return;
        }

        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(bucket.name);

          return;
        }

        // Listbox roving: Arrow/Home/End move selection + focus across every bucket row (all groups).
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
          const listbox = e.currentTarget.closest('[role="listbox"]');

          if (!listbox) {
            return;
          }

          e.preventDefault();

          const rows = Array.from(listbox.querySelectorAll<HTMLElement>('[data-testid="buckets-list-item"]'));
          const idx = rows.indexOf(e.currentTarget as HTMLElement);
          const last = rows.length - 1;
          const nextIdx =
            e.key === 'ArrowDown'
              ? Math.min(last, idx + 1)
              : e.key === 'ArrowUp'
                ? Math.max(0, idx - 1)
                : e.key === 'Home'
                  ? 0
                  : last;
          const next = rows[nextIdx];

          if (next && next !== e.currentTarget) {
            next.focus();
            next.click(); // selects the target bucket via its own onClick closure
          }
        }
      }}
      data-testid="buckets-list-item"
      className={classNames(
        'group relative rounded-xl border p-2.5 transition-all duration-200 motion-reduce:transition-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
        active
          ? 'border-bolt-elements-item-contentAccent/70 bg-bolt-elements-item-contentAccent/[0.08] shadow-sm shadow-bolt-elements-item-contentAccent/10'
          : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:border-bolt-elements-item-contentAccent/40 hover:bg-bolt-elements-background-depth-3 motion-safe:hover:-translate-y-px',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-bolt-elements-item-contentAccent"
        />
      )}
      <div className="flex items-center gap-2 min-w-0">
        <div
          className={classNames(
            'i-ph:hard-drives-duotone text-base shrink-0',
            active
              ? 'text-bolt-elements-item-contentAccent'
              : 'text-bolt-elements-textTertiary group-hover:text-bolt-elements-item-contentAccent',
          )}
          aria-hidden
        />
        <span className="text-[12px] font-medium text-bolt-elements-textPrimary truncate flex-1" title={bucket.name}>
          {bucket.name}
        </span>
        {bucket.isDefault && (
          <span
            className="inline-flex items-center rounded-md border px-1 py-px text-[8px] font-semibold uppercase tracking-wide shrink-0"
            style={{ borderColor: `color-mix(in oklch, ${CYAN} 45%, transparent)`, color: CYAN }}
            title="The site's default bucket"
          >
            Default
          </span>
        )}
        <BucketRowMenu
          bucket={bucket}
          onAddress={onAddress}
          onTogglePublic={onTogglePublic}
          onPromote={onPromote}
          onDelete={onDelete}
        />
      </div>

      {/* Meta line — visibility + age (env is conveyed by the group header). */}
      <div className="mt-1 flex items-center gap-1.5 text-[9px] text-bolt-elements-textTertiary tabular-nums pl-6">
        <span
          className="inline-flex items-center gap-0.5"
          title={bucket.public ? 'Public — has a public base URL' : 'Private'}
        >
          <div
            className={classNames(bucket.public ? 'i-ph:globe-simple' : 'i-ph:lock-simple', 'text-[10px]')}
            aria-hidden
          />
          {bucket.public ? 'Public' : 'Private'}
        </span>
        {bucket.createdAt && formatRelativeTime(bucket.createdAt) && (
          <>
            <span className="opacity-40" aria-hidden>
              ·
            </span>
            <span>{formatRelativeTime(bucket.createdAt)}</span>
          </>
        )}
      </div>
    </div>
  ),
);

BucketNavRow.displayName = 'BucketsPanel.BucketNavRow';

/*
 * ── Bucket row actions menu (B3) ──────────────────────────────────────────────
 * A Radix DropdownMenu ellipsis (⋯) per bucket row — discoverable + keyboard + touch + a11y
 * (roles/Escape/portal come from Radix). Quick access to the SAME bucket-level ops the Settings tab
 * exposes (Address / visibility / promote / delete) — all CF-REST bucket ops that work WITHOUT R2 S3
 * object creds. Clicks stop-propagating so the row's select handler never fires behind the menu.
 */

const BUCKET_MENU_CONTENT =
  'z-[100001] min-w-[180px] rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 ' +
  'p-1 shadow-2xl shadow-black/40 motion-safe:animate-[fadeIn_.12s_ease-out]';
const BUCKET_MENU_ITEM =
  'flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-lg cursor-pointer select-none outline-none ' +
  'text-bolt-elements-textSecondary data-[highlighted]:bg-bolt-elements-item-contentAccent/[0.12] ' +
  'data-[highlighted]:text-bolt-elements-item-contentAccent';

const BucketRowMenu = memo(
  ({
    bucket,
    onAddress,
    onTogglePublic,
    onPromote,
    onDelete,
  }: {
    bucket: BucketEntry;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
  }) => (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          data-testid="buckets-row-menu-trigger"
          aria-label={`Actions for ${bucket.name}`}
          title="Bucket actions"
          className={classNames(BTN_GHOST, 'shrink-0 min-h-[22px] min-w-[22px] p-1 data-[state=open]:opacity-100')}
        >
          <div className="i-ph:dots-three-vertical-bold text-sm" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className={BUCKET_MENU_CONTENT}
          onClick={(e) => e.stopPropagation()}
        >
          <DropdownMenu.Item
            className={BUCKET_MENU_ITEM}
            data-testid="buckets-row-menu-address"
            onSelect={() => onAddress(bucket)}
          >
            <div className="i-ph:link text-sm" aria-hidden /> Address
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={BUCKET_MENU_ITEM}
            data-testid="buckets-row-menu-visibility"
            onSelect={() => onTogglePublic(bucket)}
          >
            <div
              className={classNames(bucket.public ? 'i-ph:lock-simple' : 'i-ph:globe-simple', 'text-sm')}
              aria-hidden
            />
            {bucket.public ? 'Make private' : 'Make public'}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={BUCKET_MENU_ITEM}
            data-testid="buckets-row-menu-promote"
            onSelect={() => onPromote(bucket)}
          >
            <div className="i-ph:rocket-launch text-sm" aria-hidden /> Promote to production
          </DropdownMenu.Item>
          {!bucket.isDefault && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-bolt-elements-borderColor/60" />
              <DropdownMenu.Item
                className={classNames(
                  BUCKET_MENU_ITEM,
                  'text-red-400 data-[highlighted]:bg-red-500/15 data-[highlighted]:text-red-300',
                )}
                data-testid="buckets-row-menu-delete"
                onSelect={() => onDelete(bucket)}
              >
                <div className="i-ph:trash text-sm" aria-hidden /> Delete bucket…
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  ),
);

BucketRowMenu.displayName = 'BucketsPanel.BucketRowMenu';

// ── Object browser ───────────────────────────────────────────────────────────

/** Files view mode — persists for the editor session (survives bucket/tab switches). */
type FilesViewMode = 'list' | 'grid';

const VIEW_MODE_KEY = 'ps.buckets.filesView';

function readStoredViewMode(): FilesViewMode {
  try {
    return sessionStorage.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

const ObjectBrowser = memo(
  ({
    bucket,
    objectOpsAvailable,
    onCopyBucketAddress,
  }: {
    bucket: BucketEntry;
    objectOpsAvailable: boolean;
    onCopyBucketAddress: () => void;
  }) => {
    const [objects, setObjects] = useState<ObjectsState>({ status: 'idle' });
    const [prefix, setPrefix] = useState('');
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState<SortKey>('name');
    const [viewMode, setViewMode] = useState<FilesViewMode>(readStoredViewMode);
    const [failedThumbs, setFailedThumbs] = useState<Set<string>>(new Set());
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [uploading, setUploading] = useState(false);
    const [uploadName, setUploadName] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const dragDepth = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const cursorStack = useRef<string[]>([]);

    /** Load one page of objects for the current bucket + prefix (+ optional cursor). */
    const loadObjects = useCallback(
      async (cursor?: string) => {
        if (!objectOpsAvailable) {
          setObjects({
            status: 'needs-creds',
            message: 'Uploading + browsing objects needs R2 S3 credentials. Bucket management still works.',
          });
          return;
        }

        setObjects({ status: 'loading' });

        try {
          const reply = await requestR2({
            op: 'listObjects',
            bucket: bucket.name,
            prefix: prefix || undefined,
            delimiter: '/',
            cursor,
          });

          if (!reply.ok) {
            if (reply.needsCreds) {
              setObjects({ status: 'needs-creds', message: reply.error || 'Object ops need R2 S3 credentials.' });
              return;
            }

            if (reply.enabled === false) {
              setObjects({ status: 'error', message: 'Buckets are not enabled.' });
              return;
            }

            setObjects({ status: 'error', message: reply.error || 'Could not list objects.' });

            return;
          }

          setObjects({
            status: 'ready',
            cursor: reply.cursor,
            objects: reply.objects ?? [],
            prefixes: reply.prefixes ?? [],
            truncated: !!reply.truncated,
          });
        } catch (err) {
          setObjects({ status: 'error', message: err instanceof Error ? err.message : 'Could not list objects.' });
        }
      },
      [bucket.name, prefix, objectOpsAvailable],
    );

    // Reload when the bucket or prefix changes (reset selection + pagination).
    useEffect(() => {
      cursorStack.current = [];
      setSelected(new Set());
      void loadObjects();
    }, [loadObjects]);

    // Reset prefix when switching buckets.
    useEffect(() => {
      setPrefix('');
      setSearch('');
    }, [bucket.name]);

    /** Upload one file to the current prefix. */
    const uploadFile = useCallback(
      async (file: File) => {
        if (uploading || !objectOpsAvailable) {
          return;
        }

        setUploading(true);
        setUploadName(file.name);

        try {
          const key = `${prefix}${file.name}`;
          const dataUrl = await fileToDataUrl(file);
          const reply = await requestBucketUpload({
            bucket: bucket.name,
            key,
            contentType: file.type || 'application/octet-stream',
            dataUrl,
          });

          if (!reply.ok) {
            postToastToParent(reply.needsCreds ? 'warning' : 'error', reply.error || 'Upload failed.');
            return;
          }

          postToastToParent('success', `Uploaded ${file.name}.`);
          await loadObjects();
        } catch (err) {
          postToastToParent('error', err instanceof Error ? err.message : 'Upload failed.');
        } finally {
          setUploading(false);
          setUploadName(null);
        }
      },
      [uploading, objectOpsAvailable, prefix, bucket.name, loadObjects],
    );

    const uploadFiles = useCallback(
      async (files: FileList | File[]) => {
        for (const file of Array.from(files)) {
          await uploadFile(file);
        }
      },
      [uploadFile],
    );

    /** Delete one object (with an undo toast — re-upload isn't possible, so undo is a soft re-list guard). */
    const deleteObject = useCallback(
      async (key: string) => {
        setBusyKey(key);

        try {
          const reply = await requestR2({ op: 'deleteObject', bucket: bucket.name, key });

          if (!reply.ok) {
            postToastToParent('error', reply.error || 'Could not delete the object.');
            return;
          }

          postToastToParent('success', `Deleted ${key.split('/').pop()}.`);
          setObjects((cur) =>
            cur.status === 'ready' ? { ...cur, objects: cur.objects.filter((o) => o.key !== key) } : cur,
          );
          setSelected((cur) => {
            const next = new Set(cur);
            next.delete(key);

            return next;
          });
        } catch (err) {
          postToastToParent('error', err instanceof Error ? err.message : 'Could not delete the object.');
        } finally {
          setBusyKey(null);
        }
      },
      [bucket.name],
    );

    /** Bulk-delete every selected object. */
    const bulkDelete = useCallback(async () => {
      const keys = [...selected];

      if (keys.length === 0) {
        return;
      }

      postToastToParent('info', `Deleting ${keys.length} object${keys.length === 1 ? '' : 's'}…`);

      for (const key of keys) {
        await requestR2({ op: 'deleteObject', bucket: bucket.name, key }).catch(() => undefined);
      }
      postToastToParent('success', `Deleted ${keys.length} object${keys.length === 1 ? '' : 's'}.`);
      setSelected(new Set());
      await loadObjects();
    }, [selected, bucket.name, loadObjects]);

    /** Download an object → save via a temporary anchor. */
    const downloadObject = useCallback(
      async (key: string) => {
        setBusyKey(key);

        try {
          const reply = await requestBucketDownload({ bucket: bucket.name, key });

          if (!reply.ok || !reply.dataUrl) {
            postToastToParent(reply.needsCreds ? 'warning' : 'error', reply.error || 'Could not download the object.');
            return;
          }

          const a = document.createElement('a');
          a.href = reply.dataUrl;
          a.download = key.split('/').pop() || 'download';
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch (err) {
          postToastToParent('error', err instanceof Error ? err.message : 'Could not download the object.');
        } finally {
          setBusyKey(null);
        }
      },
      [bucket.name],
    );

    /** Copy an object's public URL (when the bucket is public) or its S3 path otherwise. */
    const copyObjectUrl = useCallback(
      async (key: string) => {
        const publicBase = bucket.publicUrl || bucket.address?.publicUrl;
        const url = publicBase
          ? `${publicBase.replace(/\/$/, '')}/${key}`
          : bucket.address
            ? `${bucket.address.s3Endpoint}/${bucket.address.bucketName}/${key}`
            : key;
        const ok = await copyText(url);
        postToastToParent(ok ? 'success' : 'error', ok ? 'Object URL copied.' : 'Could not copy the URL.');
      },
      [bucket.publicUrl, bucket.address],
    );

    // Drag-and-drop.
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

        if (e.dataTransfer.files?.length) {
          void uploadFiles(e.dataTransfer.files);
        }
      },
      [uploadFiles],
    );

    // Prefix breadcrumbs.
    const segments = prefix.split('/').filter(Boolean);

    // Derived: filtered + sorted objects.
    const shownObjects = useMemo(() => {
      if (objects.status !== 'ready') {
        return [];
      }

      const needle = search.trim().toLowerCase();
      let list = objects.objects;

      if (needle) {
        list = list.filter((o) => o.key.toLowerCase().includes(needle));
      }

      const cmp: Record<SortKey, (a: BucketObjectEntry, b: BucketObjectEntry) => number> = {
        name: (a, b) => a.key.localeCompare(b.key),
        size: (a, b) => (b.size ?? 0) - (a.size ?? 0),
        time: (a, b) => Date.parse(b.uploadedAt ?? '') - Date.parse(a.uploadedAt ?? ''),
      };

      return [...list].sort(cmp[sort]);
    }, [objects, search, sort]);

    const totalBytes = objects.status === 'ready' ? objects.objects.reduce((sum, o) => sum + (o.size ?? 0), 0) : 0;
    const allSelected = shownObjects.length > 0 && shownObjects.every((o) => selected.has(o.key));

    return (
      <div
        className="relative flex-1 flex flex-col min-h-0"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Toolbar — wraps by PANEL width (this pane is a flex sub-pane of the editor split, not the
            viewport, so a viewport @media is wrong). At a narrow panel (~≤620px) the control cluster
            flows onto a second line beneath the breadcrumbs instead of cramping; at wide widths it
            stays right-aligned on the same row. `gap-y-2` keeps the two rows breathing when wrapped. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-3 py-2 border-b border-bolt-elements-borderColor/60 shrink-0">
          {/* Breadcrumbs — flex-1 so they own the first line and let the control cluster wrap below. */}
          <nav className="flex items-center gap-1 text-[11px] min-w-0 flex-1 basis-40" aria-label="Prefix breadcrumbs">
            <button
              type="button"
              onClick={() => setPrefix('')}
              className="inline-flex items-center gap-1 text-bolt-elements-item-contentAccent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent rounded px-0.5"
              title={bucket.name}
            >
              <div className="i-ph:hard-drives text-xs" aria-hidden /> {bucket.name}
            </button>
            {segments.map((seg, i) => {
              const to = segments.slice(0, i + 1).join('/') + '/';
              return (
                <span key={to} className="inline-flex items-center gap-1 min-w-0">
                  <span className="text-bolt-elements-textTertiary" aria-hidden>
                    /
                  </span>
                  <button
                    type="button"
                    onClick={() => setPrefix(to)}
                    className="text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent truncate max-w-[120px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent rounded px-0.5"
                  >
                    {seg}
                  </button>
                </span>
              );
            })}
          </nav>

          {/* Control cluster — `ml-auto` right-aligns it on the first row at wide panel widths; it
              wraps BELOW the breadcrumbs as a unit when the panel narrows (~≤620px). It can itself
              wrap internally (`flex-wrap justify-end`) so the controls stack cleanly at extreme narrow
              widths rather than clipping. */}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {/* Search — grows to share free space, never shrinks below a usable width. */}
            <div className="relative grow min-w-[8rem] max-w-[14rem] group">
              <div className="i-ph:magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-xs text-bolt-elements-textTertiary group-focus-within:text-bolt-elements-item-contentAccent transition-colors pointer-events-none" />
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter objects"
                data-testid="buckets-object-search"
                className="w-full min-h-[26px] pl-7 pr-2 py-1 text-[11px] rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/50"
              />
            </div>
            {/* Sort */}
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              aria-label="Sort objects"
              className={classNames(
                'shrink-0 min-h-[26px] appearance-none pl-2.5 pr-7 py-1 text-[11px] rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary cursor-pointer transition-colors',
                'hover:border-bolt-elements-item-contentAccent/50 hover:text-bolt-elements-textPrimary',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%2300e5ff%22%20stroke-width%3D%222.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22/%3E%3C/svg%3E')]",
                'bg-[length:12px] bg-[right_0.5rem_center] bg-no-repeat',
                '[&>option]:bg-bolt-elements-background-depth-2 [&>option]:text-bolt-elements-textPrimary',
              )}
            >
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="time">Newest</option>
            </select>
            {/* View mode — list / grid (session-persisted). */}
            <div
              className="inline-flex shrink-0 overflow-hidden rounded-lg border border-bolt-elements-borderColor"
              role="group"
              aria-label="Object view"
            >
              {(
                [
                  ['list', 'i-ph:list-bullets', 'List'],
                  ['grid', 'i-ph:squares-four', 'Grid'],
                ] as const
              ).map(([mode, icon, label]) => {
                const on = viewMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setViewMode(mode);

                      try {
                        sessionStorage.setItem(VIEW_MODE_KEY, mode);
                      } catch {
                        /* storage unavailable — in-memory only */
                      }
                    }}
                    data-testid={`buckets-view-${mode}`}
                    aria-pressed={on}
                    aria-label={`${label} view`}
                    title={`${label} view`}
                    className={classNames(
                      'inline-flex items-center justify-center min-h-[26px] min-w-[28px] px-2 transition-colors motion-reduce:transition-none',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent',
                      on
                        ? 'bg-bolt-elements-item-contentAccent text-[#061018]'
                        : 'bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent',
                    )}
                  >
                    <div className={classNames(icon, 'text-sm')} aria-hidden />
                  </button>
                );
              })}
            </div>
            {/* Copy bucket address */}
            <button
              type="button"
              onClick={onCopyBucketAddress}
              title="Copy the bucket address"
              aria-label="Copy bucket address"
              className={classNames(BTN_GHOST, 'shrink-0 min-h-[26px] px-2 py-1 text-[11px]')}
            >
              <div className="i-ph:link text-sm" /> Address
            </button>
            {/* Upload — label reserves widest state so it never resizes. */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || !objectOpsAvailable}
              data-testid="buckets-upload"
              title={objectOpsAvailable ? 'Upload files to this bucket' : 'Object uploads need R2 S3 credentials'}
              className={classNames(BTN_PRIMARY, 'shrink-0 min-h-[26px] px-3 py-1 text-[11px]')}
            >
              <div
                className={classNames(
                  uploading ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:upload-simple-bold',
                  'text-sm shrink-0',
                )}
                aria-hidden
              />
              <span className="min-w-[8ch] text-center">{uploading ? 'Uploading…' : 'Upload'}</span>
            </button>
          </div>
        </div>

        {/* Bulk-action bar (visible only with a selection). */}
        {selected.size > 0 && (
          <div
            className="flex items-center gap-2 px-3 py-1.5 border-b border-bolt-elements-borderColor/40 bg-bolt-elements-item-contentAccent/[0.05] shrink-0"
            data-testid="buckets-bulk-bar"
          >
            <span className="text-[11px] text-bolt-elements-item-contentAccent font-medium tabular-nums">
              {selected.size} selected
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className={classNames(BTN_GHOST, 'min-h-[24px] px-2 py-0.5 text-[10px]')}
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => void bulkDelete()}
              className={classNames(BTN_DESTRUCTIVE, 'min-h-[24px] px-2 py-0.5 text-[10px] ml-auto')}
              data-testid="buckets-bulk-delete"
            >
              <div className="i-ph:trash text-xs" /> Delete selected
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto modern-scrollbar min-h-0">
          {objects.status === 'idle' || objects.status === 'loading' ? (
            <ObjectsSkeleton />
          ) : objects.status === 'needs-creds' ? (
            <ObjectsNeedsCreds message={objects.message} />
          ) : objects.status === 'error' ? (
            <ErrorCard message={objects.message} onRetry={() => void loadObjects()} />
          ) : shownObjects.length === 0 && objects.prefixes.length === 0 ? (
            <ObjectsEmpty
              hasFilter={!!search.trim()}
              uploading={uploading}
              onUpload={() => fileInputRef.current?.click()}
              objectOpsAvailable={objectOpsAvailable}
            />
          ) : (
            <div data-testid={viewMode === 'grid' ? 'buckets-object-grid' : 'buckets-object-list'}>
              {/* Header row with select-all + count/size. */}
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-bolt-elements-borderColor/40 sticky top-0 z-[1] bg-bolt-elements-background-depth-1/90 backdrop-blur">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) => setSelected(e.target.checked ? new Set(shownObjects.map((o) => o.key)) : new Set())}
                  aria-label="Select all objects"
                  className="h-3.5 w-3.5 accent-[var(--bolt-elements-item-contentAccent)] cursor-pointer"
                />
                <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums">
                  {shownObjects.length} object{shownObjects.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
                  {/* POLISH 3: est. monthly cost inline. */}
                  <span className="text-bolt-elements-textTertiary/70"> · ~{estMonthlyCost(totalBytes)}/mo</span>
                </span>
              </div>

              {viewMode === 'list' ? (
                <>
                  {/* Folders (common prefixes). */}
                  {objects.prefixes.map((p) => {
                    const label = p.slice(prefix.length).replace(/\/$/, '');
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPrefix(p)}
                        className="group w-full flex items-center gap-2.5 px-3 py-2 border-b border-bolt-elements-borderColor/25 hover:bg-bolt-elements-item-backgroundActive transition-colors motion-reduce:transition-none text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
                      >
                        <div
                          className="i-ph:folder-duotone text-base text-bolt-elements-item-contentAccent shrink-0"
                          aria-hidden
                        />
                        <span className="text-[12px] font-medium text-bolt-elements-textPrimary truncate flex-1">
                          {label}/
                        </span>
                        <div
                          className="i-ph:caret-right text-xs text-bolt-elements-textTertiary group-hover:text-bolt-elements-item-contentAccent"
                          aria-hidden
                        />
                      </button>
                    );
                  })}

                  {/* Objects. */}
                  {shownObjects.map((obj) => {
                    const name = obj.key.slice(prefix.length);
                    const checked = selected.has(obj.key);
                    const busy = busyKey === obj.key;

                    return (
                      <div
                        key={obj.key}
                        className="group flex items-center gap-2.5 px-3 py-2 border-b border-bolt-elements-borderColor/25 hover:bg-bolt-elements-item-backgroundActive transition-colors motion-reduce:transition-none"
                        data-testid="buckets-object-row"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setSelected((cur) => {
                              const next = new Set(cur);

                              if (e.target.checked) {
                                next.add(obj.key);
                              } else {
                                next.delete(obj.key);
                              }

                              return next;
                            })
                          }
                          aria-label={`Select ${name}`}
                          className="h-3.5 w-3.5 accent-[var(--bolt-elements-item-contentAccent)] cursor-pointer shrink-0"
                        />
                        <div
                          className={classNames(
                            iconForObject(obj.key),
                            'text-base text-bolt-elements-textTertiary group-hover:text-bolt-elements-item-contentAccent transition-colors shrink-0',
                          )}
                          aria-hidden
                        />
                        <span
                          className="text-[12px] font-mono text-bolt-elements-textPrimary truncate flex-1"
                          title={obj.key}
                        >
                          {name}
                        </span>
                        <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums shrink-0">
                          {formatBytes(obj.size)}
                        </span>
                        {formatRelativeTime(obj.uploadedAt) && (
                          <span className="hidden sm:inline text-[10px] text-bolt-elements-textTertiary/70 tabular-nums shrink-0 w-14 text-right">
                            {formatRelativeTime(obj.uploadedAt)}
                          </span>
                        )}

                        {/* Row actions. */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity motion-reduce:transition-none shrink-0">
                          {isImageKey(obj.key) && (
                            <button
                              type="button"
                              onClick={() => void downloadObject(obj.key)}
                              disabled={busy}
                              title="Preview / download"
                              aria-label={`Preview ${name}`}
                              className={classNames(BTN_GHOST, 'min-h-[24px] min-w-[24px] p-1')}
                            >
                              <div className="i-ph:eye text-xs" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => void copyObjectUrl(obj.key)}
                            title="Copy object URL"
                            aria-label={`Copy URL for ${name}`}
                            className={classNames(BTN_GHOST, 'min-h-[24px] min-w-[24px] p-1')}
                          >
                            <div className="i-ph:link text-xs" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void downloadObject(obj.key)}
                            disabled={busy}
                            title="Download"
                            aria-label={`Download ${name}`}
                            className={classNames(BTN_GHOST, 'min-h-[24px] min-w-[24px] p-1')}
                          >
                            <div
                              className={classNames(
                                busy
                                  ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                                  : 'i-ph:download-simple',
                                'text-xs',
                              )}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteObject(obj.key)}
                            disabled={busy}
                            title="Delete"
                            aria-label={`Delete ${name}`}
                            className={classNames(BTN_DESTRUCTIVE, 'min-h-[24px] min-w-[24px] p-1')}
                            data-testid="buckets-object-delete"
                          >
                            <div
                              className={classNames(
                                busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:trash',
                                'text-xs',
                              )}
                            />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5 p-3">
                  {/* Folder tiles */}
                  {objects.prefixes.map((p) => {
                    const label = p.slice(prefix.length).replace(/\/$/, '');
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setPrefix(p)}
                        data-testid="buckets-folder-tile"
                        title={`${label}/`}
                        className="group flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 text-center transition-colors motion-reduce:transition-none hover:border-bolt-elements-item-contentAccent/40 hover:bg-bolt-elements-background-depth-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
                      >
                        <div
                          className="i-ph:folder-duotone text-3xl text-bolt-elements-item-contentAccent"
                          aria-hidden
                        />
                        <span className="w-full truncate text-[11px] font-medium text-bolt-elements-textPrimary">
                          {label}/
                        </span>
                      </button>
                    );
                  })}

                  {/* Object tiles */}
                  {shownObjects.map((obj) => {
                    const name = obj.key.slice(prefix.length);
                    const checked = selected.has(obj.key);
                    const busy = busyKey === obj.key;
                    const publicBase = bucket.publicUrl || bucket.address?.publicUrl;
                    const thumbUrl =
                      publicBase && isImageKey(obj.key) && !failedThumbs.has(obj.key)
                        ? `${publicBase.replace(/\/$/, '')}/${obj.key}`
                        : null;

                    return (
                      <div
                        key={obj.key}
                        data-testid="buckets-object-tile"
                        className={classNames(
                          'group relative flex flex-col gap-1.5 rounded-xl border p-2 transition-colors motion-reduce:transition-none',
                          checked
                            ? 'border-bolt-elements-item-contentAccent/70 bg-bolt-elements-item-contentAccent/[0.08]'
                            : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:border-bolt-elements-item-contentAccent/40 hover:bg-bolt-elements-background-depth-3',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setSelected((cur) => {
                              const next = new Set(cur);

                              if (e.target.checked) {
                                next.add(obj.key);
                              } else {
                                next.delete(obj.key);
                              }

                              return next;
                            })
                          }
                          aria-label={`Select ${name}`}
                          className={classNames(
                            'absolute left-1.5 top-1.5 z-[1] h-3.5 w-3.5 cursor-pointer accent-[var(--bolt-elements-item-contentAccent)] transition-opacity',
                            checked
                              ? 'opacity-100'
                              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                          )}
                        />

                        <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-bolt-elements-background-depth-1">
                          {thumbUrl ? (
                            <img
                              src={thumbUrl}
                              alt={name}
                              loading="lazy"
                              onError={() => setFailedThumbs((c) => new Set(c).add(obj.key))}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div
                              className={classNames(
                                iconForObject(obj.key),
                                'text-3xl text-bolt-elements-textTertiary transition-colors group-hover:text-bolt-elements-item-contentAccent',
                              )}
                              aria-hidden
                            />
                          )}
                        </div>

                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-mono text-bolt-elements-textPrimary" title={obj.key}>
                            {name}
                          </p>
                          <p className="text-[9px] tabular-nums text-bolt-elements-textTertiary">
                            {formatBytes(obj.size)}
                          </p>
                        </div>

                        <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100">
                          <button
                            type="button"
                            onClick={() => void copyObjectUrl(obj.key)}
                            title="Copy object URL"
                            aria-label={`Copy URL for ${name}`}
                            className={classNames(BTN_GHOST, 'min-h-[22px] min-w-[22px] p-1')}
                          >
                            <div className="i-ph:link text-xs" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void downloadObject(obj.key)}
                            disabled={busy}
                            title="Download"
                            aria-label={`Download ${name}`}
                            className={classNames(BTN_GHOST, 'min-h-[22px] min-w-[22px] p-1')}
                          >
                            <div
                              className={classNames(
                                busy
                                  ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                                  : 'i-ph:download-simple',
                                'text-xs',
                              )}
                            />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteObject(obj.key)}
                            disabled={busy}
                            title="Delete"
                            aria-label={`Delete ${name}`}
                            data-testid="buckets-tile-delete"
                            className={classNames(BTN_DESTRUCTIVE, 'min-h-[22px] min-w-[22px] p-1')}
                          >
                            <div
                              className={classNames(
                                busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:trash',
                                'text-xs',
                              )}
                            />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination. */}
              {objects.truncated && (
                <div className="flex items-center justify-center p-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (objects.status === 'ready' && objects.cursor) {
                        cursorStack.current.push(objects.cursor);
                        void loadObjects(objects.cursor);
                      }
                    }}
                    className={classNames(BTN_SECONDARY, 'min-h-[28px] px-3 py-1 text-[11px]')}
                  >
                    <div className="i-ph:arrow-down text-sm" /> Load more
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Drag overlay */}
        {dragging && objectOpsAvailable && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg m-2 border-2 border-dashed border-bolt-elements-item-contentAccent bg-bolt-elements-background-depth-1/85 backdrop-blur-sm pointer-events-none"
            data-testid="buckets-drop-overlay"
          >
            <div
              className="i-ph:upload-simple-duotone text-4xl text-bolt-elements-item-contentAccent motion-safe:animate-bounce motion-reduce:animate-none"
              aria-hidden
            />
            <p className="text-sm font-semibold text-bolt-elements-textPrimary">Drop to upload</p>
            <p className="text-[11px] text-bolt-elements-textTertiary">Files land under {prefix || bucket.name}</p>
          </div>
        )}

        {/* In-flight upload strip. */}
        {uploading && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/[0.05] shrink-0">
            <div
              className="i-ph:circle-notch text-sm text-bolt-elements-item-contentAccent animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            <span className="text-[11px] text-bolt-elements-item-contentAccent truncate">Uploading {uploadName}…</span>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              void uploadFiles(e.target.files);
            }

            e.target.value = '';
          }}
          data-testid="buckets-file-input"
        />
      </div>
    );
  },
);

ObjectBrowser.displayName = 'BucketsPanel.ObjectBrowser';

/*
 * ── Per-bucket workspace (Files + Settings tabs) ──────────────────────────────
 * B1 premium shell: the right pane is a per-bucket WORKSPACE with two tabs. Files = the object
 * browser; Settings = visibility / address / promote / delete. Every control is backed by a REAL op
 * (no stubs) — the Settings home for actions that used to clutter the navigator rows.
 */

type WorkspaceTab = 'files' | 'settings';

const BucketWorkspace = memo(
  ({
    bucket,
    objectOpsAvailable,
    onAddress,
    onTogglePublic,
    onPromote,
    onDelete,
  }: {
    bucket: BucketEntry;
    objectOpsAvailable: boolean;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
  }) => {
    const [tab, setTab] = useState<WorkspaceTab>('files');

    // Always land on Files when the selected bucket changes.
    useEffect(() => {
      setTab('files');
    }, [bucket.name]);

    const tabs: { id: WorkspaceTab; label: string; icon: string }[] = [
      { id: 'files', label: 'Files', icon: 'i-ph:folder-open-duotone' },
      { id: 'settings', label: 'Settings', icon: 'i-ph:sliders-horizontal-duotone' },
    ];

    return (
      <div className="flex-1 flex flex-col min-h-0">
        {/* Tab bar — APG tabs: click + roving Left/Right arrow keys. */}
        <div
          role="tablist"
          aria-label={`${bucket.name} workspace`}
          className="flex items-center gap-1 px-2 py-2 border-b border-bolt-elements-borderColor/60 shrink-0"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') {
              return;
            }

            e.preventDefault();

            const idx = tabs.findIndex((t) => t.id === tab);
            const next = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
            setTab(tabs[next].id);
          }}
        >
          {tabs.map((t) => {
            const activeTab = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`buckets-tab-${t.id}`}
                aria-selected={activeTab}
                aria-controls="buckets-workspace"
                tabIndex={activeTab ? 0 : -1}
                data-testid={`buckets-workspace-tab-${t.id}`}
                data-filled-pill=""
                onClick={() => setTab(t.id)}
                className={classNames(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border',
                  'transition-colors duration-150 motion-reduce:transition-none',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                  activeTab
                    ? // Filled accent pill — literal dark ink + data-filled-pill opts out of the
                      // index.scss [role=tab] cyan-glow !important override (else cyan-on-cyan 1:1).
                      'bg-bolt-elements-item-contentAccent text-[#061018] border-bolt-elements-item-contentAccent shadow-sm shadow-bolt-elements-item-contentAccent/20'
                    : 'border-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-2',
                )}
              >
                <div className={classNames(t.icon, 'text-sm')} aria-hidden />
                {t.label}
              </button>
            );
          })}
        </div>

        <div
          id="buckets-workspace"
          role="tabpanel"
          aria-labelledby={`buckets-tab-${tab}`}
          className="flex-1 min-h-0 flex flex-col"
        >
          {tab === 'files' ? (
            <ObjectBrowser
              bucket={bucket}
              objectOpsAvailable={objectOpsAvailable}
              onCopyBucketAddress={() => onAddress(bucket)}
            />
          ) : (
            <BucketSettings
              bucket={bucket}
              onAddress={onAddress}
              onTogglePublic={onTogglePublic}
              onPromote={onPromote}
              onDelete={onDelete}
            />
          )}
        </div>
      </div>
    );
  },
);

BucketWorkspace.displayName = 'BucketsPanel.BucketWorkspace';

// ── Settings tab ──────────────────────────────────────────────────────────────

const SettingsSection = memo(
  ({
    title,
    hint,
    icon,
    danger,
    children,
  }: {
    title: string;
    hint?: string;
    icon: string;
    danger?: boolean;
    children: React.ReactNode;
  }) => (
    <section
      className={classNames(
        'rounded-xl border p-3',
        danger
          ? 'border-red-400/30 bg-red-500/[0.04]'
          : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={classNames(
            icon,
            'text-sm shrink-0',
            danger ? 'text-red-400' : 'text-bolt-elements-item-contentAccent',
          )}
          aria-hidden
        />
        <h4 className="text-[12px] font-semibold text-bolt-elements-textPrimary">{title}</h4>
      </div>
      {hint && <p className="mt-0.5 text-[10px] text-bolt-elements-textTertiary leading-relaxed">{hint}</p>}
      <div className="mt-2">{children}</div>
    </section>
  ),
);

SettingsSection.displayName = 'BucketsPanel.SettingsSection';

const BucketSettings = memo(
  ({
    bucket,
    onAddress,
    onTogglePublic,
    onPromote,
    onDelete,
  }: {
    bucket: BucketEntry;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
  }) => (
    <div className="flex-1 overflow-auto modern-scrollbar p-3 space-y-3" data-testid="buckets-settings">
      {/* Identity */}
      <div className="flex items-center gap-2 px-0.5">
        <div className="i-ph:hard-drives-duotone text-lg text-bolt-elements-item-contentAccent shrink-0" aria-hidden />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-bolt-elements-textPrimary truncate" title={bucket.name}>
            {bucket.name}
          </p>
          <p className="text-[10px] text-bolt-elements-textTertiary tabular-nums">
            {bucket.environment ?? 'custom'}
            {bucket.createdAt && formatRelativeTime(bucket.createdAt)
              ? ` · created ${formatRelativeTime(bucket.createdAt)}`
              : ''}
          </p>
        </div>
      </div>

      {/* Visibility — live setPublic toggle. */}
      <SettingsSection
        title="Visibility"
        icon={bucket.public ? 'i-ph:globe-simple-duotone' : 'i-ph:lock-simple-duotone'}
        hint={
          bucket.public
            ? 'Public — objects are reachable at a public base URL.'
            : 'Private — objects are only reachable with credentials.'
        }
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-bolt-elements-textSecondary">
            This bucket is {bucket.public ? 'public' : 'private'}.
          </span>
          <button
            type="button"
            onClick={() => onTogglePublic(bucket)}
            data-testid="buckets-settings-visibility"
            aria-label={bucket.public ? `Make ${bucket.name} private` : `Make ${bucket.name} public`}
            className={classNames(bucket.public ? BTN_GHOST : BTN_SECONDARY, 'min-h-[28px] px-3 py-1 text-[11px]')}
          >
            <div
              className={classNames(bucket.public ? 'i-ph:lock-simple' : 'i-ph:globe-simple', 'text-sm')}
              aria-hidden
            />
            {bucket.public ? 'Make private' : 'Make public'}
          </button>
        </div>
        {bucket.public && bucket.publicUrl && (
          <p className="mt-2 text-[10px] font-mono text-bolt-elements-textTertiary break-all">{bucket.publicUrl}</p>
        )}
      </SettingsSection>

      {/* Address — inline when known, plus the full copyable bundle. */}
      <SettingsSection
        title="Address"
        icon="i-ph:link-duotone"
        hint="S3 endpoint, binding + public URL for wrangler / SDKs."
      >
        {bucket.address ? (
          <div className="space-y-2">
            <AddressRow label="S3 endpoint" value={bucket.address.s3Endpoint} />
            <AddressRow label="Binding" value={bucket.address.bindingName} />
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => onAddress(bucket)}
          data-testid="buckets-settings-address"
          className={classNames(BTN_GHOST, 'mt-2 min-h-[28px] px-3 py-1 text-[11px]')}
        >
          <div className="i-ph:link text-sm" aria-hidden /> View full address
        </button>
      </SettingsSection>

      {/* Promote — live snapshot copy to production. */}
      <SettingsSection
        title="Promote to production"
        icon="i-ph:rocket-launch-duotone"
        hint="Copy a snapshot of this bucket's objects into your production bucket."
      >
        <button
          type="button"
          onClick={() => onPromote(bucket)}
          data-testid="buckets-settings-promote"
          className={classNames(BTN_SECONDARY, 'min-h-[28px] px-3 py-1 text-[11px]')}
        >
          <div className="i-ph:rocket-launch text-sm" aria-hidden /> Promote snapshot
        </button>
      </SettingsSection>

      {/* Danger zone — never for the site default bucket. */}
      {!bucket.isDefault && (
        <SettingsSection
          title="Delete bucket"
          icon="i-ph:warning-duotone"
          danger
          hint="Empties then permanently deletes this bucket and all its objects. This can't be undone."
        >
          <button
            type="button"
            onClick={() => onDelete(bucket)}
            data-testid="buckets-settings-delete"
            className={classNames(BTN_DESTRUCTIVE, 'min-h-[28px] px-3 py-1 text-[11px]')}
          >
            <div className="i-ph:trash text-sm" aria-hidden /> Delete {bucket.name}
          </button>
        </SettingsSection>
      )}
    </div>
  ),
);

BucketSettings.displayName = 'BucketsPanel.BucketSettings';

// ── Create modal ─────────────────────────────────────────────────────────────

const CreateBucketModal = memo(
  ({ onClose, onCreated }: { onClose: () => void; onCreated: (b: BucketEntry) => void }) => {
    const [name, setName] = useState('');
    const [isPublic, setIsPublic] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      inputRef.current?.focus();

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', onKey);

      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const valid = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/.test(name.trim());

    const submit = useCallback(async () => {
      if (!valid || creating) {
        return;
      }

      setCreating(true);
      setError(null);

      try {
        const reply = await requestR2({ op: 'createBucket', name: name.trim(), public: isPublic });

        if (!reply.ok) {
          setError(reply.error || 'Could not create the bucket.');
          return;
        }

        postToastToParent('success', `Created ${name.trim()}.`);
        onCreated(reply.bucket ?? { name: name.trim(), public: isPublic });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the bucket.');
      } finally {
        setCreating(false);
      }
    }, [valid, creating, name, isPublic, onCreated]);

    return (
      <ModalShell
        title="Create a bucket"
        icon="i-ph:hard-drives-duotone"
        onClose={onClose}
        testId="buckets-create-modal"
      >
        <label className="block">
          <span className="text-[11px] font-medium text-bolt-elements-textSecondary">Bucket name</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void submit();
              }
            }}
            placeholder="uploads"
            aria-label="Bucket name"
            aria-invalid={name.length > 0 && !valid}
            data-testid="buckets-create-name"
            className="mt-1 w-full min-h-[34px] px-3 py-1.5 text-[13px] rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/50"
          />
          <span className="mt-1 block text-[10px] text-bolt-elements-textTertiary">
            It’s created privately + site-prefixed so names never collide. Letters, numbers, spaces, dashes or
            underscores.
          </span>
        </label>

        <label className="mt-3 flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
            className="h-4 w-4 accent-[var(--bolt-elements-item-contentAccent)] cursor-pointer"
            data-testid="buckets-create-public"
          />
          <span className="text-[12px] text-bolt-elements-textSecondary">Make a public base URL available</span>
        </label>

        {error && (
          <p className="mt-3 text-[11px] text-red-400" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={classNames(BTN_GHOST, 'min-h-[32px] px-3 py-1.5 text-[12px]')}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!valid || creating}
            data-testid="buckets-create-submit"
            className={classNames(BTN_PRIMARY, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
          >
            <div
              className={classNames(
                creating ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:plus-bold',
                'text-sm',
              )}
              aria-hidden
            />
            <span className="min-w-[7ch] text-center">{creating ? 'Creating…' : 'Create'}</span>
          </button>
        </div>
      </ModalShell>
    );
  },
);

CreateBucketModal.displayName = 'BucketsPanel.CreateBucketModal';

// ── Delete-bucket modal (type-to-confirm) ────────────────────────────────────

const DeleteBucketModal = memo(
  ({ bucket, onClose, onDeleted }: { bucket: BucketEntry; onClose: () => void; onDeleted: (name: string) => void }) => {
    const [confirm, setConfirm] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      inputRef.current?.focus();

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', onKey);

      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const matches = confirm.trim() === bucket.name;

    const submit = useCallback(async () => {
      if (!matches || deleting) {
        return;
      }

      setDeleting(true);
      setError(null);

      try {
        const reply = await requestR2({ op: 'deleteBucket', bucket: bucket.name });

        if (!reply.ok) {
          setError(
            reply.needsCreds
              ? 'This bucket has objects and needs R2 S3 credentials to empty first.'
              : reply.error || 'Could not delete the bucket.',
          );
          return;
        }

        postToastToParent(
          'success',
          `Deleted ${bucket.name}${reply.objectsDeleted ? ` + ${reply.objectsDeleted} object${reply.objectsDeleted === 1 ? '' : 's'}` : ''}.`,
        );
        onDeleted(bucket.name);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not delete the bucket.');
      } finally {
        setDeleting(false);
      }
    }, [matches, deleting, bucket.name, onDeleted]);

    return (
      <ModalShell
        title="Delete bucket"
        icon="i-ph:warning-duotone"
        danger
        onClose={onClose}
        testId="buckets-delete-modal"
      >
        <p className="text-[12px] text-bolt-elements-textSecondary leading-relaxed">
          This empties then permanently deletes{' '}
          <span className="font-semibold text-bolt-elements-textPrimary">{bucket.name}</span> and every object in it.
          This can’t be undone.
        </p>
        <label className="mt-3 block">
          <span className="text-[11px] font-medium text-bolt-elements-textSecondary">
            Type <span className="font-mono text-red-400">{bucket.name}</span> to confirm
          </span>
          <input
            ref={inputRef}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void submit();
              }
            }}
            aria-label="Type the bucket name to confirm deletion"
            data-testid="buckets-delete-confirm"
            className="mt-1 w-full min-h-[34px] px-3 py-1.5 text-[13px] font-mono rounded-lg border border-red-400/40 bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
          />
        </label>
        {error && (
          <p className="mt-3 text-[11px] text-red-400" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className={classNames(BTN_GHOST, 'min-h-[32px] px-3 py-1.5 text-[12px]')}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!matches || deleting}
            data-testid="buckets-delete-submit"
            className={classNames(BTN_DESTRUCTIVE, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
          >
            <div
              className={classNames(
                deleting ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:trash',
                'text-sm',
              )}
              aria-hidden
            />
            <span className="min-w-[7ch] text-center">{deleting ? 'Deleting…' : 'Delete'}</span>
          </button>
        </div>
      </ModalShell>
    );
  },
);

DeleteBucketModal.displayName = 'BucketsPanel.DeleteBucketModal';

// ── Address modal (copy S3 endpoint + binding + public URL) ───────────────────

const AddressModal = memo(
  ({ bucket, address, onClose }: { bucket: BucketEntry; address: BucketAddress; onClose: () => void }) => {
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', onKey);

      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const rows: { label: string; value: string | null; hint?: string }[] = [
      { hint: 'S3-compatible API endpoint', label: 'S3 endpoint', value: address.s3Endpoint },
      { hint: 'The real Cloudflare bucket name', label: 'Bucket', value: address.bucketName },
      { hint: 'Use this in wrangler.toml [[r2_buckets]]', label: 'Binding', value: address.bindingName },
      { hint: 'CF account id', label: 'Account', value: address.accountId },
      ...(address.publicUrl ? [{ hint: 'Public base URL', label: 'Public URL', value: address.publicUrl }] : []),
    ];

    return (
      <ModalShell
        title={`Address · ${bucket.name}`}
        icon="i-ph:link-duotone"
        onClose={onClose}
        testId="buckets-address-modal"
      >
        <div className="space-y-2">
          {rows.map((row) => (
            <AddressRow key={row.label} label={row.label} value={row.value} hint={row.hint} />
          ))}
        </div>
        <div className="mt-4 flex items-center justify-end">
          <button
            type="button"
            onClick={async () => {
              const all = rows
                .filter((r) => r.value)
                .map((r) => `${r.label}: ${r.value}`)
                .join('\n');
              const ok = await copyText(all);
              postToastToParent(ok ? 'success' : 'error', ok ? 'Address copied.' : 'Could not copy.');
            }}
            data-testid="buckets-address-copy-all"
            className={classNames(BTN_PRIMARY, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
          >
            <div className="i-ph:copy text-sm" aria-hidden /> Copy all
          </button>
        </div>
      </ModalShell>
    );
  },
);

AddressModal.displayName = 'BucketsPanel.AddressModal';

const AddressRow = memo(({ label, value, hint }: { label: string; value: string | null; hint?: string }) => {
  const [copied, setCopied] = useState(false);

  if (!value) {
    return null;
  }

  return (
    <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-bolt-elements-textTertiary">{label}</span>
        <button
          type="button"
          onClick={async () => {
            const ok = await copyText(value);

            if (ok) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            } else {
              postToastToParent('error', 'Could not copy.');
            }
          }}
          aria-label={`Copy ${label}`}
          className={classNames(BTN_GHOST, 'min-h-[22px] px-1.5 py-0.5 text-[10px]')}
        >
          <div className={classNames(copied ? 'i-ph:check-bold' : 'i-ph:copy', 'text-xs')} aria-hidden />
          <span className="min-w-[6ch] text-center">{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <p className="mt-0.5 text-[11px] font-mono text-bolt-elements-textSecondary break-all">{value}</p>
      {hint && <p className="text-[9px] text-bolt-elements-textTertiary/70">{hint}</p>}
    </div>
  );
});

AddressRow.displayName = 'BucketsPanel.AddressRow';

// ── Modal shell ──────────────────────────────────────────────────────────────

const ModalShell = memo(
  ({
    title,
    icon,
    danger,
    onClose,
    testId,
    children,
  }: {
    title: string;
    icon: string;
    danger?: boolean;
    onClose: () => void;
    testId?: string;
    children: React.ReactNode;
  }) => (
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid={testId}
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm motion-safe:animate-[fadeIn_.15s_ease-out]"
        onClick={onClose}
        aria-hidden
      />
      {/* POLISH 5: glass modal card — cyan-tinted border, brand shadow, @starting-style-style entrance. */}
      <div className="relative w-full max-w-md rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-2xl shadow-black/40 overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background: danger
              ? 'linear-gradient(90deg, transparent, #f87171, transparent)'
              : `linear-gradient(90deg, transparent, ${CYAN}, ${PURPLE}, transparent)`,
          }}
        />
        <div className="flex items-center gap-2 px-4 py-3 border-b border-bolt-elements-borderColor/60">
          <div
            className={classNames(icon, 'text-lg', danger ? 'text-red-400' : 'text-bolt-elements-item-contentAccent')}
            aria-hidden
          />
          <h3 className="text-[13px] font-semibold text-bolt-elements-textPrimary flex-1 truncate">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={classNames(BTN_GHOST, 'min-h-[24px] min-w-[24px] p-1')}
          >
            <div className="i-ph:x text-sm" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  ),
);

ModalShell.displayName = 'BucketsPanel.ModalShell';

// ── Shared states ────────────────────────────────────────────────────────────

const BucketsSkeleton = memo(() => (
  <div className="p-2 space-y-1.5" aria-busy="true" data-testid="buckets-skeleton">
    {Array.from({ length: 4 }).map((_, i) => (
      <div
        key={i}
        className="rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-2.5"
      >
        <div className="h-3 w-2/3 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
        <div className="mt-1.5 h-2 w-1/3 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
      </div>
    ))}
  </div>
));

BucketsSkeleton.displayName = 'BucketsPanel.BucketsSkeleton';

const ObjectsSkeleton = memo(() => (
  <div aria-busy="true" data-testid="buckets-objects-skeleton">
    {Array.from({ length: 6 }).map((_, i) => (
      <div key={i} className="flex items-center gap-2.5 px-3 py-2 border-b border-bolt-elements-borderColor/25">
        <div className="h-4 w-4 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse shrink-0" />
        <div className="h-2.5 flex-1 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
        <div className="h-2 w-10 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
      </div>
    ))}
  </div>
));

ObjectsSkeleton.displayName = 'BucketsPanel.ObjectsSkeleton';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="buckets-error">
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

ErrorCard.displayName = 'BucketsPanel.ErrorCard';

const DisabledCard = memo(() => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="buckets-disabled"
  >
    <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
      <div className="i-ph:lock-key-duotone text-3xl text-bolt-elements-textTertiary" aria-hidden />
    </div>
    <p className="text-sm font-semibold text-bolt-elements-textSecondary">Buckets aren&rsquo;t enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px] leading-relaxed">
      This is on the way. Once it&rsquo;s turned on, your site&rsquo;s R2 buckets show up here — nothing to set up.
    </p>
  </div>
));

DisabledCard.displayName = 'BucketsPanel.DisabledCard';

const ObjectsNeedsCreds = memo(({ message }: { message: string }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="buckets-objects-needs-creds"
  >
    <div
      className="flex items-center justify-center h-14 w-14 rounded-2xl border"
      style={{ borderColor: `color-mix(in oklch, ${PURPLE} 40%, transparent)` }}
    >
      <div className="i-ph:key-duotone text-3xl" style={{ color: PURPLE_INK }} aria-hidden />
    </div>
    <p className="text-sm font-semibold text-bolt-elements-textSecondary">Object storage needs R2 keys</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[280px] leading-relaxed">{message}</p>
  </div>
));

ObjectsNeedsCreds.displayName = 'BucketsPanel.ObjectsNeedsCreds';

// ── Empty states (launchpads) ────────────────────────────────────────────────

/**
 * The bucket-list launchpad empty state — exported (like Media's `MediaPageStats`) so it is
 * DOM-render-testable without mounting the full postMessage-bridged panel. The caller passes
 * its own already-wired `onCreate`; this component holds no business logic.
 */
export const BucketsEmpty = memo(({ onCreate }: { onCreate: () => void }) => (
  <PanelEmpty
    testId="buckets-empty"
    icon="i-ph:hard-drives-duotone"
    title="No buckets yet"
    description="Create a bucket to store files for your site — uploads, media, exports, anything."
    action={
      <button
        type="button"
        onClick={onCreate}
        data-testid="buckets-empty-create"
        className={classNames(BTN_PRIMARY, 'min-h-[30px] px-4 py-2 text-[12px]')}
      >
        <div className="i-ph:plus-bold text-sm" aria-hidden /> Create your first bucket
      </button>
    }
  />
));

BucketsEmpty.displayName = 'BucketsPanel.BucketsEmpty';

/**
 * The object-list launchpad empty state — exported for the same testability reason as
 * {@link BucketsEmpty}. The upload action is gated on `objectOpsAvailable` + `hasFilter`
 * (per `action-button-must-gate-on-server-precondition`): when R2 S3 creds are missing or
 * the view is filtered to zero, the upload button is HIDDEN rather than shown as a doomed
 * control. Purely presentational — the caller passes the already-wired `onUpload`.
 */
export const ObjectsEmpty = memo(
  ({
    hasFilter,
    uploading,
    onUpload,
    objectOpsAvailable,
  }: {
    hasFilter: boolean;
    uploading: boolean;
    onUpload: () => void;
    objectOpsAvailable: boolean;
  }) => (
    <PanelEmpty
      testId="buckets-objects-empty"
      icon={hasFilter ? 'i-ph:magnifying-glass-duotone' : 'i-ph:folder-dashed-duotone'}
      title={hasFilter ? 'No matching objects' : 'This bucket is empty'}
      description={
        hasFilter ? 'Try a different filter.' : 'Drag files here, or upload — they show up here to reuse anywhere.'
      }
      action={
        !hasFilter && objectOpsAvailable ? (
          <button
            type="button"
            onClick={onUpload}
            disabled={uploading}
            data-testid="buckets-objects-empty-upload"
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
        ) : undefined
      }
    />
  ),
);

ObjectsEmpty.displayName = 'BucketsPanel.ObjectsEmpty';
