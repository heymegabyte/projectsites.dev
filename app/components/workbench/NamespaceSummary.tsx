/**
 * @file Namespace Summary — the Resources tab's prominent per-site WfP-namespace rollup.
 *
 * @remarks
 * A cinematic hero panel that ACCOUNTS FOR EVERY resource scoped under the site's Cloudflare
 * Workers-for-Platforms dispatch namespace, for the chosen environment. It answers, at a glance:
 * "what does my site's infrastructure actually consist of?" — the namespace name, a headline count of
 * connected resources, how many have drifted, and a per-kind breakdown (D1 / KV / R2 / Durable Objects /
 * Workflows / Queues / Vectorize / bindings / connections / observability) with counts + a status dot
 * (connected · available-to-add · unsupported) + the environment (preview vs production).
 *
 * DERIVED, not fetched: the entire rollup is computed CLIENT-SIDE from the SAME
 * `PS_RES_OVERVIEW_REQUEST` inventory (`ResourceOverviewEntry[]`) the {@link ResourceOverviewPanel}
 * already loads — no new bridge message, no extra round-trip, no client-supplied CF ids (every id stays
 * server-resolved; this panel only reads the kinds/states/bindings the server already returned).
 *
 * Honesty (per CAPABILITY-MATRIX.md): kinds Cloudflare cannot expose (Queues with no binding, DO state
 * browse) surface as an honest "unsupported" dot, never a fake count. The namespace name is derived
 * from the inventory's WfP/function entries when present, else shown as "resolved server-side" rather
 * than fabricated. An empty inventory renders a calm, on-brand empty rollup — never a scary blank.
 *
 * Style mirrors the sibling panels EXACTLY (UnoCSS `bolt-elements-*` tokens → black `#060610` + cyan
 * `#00e5ff`, phosphor `i-ph:*` icons, ≥24px targets, aria-labels, focus-visible rings, motion via
 * `motion-reduce:*`). Presentational + pure — it takes the already-loaded entries and renders; it owns
 * no bridge state of its own.
 */
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import type { ResourceOverviewEntry } from '~/lib/embed/embedded-mode';

/**
 * How long a freshly-observed drift set sits before the AUTOMATIC reconcile fires (per
 * `real-time-data-no-manual-refresh` — reconciliation is silent + automatic, never a button). The
 * debounce coalesces bursty inventory updates so one heal covers them, and a ref-key on the drifted
 * ids makes persistent drift reconcile ONCE per observed set instead of spamming the server.
 */
const AUTO_RECONCILE_DEBOUNCE_MS = 1_500;

/** Cadence for re-rendering the quiet "synced Ns ago" label so it stays honest without user action. */
const SYNC_TICK_MS = 15_000;

/** Format a wall-clock delta as a compact "Ns/Nm/Nh ago" for the quiet sync affordance. */
function syncedAgo(sinceMs: number): string {
  const seconds = Math.max(0, Math.round(sinceMs / 1000));

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  return `${Math.round(minutes / 60)}h ago`;
}

// ── Kind taxonomy (the canonical set the summary always accounts for) ────────────

/**
 * The canonical resource kinds a site's namespace is measured against. EVERY row renders — even a kind
 * with zero resources — so the owner sees the COMPLETE accounting (what they have AND what they could
 * add), never a partial list. Order = data stores first, then compute, then platform glue.
 */
interface KindSpec {
  /** Canonical key used to bucket inventory entries (case-insensitive substring match). */
  key: string;
  /** Human label. */
  label: string;
  /** Phosphor duotone icon. */
  icon: string;
  /** Substrings that map a raw `resource_kind` into this bucket. */
  match: string[];
  /**
   * A caveat about what Cloudflare can expose for this kind (per CAPABILITY-MATRIX.md) — shown as the
   * tile title/hover. INFORMATIONAL only: a kind can carry a note AND still be a reachable surface
   * (e.g. Durable Objects — the drill-in honestly shows namespaces/ids, never state). Use
   * {@link KindSpec.unsupported} for a kind that genuinely cannot be surfaced on this deployment.
   */
  platformNote?: string;
  /**
   * TRUE when this deployment structurally cannot surface the kind at all (per CAPABILITY-MATRIX.md +
   * the adapter's `UNSUPPORTED_KINDS`) — e.g. Queues, which has NO `QUEUE` binding here. Such a tile
   * shows an honest "Not available" and is NEVER an actionable drill-in (never a doomed control per
   * `action-button-must-gate-on-server-precondition`). Distinct from a mere `platformNote` caveat.
   */
  unsupported?: boolean;
  /**
   * TRUE for a kind that is SUPPORTED + countable but has no per-kind adapter drill-in endpoint
   * (the owner-grade wire kinds `wfp_worker` / `hostname` / `routing` — the worker's detail route
   * only serves the adapter kinds). The tile counts honestly but stays presentational — never a
   * doomed click into a 400.
   */
  noDrill?: boolean;
}

export const KIND_SPECS: KindSpec[] = [
  { key: 'd1', label: 'D1 Databases', icon: 'i-ph:database-duotone', match: ['d1', 'database', 'sql'] },
  { key: 'kv', label: 'KV Namespaces', icon: 'i-ph:key-duotone', match: ['kv', 'key'] },
  // NOTE: no bare 'object' match — `durable_object` contains it and would mis-bucket under R2
  // (caught by owner-resource-mapping.spec). 'r2'/'bucket'/'storage' cover the real variants.
  { key: 'r2', label: 'R2 Buckets', icon: 'i-ph:cloud-duotone', match: ['r2', 'bucket', 'storage'] },
  {
    key: 'durable_object',
    label: 'Durable Objects',
    icon: 'i-ph:cube-duotone',
    match: ['durable', 'do'],
    platformNote: 'Cloudflare can address instances, not browse all state',
  },
  { key: 'workflow', label: 'Workflows', icon: 'i-ph:flow-arrow-duotone', match: ['workflow'] },
  {
    key: 'queue',
    label: 'Queues',
    icon: 'i-ph:queue-duotone',
    match: ['queue'],
    platformNote: 'No queue binding on this account yet',
    unsupported: true,
  },
  { key: 'vectorize', label: 'Vectorize', icon: 'i-ph:graph-duotone', match: ['vectorize', 'vector', 'index'] },
  { key: 'binding', label: 'Bindings', icon: 'i-ph:plugs-connected-duotone', match: ['binding', 'ai', 'browser'] },
  { key: 'connection', label: 'Connections', icon: 'i-ph:link-duotone', match: ['connection', 'mcp', 'hyperdrive'] },
  {
    key: 'observability',
    label: 'Observability',
    icon: 'i-ph:chart-line-duotone',
    match: ['observability', 'analytics', 'logs', 'metric'],
  },
  {
    key: 'worker',
    label: 'Site Workers',
    icon: 'i-ph:function-duotone',
    match: ['wfp', 'worker', 'dispatch'],
    platformNote: 'The Worker that serves your site, deployed per environment',
    noDrill: true,
  },
  {
    key: 'domain',
    label: 'Domains & Routing',
    icon: 'i-ph:globe-duotone',
    match: ['hostname', 'routing', 'dns'],
    platformNote: 'Where your site is reachable — your subdomain and any custom domains',
    noDrill: true,
  },
];

/** Any inventory entry not matched by a KindSpec falls into a catch-all row so nothing is dropped. */
const OTHER_SPEC: KindSpec = { key: 'other', label: 'Other Resources', icon: 'i-ph:stack-duotone', match: [] };

// ── Availability (mirrors ResourceOverviewPanel's server-driven classification) ──

type Availability = 'connected' | 'available' | 'unsupported';

/**
 * What a kind-tile click hands back to the Resources tab so it can open that kind's per-kind
 * drill-in — NEVER a Cloudflare id (the summary only knows kinds/counts; every real id stays
 * server-resolved). `availability` lets the detail panel lead with the right action: `connected`
 * → read + per-action writes; `available` → provision-first; a tile that is `unsupported` never
 * opens (it's not a button). This is the bridge that makes the dark per-site KV / Durable Objects /
 * Queues / Connections / Observability surfaces REACHABLE from the at-a-glance rollup.
 */
export interface OpenKindTarget {
  /** Canonical kind key (`kv` | `durable_object` | `queue` | `connection` | `observability` | …). */
  kind: string;
  /** The kind's availability verdict, so the detail panel leads with the right primary action. */
  availability: Extract<Availability, 'connected' | 'available'>;
}

function availabilityFor(entry: ResourceOverviewEntry): Availability {
  const s = (entry.lifecycle_state || '').toLowerCase();

  if (s.includes('unsupported') || s.includes('unavailable')) {
    return 'unsupported';
  }

  if (s.includes('available') || s.includes('not_connected') || s.includes('unbound') || s.includes('proposed')) {
    return 'available';
  }

  return 'connected';
}

/** Bucket a raw `resource_kind` into a KindSpec (first substring match wins), else OTHER. */
export function specForKind(kind: string): KindSpec {
  const k = (kind || '').toLowerCase();

  for (const spec of KIND_SPECS) {
    if (spec.match.some((m) => k.includes(m))) {
      return spec;
    }
  }

  return OTHER_SPEC;
}

// ── Rollup shape ─────────────────────────────────────────────────────────────

interface KindRollup {
  spec: KindSpec;
  total: number;
  connected: number;
  available: number;
  unsupported: number;
  drifted: number;
  /** Environments this kind's resources span (for a compact env chip). */
  environments: Set<string>;
}

interface NamespaceRollup {
  /** The resolved WfP dispatch namespace label, or null when the inventory can't name it. */
  namespaceLabel: string | null;
  totalResources: number;
  connected: number;
  available: number;
  unsupported: number;
  drifted: number;
  kinds: KindRollup[];
  /** Kinds that actually have ≥1 resource, for the "N of M kinds in use" headline. */
  kindsInUse: number;
}

/** A stable, blank rollup row for a kind (so every canonical kind always renders). */
function blankRollup(spec: KindSpec): KindRollup {
  return { spec, total: 0, connected: 0, available: 0, unsupported: 0, drifted: 0, environments: new Set<string>() };
}

/**
 * Try to name the site's WfP dispatch namespace from the inventory itself — a function/WfP/dispatch
 * entry carries it in its binding or concept. We NEVER fabricate one; when nothing names it, the caller
 * shows an honest "resolved server-side" label instead.
 */
function deriveNamespaceLabel(resources: ResourceOverviewEntry[]): string | null {
  for (const entry of resources) {
    const k = (entry.resource_kind || '').toLowerCase();
    const isWfp = k.includes('wfp') || k.includes('dispatch') || k.includes('function') || k.includes('namespace');

    if (isWfp) {
      // The owner-grade wire carries the REAL dispatch-namespace name in the advanced detail
      // (`… · namespace: project-sites-endpoints`) — prefer it over the concept token.
      const fromDetail = /namespace:\s*([^\s·]+)/.exec(entry.detail || '')?.[1];

      if (fromDetail) {
        return fromDetail;
      }

      const candidate = (entry.resource_concept || entry.binding_name || '').trim();

      if (candidate) {
        return candidate;
      }
    }
  }

  return null;
}

/** Compute the whole namespace rollup from the already-loaded inventory. Pure. */
function computeRollup(resources: ResourceOverviewEntry[]): NamespaceRollup {
  const byKey = new Map<string, KindRollup>();

  // Seed every canonical kind so the accounting is COMPLETE, not just what happens to exist.
  for (const spec of KIND_SPECS) {
    byKey.set(spec.key, blankRollup(spec));
  }

  let connected = 0;
  let available = 0;
  let unsupported = 0;
  let drifted = 0;

  for (const entry of resources) {
    const spec = specForKind(entry.resource_kind);
    let row = byKey.get(spec.key);

    if (!row) {
      row = blankRollup(spec);
      byKey.set(spec.key, row);
    }

    row.total += 1;
    row.environments.add(entry.environment || 'default');

    const availability = availabilityFor(entry);

    if (availability === 'connected') {
      row.connected += 1;
      connected += 1;
    } else if (availability === 'available') {
      row.available += 1;
      available += 1;
    } else {
      row.unsupported += 1;
      unsupported += 1;
    }

    if (entry.drift_code) {
      row.drifted += 1;
      drifted += 1;
    }
  }

  const kinds = [...byKey.values()];
  const kindsInUse = kinds.filter((k) => k.total > 0).length;

  return {
    namespaceLabel: deriveNamespaceLabel(resources),
    totalResources: resources.length,
    connected,
    available,
    unsupported,
    drifted,
    kinds,
    kindsInUse,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * The per-site WfP-namespace summary. Renders a hero band (namespace identity + headline stats) over a
 * per-kind accounting grid. Presentational — it derives everything from `resources` (the same inventory
 * the overview loaded) and never fetches. Reconciliation is REAL-TIME (per
 * `real-time-data-no-manual-refresh`): when `onReconcile` is provided and drift appears, the summary
 * calls it automatically (debounced, once per observed drift set) — there is no manual button; the only
 * freshness signal is the quiet "synced Ns ago" status line.
 */
export const NamespaceSummary = memo(
  ({
    resources,
    environment,
    onReconcile,
    reconciling,
    onOpenKind,
  }: {
    resources: ResourceOverviewEntry[];
    environment: string;
    /** Silent auto-heal hook — invoked AUTOMATICALLY (debounced) when drift is observed; never a button. */
    onReconcile?: () => void;
    /** True while the parent's reconcile is in flight — drives the quiet "Syncing…" affordance. */
    reconciling?: boolean;
    /**
     * Open a kind's per-kind drill-in. When provided, every SUPPORTED kind tile (including
     * zero-count ones) becomes a keyboard-operable button — so the dark per-site KV / Durable
     * Objects / Queues / Connections / Observability surfaces are reachable, never orphaned tiles.
     * Omit to keep the summary purely presentational (backward compatible).
     */
    onOpenKind?: (target: OpenKindTarget) => void;
  }) => {
    const rollup = useMemo(() => computeRollup(resources), [resources]);
    const envLabel = environment.charAt(0).toUpperCase() + environment.slice(1);

    /*
     * AUTOMATIC + SILENT drift reconcile. A stable signature of the drifted ids gates the call so one
     * observed drift set heals exactly once (a persistent-drift re-render can't spam the server), and
     * the debounce lets bursty inventory updates settle before the single heal fires. Cleared when the
     * inventory comes back clean so a NEW drift set reconciles again. Never a click (R1 mandate).
     */
    const driftKey = useMemo(
      () =>
        resources
          .filter((r) => Boolean(r.drift_code))
          .map((r) => r.id)
          .sort()
          .join('|'),
      [resources],
    );
    const lastReconciledKey = useRef('');
    useEffect(() => {
      if (!onReconcile || reconciling) {
        return undefined;
      }

      if (!driftKey) {
        lastReconciledKey.current = '';
        return undefined;
      }

      if (driftKey === lastReconciledKey.current) {
        return undefined;
      }

      const timer = setTimeout(() => {
        lastReconciledKey.current = driftKey;
        onReconcile();
      }, AUTO_RECONCILE_DEBOUNCE_MS);

      return () => clearTimeout(timer);
    }, [driftKey, onReconcile, reconciling]);

    /*
     * The quiet "synced Ns ago" freshness affordance — the ONLY signal standing in for the removed
     * Reconcile button. Stamped when a reconcile completes (reconciling true→false) or when the
     * inventory is first observed clean; a slow self-tick keeps the relative label honest (paused
     * while the tab is hidden).
     */
    const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
    const prevReconciling = useRef(Boolean(reconciling));
    useEffect(() => {
      if (prevReconciling.current && !reconciling) {
        setLastSyncedAt(Date.now());
      }

      prevReconciling.current = Boolean(reconciling);
    }, [reconciling]);
    useEffect(() => {
      if (rollup.drifted === 0) {
        setLastSyncedAt((cur) => cur ?? Date.now());
      }
    }, [rollup.drifted]);
    const [, forceTick] = useState(0);
    useEffect(() => {
      const id = setInterval(() => {
        if (typeof document === 'undefined' || !document.hidden) {
          forceTick((n) => n + 1);
        }
      }, SYNC_TICK_MS);

      return () => clearInterval(id);
    }, []);

    const syncing = Boolean(reconciling) || rollup.drifted > 0;
    const syncLabel = reconciling
      ? 'Syncing your resources…'
      : rollup.drifted > 0
        ? `${rollup.drifted} resource${rollup.drifted === 1 ? '' : 's'} drifted · syncing automatically`
        : lastSyncedAt
          ? `In sync · synced ${syncedAgo(Date.now() - lastSyncedAt)}`
          : 'In sync';

    return (
      <section
        data-testid="namespace-summary"
        aria-label="Namespace summary"
        className="relative overflow-hidden rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2"
      >
        {/* Cinematic cyan wash — transform/opacity-safe, motion-reduce respected via the static gradient */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(120% 100% at 0% 0%, color-mix(in oklch, #00e5ff 12%, transparent), transparent 55%), radial-gradient(90% 90% at 100% 0%, color-mix(in oklch, #7c3aed 10%, transparent), transparent 60%)',
          }}
        />

        <div className="relative">
          {/* ── Hero band — namespace identity + headline stats ── */}
          <div className="flex flex-wrap items-start gap-4 px-5 pt-5 pb-4 border-b border-bolt-elements-borderColor/60">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div className="i-ph:cube-transparent-duotone text-3xl text-bolt-elements-item-contentAccent shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-bolt-elements-textPrimary tracking-tight">
                    Platform namespace
                  </h3>
                  <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full border border-bolt-elements-item-contentAccent/40 bg-bolt-elements-item-contentAccent/10 text-bolt-elements-item-contentAccent">
                    <div className="i-ph:git-branch text-[10px]" />
                    {envLabel}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 min-w-0" title="Workers-for-Platforms dispatch namespace">
                  <div className="i-ph:function text-[13px] text-bolt-elements-textTertiary shrink-0" />
                  <code className="text-[12px] font-mono text-bolt-elements-textSecondary truncate">
                    {rollup.namespaceLabel ?? 'dispatch namespace · resolved server-side'}
                  </code>
                </div>
                <p className="mt-1 text-[11px] text-bolt-elements-textTertiary">
                  Every Cloudflare resource your site is wired to, scoped to this namespace.
                </p>
              </div>
            </div>

            {/* Headline metrics — connected / available / drift */}
            <div className="flex items-stretch gap-2.5 shrink-0" role="group" aria-label="Namespace totals">
              <HeroStat
                icon="i-ph:stack-duotone"
                value={rollup.totalResources}
                label="Resources"
                tone="accent"
                testid="ns-stat-total"
              />
              <HeroStat
                icon="i-ph:plugs-connected"
                value={rollup.connected}
                label="Connected"
                tone="ok"
                testid="ns-stat-connected"
              />
              <HeroStat
                icon="i-ph:warning"
                value={rollup.drifted}
                label="Drifted"
                tone={rollup.drifted > 0 ? 'warn' : 'muted'}
                testid="ns-stat-drift"
              />
            </div>
          </div>

          {/* ── Per-kind accounting grid ── */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-bolt-elements-textSecondary">
                Resource breakdown
              </h4>
              <span className="text-[10px] text-bolt-elements-textTertiary" data-testid="ns-kinds-in-use">
                {rollup.kindsInUse} of {rollup.kinds.length} kinds in use
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
              {rollup.kinds.map((row) => (
                <KindTile key={row.spec.key} row={row} onOpen={onOpenKind} />
              ))}
            </div>

            {/* Quiet sync affordance — reconciliation is AUTOMATIC + silent (per
                `real-time-data-no-manual-refresh`); this status line is the only freshness signal,
                never a button. Drift heals itself on the next automatic cycle. */}
            <div
              className="mt-4 flex items-center gap-2 text-[10px] text-bolt-elements-textTertiary select-none"
              data-testid="ns-sync-status"
              role="status"
              aria-live="off"
              title="Reconciliation runs automatically — nothing to click"
            >
              <span
                aria-hidden="true"
                className={classNames(
                  'h-1.5 w-1.5 rounded-full shrink-0',
                  syncing
                    ? 'bg-amber-400 animate-pulse motion-reduce:animate-none'
                    : 'bg-emerald-400',
                )}
              />
              <span className="tabular-nums">{syncLabel}</span>
            </div>
          </div>
        </div>
      </section>
    );
  },
);

NamespaceSummary.displayName = 'NamespaceSummary';

// ── Hero stat pill ─────────────────────────────────────────────────────────

const HeroStat = memo(
  ({
    icon,
    value,
    label,
    tone,
    testid,
  }: {
    icon: string;
    value: number;
    label: string;
    tone: 'accent' | 'ok' | 'warn' | 'muted';
    testid: string;
  }) => {
    const toneCls =
      tone === 'accent'
        ? 'text-bolt-elements-item-contentAccent border-bolt-elements-item-contentAccent/40 bg-bolt-elements-item-contentAccent/[0.06]'
        : tone === 'ok'
          ? 'text-emerald-400 border-emerald-400/40 bg-emerald-400/[0.06]'
          : tone === 'warn'
            ? 'text-amber-300 border-amber-400/40 bg-amber-400/[0.08]'
            : 'text-bolt-elements-textTertiary border-bolt-elements-borderColor bg-bolt-elements-background-depth-1';

    return (
      <div
        data-testid={testid}
        className={classNames('flex flex-col items-center justify-center rounded-xl border px-3.5 py-2 min-w-[76px]', toneCls)}
      >
        <div className="flex items-center gap-1.5">
          <div className={classNames(icon, 'text-sm')} aria-hidden="true" />
          <span className="text-lg font-bold leading-none tabular-nums">{value}</span>
        </div>
        <span className="mt-1 text-[9px] font-medium uppercase tracking-wider opacity-90">{label}</span>
      </div>
    );
  },
);

HeroStat.displayName = 'NamespaceSummary.HeroStat';

// ── Per-kind tile ────────────────────────────────────────────────────────────

const KindTile = memo(({ row, onOpen }: { row: KindRollup; onOpen?: (target: OpenKindTarget) => void }) => {
  const has = row.total > 0;
  const drifted = row.drifted > 0;
  // A kind this deployment genuinely cannot surface (Queues — no binding) AND that has nothing → honest
  // "Not available" treatment (never a fake 0-count). A mere `platformNote` caveat (e.g. Durable Objects)
  // is NOT unsupported — that surface is still reachable.
  const platformUnsupported = !has && Boolean(row.spec.unsupported);
  // `other` is a catch-all bucket, not a real drill-in target — never make it actionable.
  const isOther = row.spec.key === 'other';
  // A tile is a REACHABLE button when a handler exists AND the kind is a genuine, supported surface
  // (never a doomed control per `action-button-must-gate-on-server-precondition`): a genuinely
  // unsupported kind + the `other` bucket stay presentational. A zero-count-but-supported kind IS
  // clickable — that is exactly how the dark per-site KV / DO / Connections / Observability surfaces
  // are reached (their FLAG gates the server; the drill-in renders the honest not-enabled/empty state).
  // `noDrill` kinds (worker / domain — no per-kind adapter endpoint) count honestly but stay
  // presentational, so a tile can never be a doomed click into a 400.
  const actionable = Boolean(onOpen) && !row.spec.unsupported && !row.spec.noDrill && !isOther;

  // The status dot: warn on drift, ok when connected, muted when only "available", amber when unsupported.
  const dot = drifted
    ? 'bg-amber-400'
    : row.connected > 0
      ? 'bg-emerald-400'
      : platformUnsupported
        ? 'bg-amber-400/50'
        : has
          ? 'bg-bolt-elements-item-contentAccent'
          : 'bg-bolt-elements-borderColor';

  // Availability hint handed to the detail panel: a connected kind leads with read, everything else
  // (zero-count OR only "available") leads with Provision.
  const availability: OpenKindTarget['availability'] = row.connected > 0 ? 'connected' : 'available';

  const open = () => onOpen?.({ kind: row.spec.key, availability });

  const innerClassName = classNames(
    'group relative w-full text-left rounded-xl border p-3 transition-colors',
    has
      ? 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 hover:border-bolt-elements-item-contentAccent/50'
      : 'border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1/40',
    actionable &&
      'cursor-pointer hover:border-bolt-elements-item-contentAccent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-2 focus-visible:ring-bolt-elements-item-contentAccent',
  );

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <div
          className={classNames(
            row.spec.icon,
            'text-xl shrink-0',
            has ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textTertiary',
          )}
          aria-hidden="true"
        />
        <span className={classNames('mt-1 h-1.5 w-1.5 rounded-full shrink-0', dot)} aria-hidden="true" />
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={classNames(
            'text-xl font-bold leading-none tabular-nums',
            has ? 'text-bolt-elements-textPrimary' : 'text-bolt-elements-textTertiary',
          )}
        >
          {row.total}
        </span>
        {drifted && (
          <span className="text-[9px] font-semibold uppercase tracking-wider text-amber-300" title={`${row.drifted} drifted`}>
            {row.drifted} drift
          </span>
        )}
      </div>

      <p className="mt-0.5 text-[10px] font-medium text-bolt-elements-textSecondary leading-tight">{row.spec.label}</p>

      {/* Sub-line — honest status: connected/available split, or the platform "unsupported" note. */}
      {platformUnsupported ? (
        <p className="mt-1 text-[9px] text-bolt-elements-textTertiary/80 italic leading-tight">Not available</p>
      ) : has ? (
        <p className="mt-1 text-[9px] text-bolt-elements-textTertiary leading-tight">
          {row.connected > 0 && `${row.connected} connected`}
          {row.connected > 0 && row.available > 0 && ' · '}
          {row.available > 0 && `${row.available} available`}
        </p>
      ) : (
        <p className="mt-1 text-[9px] text-bolt-elements-textTertiary/70 leading-tight">
          {actionable ? 'Open to set up' : 'None yet'}
        </p>
      )}

      {/* A subtle "open" affordance on the actionable tiles, so the drill-in is discoverable. */}
      {actionable && (
        <div
          className="i-ph:arrow-right pointer-events-none absolute bottom-2.5 right-2.5 text-[11px] text-bolt-elements-textTertiary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden="true"
        />
      )}
    </>
  );

  const shared = {
    'data-testid': 'ns-kind-tile',
    'data-kind': row.spec.key,
    'data-count': row.total,
    title: row.spec.platformNote || `${row.total} ${row.spec.label}`,
  } as const;

  if (actionable) {
    return (
      <button
        type="button"
        {...shared}
        onClick={open}
        aria-label={`Open ${row.spec.label}${row.connected > 0 ? '' : ' — set up'}`}
        className={innerClassName}
      >
        {body}
      </button>
    );
  }

  return (
    <div {...shared} className={innerClassName}>
      {body}
    </div>
  );
});

KindTile.displayName = 'NamespaceSummary.KindTile';
