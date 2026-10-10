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
import * as ContextMenu from '@radix-ui/react-context-menu';
import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader } from './panel';
import { PanelEmpty } from './panel/PanelEmpty';
import { BucketsTwoPane } from './BucketsTwoPane';
import { iconForObject, isImageKey, colorForObject, objectTypeLabel } from './bucket-icons';
import {
  isEmbedded,
  postToastToParent,
  requestBucketClone,
  requestBucketDownload,
  requestBucketOwnerKeyCreate,
  requestBucketOwnerKeyRevoke,
  requestBucketOwnerKeyRotate,
  requestBucketOwnerKeyStatus,
  requestBucketUpload,
  requestBucketZip,
  requestObjectPublic,
  requestOwnerKeyCreate,
  requestOwnerKeyRevoke,
  requestOwnerKeyRotate,
  requestOwnerKeyStatus,
  requestR2,
  requestR2Copy,
  type BucketAddress,
  type BucketEntry,
  type BucketObjectEntry,
  type OwnerKeyStatus,
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
  // A subtle top-lit gradient (not a flat fill) + inner highlight ring read as a premium, dimensional
  // primary — the Linear/Stripe "pressable" look. Transform-only hover lift keeps it 0-CLS.
  'bg-[linear-gradient(180deg,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_100%,white_14%),var(--bolt-elements-item-contentAccent))]',
  'text-[#04121a] font-semibold ring-1 ring-inset ring-white/15',
  'shadow-[0_1px_0_rgba(255,255,255,0.22)_inset,0_2px_8px_-2px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_55%,transparent)]',
  'enabled:hover:shadow-[0_1px_0_rgba(255,255,255,0.28)_inset,0_6px_18px_-4px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_70%,transparent)]',
  'enabled:hover:brightness-[1.06] motion-safe:enabled:hover:-translate-y-px',
  'enabled:active:translate-y-0 enabled:active:brightness-95 focus-visible:ring-bolt-elements-item-contentAccent',
);
const BTN_SECONDARY = classNames(
  CTRL_BASE,
  'border border-bolt-elements-item-contentAccent/35 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_6%,transparent)]',
  'text-bolt-elements-item-contentAccent',
  'enabled:hover:bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_14%,transparent)] enabled:hover:border-bolt-elements-item-contentAccent/60',
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

/*
 * ── Cinematic object-browser entrance (B5 slice 4 — "gorgeous + ANIMATED") ─────────────────────────
 * A restrained, Linear/Stripe-grade entrance for object rows + tiles: a transform-only
 * opacity + translateY rise, STAGGERED per index so the browser "assembles" on open and on every
 * list⇄grid flip. Transform-only ⇒ ZERO CLS (never animate width/height/top/left). The keyframe
 * (`psBucketRise`) is injected ONCE via {@link BucketAnimationStyles} (self-contained — no global
 * CSS file edit). Motion is `motion-safe:`-gated AND carries a `motion-reduce:` opt-out, so a user
 * with `prefers-reduced-motion: reduce` gets the final frame instantly with NO motion (WCAG 2.3.3).
 */
/*
 * The entrance keyframe + a transform-only transition (powers the spring select-scale + hover lift);
 * both halves are motion-reduce-safe so reduced-motion users get the final frame with no motion.
 */
export const OBJECT_ENTRANCE_CLASS =
  'motion-safe:animate-[psBucketRise_.38s_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none ' +
  'transition-[transform,box-shadow,background-color,border-color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ' +
  'motion-reduce:transition-none will-change-transform';

/** The per-row stagger — a SMALL 24ms step, CAPPED at 384ms so a 1,000-object bucket never stalls. */
export function objectEntranceStyle(index: number): React.CSSProperties {
  const delay = Math.min(index, 16) * 24;
  return { animationDelay: `${delay}ms` };
}

/*
 * ── Grid-tile craft tokens (the signature element) ─────────────────────────────
 * The object GRID is the surface a user screenshots, so its thumbnail slot + hover are the money
 * shot. These two class strings are the ONE source of truth consumed by BOTH the live grid tile
 * (here) AND the `/_preview` gallery (so the headless screenshot is the faithful pixel-proof).
 *
 * Why each piece earns its place:
 *   • A richer OKLCH thumbnail SLOT — a top-anchored accent radial over a depth-1→accent vertical
 *     blend, PLUS a soft floor vignette (bottom-anchored) so the slot reads as a lit recess, not a
 *     flat panel. A crisp DOUBLE inset ring (a hairline border token + a 1px white top-edge inset
 *     shadow) gives the recess a machined lip.
 *   • A more satisfying tile HOVER — a transform-only lift (0 CLS) + a shadow BLOOM + a subtle
 *     accent border-GLOW painted with `color-mix` (NEVER the forbidden `/[opacity]` on the hex
 *     contentAccent var). The glow is a box-shadow ring, so it never shifts layout.
 */
export const TILE_THUMB_SLOT_CLASS =
  'relative flex aspect-square items-center justify-center overflow-hidden rounded-lg ' +
  'bg-[radial-gradient(130%_85%_at_50%_0%,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_9%,transparent),transparent_58%),' +
  'radial-gradient(90%_70%_at_50%_118%,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_6%,transparent),transparent_52%),' +
  'linear-gradient(180deg,var(--bolt-elements-bg-depth-1),color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_4%,var(--bolt-elements-bg-depth-1)))] ' +
  'ring-1 ring-inset ring-bolt-elements-borderColor/45 ' +
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.045),inset_0_-16px_28px_-24px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_40%,transparent)]';

/** The resting (unselected) object-tile shell — a hairline card that blooms a shadow + accent border-glow on hover. */
export const TILE_SHELL_RESTING_CLASS =
  'border-bolt-elements-borderColor/70 bg-bolt-elements-background-depth-2 ' +
  'hover:border-bolt-elements-item-contentAccent/50 hover:bg-bolt-elements-background-depth-3 ' +
  'hover:shadow-[0_12px_30px_-12px_rgba(0,0,0,0.7),0_0_0_1px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_26%,transparent),0_0_22px_-10px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_55%,transparent)] ' +
  'motion-safe:hover:-translate-y-1';

/*
 * ── Empty-state launchpad craft (className passthrough on PanelEmpty) ──────────
 * Keeps PanelEmpty as the single empty-state primitive (no fork) while making the Buckets launchpads
 * more CINEMATIC via its `className` slot:
 *   • a whisper radial AURA behind the whole launchpad (centered accent bloom — reads as a lit stage),
 *   • a soft concentric GLOW ring + a motion-safe one-shot float-in on the icon badge (targeted through
 *     a child selector so PanelEmpty itself is untouched; `motion-reduce:` opts out → WCAG 2.3.3),
 *   • `text-wrap:balance` on the headline and `pretty` on the helper so short copy never widows,
 *   • a gently FLUID headline via `clamp()` so the title scales with the (variable-width) editor pane.
 * All decorative layers are painted with box-shadow / background (0 CLS); none are hard-coded brand hex
 * (OKLCH color-mix off the accent token) — so the aura passes the brand audit + stays AA-safe.
 */
export const EMPTY_LAUNCHPAD_CLASS = classNames(
  'relative isolate overflow-hidden',
  // Radial stage aura — behind everything (`-z-10`), decorative, never intercepts a click.
  "before:pointer-events-none before:absolute before:inset-0 before:-z-10 before:content-['']",
  'before:bg-[radial-gradient(60%_42%_at_50%_34%,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_8%,transparent),transparent_70%)]',
  // Icon badge (PanelEmpty's first child div) — add a concentric accent glow + a one-shot float-in.
  '[&>div:first-child]:shadow-[0_0_0_1px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_18%,transparent),0_12px_40px_-12px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_50%,transparent)]',
  'motion-safe:[&>div:first-child]:animate-[psBucketRise_.5s_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:[&>div:first-child]:animate-none',
  // Headline fluid + balanced; helper set pretty so the last line never widows.
  '[&_p]:text-balance [&>div>p:first-child]:text-[clamp(0.95rem,0.86rem+0.5vw,1.2rem)] [&>div>p:last-child]:[text-wrap:pretty]',
);

/**
 * Injects the single `psBucketRise` keyframe (opacity 0→1 + a 6px translateY rise) exactly once per
 * document. Rendered at the top of the panel; harmless if duplicated (same id, idempotent text). The
 * keyframe itself has no media guard — the `motion-reduce:animate-none` utility on each element is
 * what honors `prefers-reduced-motion`, so the SAME class works in the panel and the `/_preview` gallery.
 */
export const BucketAnimationStyles = memo(() => (
  <style
    data-testid="buckets-animation-styles"
    dangerouslySetInnerHTML={{
      __html:
        '@keyframes psBucketRise{from{opacity:0;transform:translateY(7px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}',
    }}
  />
));

BucketAnimationStyles.displayName = 'BucketsPanel.BucketAnimationStyles';

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

/*
 * `iconForObject` (distinct per-type Phosphor duotone glyph) + `isImageKey` live in the pure,
 * dependency-free `./bucket-icons` module (fire-B5) so the `/_preview` gallery + the Vitest suite can
 * consume the SAME map without this bridge-coupled component. Re-exported here so existing importers
 * (`import { iconForObject, isImageKey } from './BucketsPanel'`) keep resolving.
 */
export { iconForObject, isImageKey } from './bucket-icons';

// ── In-editor object preview (B12) ─────────────────────────────────────────────

/**
 * How a bucket object should be PREVIEWED in-editor (B12). Drives {@link ObjectPreviewModal}: images
 * render as inert `<img>`, media as inert `<video>`/`<audio>`, pdf inside a SANDBOXED iframe (no
 * `allow-scripts`), text/code ESCAPED in a `<pre>`, and anything else → a graceful download fallback.
 * A pure function (no React / no bridge) so the Vitest suite + the `/_preview` gallery share one SSOT.
 */
export type PreviewKind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'none';

/** Extensions rendered as ESCAPED text in a `<pre>` (never executed, never `dangerouslySetInnerHTML`). */
const TEXT_PREVIEW_RE = /\.(txt|md|markdown|mdx|json|jsonc|csv|tsv|log|ts|tsx|js|mjs|cjs|jsx|css|scss|html?|xml|ya?ml|toml)$/i;
const VIDEO_PREVIEW_RE = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO_PREVIEW_RE = /\.(mp3|wav|ogg|m4a|flac|aac|opus)$/i;

/**
 * Classify an object for the in-editor preview by its key (extension) with an optional content-type
 * hint. Extension wins for the escaped-text families (so a `text/html` key still renders as inert,
 * escaped source — never as a live document); `application/pdf` or a `.pdf` key → the sandboxed
 * iframe. Unknown → `'none'` (the download-only fallback — never a doomed control).
 *
 * @param key - The object key (e.g. `report.pdf`, `images/hero.webp`).
 * @param contentType - Optional MIME hint from the download bridge.
 * @returns The {@link PreviewKind} to render.
 */
export function classifyPreview(key: string, contentType?: string | null): PreviewKind {
  if (isImageKey(key)) {
    return 'image';
  }

  if (/\.pdf$/i.test(key) || contentType === 'application/pdf') {
    return 'pdf';
  }

  // Text/code BEFORE the generic MIME sniff so `.html`/`.xml` render as escaped source, not a doc.
  if (TEXT_PREVIEW_RE.test(key)) {
    return 'text';
  }

  if (VIDEO_PREVIEW_RE.test(key)) {
    return 'video';
  }

  if (AUDIO_PREVIEW_RE.test(key)) {
    return 'audio';
  }

  // Content-type fallbacks for extension-less keys.
  if (contentType) {
    if (contentType.startsWith('image/')) {
      return 'image';
    }

    if (contentType.startsWith('video/')) {
      return 'video';
    }

    if (contentType.startsWith('audio/')) {
      return 'audio';
    }

    if (contentType.startsWith('text/') || /\b(json|xml|javascript|csv|yaml)\b/.test(contentType)) {
      return 'text';
    }
  }

  return 'none';
}

/** True when an object can be previewed in-editor at all (anything but `'none'`). */
export function isPreviewable(key: string, contentType?: string | null): boolean {
  return classifyPreview(key, contentType) !== 'none';
}

/**
 * Decode a base64 `data:` URL into a Blob so untrusted bytes are rendered from an OPAQUE blob: URL
 * (not the inline data: URL). Returns `null` if the string isn't a decodable data URL.
 */
function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);

  if (!match) {
    return null;
  }

  const mime = match[1] || 'application/octet-stream';
  const isBase64 = !!match[2];
  const data = match[3];

  try {
    if (isBase64) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      return new Blob([bytes], { type: mime });
    }

    return new Blob([decodeURIComponent(data)], { type: mime });
  } catch {
    return null;
  }
}

/** Decode the TEXT body of a base64 data URL to a string (for the escaped `<pre>` text preview). */
function dataUrlToText(dataUrl: string): string {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);

  if (!match) {
    return '';
  }

  const isBase64 = !!match[2];
  const data = match[3];

  try {
    if (isBase64) {
      const binary = atob(data);

      // Decode as UTF-8 (atob yields a Latin-1 byte string).
      const bytes = new Uint8Array(binary.length);

      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      return new TextDecoder().decode(bytes);
    }

    return decodeURIComponent(data);
  } catch {
    return '';
  }
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
  // B11 — a whole-bucket server search is in flight (distinct from the plain page load so the UI can say
  // "searching all objects…" instead of the generic skeleton).
  | { status: 'searching' }
  | { status: 'needs-creds'; message: string }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      objects: BucketObjectEntry[];
      prefixes: string[];
      cursor?: string;
      truncated: boolean;
      /**
       * B11 search mode: when these are present the `ready` list is the result of a whole-bucket SERVER
       * search (not a page). `scannedAll=false` ⇒ the scan stopped short of the bucket's end;
       * `truncated=true` ⇒ more matches than the result cap. The UI renders an HONEST note from them.
       */
      search?: string;
      scannedAll?: boolean;
      scanned?: number;
    };

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

  // Clone-bucket dialog (B6) — opened from a bucket row's actions menu (Settings has its own section).
  const [cloneTarget, setCloneTarget] = useState<BucketEntry | null>(null);

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

  // B6 — after a successful clone, refresh the inventory and jump the selection to the new bucket so the
  // owner immediately sees the copy they just made (embarrassingly-easy: the result is right there).
  const onCloned = useCallback(
    (newBucket: BucketEntry | null) => {
      if (newBucket?.name) {
        setSelectedBucket(newBucket.name);
      }
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
      {/* Inject the one `psBucketRise` keyframe the cinematic object-browser entrance rides on. */}
      <BucketAnimationStyles />
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
                  onClone={setCloneTarget}
                />
              ))}
          </>
        }
        right={
          selectedBucket && buckets.status === 'ready' ? (
            <BucketWorkspace
              bucket={buckets.buckets.find((b) => b.name === selectedBucket) ?? { name: selectedBucket }}
              allBuckets={buckets.buckets.map((b) => b.name)}
              objectOpsAvailable={objectOpsAvailable}
              onAddress={openAddress}
              onTogglePublic={onTogglePublic}
              onPromote={onPromote}
              onDelete={setDeleteTarget}
              onCloned={onCloned}
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
      {cloneTarget && (
        <CloneBucketModal
          bucket={cloneTarget}
          onClose={() => setCloneTarget(null)}
          onCloned={(b) => {
            setCloneTarget(null);
            onCloned(b);
          }}
        />
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
    const [showShortcuts, setShowShortcuts] = useState(false);

    return (
      <>
        <PanelHeader
          icon="i-ph:hard-drives-duotone"
          title="Buckets"
          subtitle={
            count > 0 ? (
              <span className="tabular-nums">
                <span className="text-bolt-elements-textSecondary font-medium">{count}</span> bucket
                {count === 1 ? '' : 's'}
                {!objectOpsAvailable && (
                  <span className="text-bolt-elements-textTertiary"> · file uploads coming soon</span>
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
              {!createDisabled && (
                <button
                  type="button"
                  onClick={() => setShowShortcuts(true)}
                  data-testid="buckets-shortcuts-trigger"
                  aria-label="Keyboard shortcuts & tips"
                  title="Keyboard shortcuts & tips"
                  className={classNames(BTN_GHOST, 'min-h-[26px] min-w-[26px] px-1.5 py-1')}
                >
                  <div className="i-ph:keyboard text-sm" aria-hidden />
                </button>
              )}
              {/* Live affordance — the inventory self-updates on a visibility-aware poll; no manual
                Refresh (per `real-time-data-no-manual-refresh`). */}
              <span
                className="hidden sm:inline-flex items-center gap-1.5 text-[10px] text-bolt-elements-textSecondary select-none"
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
        {showShortcuts && <ShortcutsSheet onClose={() => setShowShortcuts(false)} />}
      </>
    );
  },
);

BucketsHeader.displayName = 'BucketsPanel.Header';

/*
 * ── Shortcuts & tips sheet (B3) ───────────────────────────────────────────────
 * A discoverable help affordance ("?" in the header) now that the panel has keyboard nav (B14),
 * a row actions menu (B3) and a list/grid toggle (B1-polish). Reuses the ModalShell primitive.
 */

const SHORTCUT_GROUPS: { title: string; items: { keys: string; label: string }[] }[] = [
  {
    title: 'Navigate buckets',
    items: [
      { keys: '↑ ↓', label: 'Move between buckets' },
      { keys: 'Home / End', label: 'First / last bucket' },
      { keys: 'Enter', label: 'Open the selected bucket' },
    ],
  },
  {
    title: 'Bucket actions',
    items: [{ keys: '⋯ / right-click', label: 'Address · visibility · promote · delete' }],
  },
  {
    title: 'Files',
    items: [
      { keys: 'List / Grid', label: 'Toggle the object view' },
      { keys: 'Drag & drop', label: 'Upload files to the bucket' },
    ],
  },
  { title: 'General', items: [{ keys: 'Esc', label: 'Close a menu or dialog' }] },
];

const ShortcutsSheet = memo(({ onClose }: { onClose: () => void }) => (
  <ModalShell title="Shortcuts & tips" icon="i-ph:keyboard-duotone" onClose={onClose} testId="buckets-shortcuts-sheet">
    <div className="space-y-3">
      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-bolt-elements-textTertiary">
            {group.title}
          </p>
          <ul className="space-y-1">
            {group.items.map((item) => (
              <li key={item.label} className="flex items-center justify-between gap-3">
                <span className="text-[12px] text-bolt-elements-textSecondary">{item.label}</span>
                <kbd className="shrink-0 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-1.5 py-0.5 font-mono text-[10px] text-bolt-elements-textTertiary">
                  {item.keys}
                </kbd>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  </ModalShell>
));

ShortcutsSheet.displayName = 'BucketsPanel.ShortcutsSheet';

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
    onClone,
  }: {
    buckets: BucketEntry[];
    selected: string | null;
    onSelect: (name: string) => void;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
    onClone: (b: BucketEntry) => void;
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
                <span className="text-[9px] font-semibold uppercase tracking-[0.1em] text-bolt-elements-textTertiary">
                  {group.label}
                </span>
                {items.length > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[16px] h-[15px] px-1 rounded-full bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_10%,transparent)] text-[9px] font-semibold text-bolt-elements-item-contentAccent/90 tabular-nums">
                    {items.length}
                  </span>
                )}
                <div
                  className="flex-1 h-px ml-1 bg-[linear-gradient(90deg,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_22%,var(--bolt-elements-borderColor)),transparent)]"
                  aria-hidden
                />
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
                      onClone={onClone}
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
    onClone,
  }: {
    bucket: BucketEntry;
    active: boolean;
    tabbable: boolean;
    onSelect: (name: string) => void;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
    onClone: (b: BucketEntry) => void;
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
        'group relative rounded-xl border p-2.5 overflow-hidden transition-[transform,border-color,background-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
        active
          ? // Selected: a left-to-right accent gradient fill + a restrained outer glow make the active
            // bucket read instantly without shouting (the rail span below anchors the edge).
            'border-bolt-elements-item-contentAccent/70 bg-[linear-gradient(90deg,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_16%,transparent),color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)_60%,transparent)] shadow-[0_0_0_1px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_18%,transparent),0_4px_14px_-6px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_45%,transparent)]'
          : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 hover:border-bolt-elements-item-contentAccent/40 hover:bg-bolt-elements-background-depth-3 hover:shadow-[0_3px_12px_-6px_rgba(0,0,0,0.5)] motion-safe:hover:-translate-y-px',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-bolt-elements-item-contentAccent shadow-[0_0_8px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_60%,transparent)]"
        />
      )}
      <div className="flex items-center gap-2 min-w-0">
        <div
          className={classNames(
            'i-ph:hard-drives-duotone text-base shrink-0 transition-[transform,color] duration-200 motion-reduce:transition-none',
            active
              ? 'text-bolt-elements-item-contentAccent motion-safe:scale-110'
              : 'text-bolt-elements-textTertiary group-hover:text-bolt-elements-item-contentAccent motion-safe:group-hover:scale-105',
          )}
          aria-hidden
        />
        <span className="text-[12px] font-medium text-bolt-elements-textPrimary truncate flex-1" title={bucket.name}>
          {bucket.name}
        </span>
        {bucket.isDefault && (
          <span
            className="inline-flex items-center gap-0.5 rounded-md border px-1 py-px text-[8px] font-semibold uppercase tracking-wide shrink-0"
            style={{
              borderColor: `color-mix(in oklch, ${CYAN} 45%, transparent)`,
              color: CYAN,
              background: `color-mix(in oklch, ${CYAN} 10%, transparent)`,
            }}
            title="The site's default bucket"
          >
            <span className="i-ph:star-fill text-[7px]" aria-hidden />
            Default
          </span>
        )}
        <BucketRowMenu
          bucket={bucket}
          onAddress={onAddress}
          onTogglePublic={onTogglePublic}
          onPromote={onPromote}
          onDelete={onDelete}
          onClone={onClone}
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
  'text-bolt-elements-textSecondary data-[highlighted]:bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_12%,transparent)] ' +
  'data-[highlighted]:text-bolt-elements-item-contentAccent';

const BucketRowMenu = memo(
  ({
    bucket,
    onAddress,
    onTogglePublic,
    onPromote,
    onDelete,
    onClone,
  }: {
    bucket: BucketEntry;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
    onClone: (b: BucketEntry) => void;
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
          <DropdownMenu.Item
            className={BUCKET_MENU_ITEM}
            data-testid="buckets-row-menu-clone"
            onSelect={() => onClone(bucket)}
          >
            <div className="i-ph:copy text-sm" aria-hidden /> Clone bucket…
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

/*
 * ── Object selection logic (B3 — keyboard multi-select) ───────────────────────
 * Pure, dependency-free helpers for the keyboard + range selection so the Vitest suite can assert
 * the EXACT set math without mounting the bridge-coupled panel. The browser wires these straight to
 * the existing `setSelected` Set (checkbox selection keeps working unchanged).
 */

/** Every loaded (shown) object key — what `Cmd/Ctrl+A` selects. */
export function selectAllKeys(shown: ReadonlyArray<{ key: string }>): Set<string> {
  return new Set(shown.map((o) => o.key));
}

/**
 * The keys in the INCLUSIVE index range between an anchor and a target (order-independent) — what a
 * `Shift+click` selects. Out-of-bounds / missing anchor → just the target's key (graceful, never a
 * doomed no-op). Returns an empty set when the target index itself is invalid.
 */
export function rangeKeys(shown: ReadonlyArray<{ key: string }>, anchor: number, target: number): Set<string> {
  if (target < 0 || target >= shown.length) {
    return new Set();
  }

  if (anchor < 0 || anchor >= shown.length) {
    return new Set([shown[target].key]);
  }

  const lo = Math.min(anchor, target);
  const hi = Math.max(anchor, target);
  const out = new Set<string>();

  for (let i = lo; i <= hi; i++) {
    out.add(shown[i].key);
  }

  return out;
}

/** Union the current selection with a range (Shift+click EXTENDS, it never replaces). */
export function extendSelection(current: ReadonlySet<string>, add: ReadonlySet<string>): Set<string> {
  const next = new Set(current);

  for (const k of add) {
    next.add(k);
  }

  return next;
}

/*
 * ── Object copy/move/rename key math (B8) ─────────────────────────────────────
 * Pure, mountless helpers so the Vitest suite asserts the EXACT destination-key derivation (and the
 * collision guard) without the bridge. The dialogs call these to turn a user's typed name / folder into
 * the full destination key the `requestR2Copy` bridge sends.
 */

/** The parent "folder" prefix of a key (everything up to + including the last `/`, or '' at the root). */
export function objectParentPrefix(key: string): string {
  const i = key.lastIndexOf('/');

  return i < 0 ? '' : key.slice(0, i + 1);
}

/** The basename of a key (the segment after the last `/`). */
export function objectBaseName(key: string): string {
  const i = key.lastIndexOf('/');

  return i < 0 ? key : key.slice(i + 1);
}

/** The destination key for a RENAME: the SAME parent folder, a new basename. Blank name → null. */
export function renameDestKey(srcKey: string, newName: string): string | null {
  const name = newName.trim();

  if (!name || name.includes('/')) {
    return null; // a rename changes the name only — a `/` would move it (use Move instead)
  }

  return objectParentPrefix(srcKey) + name;
}

/** The destination key for a MOVE: a new folder prefix + the SAME basename. A blank prefix = root. */
export function moveDestKey(srcKey: string, folder: string): string {
  const clean = folder.trim().replace(/^\/+/, ''); // never leading-slash; '' means the bucket root
  const prefix = clean === '' || clean.endsWith('/') ? clean : `${clean}/`;

  return prefix + objectBaseName(srcKey);
}

/*
 * ── Object row/tile context menu (B3) ─────────────────────────────────────────
 * A Radix ContextMenu wrapping each object row/tile — exposes the SAME four ops the hover buttons do
 * (Preview · Copy URL · Download · Delete), reusing the EXACT handlers. Radix gives us right-click +
 * keyboard (the browser's context-menu key / Shift+F10), roles (`menu`/`menuitem`), Escape-to-close,
 * and focus return for free. On touch there's no right-click, so the always-present ⋯ hover buttons
 * remain the touch affordance — this menu is the pointer/keyboard power path, never the only path.
 * The trigger is the row/tile itself (`asChild`), so a two-finger / right click anywhere on it opens.
 */

const OBJECT_MENU_CONTENT =
  'z-[100001] min-w-[180px] rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 ' +
  'p-1 shadow-2xl shadow-black/40 motion-safe:animate-[fadeIn_.12s_ease-out]';
const OBJECT_MENU_ITEM =
  'flex items-center gap-2 px-2.5 py-1.5 text-[11px] rounded-lg cursor-pointer select-none outline-none ' +
  'text-bolt-elements-textSecondary data-[highlighted]:bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_12%,transparent)] ' +
  'data-[highlighted]:text-bolt-elements-item-contentAccent data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed';

/**
 * Right-click (and keyboard) context menu for a single object. Wraps its row/tile as the trigger and
 * fires the existing object handlers. `name` is the display label (prefix-stripped key).
 */
export const ObjectActionMenu = memo(
  ({
    objectKey,
    name,
    canPreview,
    children,
    onPreview,
    onCopyUrl,
    onDownload,
    onRename,
    onCopy,
    onMove,
    onShare,
    onRevokeShare,
    onDelete,
  }: {
    objectKey: string;
    name: string;
    canPreview: boolean;
    children: React.ReactNode;
    onPreview: (key: string) => void;
    onCopyUrl: (key: string) => void;
    onDownload: (key: string) => void;
    /** B8 — rename this object (copy to a new name in-place + delete the source). */
    onRename?: (key: string) => void;
    /** B8 — duplicate this object to a new name (copy, source kept). */
    onCopy?: (key: string) => void;
    /** B8 — move this object to another folder/prefix (copy + delete the source). */
    onMove?: (key: string) => void;
    /** B9 — share this ONE file via a public, revoke-safe link (copies the link). */
    onShare?: (key: string) => void;
    /** B9 — stop sharing this file (the public link dies immediately). */
    onRevokeShare?: (key: string) => void;
    onDelete: (key: string) => void;
  }) => (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={OBJECT_MENU_CONTENT}
          data-testid="buckets-object-context-menu"
          aria-label={`Actions for ${name}`}
        >
          {canPreview && (
            <ContextMenu.Item
              className={OBJECT_MENU_ITEM}
              data-testid="buckets-object-context-preview"
              onSelect={() => onPreview(objectKey)}
            >
              <div className="i-ph:eye text-sm" aria-hidden /> Preview
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className={OBJECT_MENU_ITEM}
            data-testid="buckets-object-context-copy"
            onSelect={() => onCopyUrl(objectKey)}
          >
            <div className="i-ph:link text-sm" aria-hidden /> Copy URL
          </ContextMenu.Item>
          <ContextMenu.Item
            className={OBJECT_MENU_ITEM}
            data-testid="buckets-object-context-download"
            onSelect={() => onDownload(objectKey)}
          >
            <div className="i-ph:download-simple text-sm" aria-hidden /> Download
          </ContextMenu.Item>
          {(onRename || onCopy || onMove) && (
            <ContextMenu.Separator className="my-1 h-px bg-bolt-elements-borderColor/60" />
          )}
          {onRename && (
            <ContextMenu.Item
              className={OBJECT_MENU_ITEM}
              data-testid="buckets-object-context-rename"
              onSelect={() => onRename(objectKey)}
            >
              <div className="i-ph:textbox text-sm" aria-hidden /> Rename…
            </ContextMenu.Item>
          )}
          {onCopy && (
            <ContextMenu.Item
              className={OBJECT_MENU_ITEM}
              data-testid="buckets-object-context-duplicate"
              onSelect={() => onCopy(objectKey)}
            >
              <div className="i-ph:copy text-sm" aria-hidden /> Copy to…
            </ContextMenu.Item>
          )}
          {onMove && (
            <ContextMenu.Item
              className={OBJECT_MENU_ITEM}
              data-testid="buckets-object-context-move"
              onSelect={() => onMove(objectKey)}
            >
              <div className="i-ph:folder-open text-sm" aria-hidden /> Move to…
            </ContextMenu.Item>
          )}
          {(onShare || onRevokeShare) && (
            <ContextMenu.Separator className="my-1 h-px bg-bolt-elements-borderColor/60" />
          )}
          {onShare && (
            <ContextMenu.Item
              className={OBJECT_MENU_ITEM}
              data-testid="buckets-object-context-share"
              onSelect={() => onShare(objectKey)}
            >
              <div className="i-ph:link-simple-horizontal text-sm" aria-hidden /> Share publicly &amp; copy link
            </ContextMenu.Item>
          )}
          {onRevokeShare && (
            <ContextMenu.Item
              className={OBJECT_MENU_ITEM}
              data-testid="buckets-object-context-revoke-share"
              onSelect={() => onRevokeShare(objectKey)}
            >
              <div className="i-ph:link-break text-sm" aria-hidden /> Stop sharing
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-bolt-elements-borderColor/60" />
          <ContextMenu.Item
            className={classNames(
              OBJECT_MENU_ITEM,
              'text-red-400 data-[highlighted]:bg-red-500/15 data-[highlighted]:text-red-300',
            )}
            data-testid="buckets-object-context-delete"
            onSelect={() => onDelete(objectKey)}
          >
            <div className="i-ph:trash text-sm" aria-hidden /> Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  ),
);

ObjectActionMenu.displayName = 'BucketsPanel.ObjectActionMenu';

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

export const ObjectBrowser = memo(
  ({
    bucket,
    allBuckets,
    objectOpsAvailable,
    onCopyBucketAddress,
  }: {
    bucket: BucketEntry;
    /** All of the site's bucket display names — the cross-bucket copy/move destinations. */
    allBuckets?: readonly string[];
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
    // B12 — the object key whose in-editor preview is open (null = no preview).
    const [previewKey, setPreviewKey] = useState<string | null>(null);
    // B8 — the active copy/move/rename dialog (null = none). `mode` picks the dialog + the op.
    const [objectOp, setObjectOp] = useState<{ mode: 'rename' | 'copy' | 'move'; key: string } | null>(null);
    const dragDepth = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const cursorStack = useRef<string[]>([]);
    // B3 — the anchor index for Shift-click range selection (the last row/tile the user clicked).
    const rangeAnchor = useRef<number | null>(null);
    // Whether Shift was held at pointer-down (captured there so the `onChange` toggle can read it —
    // `change` events don't carry modifier keys). Reset after each toggle.
    const shiftHeld = useRef(false);

    /** Load one page of objects for the current bucket + prefix (+ optional cursor). */
    const loadObjects = useCallback(
      async (cursor?: string) => {
        if (!objectOpsAvailable) {
          setObjects({
            status: 'needs-creds',
            message:
              'Uploading and browsing the files inside your buckets is being enabled for your site — nothing to set up on your end. You can still create and manage buckets.',
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
              setObjects({
                status: 'needs-creds',
                message: 'Uploading and browsing files is being enabled for your site.',
              });
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

    /**
     * B11 — SERVER-SIDE whole-bucket search. Unlike {@link loadObjects} (one page, folder view), this
     * asks the worker to scan the ENTIRE bucket for keys that CONTAIN `term` (bounded; honest limits).
     * It narrows with the current `prefix` and reports `scannedAll`/`scanned` so the UI never over-claims
     * completeness. Only called for a non-empty term (the empty case falls back to {@link loadObjects}).
     */
    const searchObjects = useCallback(
      async (term: string) => {
        if (!objectOpsAvailable) {
          return;
        }

        setObjects({ status: 'searching' });

        try {
          const reply = await requestR2({
            op: 'listObjects',
            bucket: bucket.name,
            prefix: prefix || undefined,
            search: term,
          });

          if (!reply.ok) {
            if (reply.needsCreds) {
              setObjects({ status: 'needs-creds', message: 'Uploading and browsing files is being enabled for your site.' });
              return;
            }
            if (reply.enabled === false) {
              setObjects({ status: 'error', message: 'Buckets are not enabled.' });
              return;
            }
            setObjects({ status: 'error', message: reply.error || 'Could not search objects.' });
            return;
          }

          setObjects({
            status: 'ready',
            objects: reply.objects ?? [],
            prefixes: [], // a whole-bucket search is flat — no folder rows
            scanned: reply.scanned,
            scannedAll: reply.scannedAll,
            search: term,
            truncated: !!reply.truncated,
          });
        } catch (err) {
          setObjects({ status: 'error', message: err instanceof Error ? err.message : 'Could not search objects.' });
        }
      },
      [bucket.name, prefix, objectOpsAvailable],
    );

    // Reload when the bucket or prefix changes (reset selection + pagination). Skipped while a search is
    // active — the search effect below owns the fetch so a prefix-driven reload never clobbers results.
    const searchActive = search.trim().length > 0;
    useEffect(() => {
      if (searchActive) {
        return;
      }
      cursorStack.current = [];
      setSelected(new Set());
      void loadObjects();
    }, [loadObjects, searchActive]);

    /**
     * B11 — debounce the search box. A non-empty term (after ~280ms of quiet) issues ONE server search
     * across the whole bucket; clearing the term falls back to the plain page listing. The debounce
     * coalesces keystrokes into a single request (never one per character).
     */
    useEffect(() => {
      const term = search.trim();
      if (!term) {
        return; // the non-search effect above re-loads the plain listing when `searchActive` flips false
      }
      setSelected(new Set());
      const t = setTimeout(() => {
        void searchObjects(term);
      }, 280);
      return () => clearTimeout(t);
    }, [search, searchObjects]);

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

    /** Download an object → save via a temporary anchor. (Declared before `bulkDownload` uses it.) */
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

    /*
     * B9 — share ONE file via a public, revoke-safe link. R2 has no per-object public ACL, so the bridge
     * flips the object public server-side (mints an unguessable share slug) and hands back a link served
     * by the public gateway. We copy the link to the clipboard immediately so the owner can paste it — one
     * obvious action, zero config. An honest toast names what happened ("link copied — anyone with it can
     * view this one file"). On a needs-creds / disabled reply we degrade to a clear warning, never a crash.
     */
    const shareObject = useCallback(
      async (key: string) => {
        setBusyKey(key);
        try {
          const reply = await requestObjectPublic({ action: 'share', bucket: bucket.name, objectKey: key });
          if (!reply.ok || !reply.url) {
            postToastToParent(reply.needsCreds ? 'warning' : 'error', reply.error || 'Could not create a public link.');
            return;
          }
          const copied = await copyText(reply.url);
          postToastToParent(
            'success',
            copied
              ? `Public link copied — anyone with it can view ${objectBaseName(key)}.`
              : `Public link ready: ${reply.url}`,
          );
        } catch (err) {
          postToastToParent('error', err instanceof Error ? err.message : 'Could not create a public link.');
        } finally {
          setBusyKey(null);
        }
      },
      [bucket.name],
    );

    /** B9 — revoke an object's public link (dies immediately). Idempotent + honest toast. */
    const revokeShare = useCallback(
      async (key: string) => {
        setBusyKey(key);
        try {
          const reply = await requestObjectPublic({ action: 'revoke', bucket: bucket.name, objectKey: key });
          if (!reply.ok) {
            postToastToParent(reply.needsCreds ? 'warning' : 'error', reply.error || 'Could not stop sharing that file.');
            return;
          }
          postToastToParent(
            'success',
            reply.revoked ? `Public link revoked — ${objectBaseName(key)} is private again.` : `${objectBaseName(key)} wasn’t shared.`,
          );
        } catch (err) {
          postToastToParent('error', err instanceof Error ? err.message : 'Could not stop sharing that file.');
        } finally {
          setBusyKey(null);
        }
      },
      [bucket.name],
    );

    /*
     * B8 — copy / move / rename ONE object via the `requestR2Copy` bridge (server-side S3 CopyObject).
     * `deleteSource` turns copy into move/rename. `destBucket` (when it differs from the current bucket)
     * copies/moves ACROSS buckets — a cross-bucket move is copy-to-dest THEN delete-source server-side.
     * Returns `true` on success so the dialog can close; a `conflict` keeps the dialog open (the owner
     * picks another name/bucket). Refreshes the list on success so the change appears without a reload.
     */
    const runObjectOp = useCallback(
      async (
        srcKey: string,
        destKey: string,
        deleteSource: boolean,
        destBucket?: string,
      ): Promise<{ ok: boolean; conflict?: boolean }> => {
        setBusyKey(srcKey);
        // Only send destBucket when it actually crosses buckets (keeps the same-bucket request byte-identical).
        const crossing = !!destBucket && destBucket !== bucket.name;

        try {
          const reply = await requestR2Copy({
            bucket: bucket.name,
            deleteSource,
            destKey,
            srcKey,
            ...(crossing ? { destBucket } : {}),
          });

          if (!reply.ok) {
            if (reply.conflict) {
              return { conflict: true, ok: false };
            }

            postToastToParent(reply.needsCreds ? 'warning' : 'error', reply.error || 'Could not complete that.');

            return { ok: false };
          }

          const verb = deleteSource
            ? crossing || objectParentPrefix(srcKey) !== objectParentPrefix(destKey)
              ? 'Moved'
              : 'Renamed'
            : 'Copied';
          const dest = crossing ? `${destBucket}/${objectBaseName(destKey)}` : objectBaseName(destKey);
          postToastToParent('success', `${verb} ${objectBaseName(srcKey)} → ${dest}.`);
          await loadObjects();

          return { ok: true };
        } catch (err) {
          postToastToParent('error', err instanceof Error ? err.message : 'Could not complete that.');

          return { ok: false };
        } finally {
          setBusyKey(null);
        }
      },
      [bucket.name, loadObjects],
    );

    /** Bulk-download every selected object (sequential so a large selection never floods the bridge). */
    const bulkDownload = useCallback(async () => {
      const keys = [...selected];

      if (keys.length === 0) {
        return;
      }

      postToastToParent('info', `Downloading ${keys.length} file${keys.length === 1 ? '' : 's'}…`);

      for (const key of keys) {
        await downloadObject(key);
      }
    }, [selected, downloadObject]);

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
    //  • SERVER-search mode (objects.search set) — the worker already filtered the WHOLE bucket, so we
    //    just sort the server results (no client re-filter, or we'd re-narrow to the loaded view).
    //  • Plain mode — keep the instant client substring filter of the loaded page for responsiveness
    //    (so typing shows a result immediately, before the ~280ms debounce fires the server search).
    const shownObjects = useMemo(() => {
      if (objects.status !== 'ready') {
        return [];
      }

      const serverSearched = typeof objects.search === 'string';
      const needle = search.trim().toLowerCase();
      let list = objects.objects;

      if (!serverSearched && needle) {
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

    /*
     * B3 — keyboard multi-select on the object browser:
     *   • Cmd/Ctrl+A → select every loaded object (and resets the range anchor to the top).
     *   • Escape     → clear the whole selection.
     * Scoped to the browser container; we skip when focus is in the Filter input so A/typing there is
     * untouched, and we never hijack the browser-native select-all unless there are objects to select.
     */
    const onBrowserKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement | null;
        const typing =
          !!target &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

        if ((e.metaKey || e.ctrlKey) && (e.key === 'a' || e.key === 'A') && !typing) {
          if (shownObjects.length === 0) {
            return;
          }

          e.preventDefault();
          rangeAnchor.current = 0;
          setSelected(selectAllKeys(shownObjects));

          return;
        }

        if (e.key === 'Escape' && selected.size > 0 && !typing) {
          e.preventDefault();
          rangeAnchor.current = null;
          setSelected(new Set());
        }
      },
      [shownObjects, selected.size],
    );

    /*
     * Toggle ONE object's selection from its checkbox/row click. A plain click sets the Shift anchor;
     * a Shift+click extends the selection across the inclusive range from the anchor to this index
     * (the familiar file-manager gesture) WITHOUT clearing what's already picked.
     */
    const toggleObjectAt = useCallback(
      (index: number, shiftKey: boolean) => {
        setSelected((cur) => {
          if (shiftKey && rangeAnchor.current !== null) {
            return extendSelection(cur, rangeKeys(shownObjects, rangeAnchor.current, index));
          }

          const key = shownObjects[index]?.key;

          if (key === undefined) {
            return cur;
          }

          const next = new Set(cur);

          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }

          return next;
        });

        if (!shiftKey) {
          rangeAnchor.current = index;
        }
      },
      [shownObjects],
    );

    return (
      <div
        className="relative flex-1 flex flex-col min-h-0"
        onKeyDown={onBrowserKeyDown}
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
              className="inline-flex items-center gap-1 font-medium text-bolt-elements-item-contentAccent rounded-md px-1 py-0.5 transition-colors hover:bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_10%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
              title={bucket.name}
            >
              <div className="i-ph:hard-drives-duotone text-xs" aria-hidden /> {bucket.name}
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
                placeholder="Search all files…"
                aria-label="Search all objects in this bucket"
                title="Searches the whole bucket, not just the files shown"
                data-testid="buckets-object-search"
                className="w-full min-h-[26px] pl-7 pr-2 py-1 text-[11px] rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary transition-[border-color,box-shadow,background-color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/50 focus-visible:bg-bolt-elements-background-depth-1 focus-visible:shadow-[0_0_0_3px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_12%,transparent)] hover:border-bolt-elements-item-contentAccent/30"
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
              title={objectOpsAvailable ? 'Upload files to this bucket' : 'File uploads are being set up for your site'}
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

        {/* Bulk-action bar (visible only with a selection). Rises in on the shared `psBucketRise`
            keyframe — motion-safe only, with a motion-reduce opt-out (WCAG 2.3.3). A cyan left rail +
            accent wash makes the selection state read instantly on the brand-dark shell. */}
        {selected.size > 0 && (
          <div
            className={classNames(
              'relative flex items-center gap-2 px-3 py-1.5 border-b border-bolt-elements-item-contentAccent/25 shrink-0',
              // Glass depth: an accent wash + a saturating backdrop-blur floats the bar above the list.
              'bg-[linear-gradient(90deg,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_12%,transparent),color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent))] backdrop-blur-sm',
              'shadow-[0_2px_10px_-4px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_35%,transparent)]',
              'motion-safe:animate-[psBucketRise_.24s_cubic-bezier(0.16,1,0.3,1)_both] motion-reduce:animate-none',
            )}
            role="toolbar"
            aria-label={`${selected.size} object${selected.size === 1 ? '' : 's'} selected — bulk actions`}
            data-testid="buckets-bulk-bar"
          >
            <span
              aria-hidden
              className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-bolt-elements-item-contentAccent shadow-[0_0_8px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_60%,transparent)]"
            />
            <span className="inline-flex items-center gap-1.5 text-[11px] text-bolt-elements-item-contentAccent font-semibold tabular-nums">
              <span className="i-ph:check-square-duotone text-sm" aria-hidden />
              {selected.size} selected
            </span>
            <button
              type="button"
              onClick={() => {
                rangeAnchor.current = null;
                setSelected(new Set());
              }}
              className={classNames(BTN_GHOST, 'min-h-[24px] px-2 py-0.5 text-[10px]')}
              data-testid="buckets-bulk-clear"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={() => void bulkDownload()}
              className={classNames(BTN_SECONDARY, 'min-h-[24px] px-2 py-0.5 text-[10px] ml-auto')}
              data-testid="buckets-bulk-download"
            >
              <div className="i-ph:download-simple text-xs" /> Download
            </button>
            <button
              type="button"
              onClick={() => void bulkDelete()}
              className={classNames(BTN_DESTRUCTIVE, 'min-h-[24px] px-2 py-0.5 text-[10px]')}
              data-testid="buckets-bulk-delete"
            >
              <div className="i-ph:trash text-xs" /> Delete
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-auto modern-scrollbar min-h-0">
          {objects.status === 'idle' || objects.status === 'loading' ? (
            <ObjectsSkeleton />
          ) : objects.status === 'searching' ? (
            // B11 — a whole-bucket server search is in flight. Honest, specific copy (not "Loading…").
            <ObjectsSearching term={search.trim()} />
          ) : objects.status === 'needs-creds' ? (
            <ObjectsNeedsCreds message={objects.message} />
          ) : objects.status === 'error' ? (
            <ErrorCard
              message={objects.message}
              onRetry={() => (searchActive ? void searchObjects(search.trim()) : void loadObjects())}
            />
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
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-bolt-elements-borderColor/40 sticky top-0 z-[1] bg-bolt-elements-background-depth-1/95 backdrop-blur-sm supports-[backdrop-filter]:bg-bolt-elements-background-depth-1/80">
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
                  {/* B11 — in server-search mode, say so explicitly ("searched all objects"). */}
                  {typeof objects.search === 'string' && (
                    <span className="text-bolt-elements-item-contentAccent/80"> · whole-bucket search</span>
                  )}
                </span>
              </div>

              {/* B11 — HONEST search-limit note. Only when the server search did NOT see everything
                  (`scannedAll:false`) or had to cut the result set (`truncated:true`). We NEVER claim we
                  searched the whole bucket when we didn't — we name the scan ceiling instead. */}
              {typeof objects.search === 'string' && (objects.truncated || objects.scannedAll === false) && (
                <div
                  data-testid="buckets-search-truncated"
                  role="status"
                  className="flex items-start gap-2 px-3 py-2 border-b border-bolt-elements-borderColor/40 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)] text-[11px] text-bolt-elements-textSecondary"
                >
                  <div className="i-ph:info-duotone text-sm text-bolt-elements-item-contentAccent shrink-0 mt-px" aria-hidden />
                  <span>
                    {objects.truncated ? (
                      <>
                        Showing the first <span className="tabular-nums font-medium">{shownObjects.length.toLocaleString()}</span>{' '}
                        matches
                      </>
                    ) : (
                      <>
                        Showing <span className="tabular-nums font-medium">{shownObjects.length.toLocaleString()}</span>{' '}
                        match{shownObjects.length === 1 ? '' : 'es'}
                      </>
                    )}
                    {typeof objects.scanned === 'number' && (
                      <>
                        {' '}· scanned up to{' '}
                        <span className="tabular-nums font-medium">{objects.scanned.toLocaleString()}</span> object
                        {objects.scanned === 1 ? '' : 's'}
                      </>
                    )}
                    {objects.scannedAll === false && '. Narrow with a folder prefix to search deeper.'}
                  </span>
                </div>
              )}

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
                        className="group w-full flex items-center gap-3 px-3 py-2.5 border-b border-bolt-elements-borderColor/20 hover:bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)] hover:border-bolt-elements-item-contentAccent/20 transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none motion-safe:hover:translate-x-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent"
                      >
                        <div className="flex items-center justify-center h-7 w-7 shrink-0 rounded-lg ring-1 ring-inset ring-bolt-elements-item-contentAccent/20 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_7%,transparent)]">
                          <div className="i-ph:folder-duotone text-lg text-bolt-elements-item-contentAccent" aria-hidden />
                        </div>
                        <span className="text-[12px] font-medium text-bolt-elements-textPrimary truncate flex-1">
                          {label}/
                        </span>
                        <div
                          className="i-ph:caret-right text-xs text-bolt-elements-textTertiary transition-transform duration-150 motion-reduce:transition-none group-hover:text-bolt-elements-item-contentAccent motion-safe:group-hover:translate-x-0.5"
                          aria-hidden
                        />
                      </button>
                    );
                  })}

                  {/* Objects. */}
                  {shownObjects.map((obj, index) => {
                    const name = obj.key.slice(prefix.length);
                    const checked = selected.has(obj.key);
                    const busy = busyKey === obj.key;

                    return (
                      <ObjectActionMenu
                        key={obj.key}
                        objectKey={obj.key}
                        name={name}
                        canPreview={isPreviewable(obj.key)}
                        onPreview={setPreviewKey}
                        onCopyUrl={(k) => void copyObjectUrl(k)}
                        onDownload={(k) => void downloadObject(k)}
                        onRename={objectOpsAvailable ? (k) => setObjectOp({ key: k, mode: 'rename' }) : undefined}
                        onCopy={objectOpsAvailable ? (k) => setObjectOp({ key: k, mode: 'copy' }) : undefined}
                        onMove={objectOpsAvailable ? (k) => setObjectOp({ key: k, mode: 'move' }) : undefined}
                        onShare={objectOpsAvailable ? (k) => void shareObject(k) : undefined}
                        onRevokeShare={objectOpsAvailable ? (k) => void revokeShare(k) : undefined}
                        onDelete={(k) => void deleteObject(k)}
                      >
                      <div
                        style={objectEntranceStyle(index)}
                        className={classNames(
                          'group relative flex items-center gap-3 px-3 py-2.5 border-b',

                          // Cinematic staggered entrance (transform-only ⇒ no CLS) + spring select-scale.
                          OBJECT_ENTRANCE_CLASS,
                          checked
                            ? 'border-bolt-elements-item-contentAccent/30 bg-[linear-gradient(90deg,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_10%,transparent),transparent_70%)] shadow-[inset_0_1px_0_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_12%,transparent)] motion-safe:scale-[1.004]'
                            : 'border-bolt-elements-borderColor/20 hover:bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)] hover:border-bolt-elements-item-contentAccent/20 motion-safe:hover:translate-x-0.5',
                        )}
                        data-testid="buckets-object-row"
                      >
                        {checked && (
                          <span
                            aria-hidden
                            className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-bolt-elements-item-contentAccent shadow-[0_0_8px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_55%,transparent)]"
                          />
                        )}
                        <input
                          type="checkbox"
                          checked={checked}
                          // Capture Shift at pointer/keyboard-down; `change` can't see modifier keys.
                          onMouseDown={(e) => (shiftHeld.current = e.shiftKey)}
                          onKeyDown={(e) => (shiftHeld.current = e.shiftKey)}
                          onChange={() => {
                            // Shift+click extends a range from the anchor; plain click toggles + re-anchors.
                            toggleObjectAt(index, shiftHeld.current);
                            shiftHeld.current = false;
                          }}
                          aria-label={`Select ${name}`}
                          className="h-3.5 w-3.5 accent-[var(--bolt-elements-item-contentAccent)] cursor-pointer shrink-0"
                        />
                        {/* File-type glyph in a subtle inset chip — gives each row the dimensional
                            "asset" feel of a premium file explorer; the duotone tint reads the type. */}
                        <div
                          className={classNames(
                            'flex items-center justify-center h-7 w-7 shrink-0 rounded-lg ring-1 ring-inset transition-[background-color,box-shadow] duration-150 motion-reduce:transition-none',
                            checked
                              ? 'bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_12%,transparent)] ring-bolt-elements-item-contentAccent/30'
                              : 'bg-bolt-elements-background-depth-2/70 ring-bolt-elements-borderColor/50 group-hover:ring-bolt-elements-item-contentAccent/25',
                          )}
                          aria-hidden
                        >
                          <div
                            className={classNames(
                              iconForObject(obj.key),
                              'text-lg transition-colors',

                              /*
                               * Color-code by file type at rest (reads like a polished file explorer);
                               * a selected row shows the brand accent so selection still reads first.
                               */
                              checked ? 'text-bolt-elements-item-contentAccent' : colorForObject(obj.key),
                            )}
                          />
                        </div>
                        <span
                          className="text-[12px] font-mono text-bolt-elements-textPrimary truncate flex-1"
                          title={obj.key}
                        >
                          {name}
                        </span>
                        <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums shrink-0 tracking-tight">
                          {formatBytes(obj.size)}
                        </span>
                        {formatRelativeTime(obj.uploadedAt) && (
                          <span className="hidden sm:inline text-[10px] text-bolt-elements-textTertiary/70 tabular-nums shrink-0 w-14 text-right">
                            {formatRelativeTime(obj.uploadedAt)}
                          </span>
                        )}

                        {/* Row actions. */}
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity motion-reduce:transition-none shrink-0">
                          {isPreviewable(obj.key) && (
                            <button
                              type="button"
                              onClick={() => setPreviewKey(obj.key)}
                              title="Preview"
                              aria-label={`Preview ${name}`}
                              data-testid="buckets-object-preview"
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
                      </ObjectActionMenu>
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
                        className="group flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border border-bolt-elements-borderColor bg-[radial-gradient(120%_80%_at_50%_0%,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_8%,transparent),transparent_58%),linear-gradient(180deg,var(--bolt-elements-bg-depth-2),color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_4%,var(--bolt-elements-bg-depth-2)))] p-3 text-center transition-[transform,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none hover:border-bolt-elements-item-contentAccent/50 hover:shadow-[0_12px_30px_-12px_rgba(0,0,0,0.65),0_0_22px_-10px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_50%,transparent)] motion-safe:hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
                      >
                        <div
                          className="i-ph:folder-duotone text-3xl text-bolt-elements-item-contentAccent transition-transform duration-200 motion-reduce:transition-none motion-safe:group-hover:scale-110"
                          aria-hidden
                        />
                        <span className="w-full truncate text-[11px] font-medium text-bolt-elements-textPrimary">
                          {label}/
                        </span>
                      </button>
                    );
                  })}

                  {/* Object tiles */}
                  {shownObjects.map((obj, index) => {
                    const name = obj.key.slice(prefix.length);
                    const checked = selected.has(obj.key);
                    const busy = busyKey === obj.key;
                    const publicBase = bucket.publicUrl || bucket.address?.publicUrl;
                    const thumbUrl =
                      publicBase && isImageKey(obj.key) && !failedThumbs.has(obj.key)
                        ? `${publicBase.replace(/\/$/, '')}/${obj.key}`
                        : null;

                    return (
                      <ObjectActionMenu
                        key={obj.key}
                        objectKey={obj.key}
                        name={name}
                        canPreview={isPreviewable(obj.key)}
                        onPreview={setPreviewKey}
                        onCopyUrl={(k) => void copyObjectUrl(k)}
                        onDownload={(k) => void downloadObject(k)}
                        onRename={objectOpsAvailable ? (k) => setObjectOp({ key: k, mode: 'rename' }) : undefined}
                        onCopy={objectOpsAvailable ? (k) => setObjectOp({ key: k, mode: 'copy' }) : undefined}
                        onMove={objectOpsAvailable ? (k) => setObjectOp({ key: k, mode: 'move' }) : undefined}
                        onShare={objectOpsAvailable ? (k) => void shareObject(k) : undefined}
                        onRevokeShare={objectOpsAvailable ? (k) => void revokeShare(k) : undefined}
                        onDelete={(k) => void deleteObject(k)}
                      >
                      <div
                        style={objectEntranceStyle(index)}
                        data-testid="buckets-object-tile"
                        className={classNames(
                          'group relative flex flex-col gap-1.5 rounded-xl border p-2',

                          // Cinematic staggered entrance (transform-only ⇒ no CLS) — same on every grid flip.
                          OBJECT_ENTRANCE_CLASS,
                          checked
                            ? 'border-bolt-elements-item-contentAccent/60 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_8%,transparent)] shadow-[0_0_0_1px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_30%,transparent),0_8px_22px_-8px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_55%,transparent)] motion-safe:scale-[1.02]'
                            : TILE_SHELL_RESTING_CLASS,
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onMouseDown={(e) => (shiftHeld.current = e.shiftKey)}
                          onKeyDown={(e) => (shiftHeld.current = e.shiftKey)}
                          onChange={() => {
                            toggleObjectAt(index, shiftHeld.current);
                            shiftHeld.current = false;
                          }}
                          aria-label={`Select ${name}`}
                          className={classNames(
                            'absolute left-1.5 top-1.5 z-[1] h-3.5 w-3.5 cursor-pointer accent-[var(--bolt-elements-item-contentAccent)] transition-opacity',
                            checked
                              ? 'opacity-100'
                              : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                          )}
                        />

                        <div className={TILE_THUMB_SLOT_CLASS}>
                          {thumbUrl ? (
                            <img
                              src={thumbUrl}
                              alt={name}
                              loading="lazy"
                              onError={() => setFailedThumbs((c) => new Set(c).add(obj.key))}
                              className="h-full w-full object-cover transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none motion-safe:group-hover:scale-[1.06]"
                            />
                          ) : (
                            <div
                              className={classNames(
                                iconForObject(obj.key),
                                'text-4xl transition-[transform,color] duration-200 motion-reduce:transition-none motion-safe:group-hover:scale-110',

                                // Color-code the file-type glyph at rest; selected tile keeps the accent.
                                checked ? 'text-bolt-elements-item-contentAccent' : colorForObject(obj.key),
                              )}
                              aria-hidden
                            />
                          )}
                          {/* Hover-reveal type chip — a quiet file-type badge that fades in on hover so the
                              grid stays calm at rest but gains a VS Code / Finder "inspect" affordance on
                              intent. Accent text on a ≤12% accent tint (NOT a /[opacity] on the hex var),
                              opacity-only reveal ⇒ 0 CLS. Images show "IMG"; folders are never tiles here. */}
                          <span
                            aria-hidden
                            className="pointer-events-none absolute bottom-1 right-1 rounded-md border border-bolt-elements-item-contentAccent/30 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_12%,transparent)] px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wide text-bolt-elements-item-contentAccent opacity-0 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none group-hover:opacity-100"
                          >
                            {objectTypeLabel(obj.key)}
                          </span>
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
                          {isPreviewable(obj.key) && (
                            <button
                              type="button"
                              onClick={() => setPreviewKey(obj.key)}
                              title="Preview"
                              aria-label={`Preview ${name}`}
                              data-testid="buckets-tile-preview"
                              className={classNames(BTN_GHOST, 'min-h-[22px] min-w-[22px] p-1')}
                            >
                              <div className="i-ph:eye text-xs" />
                            </button>
                          )}
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
                      </ObjectActionMenu>
                    );
                  })}
                </div>
              )}

              {/* Pagination. Cursor paging is a PLAIN-listing affordance — a whole-bucket search is
                  single-shot (no cursor), so "Load more" never renders in search mode (no doomed control;
                  the honest note above already states the search limit). */}
              {objects.truncated && typeof objects.search !== 'string' && objects.cursor && (
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
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl m-2 border-2 border-dashed border-bolt-elements-item-contentAccent/80 bg-[radial-gradient(120%_120%_at_50%_30%,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_14%,transparent),transparent_60%),color-mix(in_oklch,var(--bolt-elements-bg-depth-1)_88%,transparent)] backdrop-blur-md pointer-events-none motion-safe:animate-[fadeIn_.15s_ease-out]"
            data-testid="buckets-drop-overlay"
          >
            <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-bolt-elements-item-contentAccent/40 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_10%,transparent)] shadow-[0_0_30px_-6px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_60%,transparent)]">
              <div
                className="i-ph:upload-simple-duotone text-3xl text-bolt-elements-item-contentAccent motion-safe:animate-bounce motion-reduce:animate-none"
                aria-hidden
              />
            </div>
            <p className="text-sm font-semibold text-bolt-elements-textPrimary">Drop to upload</p>
            <p className="text-[11px] text-bolt-elements-textTertiary">
              Files land under <span className="font-mono text-bolt-elements-item-contentAccent/90">{prefix || bucket.name}</span>
            </p>
          </div>
        )}

        {/* In-flight upload strip. */}
        {uploading && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-bolt-elements-item-contentAccent/30 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)] shrink-0">
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

        {/* B12 — in-editor sandboxed object preview (bytes via the existing download bridge). */}
        {previewKey && (
          <ObjectPreviewModal
            bucket={bucket.name}
            objectKey={previewKey}
            onClose={() => setPreviewKey(null)}
            onDownload={(key) => void downloadObject(key)}
          />
        )}

        {/* B8 — rename / copy / move one object (server-side S3 CopyObject via the bridge; copy/move can
            target ANOTHER of the site's buckets via the destination-bucket picker). */}
        {objectOp && (
          <ObjectCopyDialog
            mode={objectOp.mode}
            srcKey={objectOp.key}
            existingKeys={objects.status === 'ready' ? objects.objects.map((o) => o.key) : []}
            buckets={allBuckets}
            currentBucket={bucket.name}
            onClose={() => setObjectOp(null)}
            onSubmit={async (destKey, deleteSource, destBucket) => {
              const r = await runObjectOp(objectOp.key, destKey, deleteSource, destBucket);

              if (r.ok) {
                setObjectOp(null);
              }

              return r;
            }}
          />
        )}
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
    allBuckets,
    objectOpsAvailable,
    onAddress,
    onTogglePublic,
    onPromote,
    onDelete,
    onCloned,
  }: {
    bucket: BucketEntry;
    /** All of the site's bucket display names — threaded to the object browser for cross-bucket copy/move. */
    allBuckets?: readonly string[];
    objectOpsAvailable: boolean;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
    onCloned: (newBucket: BucketEntry | null) => void;
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
              allBuckets={allBuckets}
              objectOpsAvailable={objectOpsAvailable}
              onCopyBucketAddress={() => onAddress(bucket)}
            />
          ) : (
            <BucketSettings
              bucket={bucket}
              objectOpsAvailable={objectOpsAvailable}
              onAddress={onAddress}
              onTogglePublic={onTogglePublic}
              onPromote={onPromote}
              onDelete={onDelete}
              onCloned={onCloned}
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
    objectOpsAvailable,
    onAddress,
    onTogglePublic,
    onPromote,
    onDelete,
    onCloned,
  }: {
    bucket: BucketEntry;
    objectOpsAvailable: boolean;
    onAddress: (b: BucketEntry) => void;
    onTogglePublic: (b: BucketEntry) => void;
    onPromote: (b: BucketEntry) => void;
    onDelete: (b: BucketEntry) => void;
    onCloned: (newBucket: BucketEntry | null) => void;
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

      {/* Clone this bucket into a new one (B6). */}
      <BucketCloneSection bucket={bucket} objectOpsAvailable={objectOpsAvailable} onCloned={onCloned} />

      {/* Download the whole bucket as one .zip (B7). */}
      <BucketExportSection bucket={bucket} objectOpsAvailable={objectOpsAvailable} />

      {/* Site-wide API access key — works for ALL the owner's buckets (B5 slice 4). */}
      <OwnerKeySection />

      {/* Bucket-scoped API access key — works ONLY for this one bucket (B4-UI). */}
      <BucketKeySection bucket={bucket.name} />

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

// ── Download-as-ZIP export (B7) ────────────────────────────────────────────────

/**
 * "Download as ZIP" — export the WHOLE bucket as one `.zip` (B7). Self-contained (like `OwnerKeySection`):
 * owns its own in-flight state, calls the `requestBucketZip` bridge (admin GETs the `application/zip` +
 * forwards the honest `x-ps-zip-*` truncation accounting), and triggers a browser download from the
 * returned data URL via a temporary anchor — the SAME mechanism the single-object download uses.
 *
 * Embarrassingly-easy + no doomed control: the button is DISABLED with an inline explanation while object
 * storage is still being set up (`objectOpsAvailable` false — the whole archive needs R2 S3 creds, exactly
 * like per-object download), so the owner never clicks a control that can only fail. The export is BOUNDED
 * server-side; when the worker reports `truncated`, we surface an HONEST "capped at N files / X" warning
 * (never imply the archive is complete). While zipping, the button shows a live "Zipping…" state.
 */
export const BucketExportSection = memo(({ bucket, objectOpsAvailable }: { bucket: BucketEntry; objectOpsAvailable: boolean }) => {
  const [zipping, setZipping] = useState(false);

  const downloadZip = useCallback(async () => {
    if (zipping) {
      return;
    }

    setZipping(true);
    postToastToParent('info', `Preparing ${bucket.name}.zip…`);

    try {
      const reply = await requestBucketZip({ bucket: bucket.name });

      if (!reply.ok || !reply.dataUrl) {
        postToastToParent(reply.needsCreds ? 'warning' : 'error', reply.error || 'Could not build the archive.');
        return;
      }

      // Save via a temporary anchor (same as the single-object download path).
      const a = document.createElement('a');
      a.href = reply.dataUrl;
      a.download = reply.filename || `${bucket.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      if (reply.truncated) {
        // HONEST partial-export notice — never let the filename imply a complete archive.
        const n = reply.includedCount ?? 0;
        const total = reply.totalCount ?? n;
        postToastToParent(
          'warning',
          `Downloaded the first ${n} of ${total} file${total === 1 ? '' : 's'} (${formatBytes(reply.bytesIncluded)}). The bucket is larger than one archive can hold — download the rest by folder.`,
        );
      } else {
        const n = reply.includedCount ?? 0;
        postToastToParent(
          'success',
          n === 0
            ? 'That bucket is empty — downloaded an empty archive.'
            : `Downloaded ${n} file${n === 1 ? '' : 's'} (${formatBytes(reply.bytesIncluded)}).`,
        );
      }
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not build the archive.');
    } finally {
      setZipping(false);
    }
  }, [bucket.name, zipping]);

  return (
    <SettingsSection
      title="Download as ZIP"
      icon="i-ph:file-zip-duotone"
      hint={
        objectOpsAvailable
          ? 'Download every object in this bucket as one .zip (bounded — very large buckets export the first slice).'
          : 'Available once file storage for this site finishes setting up.'
      }
    >
      <button
        type="button"
        onClick={() => void downloadZip()}
        disabled={!objectOpsAvailable || zipping}
        data-testid="buckets-settings-zip"
        aria-label={`Download ${bucket.name} as a ZIP archive`}
        aria-busy={zipping}
        className={classNames(
          BTN_SECONDARY,
          'min-h-[28px] px-3 py-1 text-[11px] disabled:opacity-45 disabled:cursor-not-allowed',
        )}
      >
        {zipping ? (
          <>
            <div className="i-ph:circle-notch text-sm animate-spin motion-reduce:animate-none" aria-hidden /> Zipping…
          </>
        ) : (
          <>
            <div className="i-ph:download-simple text-sm" aria-hidden /> Download .zip
          </>
        )}
      </button>
    </SettingsSection>
  );
});

BucketExportSection.displayName = 'BucketsPanel.BucketExportSection';

// ── Owner-key credential strip (B5 slice 4) ────────────────────────────────────

/** Local view-state for the owner-key section. */
type OwnerKeyState =
  | { status: 'loading' }
  | { status: 'disabled' } // r2_bucket_manager flag dark
  | { status: 'needs-creds' } // platform hasn't configured CF/R2 creds yet
  | { status: 'error'; message: string }
  | { status: 'ready'; key: OwnerKeyStatus };

/**
 * The owner-facing scoped-R2-key credential strip — a SITE-level credential (NOT per-bucket) the owner
 * mints to use their R2 from their OWN tooling (wrangler / aws-cli / SDKs), separate from the Worker's
 * internal object-ops token. It drives the already-built bridge helpers (`requestOwnerKey*`, all →
 * `PS_R2_KEY_RESULT`). Embarrassingly-easy: ONE obvious primary action (Create), the secret revealed
 * ONCE in the shared {@link ModalShell} with copy + honest "shown once — rotate for a new one" copy,
 * Rotate re-reveals once, Revoke confirms first. Graceful dark-flag / needs-creds / error cards — never
 * a scary error, never a doomed control.
 *
 * Exported for falsifiable render tests (mirrors {@link BucketsEmpty}) — it holds its own bridge wiring
 * so it is self-contained inside the Settings tab.
 */
export const OwnerKeySection = memo(() => {
  const [state, setState] = useState<OwnerKeyState>({ status: 'loading' });

  // The show-once reveal (create/rotate) + the revoke confirm — both overlay dialogs.
  const [reveal, setReveal] = useState<{ accessKeyId: string; secretAccessKey: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState<null | 'create' | 'rotate' | 'revoke'>(null);

  /** Translate any owner-key reply into local view-state (shared by load + every mutation). */
  const applyReply = useCallback((reply: Awaited<ReturnType<typeof requestOwnerKeyStatus>>): boolean => {
    if (!reply.ok) {
      if (reply.enabled === false) {
        setState({ status: 'disabled' });
        return false;
      }

      if (reply.needsCreds) {
        setState({ status: 'needs-creds' });
        return false;
      }

      setState({ status: 'error', message: reply.error || 'Could not load your access key.' });

      return false;
    }

    if (reply.status) {
      setState({ status: 'ready', key: reply.status });
    }

    return true;
  }, []);

  const load = useCallback(async () => {
    setState({ status: 'loading' });

    if (!isEmbedded) {
      setState({ status: 'error', message: 'Open this from the ProjectSites admin to manage your access key.' });
      return;
    }

    try {
      applyReply(await requestOwnerKeyStatus());
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Could not load your access key.' });
    }
  }, [applyReply]);

  useEffect(() => {
    void load();
  }, [load]);

  const doCreate = useCallback(async () => {
    setBusy('create');

    try {
      const reply = await requestOwnerKeyCreate();

      if (reply.ok && reply.secretAccessKey && reply.accessKeyId) {
        setReveal({ accessKeyId: reply.accessKeyId, secretAccessKey: reply.secretAccessKey });
        postToastToParent('success', 'Access key created.');
      }

      applyReply(reply);
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not create the access key.');
    } finally {
      setBusy(null);
    }
  }, [applyReply]);

  const doRotate = useCallback(async () => {
    setBusy('rotate');

    try {
      const reply = await requestOwnerKeyRotate();

      if (reply.ok && reply.secretAccessKey && reply.accessKeyId) {
        setReveal({ accessKeyId: reply.accessKeyId, secretAccessKey: reply.secretAccessKey });
        postToastToParent('success', 'Access key rotated.');
      }

      applyReply(reply);
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not rotate the access key.');
    } finally {
      setBusy(null);
    }
  }, [applyReply]);

  const doRevoke = useCallback(async () => {
    setBusy('revoke');

    try {
      const reply = await requestOwnerKeyRevoke();

      if (reply.ok) {
        postToastToParent('success', reply.revoked ? 'Access key revoked.' : 'No access key to revoke.');

        // Re-fetch the (now-empty) status so the UI returns to the Create launchpad.
        applyReply(await requestOwnerKeyStatus());
      } else {
        applyReply(reply);
      }
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not revoke the access key.');
    } finally {
      setBusy(null);
      setConfirmRevoke(false);
    }
  }, [applyReply]);

  // ── Degraded / loading cards — friendly, never scary, never a doomed button. ──
  if (state.status === 'loading') {
    return (
      <SettingsSection title="API access key" icon="i-ph:key-duotone" hint="Loading…">
        <div
          data-testid="buckets-owner-key"
          className="h-8 rounded-lg bg-bolt-elements-background-depth-3 motion-safe:animate-pulse"
          aria-busy="true"
        />
      </SettingsSection>
    );
  }

  if (state.status === 'disabled') {
    return (
      <SettingsSection title="API access key" icon="i-ph:key-duotone" hint="For wrangler, aws-cli + S3 SDKs.">
        <p
          data-testid="buckets-owner-key-disabled"
          className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5 text-[11px] text-bolt-elements-textSecondary leading-relaxed"
          role="status"
        >
          Access keys are on the way. Once this is turned on, you&rsquo;ll be able to mint a key for your own tooling
          right here — nothing to set up.
        </p>
      </SettingsSection>
    );
  }

  if (state.status === 'needs-creds') {
    return (
      <SettingsSection title="API access key" icon="i-ph:key-duotone" hint="For wrangler, aws-cli + S3 SDKs.">
        <p
          data-testid="buckets-owner-key-needs-creds"
          className="rounded-lg border p-2.5 text-[11px] leading-relaxed"
          style={{
            borderColor: `color-mix(in oklch, ${PURPLE} 40%, transparent)`,
            color: PURPLE_INK,
          }}
          role="status"
        >
          Access keys are being set up for your site. This takes a moment the first time — check back shortly and
          you&rsquo;ll be able to create one here.
        </p>
      </SettingsSection>
    );
  }

  if (state.status === 'error') {
    return (
      <SettingsSection title="API access key" icon="i-ph:key-duotone" hint="For wrangler, aws-cli + S3 SDKs.">
        <div data-testid="buckets-owner-key" className="space-y-2">
          <p className="text-[11px] text-red-400" role="alert">
            {state.message}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className={classNames(BTN_SECONDARY, 'min-h-[28px] px-3 py-1 text-[11px]')}
          >
            <div className="i-ph:arrow-clockwise text-sm" aria-hidden /> Try again
          </button>
        </div>
      </SettingsSection>
    );
  }

  const { key } = state;

  return (
    <SettingsSection
      title="API access key"
      icon="i-ph:key-duotone"
      hint="Use R2 from wrangler, aws-cli + S3 SDKs. The secret is shown once — if you lose it, rotate to get a new one."
    >
      <div data-testid="buckets-owner-key" className="space-y-2.5">
        {key.exists ? (
          <>
            {/* Masked identity — NEVER the secret. */}
            <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-bolt-elements-textTertiary">
                  Access key ID
                </span>
                <span
                  className={classNames(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                    key.status === 'active'
                      ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-item-contentAccent'
                      : 'bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary',
                  )}
                >
                  <span
                    className={classNames(
                      'h-1.5 w-1.5 rounded-full',
                      key.status === 'active' ? 'bg-bolt-elements-item-contentAccent' : 'bg-bolt-elements-textTertiary',
                    )}
                    aria-hidden
                  />
                  {key.status === 'active' ? 'Active' : 'None'}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] font-mono text-bolt-elements-textSecondary break-all">
                {key.accessKeyIdMasked ?? '—'}
              </p>
              {formatRelativeTime(key.createdAt) && (
                <p className="text-[9px] text-bolt-elements-textTertiary/70 tabular-nums">
                  created {formatRelativeTime(key.createdAt)}
                  {key.rotatedAt && formatRelativeTime(key.rotatedAt)
                    ? ` · rotated ${formatRelativeTime(key.rotatedAt)}`
                    : ''}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void doRotate()}
                disabled={busy !== null}
                data-testid="buckets-owner-key-rotate"
                className={classNames(BTN_SECONDARY, 'min-h-[28px] px-3 py-1 text-[11px]')}
              >
                <div
                  className={classNames(
                    busy === 'rotate'
                      ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                      : 'i-ph:arrows-clockwise',
                    'text-sm',
                  )}
                  aria-hidden
                />
                Rotate
              </button>
              <button
                type="button"
                onClick={() => setConfirmRevoke(true)}
                disabled={busy !== null}
                data-testid="buckets-owner-key-revoke"
                className={classNames(BTN_DESTRUCTIVE, 'min-h-[28px] px-3 py-1 text-[11px]')}
              >
                <div className="i-ph:prohibit text-sm" aria-hidden /> Revoke
              </button>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            {/* Empty = a launchpad: ONE obvious action, inline guidance. */}
            <p className="text-[11px] text-bolt-elements-textSecondary leading-relaxed">
              Create a scoped key to use this site&rsquo;s storage from your own tools. We&rsquo;ll show the secret once
              — copy it somewhere safe.
            </p>
            <button
              type="button"
              onClick={() => void doCreate()}
              disabled={busy !== null}
              data-testid="buckets-owner-key-create"
              className={classNames(BTN_PRIMARY, 'min-h-[30px] px-4 py-1.5 text-[12px]')}
            >
              <div
                className={classNames(
                  busy === 'create' ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:key-bold',
                  'text-sm',
                )}
                aria-hidden
              />
              <span className="min-w-[12ch] text-center">{busy === 'create' ? 'Creating…' : 'Create access key'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Show-once secret reveal — the ONLY time the secret is ever visible. */}
      {reveal && (
        <OwnerKeyRevealModal
          accessKeyId={reveal.accessKeyId}
          secret={reveal.secretAccessKey}
          onClose={() => setReveal(null)}
        />
      )}

      {/* Revoke confirm — a destructive action is NEVER one click. */}
      {confirmRevoke && (
        <ModalShell
          title="Revoke access key"
          icon="i-ph:prohibit-duotone"
          danger
          onClose={() => setConfirmRevoke(false)}
          testId="buckets-owner-key-revoke-modal"
        >
          <p className="text-[12px] text-bolt-elements-textSecondary leading-relaxed">
            This immediately stops the current key from working anywhere it&rsquo;s used. Any tool using it will lose
            access. You can create a new key afterwards.
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmRevoke(false)}
              className={classNames(BTN_GHOST, 'min-h-[32px] px-3 py-1.5 text-[12px]')}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void doRevoke()}
              disabled={busy === 'revoke'}
              data-testid="buckets-owner-key-revoke-confirm"
              className={classNames(BTN_DESTRUCTIVE, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
            >
              <div
                className={classNames(
                  busy === 'revoke' ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:prohibit',
                  'text-sm',
                )}
                aria-hidden
              />
              <span className="min-w-[7ch] text-center">{busy === 'revoke' ? 'Revoking…' : 'Revoke'}</span>
            </button>
          </div>
        </ModalShell>
      )}
    </SettingsSection>
  );
});

OwnerKeySection.displayName = 'BucketsPanel.OwnerKeySection';

// ── Bucket-scoped owner-key workspace (B4-UI) ──────────────────────────────────

/** Local view-state for the per-bucket key section (same shape as {@link OwnerKeyState}). */
type BucketKeyState =
  | { status: 'loading' }
  | { status: 'disabled' } // r2_bucket_manager flag dark
  | { status: 'needs-creds' } // platform hasn't configured CF/R2 creds yet
  | { status: 'error'; message: string }
  | { status: 'ready'; key: OwnerKeyStatus };

/**
 * The BUCKET-scoped access-key section — a credential the owner mints that works for ONLY the
 * currently-selected bucket, in contrast to the SITE-wide {@link OwnerKeySection} above it (which works
 * for ALL their buckets). It drives the already-built PER-BUCKET bridge helpers
 * (`requestBucketOwnerKey*`, passed the selected bucket's DISPLAY name, all → `PS_R2_BUCKET_KEY_RESULT`)
 * — NEVER the site-wide helpers. Behaviour mirrors `OwnerKeySection`: masked id + Active/None + created/
 * rotated time on select; Create reveals the `secretAccessKey` ONCE in the shared {@link ModalShell}
 * with copy + honest "shown once — rotate if you lose it" copy; Rotate re-reveals once; Revoke confirms
 * first. Graceful dark-flag / needs-creds / error cards — never a scary error, never a doomed control.
 *
 * Embarrassingly-easy: the copy NAMES the bucket and says "only this bucket" everywhere, so a
 * non-technical owner can never confuse it with the site-wide key. Re-fetches when the selected bucket
 * changes. Exported for falsifiable render tests (mirrors {@link OwnerKeySection}).
 */
export const BucketKeySection = memo(({ bucket }: { bucket: string }) => {
  const [state, setState] = useState<BucketKeyState>({ status: 'loading' });

  // The show-once reveal (create/rotate) + the revoke confirm — both overlay dialogs.
  const [reveal, setReveal] = useState<{ accessKeyId: string; secretAccessKey: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState<null | 'create' | 'rotate' | 'revoke'>(null);

  /** Translate any per-bucket owner-key reply into local view-state (shared by load + every mutation). */
  const applyReply = useCallback(
    (reply: Awaited<ReturnType<typeof requestBucketOwnerKeyStatus>>): boolean => {
      if (!reply.ok) {
        if (reply.enabled === false) {
          setState({ status: 'disabled' });
          return false;
        }

        if (reply.needsCreds) {
          setState({ status: 'needs-creds' });
          return false;
        }

        setState({ status: 'error', message: reply.error || 'Could not load this bucket’s access key.' });

        return false;
      }

      if (reply.status) {
        setState({ status: 'ready', key: reply.status });
      }

      return true;
    },
    [],
  );

  const load = useCallback(async () => {
    setState({ status: 'loading' });

    if (!isEmbedded) {
      setState({ status: 'error', message: 'Open this from the ProjectSites admin to manage this bucket’s key.' });
      return;
    }

    try {
      applyReply(await requestBucketOwnerKeyStatus(bucket));
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not load this bucket’s access key.',
      });
    }
  }, [applyReply, bucket]);

  // Fetch on mount AND whenever the selected bucket changes (scope to the new name).
  useEffect(() => {
    void load();
  }, [load]);

  // A bucket switch mid-reveal/confirm would show the wrong bucket's dialog — close them.
  useEffect(() => {
    setReveal(null);
    setConfirmRevoke(false);
  }, [bucket]);

  const doCreate = useCallback(async () => {
    setBusy('create');

    try {
      const reply = await requestBucketOwnerKeyCreate(bucket);

      if (reply.ok && reply.secretAccessKey && reply.accessKeyId) {
        setReveal({ accessKeyId: reply.accessKeyId, secretAccessKey: reply.secretAccessKey });
        postToastToParent('success', `Access key created for ${bucket}.`);
      }

      applyReply(reply);
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not create the access key.');
    } finally {
      setBusy(null);
    }
  }, [applyReply, bucket]);

  const doRotate = useCallback(async () => {
    setBusy('rotate');

    try {
      const reply = await requestBucketOwnerKeyRotate(bucket);

      if (reply.ok && reply.secretAccessKey && reply.accessKeyId) {
        setReveal({ accessKeyId: reply.accessKeyId, secretAccessKey: reply.secretAccessKey });
        postToastToParent('success', `Access key rotated for ${bucket}.`);
      }

      applyReply(reply);
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not rotate the access key.');
    } finally {
      setBusy(null);
    }
  }, [applyReply, bucket]);

  const doRevoke = useCallback(async () => {
    setBusy('revoke');

    try {
      const reply = await requestBucketOwnerKeyRevoke(bucket);

      if (reply.ok) {
        postToastToParent('success', reply.revoked ? 'Access key revoked.' : 'No access key to revoke.');

        // Re-fetch the (now-empty) status so the UI returns to the Create launchpad.
        applyReply(await requestBucketOwnerKeyStatus(bucket));
      } else {
        applyReply(reply);
      }
    } catch (err) {
      postToastToParent('error', err instanceof Error ? err.message : 'Could not revoke the access key.');
    } finally {
      setBusy(null);
      setConfirmRevoke(false);
    }
  }, [applyReply, bucket]);

  // The one-line scope reminder that keeps this from ever being confused with the site-wide key.
  const scopeHint = `This key works only for the ${bucket} bucket — not your other buckets.`;

  // ── Degraded / loading cards — friendly, never scary, never a doomed button. ──
  if (state.status === 'loading') {
    return (
      <SettingsSection title="Bucket access key" icon="i-ph:key-duotone" hint="Loading…">
        <div
          data-testid="buckets-bucket-key"
          className="h-8 rounded-lg bg-bolt-elements-background-depth-3 motion-safe:animate-pulse"
          aria-busy="true"
        />
      </SettingsSection>
    );
  }

  if (state.status === 'disabled') {
    return (
      <SettingsSection title="Bucket access key" icon="i-ph:key-duotone" hint={scopeHint}>
        <p
          data-testid="buckets-bucket-key-disabled"
          className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5 text-[11px] text-bolt-elements-textSecondary leading-relaxed"
          role="status"
        >
          Per-bucket access keys are on the way. Once this is turned on, you&rsquo;ll be able to mint a key for just
          this bucket right here — nothing to set up.
        </p>
      </SettingsSection>
    );
  }

  if (state.status === 'needs-creds') {
    return (
      <SettingsSection title="Bucket access key" icon="i-ph:key-duotone" hint={scopeHint}>
        <p
          data-testid="buckets-bucket-key-needs-creds"
          className="rounded-lg border p-2.5 text-[11px] leading-relaxed"
          style={{
            borderColor: `color-mix(in oklch, ${PURPLE} 40%, transparent)`,
            color: PURPLE_INK,
          }}
          role="status"
        >
          Access keys are being set up for your site. This takes a moment the first time — check back shortly and
          you&rsquo;ll be able to create one for {bucket} here.
        </p>
      </SettingsSection>
    );
  }

  if (state.status === 'error') {
    return (
      <SettingsSection title="Bucket access key" icon="i-ph:key-duotone" hint={scopeHint}>
        <div data-testid="buckets-bucket-key" className="space-y-2">
          <p className="text-[11px] text-red-400" role="alert">
            {state.message}
          </p>
          <button
            type="button"
            onClick={() => void load()}
            className={classNames(BTN_SECONDARY, 'min-h-[28px] px-3 py-1 text-[11px]')}
          >
            <div className="i-ph:arrow-clockwise text-sm" aria-hidden /> Try again
          </button>
        </div>
      </SettingsSection>
    );
  }

  const { key } = state;

  return (
    <SettingsSection
      title="Bucket access key"
      icon="i-ph:key-duotone"
      hint={`${scopeHint} The secret is shown once — if you lose it, rotate to get a new one.`}
    >
      <div data-testid="buckets-bucket-key" className="space-y-2.5">
        {/* Scope banner — unmistakable this is NOT the site-wide key above. */}
        <p
          className="rounded-lg border border-bolt-elements-item-contentAccent/30 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)] px-2.5 py-1.5 text-[10px] leading-relaxed text-bolt-elements-textSecondary"
          data-testid="buckets-bucket-key-scope"
        >
          <span className="i-ph:lock-key text-xs align-[-2px] text-bolt-elements-item-contentAccent" aria-hidden />{' '}
          Scoped to <span className="font-semibold text-bolt-elements-textPrimary">{bucket}</span> — this key unlocks{' '}
          <span className="font-semibold">only this bucket</span>. For every bucket at once, use the site-wide key
          above.
        </p>

        {key.exists ? (
          <>
            {/* Masked identity — NEVER the secret. */}
            <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wide text-bolt-elements-textTertiary">
                  Access key ID
                </span>
                <span
                  className={classNames(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                    key.status === 'active'
                      ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-item-contentAccent'
                      : 'bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary',
                  )}
                >
                  <span
                    className={classNames(
                      'h-1.5 w-1.5 rounded-full',
                      key.status === 'active'
                        ? 'bg-bolt-elements-item-contentAccent'
                        : 'bg-bolt-elements-textTertiary',
                    )}
                    aria-hidden
                  />
                  {key.status === 'active' ? 'Active' : 'None'}
                </span>
              </div>
              <p className="mt-0.5 text-[12px] font-mono text-bolt-elements-textSecondary break-all">
                {key.accessKeyIdMasked ?? '—'}
              </p>
              {formatRelativeTime(key.createdAt) && (
                <p className="text-[9px] text-bolt-elements-textTertiary/70 tabular-nums">
                  created {formatRelativeTime(key.createdAt)}
                  {key.rotatedAt && formatRelativeTime(key.rotatedAt)
                    ? ` · rotated ${formatRelativeTime(key.rotatedAt)}`
                    : ''}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void doRotate()}
                disabled={busy !== null}
                data-testid="buckets-bucket-key-rotate"
                className={classNames(BTN_SECONDARY, 'min-h-[28px] px-3 py-1 text-[11px]')}
              >
                <div
                  className={classNames(
                    busy === 'rotate'
                      ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                      : 'i-ph:arrows-clockwise',
                    'text-sm',
                  )}
                  aria-hidden
                />
                Rotate
              </button>
              <button
                type="button"
                onClick={() => setConfirmRevoke(true)}
                disabled={busy !== null}
                data-testid="buckets-bucket-key-revoke"
                className={classNames(BTN_DESTRUCTIVE, 'min-h-[28px] px-3 py-1 text-[11px]')}
              >
                <div className="i-ph:prohibit text-sm" aria-hidden /> Revoke
              </button>
            </div>
          </>
        ) : (
          <div className="space-y-2">
            {/* Empty = a launchpad: ONE obvious action, inline guidance. */}
            <p className="text-[11px] text-bolt-elements-textSecondary leading-relaxed">
              Create a key that works with just this bucket&rsquo;s storage from your own tools. We&rsquo;ll show the
              secret once — copy it somewhere safe.
            </p>
            <button
              type="button"
              onClick={() => void doCreate()}
              disabled={busy !== null}
              data-testid="buckets-bucket-key-create"
              className={classNames(BTN_PRIMARY, 'min-h-[30px] px-4 py-1.5 text-[12px]')}
            >
              <div
                className={classNames(
                  busy === 'create' ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:key-bold',
                  'text-sm',
                )}
                aria-hidden
              />
              <span className="min-w-[12ch] text-center">{busy === 'create' ? 'Creating…' : 'Create access key'}</span>
            </button>
          </div>
        )}
      </div>

      {/* Show-once secret reveal — the ONLY time the secret is ever visible. */}
      {reveal && (
        <BucketKeyRevealModal
          bucket={bucket}
          accessKeyId={reveal.accessKeyId}
          secret={reveal.secretAccessKey}
          onClose={() => setReveal(null)}
        />
      )}

      {/* Revoke confirm — a destructive action is NEVER one click. */}
      {confirmRevoke && (
        <ModalShell
          title={`Revoke the ${bucket} key`}
          icon="i-ph:prohibit-duotone"
          danger
          onClose={() => setConfirmRevoke(false)}
          testId="buckets-bucket-key-revoke-modal"
        >
          <p className="text-[12px] text-bolt-elements-textSecondary leading-relaxed">
            This immediately stops this bucket&rsquo;s key from working anywhere it&rsquo;s used. Any tool using it will
            lose access to <span className="font-semibold text-bolt-elements-textPrimary">{bucket}</span>. Your
            site-wide key and other buckets are unaffected. You can create a new one afterwards.
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmRevoke(false)}
              className={classNames(BTN_GHOST, 'min-h-[32px] px-3 py-1.5 text-[12px]')}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void doRevoke()}
              disabled={busy === 'revoke'}
              data-testid="buckets-bucket-key-revoke-confirm"
              className={classNames(BTN_DESTRUCTIVE, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
            >
              <div
                className={classNames(
                  busy === 'revoke' ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:prohibit',
                  'text-sm',
                )}
                aria-hidden
              />
              <span className="min-w-[7ch] text-center">{busy === 'revoke' ? 'Revoking…' : 'Revoke'}</span>
            </button>
          </div>
        </ModalShell>
      )}
    </SettingsSection>
  );
});

BucketKeySection.displayName = 'BucketsPanel.BucketKeySection';

/**
 * The show-once secret reveal dialog for a BUCKET-scoped key — renders inside the shared
 * {@link ModalShell}. Names the bucket + reiterates the "only this bucket" scope so the owner knows
 * exactly what this credential unlocks. The Secret Access Key is NEVER re-fetchable, so this is the
 * owner's one chance to copy it. Mirrors {@link OwnerKeyRevealModal}.
 */
const BucketKeyRevealModal = memo(
  ({
    bucket,
    accessKeyId,
    secret,
    onClose,
  }: {
    bucket: string;
    accessKeyId: string;
    secret: string;
    onClose: () => void;
  }) => {
    const [copied, setCopied] = useState(false);

    return (
      <ModalShell
        title={`${bucket} access key`}
        icon="i-ph:key-duotone"
        onClose={onClose}
        testId="buckets-bucket-key-reveal"
      >
        <p className="text-[12px] text-bolt-elements-textSecondary leading-relaxed">
          This key works with <span className="font-semibold text-bolt-elements-textPrimary">only the {bucket}</span>{' '}
          bucket. Copy the <span className="font-semibold text-bolt-elements-textPrimary">Secret Access Key</span> now —
          it&rsquo;s <span className="font-semibold text-bolt-elements-item-contentAccent">shown once</span>. If you
          lose it, rotate to get a new one.
        </p>

        <div className="mt-3 space-y-2">
          <AddressRow label="Access Key ID" value={accessKeyId} hint="Pairs with the secret below" />
          <div className="rounded-lg border border-bolt-elements-item-contentAccent/40 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)] p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-bolt-elements-item-contentAccent">
                Secret Access Key
              </span>
              <button
                type="button"
                onClick={async () => {
                  const ok = await copyText(secret);

                  if (ok) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  } else {
                    postToastToParent('error', 'Could not copy.');
                  }
                }}
                data-testid="buckets-bucket-key-copy-secret"
                aria-label="Copy the secret access key"
                className={classNames(BTN_PRIMARY, 'min-h-[24px] px-2 py-0.5 text-[10px]')}
              >
                <div className={classNames(copied ? 'i-ph:check-bold' : 'i-ph:copy', 'text-xs')} aria-hidden />
                <span className="min-w-[6ch] text-center">{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <p className="mt-0.5 text-[11px] font-mono text-bolt-elements-textPrimary break-all select-all">{secret}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={async () => {
              const ok = await copyText(`Access Key ID: ${accessKeyId}\nSecret Access Key: ${secret}`);
              postToastToParent(ok ? 'success' : 'error', ok ? 'Credentials copied.' : 'Could not copy.');
            }}
            className={classNames(BTN_SECONDARY, 'min-h-[32px] px-3 py-1.5 text-[12px]')}
          >
            <div className="i-ph:copy text-sm" aria-hidden /> Copy both
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="buckets-bucket-key-reveal-done"
            className={classNames(BTN_PRIMARY, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
          >
            <div className="i-ph:check text-sm" aria-hidden /> I&rsquo;ve saved it
          </button>
        </div>
      </ModalShell>
    );
  },
);

BucketKeyRevealModal.displayName = 'BucketsPanel.BucketKeyRevealModal';

/**
 * The show-once secret reveal dialog — renders inside the shared {@link ModalShell}. The Secret Access
 * Key is NEVER re-fetchable, so this is the owner's one chance to copy it. Big copy-to-clipboard button,
 * honest "shown once — rotate to get a new one" copy, and a "Copy both" convenience.
 */
const OwnerKeyRevealModal = memo(
  ({ accessKeyId, secret, onClose }: { accessKeyId: string; secret: string; onClose: () => void }) => {
    const [copied, setCopied] = useState(false);

    return (
      <ModalShell
        title="Your new access key"
        icon="i-ph:key-duotone"
        onClose={onClose}
        testId="buckets-owner-key-reveal"
      >
        <p className="text-[12px] text-bolt-elements-textSecondary leading-relaxed">
          Copy the <span className="font-semibold text-bolt-elements-textPrimary">Secret Access Key</span> now —
          it&rsquo;s <span className="font-semibold text-bolt-elements-item-contentAccent">shown once</span>. If you
          lose it, rotate to get a new one.
        </p>

        <div className="mt-3 space-y-2">
          <AddressRow label="Access Key ID" value={accessKeyId} hint="Pairs with the secret below" />
          <div className="rounded-lg border border-bolt-elements-item-contentAccent/40 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_5%,transparent)] p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wide text-bolt-elements-item-contentAccent">
                Secret Access Key
              </span>
              <button
                type="button"
                onClick={async () => {
                  const ok = await copyText(secret);

                  if (ok) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  } else {
                    postToastToParent('error', 'Could not copy.');
                  }
                }}
                data-testid="buckets-owner-key-copy-secret"
                aria-label="Copy the secret access key"
                className={classNames(BTN_PRIMARY, 'min-h-[24px] px-2 py-0.5 text-[10px]')}
              >
                <div className={classNames(copied ? 'i-ph:check-bold' : 'i-ph:copy', 'text-xs')} aria-hidden />
                <span className="min-w-[6ch] text-center">{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
            <p className="mt-0.5 text-[11px] font-mono text-bolt-elements-textPrimary break-all select-all">{secret}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={async () => {
              const ok = await copyText(`Access Key ID: ${accessKeyId}\nSecret Access Key: ${secret}`);
              postToastToParent(ok ? 'success' : 'error', ok ? 'Credentials copied.' : 'Could not copy.');
            }}
            className={classNames(BTN_SECONDARY, 'min-h-[32px] px-3 py-1.5 text-[12px]')}
          >
            <div className="i-ph:copy text-sm" aria-hidden /> Copy both
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid="buckets-owner-key-reveal-done"
            className={classNames(BTN_PRIMARY, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
          >
            <div className="i-ph:check text-sm" aria-hidden /> I&rsquo;ve saved it
          </button>
        </div>
      </ModalShell>
    );
  },
);

OwnerKeyRevealModal.displayName = 'BucketsPanel.OwnerKeyRevealModal';

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

// ── Clone-bucket dialog (B6) ──────────────────────────────────────────────────

/**
 * Clone a bucket (B6) — create a NEW bucket + server-side-copy the source bucket's objects into it. Renders
 * in the shared {@link ModalShell} (brand-dark, cyan, motion-safe entrance, focus-trap + Escape). PREFILLS
 * the new name as `{src}-copy` (AI-does-the-work / embarrassingly-easy — the owner just confirms), validates
 * it with the SAME rule as create, and on submit drives the `requestBucketClone` bridge (admin proxies to
 * `POST …/clone`). The clone is BOUNDED server-side; when the reply reports `truncated`, we surface an HONEST
 * "copied N of M (capped)" WARNING (never imply a full clone). A 409 name-collision keeps the dialog OPEN
 * with an inline error so the owner just picks another name (no doomed control). Exported for falsifiability
 * (mirrors {@link CreateBucketModal}).
 */
export const CloneBucketModal = memo(
  ({
    bucket,
    onClose,
    onCloned,
  }: {
    bucket: BucketEntry;
    onClose: () => void;
    onCloned: (newBucket: BucketEntry | null) => void;
  }) => {
    const [name, setName] = useState(`${bucket.name}-copy`);
    const [cloning, setCloning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          onClose();
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const valid = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,30}$/.test(name.trim()) && name.trim() !== bucket.name;

    const submit = useCallback(async () => {
      if (!valid || cloning) {
        return;
      }
      setCloning(true);
      setError(null);
      try {
        const reply = await requestBucketClone({ bucket: bucket.name, name: name.trim() });
        if (!reply.ok) {
          // A name-collision (409) keeps the dialog open with an inline reason (pick another name). A
          // needsCreds reply is a WARNING toast (storage still setting up), never a crash.
          if (reply.needsCreds) {
            postToastToParent('warning', reply.error || 'File storage for this site is still being set up.');
          }
          setError(reply.error || 'Could not clone the bucket.');
          return;
        }
        const copied = reply.copiedCount ?? 0;
        const total = reply.totalCount ?? copied;
        if (reply.truncated) {
          // HONEST partial-clone notice — never imply a complete clone.
          postToastToParent(
            'warning',
            `Cloned the first ${copied} of ${total} object${total === 1 ? '' : 's'} into ${name.trim()}. The bucket is larger than one clone can hold — copy the rest by folder.`,
          );
        } else {
          postToastToParent(
            'success',
            copied === 0
              ? `Created ${name.trim()} — the source bucket was empty, so nothing was copied.`
              : `Cloned ${copied} object${copied === 1 ? '' : 's'} into ${name.trim()}.`,
          );
        }
        onCloned(reply.bucket ?? null);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not clone the bucket.');
      } finally {
        setCloning(false);
      }
    }, [valid, cloning, name, bucket.name, onCloned, onClose]);

    return (
      <ModalShell
        title={`Clone ${bucket.name}`}
        icon="i-ph:copy-duotone"
        onClose={onClose}
        testId="buckets-clone-modal"
      >
        <label className="block">
          <span className="text-[11px] font-medium text-bolt-elements-textSecondary">New bucket name</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void submit();
              }
            }}
            placeholder={`${bucket.name}-copy`}
            aria-label="New bucket name"
            aria-invalid={name.length > 0 && !valid}
            data-testid="buckets-clone-name"
            className="mt-1 w-full min-h-[34px] px-3 py-1.5 text-[13px] rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/50"
          />
          <span className="mt-1 block text-[10px] text-bolt-elements-textTertiary">
            Creates a new private bucket and copies every object from {bucket.name} into it. Very large buckets
            copy the first slice — you’ll be told if so.
          </span>
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
            disabled={!valid || cloning}
            data-testid="buckets-clone-submit"
            aria-busy={cloning}
            className={classNames(BTN_PRIMARY, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
          >
            <div
              className={classNames(
                cloning ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:copy-bold',
                'text-sm',
              )}
              aria-hidden
            />
            <span className="min-w-[8ch] text-center">{cloning ? 'Cloning…' : 'Clone bucket'}</span>
          </button>
        </div>
      </ModalShell>
    );
  },
);

CloneBucketModal.displayName = 'BucketsPanel.CloneBucketModal';

/**
 * Settings launchpad for the clone (B6) — a self-contained section (like {@link BucketExportSection}) that
 * opens the {@link CloneBucketModal}. DISABLED with an inline reason while object storage is still being set
 * up (`objectOpsAvailable` false — the copy needs R2 S3 creds), so the owner never clicks a doomed control.
 * Exported for falsifiability.
 */
export const BucketCloneSection = memo(
  ({
    bucket,
    objectOpsAvailable,
    onCloned,
  }: {
    bucket: BucketEntry;
    objectOpsAvailable: boolean;
    onCloned: (newBucket: BucketEntry | null) => void;
  }) => {
    const [open, setOpen] = useState(false);
    return (
      <SettingsSection
        title="Clone this bucket"
        icon="i-ph:copy-duotone"
        hint={
          objectOpsAvailable
            ? 'Create a copy — a new private bucket with every object from this one (bounded for very large buckets).'
            : 'Available once file storage for this site finishes setting up.'
        }
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!objectOpsAvailable}
          data-testid="buckets-settings-clone"
          aria-label={`Clone ${bucket.name} into a new bucket`}
          className={classNames(
            BTN_SECONDARY,
            'min-h-[28px] px-3 py-1 text-[11px] disabled:opacity-45 disabled:cursor-not-allowed',
          )}
        >
          <div className="i-ph:copy text-sm" aria-hidden /> Clone bucket
        </button>
        {open && (
          <CloneBucketModal
            bucket={bucket}
            onClose={() => setOpen(false)}
            onCloned={(b) => {
              setOpen(false);
              onCloned(b);
            }}
          />
        )}
      </SettingsSection>
    );
  },
);

BucketCloneSection.displayName = 'BucketsPanel.BucketCloneSection';

// ── Object rename / copy / move dialog (B8) ───────────────────────────────────

/** Per-mode dialog copy — title, icon, input label, placeholder, help, and the submit verb. */
const OBJECT_OP_COPY: Record<
  'rename' | 'copy' | 'move',
  { title: string; icon: string; label: string; help: string; verb: string; busyVerb: string; submitIcon: string }
> = {
  copy: {
    busyVerb: 'Copying…',
    help: 'Makes a duplicate in this bucket. The original stays where it is.',
    icon: 'i-ph:copy-duotone',
    label: 'Copy as',
    submitIcon: 'i-ph:copy-bold',
    title: 'Copy file',
    verb: 'Copy',
  },
  move: {
    busyVerb: 'Moving…',
    help: 'Type a folder (e.g. images/archive). Leave blank to move it to the top level.',
    icon: 'i-ph:folder-open-duotone',
    label: 'Move to folder',
    submitIcon: 'i-ph:arrow-line-right-bold',
    title: 'Move file',
    verb: 'Move',
  },
  rename: {
    busyVerb: 'Renaming…',
    help: 'Renames the file in place. Keep the extension so it still opens correctly.',
    icon: 'i-ph:textbox-duotone',
    label: 'New name',
    submitIcon: 'i-ph:check-bold',
    title: 'Rename file',
    verb: 'Rename',
  },
};

/**
 * One dialog for the object ops (B8), rendered in the shared {@link ModalShell} (brand-dark, cyan,
 * motion-safe entrance, focus-trap + Escape from ModalShell). `rename`/`copy` prefill the current basename
 * + select it; `move` takes a destination folder (prefix). The destination key is derived by
 * {@link renameDestKey} / {@link moveDestKey}; a live client-side COLLISION GUARD disables submit when the
 * computed key already exists IN THE DESTINATION BUCKET (no doomed overwrite).
 *
 * CROSS-bucket: for `copy`/`move` on a multi-bucket site, a **destination-bucket picker** lets the owner
 * send the object to ANOTHER of their buckets. It defaults to `currentBucket` (same-bucket path unchanged).
 * `rename` is always in-place (no picker). When the chosen bucket differs from the current one, the
 * same-bucket collision check (`existingKeys`) no longer applies — the SAME key in another bucket is a
 * legitimate destination; a real collision there surfaces as a server `conflict`. `onSubmit`'s 3rd arg is
 * the chosen bucket (or `undefined` when there's no picker). Returns `{ok, conflict}` so a server race still
 * surfaces inline. Never a dead-end: submit stays disabled with a reason until valid + non-colliding.
 */
export const ObjectCopyDialog = memo(
  ({
    mode,
    srcKey,
    existingKeys,
    buckets,
    currentBucket,
    onClose,
    onSubmit,
  }: {
    mode: 'rename' | 'copy' | 'move';
    srcKey: string;
    existingKeys: readonly string[];
    /** All of the site's bucket display names — the cross-bucket destination options. Optional. */
    buckets?: readonly string[];
    /** The bucket the object currently lives in — the picker's default (same-bucket). Optional. */
    currentBucket?: string;
    onClose: () => void;
    onSubmit: (
      destKey: string,
      deleteSource: boolean,
      destBucket?: string,
    ) => Promise<{ ok: boolean; conflict?: boolean }>;
  }) => {
    const copy = OBJECT_OP_COPY[mode];
    const baseName = objectBaseName(srcKey);
    const parentPrefix = objectParentPrefix(srcKey);
    // rename/copy start from the current name; move starts from the current folder.
    const [value, setValue] = useState(mode === 'move' ? parentPrefix : baseName);
    // CROSS-bucket destination. Defaults to the current bucket (same-bucket). Only copy/move can cross.
    const [destBucket, setDestBucket] = useState(currentBucket ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // The picker shows only when crossing is possible: copy/move + a multi-bucket site. Rename is in-place.
    const otherBuckets = (buckets ?? []).filter(Boolean);
    const canCrossBucket = (mode === 'copy' || mode === 'move') && otherBuckets.length > 1 && !!currentBucket;
    // True once the owner points at a DIFFERENT bucket than the object's current one.
    const crossing = canCrossBucket && destBucket !== '' && destBucket !== currentBucket;

    useEffect(() => {
      const el = inputRef.current;

      if (!el) {
        return;
      }

      el.focus();
      // Select just the filename stem (before the extension) for rename/copy so a quick retype keeps the
      // extension; move selects all (it's a folder path).
      if (mode === 'move') {
        el.select();
      } else {
        const dot = baseName.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : baseName.length);
      }
    }, [mode, baseName]);

    // The computed destination key + validity. rename forbids `/` (that's a move); move is always a prefix.
    const destKey = mode === 'move' ? moveDestKey(srcKey, value) : renameDestKey(srcKey, value);
    // A no-op only when NOT crossing buckets (the same key in ANOTHER bucket is a real copy/move).
    const unchanged = destKey === srcKey && !crossing;
    // The same-bucket collision guard applies only when the destination IS the current bucket. Crossing to
    // another bucket means `existingKeys` (this bucket's listing) no longer describes the destination.
    const collides = !crossing && destKey !== null && destKey !== srcKey && existingKeys.includes(destKey);
    const valid = destKey !== null && !unchanged && !collides;

    const reason = !destKey
      ? mode === 'rename'
        ? 'Enter a name (no “/” — use Move to change folders).'
        : 'Enter a destination.'
      : unchanged
        ? mode === 'move'
          ? 'Pick a different folder or bucket.'
          : 'Pick a different name or bucket.'
        : collides
          ? 'Something with that name already exists here.'
          : null;

    const submit = useCallback(async () => {
      if (!valid || busy || destKey === null) {
        return;
      }

      setBusy(true);
      setError(null);
      // copy keeps source; rename/move delete it. The 3rd arg is the chosen bucket (undefined = no picker).
      const chosenBucket = canCrossBucket ? destBucket || currentBucket : currentBucket;
      const r = await onSubmit(destKey, mode !== 'copy', chosenBucket);

      if (!r.ok) {
        setError(r.conflict ? 'Something with that name already exists there.' : 'Could not complete that.');
        setBusy(false);
      }
      // On success the parent unmounts this dialog — no need to clear `busy`.
    }, [valid, busy, destKey, mode, onSubmit, canCrossBucket, destBucket, currentBucket]);

    return (
      <ModalShell title={copy.title} icon={copy.icon} onClose={onClose} testId="buckets-object-op-modal">
        <p className="mb-3 text-[11px] text-bolt-elements-textTertiary">
          <span className="text-bolt-elements-textSecondary">{baseName}</span>
          {parentPrefix && <span> in {parentPrefix}</span>}
        </p>

        <label className="block">
          <span className="text-[11px] font-medium text-bolt-elements-textSecondary">{copy.label}</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void submit();
              }
            }}
            placeholder={mode === 'move' ? 'images/archive' : baseName}
            aria-label={copy.label}
            aria-invalid={!!reason && value.trim().length > 0}
            disabled={busy}
            data-testid="buckets-object-op-input"
            className="mt-1 w-full min-h-[34px] px-3 py-1.5 text-[13px] rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/50 disabled:opacity-60"
          />
          <span className="mt-1 block text-[10px] text-bolt-elements-textTertiary">{copy.help}</span>
        </label>

        {canCrossBucket && (
          <label className="mt-3 block">
            <span className="text-[11px] font-medium text-bolt-elements-textSecondary">Destination bucket</span>
            <div className="relative mt-1">
              <select
                value={destBucket}
                onChange={(e) => {
                  setDestBucket(e.target.value);
                  setError(null);
                }}
                disabled={busy}
                aria-label="Destination bucket"
                data-testid="buckets-object-op-destbucket"
                className="w-full min-h-[34px] appearance-none rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 pr-8 text-[13px] text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/50 disabled:opacity-60"
              >
                {otherBuckets.map((b) => (
                  <option key={b} value={b}>
                    {b}
                    {b === currentBucket ? ' (this bucket)' : ''}
                  </option>
                ))}
              </select>
              <div
                className="i-ph:caret-down pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-bolt-elements-textTertiary"
                aria-hidden
              />
            </div>
            <span className="mt-1 block text-[10px] text-bolt-elements-textTertiary">
              {crossing
                ? mode === 'move'
                  ? 'Moves the file to the other bucket (copied there, then removed from here).'
                  : 'Copies the file into the other bucket. The original stays here.'
                : 'Keep this bucket, or pick another one of your buckets.'}
            </span>
          </label>
        )}

        {destKey && valid && (
          <p className="mt-2 text-[10px] text-bolt-elements-textTertiary">
            → <span className="font-mono text-bolt-elements-textSecondary">{crossing ? `${destBucket}/` : ''}{destKey}</span>
          </p>
        )}

        {(error || (reason && value.trim().length > 0)) && (
          <p className="mt-3 text-[11px] text-red-400" role="alert" data-testid="buckets-object-op-error">
            {error ?? reason}
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
            disabled={!valid || busy}
            data-testid="buckets-object-op-submit"
            className={classNames(BTN_PRIMARY, 'min-h-[32px] px-4 py-1.5 text-[12px]')}
          >
            <div
              className={classNames(
                busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : copy.submitIcon,
                'text-sm',
              )}
              aria-hidden
            />
            <span className="min-w-[6ch] text-center">{busy ? copy.busyVerb : copy.verb}</span>
          </button>
        </div>
      </ModalShell>
    );
  },
);

ObjectCopyDialog.displayName = 'BucketsPanel.ObjectCopyDialog';

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
              ? 'This bucket still has files in it — emptying it is being set up for your site.'
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

/*
 * ── In-editor object preview modal (B12) ──────────────────────────────────────
 * SEE a file without downloading it. Fetches bytes once via the existing `requestBucketDownload`
 * bridge (→ `PS_R2_DOWNLOAD_RESULT`, a base64 data URL), decodes to an OPAQUE blob: URL, and renders
 * by {@link classifyPreview}:
 *   • image  → inert `<img>`
 *   • pdf    → SANDBOXED `<iframe sandbox>` (NO `allow-scripts` — untrusted bytes never execute)
 *   • text   → fetched + ESCAPED in a `<pre>` (React escapes text children; never innerHTML)
 *   • video/audio → inert `<video controls>` / `<audio controls>`
 *   • none   → graceful "No preview available — Download" fallback (never a doomed control)
 * Loading + error states included; the blob: URL is REVOKED on close/unmount (no leak). Rendered in
 * the shared {@link ModalShell} (brand-dark, cyan, motion-safe entrance, focus-trap, Escape-to-close).
 */

type PreviewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; kind: PreviewKind; blobUrl?: string; text?: string; contentType?: string };

const ObjectPreviewModal = memo(
  ({
    bucket,
    objectKey,
    onClose,
    onDownload,
  }: {
    bucket: string;
    objectKey: string;
    onClose: () => void;
    /** Reuse the parent's download action for the fallback + the header's Download affordance. */
    onDownload: (key: string) => void;
  }) => {
    const [state, setState] = useState<PreviewState>({ status: 'loading' });

    // Hold the created blob: URL so cleanup revokes exactly what we made (untrusted-bytes hygiene).
    const blobUrlRef = useRef<string | null>(null);
    const name = objectKey.split('/').pop() || objectKey;

    useEffect(() => {
      let cancelled = false;

      const revoke = () => {
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
          blobUrlRef.current = null;
        }
      };

      void (async () => {
        try {
          const reply = await requestBucketDownload({ bucket, key: objectKey });

          if (cancelled) {
            return;
          }

          if (!reply.ok || !reply.dataUrl) {
            setState({ status: 'error', message: reply.error || 'Couldn’t load preview.' });
            return;
          }

          const kind = classifyPreview(objectKey, reply.contentType);

          if (kind === 'text') {
            setState({ status: 'ready', kind, text: dataUrlToText(reply.dataUrl), contentType: reply.contentType });
            return;
          }

          if (kind === 'none') {
            setState({ status: 'ready', kind, contentType: reply.contentType });
            return;
          }

          // image / pdf / video / audio → render from an opaque blob: URL (never the inline data: URL).
          const blob = dataUrlToBlob(reply.dataUrl);

          if (!blob) {
            setState({ status: 'error', message: 'Couldn’t load preview.' });
            return;
          }

          revoke();

          const blobUrl = URL.createObjectURL(blob);
          blobUrlRef.current = blobUrl;
          setState({ status: 'ready', kind, blobUrl, contentType: reply.contentType });
        } catch (err) {
          if (!cancelled) {
            setState({ status: 'error', message: err instanceof Error ? err.message : 'Couldn’t load preview.' });
          }
        }
      })();

      return () => {
        cancelled = true;
        revoke();
      };
    }, [bucket, objectKey]);

    const downloadBtn = (
      <button
        type="button"
        onClick={() => {
          onDownload(objectKey);
          onClose();
        }}
        data-testid="buckets-preview-download"
        className={classNames(BTN_SECONDARY, 'min-h-[28px] px-3 py-1 text-[11px]')}
      >
        <div className="i-ph:download-simple text-sm" aria-hidden /> Download
      </button>
    );

    return (
      <ModalShell title={name} icon="i-ph:eye-duotone" onClose={onClose} testId="buckets-preview-modal">
        <div className="space-y-3" data-testid="buckets-preview-body">
          {state.status === 'loading' && (
            <div
              className="flex flex-col items-center justify-center gap-2 py-12 text-center"
              data-testid="buckets-preview-loading"
              aria-busy="true"
            >
              <div
                className="i-ph:circle-notch text-2xl text-bolt-elements-item-contentAccent animate-spin motion-reduce:animate-none"
                aria-hidden
              />
              <p className="text-[11px] text-bolt-elements-textTertiary">Loading preview…</p>
            </div>
          )}

          {state.status === 'error' && (
            <div
              className="flex flex-col items-center gap-3 py-10 text-center"
              role="alert"
              data-testid="buckets-preview-error"
            >
              <div className="i-ph:warning-circle-duotone text-3xl text-red-400" aria-hidden />
              <p className="text-[12px] text-bolt-elements-textSecondary">Couldn’t load preview.</p>
              {downloadBtn}
            </div>
          )}

          {state.status === 'ready' && state.kind === 'image' && state.blobUrl && (
            <div className="flex items-center justify-center rounded-xl border border-bolt-elements-borderColor/60 bg-[radial-gradient(120%_80%_at_50%_0%,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_6%,transparent),transparent_60%),var(--bolt-elements-bg-depth-1)] p-2 ring-1 ring-inset ring-bolt-elements-borderColor/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
              {/* Inert element — bytes can't execute. `bg-[length:...]` checker reads transparency. */}
              <img
                src={state.blobUrl}
                alt={name}
                data-testid="buckets-preview-image"
                className="max-h-[60vh] max-w-full rounded-lg object-contain"
                style={{
                  backgroundImage:
                    'linear-gradient(45deg,#1a1a26 25%,transparent 25%),linear-gradient(-45deg,#1a1a26 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#1a1a26 75%),linear-gradient(-45deg,transparent 75%,#1a1a26 75%)',
                  backgroundSize: '16px 16px',
                  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
                }}
              />
            </div>
          )}

          {state.status === 'ready' && state.kind === 'pdf' && state.blobUrl && (
            <iframe
              // SANDBOXED — NO `allow-scripts`: an untrusted PDF/any-HTML payload can never run code.
              sandbox=""
              src={state.blobUrl}
              title={`Preview of ${name}`}
              data-testid="buckets-preview-pdf"
              className="h-[60vh] w-full rounded-xl border border-bolt-elements-borderColor/60 bg-white"
            />
          )}

          {state.status === 'ready' && state.kind === 'text' && (
            <pre
              data-testid="buckets-preview-text"
              className="max-h-[60vh] overflow-auto modern-scrollbar rounded-xl border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1 p-3 font-mono text-[11px] leading-relaxed text-bolt-elements-textSecondary whitespace-pre-wrap break-words ring-1 ring-inset ring-bolt-elements-borderColor/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
            >
              {/* React escapes text children — the source is shown, never executed / interpreted. */}
              {state.text}
            </pre>
          )}

          {state.status === 'ready' && state.kind === 'video' && state.blobUrl && (
            <video
              src={state.blobUrl}
              controls
              data-testid="buckets-preview-video"
              className="max-h-[60vh] w-full rounded-xl border border-bolt-elements-borderColor/60 bg-black"
            >
              <track kind="captions" />
            </video>
          )}

          {state.status === 'ready' && state.kind === 'audio' && state.blobUrl && (
            <div className="rounded-xl border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1 p-4">
              <audio src={state.blobUrl} controls data-testid="buckets-preview-audio" className="w-full">
                <track kind="captions" />
              </audio>
            </div>
          )}

          {state.status === 'ready' && state.kind === 'none' && (
            <div
              className="flex flex-col items-center gap-3 py-10 text-center"
              data-testid="buckets-preview-unavailable"
            >
              <div className="i-ph:file-dashed-duotone text-3xl text-bolt-elements-textTertiary" aria-hidden />
              <div>
                <p className="text-[12px] font-medium text-bolt-elements-textSecondary">No preview available</p>
                <p className="mt-0.5 text-[10px] text-bolt-elements-textTertiary">
                  This file type can’t be shown here — download it to open it.
                </p>
              </div>
              {downloadBtn}
            </div>
          )}

          {/* A persistent Download affordance for the renderable types (fallback states embed their own). */}
          {state.status === 'ready' && state.kind !== 'none' && (
            <div className="flex items-center justify-end border-t border-bolt-elements-borderColor/40 pt-3">
              {downloadBtn}
            </div>
          )}
        </div>
      </ModalShell>
    );
  },
);

ObjectPreviewModal.displayName = 'BucketsPanel.ObjectPreviewModal';

export { ObjectPreviewModal };

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
  }) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    /*
     * Accessible dialog (WCAG 2.4.3 / 2.1.2): move focus in on open, TRAP Tab within, close on Escape.
     * Runs once per mount (latest onClose via ref) so it never steals focus on re-render.
     */
    useEffect(() => {
      const panel = panelRef.current;

      if (!panel) {
        return undefined;
      }

      const FOCUSABLE =
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
      const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));

      // Pull focus in only if it isn't already inside (a child modal may have autofocused its input).
      if (!panel.contains(document.activeElement)) {
        (focusables()[0] ?? panel).focus();
      }

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCloseRef.current();

          return;
        }

        if (e.key !== 'Tab') {
          return;
        }

        const els = focusables();

        if (els.length === 0) {
          e.preventDefault();
          panel.focus();

          return;
        }

        const first = els[0];
        const last = els[els.length - 1];
        const active = document.activeElement;

        if (e.shiftKey && (active === first || active === panel)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      };

      document.addEventListener('keydown', onKey, true);

      return () => document.removeEventListener('keydown', onKey, true);
    }, []);

    return (
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
        <div
          ref={panelRef}
          tabIndex={-1}
          className="relative w-full max-w-md rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 shadow-2xl shadow-black/40 overflow-hidden focus:outline-none"
        >
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
    );
  },
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

/**
 * B11 — the "searching all objects…" in-flight state for a whole-bucket server search. Distinct from the
 * generic skeleton so the copy is HONEST + specific about what's happening (scanning the ENTIRE bucket,
 * not just the loaded page). Motion-reduce safe (the spinner pulse respects `prefers-reduced-motion`).
 */
const ObjectsSearching = memo(({ term }: { term: string }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    role="status"
    aria-live="polite"
    data-testid="buckets-objects-searching"
  >
    <div className="flex items-center justify-center h-12 w-12 rounded-2xl border border-bolt-elements-item-contentAccent/30 bg-[color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_7%,transparent)] shadow-[0_0_28px_-6px_color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_55%,transparent)]">
      <div className="i-ph:magnifying-glass-duotone text-2xl text-bolt-elements-item-contentAccent motion-safe:animate-pulse" aria-hidden />
    </div>
    <p className="text-xs text-bolt-elements-textSecondary max-w-[280px] leading-relaxed">
      Searching all objects{term ? <> for “<span className="text-bolt-elements-textPrimary font-medium">{term}</span>”</> : ''}…
    </p>
  </div>
));

ObjectsSearching.displayName = 'BucketsPanel.ObjectsSearching';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    role="alert"
    data-testid="buckets-error"
  >
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
    role="status"
    data-testid="buckets-disabled"
  >
    <div className="flex items-center justify-center h-16 w-16 rounded-2xl border border-bolt-elements-borderColor bg-[radial-gradient(120%_120%_at_50%_0%,color-mix(in_oklch,var(--bolt-elements-item-contentAccent)_6%,transparent),transparent_60%),var(--bolt-elements-bg-depth-2)]">
      <div className="i-ph:lock-key-duotone text-3xl text-bolt-elements-textTertiary" aria-hidden />
    </div>
    <p className="text-sm font-semibold text-bolt-elements-textSecondary text-balance">Buckets aren&rsquo;t enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px] leading-relaxed">
      This is on the way. Once it&rsquo;s turned on, your site&rsquo;s buckets show up here — nothing to set up.
    </p>
  </div>
));

DisabledCard.displayName = 'BucketsPanel.DisabledCard';

const ObjectsNeedsCreds = memo(({ message }: { message: string }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    role="status"
    data-testid="buckets-objects-needs-creds"
  >
    <div
      className="flex items-center justify-center h-14 w-14 rounded-2xl border"
      style={{ borderColor: `color-mix(in oklch, ${PURPLE} 40%, transparent)` }}
    >
      <div className="i-ph:cloud-arrow-up-duotone text-3xl" style={{ color: PURPLE_INK }} aria-hidden />
    </div>
    <p className="text-sm font-semibold text-bolt-elements-textSecondary">File uploads are being set up</p>
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
    className={EMPTY_LAUNCHPAD_CLASS}
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
      className={EMPTY_LAUNCHPAD_CLASS}
      icon={hasFilter ? 'i-ph:magnifying-glass-duotone' : 'i-ph:folder-dashed-duotone'}
      title={hasFilter ? 'No matching objects' : 'This bucket is empty'}
      description={
        hasFilter
          ? 'No files match that search. Try a shorter term or clear the search.'
          : 'Drag files here, or upload — they show up here to reuse anywhere.'
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
