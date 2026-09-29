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
import React, { memo, useMemo } from 'react';
import { classNames } from '~/utils/classNames';
import type { ResourceOverviewEntry } from '~/lib/embed/embedded-mode';

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
   * Kinds Cloudflare structurally cannot expose on this deployment (per CAPABILITY-MATRIX.md) — shown
   * with an honest "unsupported" treatment when the inventory has none, never a fake count.
   */
  platformNote?: string;
}

const KIND_SPECS: KindSpec[] = [
  { key: 'd1', label: 'D1 Databases', icon: 'i-ph:database-duotone', match: ['d1', 'database', 'sql'] },
  { key: 'kv', label: 'KV Namespaces', icon: 'i-ph:key-duotone', match: ['kv', 'key'] },
  { key: 'r2', label: 'R2 Buckets', icon: 'i-ph:cloud-duotone', match: ['r2', 'bucket', 'object', 'storage'] },
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
];

/** Any inventory entry not matched by a KindSpec falls into a catch-all row so nothing is dropped. */
const OTHER_SPEC: KindSpec = { key: 'other', label: 'Other Resources', icon: 'i-ph:stack-duotone', match: [] };

// ── Availability (mirrors ResourceOverviewPanel's server-driven classification) ──

type Availability = 'connected' | 'available' | 'unsupported';

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
function specForKind(kind: string): KindSpec {
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
 * the overview loaded) and never fetches. A drift click scrolls the owner to the drifted cards below.
 */
export const NamespaceSummary = memo(
  ({
    resources,
    environment,
    onReconcile,
    reconciling,
  }: {
    resources: ResourceOverviewEntry[];
    environment: string;
    onReconcile?: () => void;
    reconciling?: boolean;
  }) => {
    const rollup = useMemo(() => computeRollup(resources), [resources]);
    const envLabel = environment.charAt(0).toUpperCase() + environment.slice(1);

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
                <KindTile key={row.spec.key} row={row} />
              ))}
            </div>

            {/* Optional reconcile nudge — one obvious action, only when something can be healed */}
            {onReconcile && (rollup.drifted > 0 || rollup.available > 0) && (
              <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.04] px-3.5 py-2.5">
                <div className="i-ph:sparkle-duotone text-base text-bolt-elements-item-contentAccent shrink-0" />
                <p className="text-[11px] text-bolt-elements-textSecondary flex-1 min-w-0">
                  {rollup.drifted > 0
                    ? `${rollup.drifted} resource${rollup.drifted === 1 ? '' : 's'} drifted from desired state.`
                    : `${rollup.available} resource${rollup.available === 1 ? '' : 's'} available to connect.`}{' '}
                  Reconcile brings everything into sync.
                </p>
                <button
                  type="button"
                  onClick={onReconcile}
                  disabled={reconciling}
                  data-testid="ns-reconcile"
                  className="min-h-[24px] text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-bolt-elements-item-contentAccent text-[#061018] enabled:hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                >
                  <div
                    className={classNames(
                      reconciling
                        ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                        : 'i-ph:arrows-counter-clockwise',
                      'text-sm shrink-0',
                    )}
                  />
                  <span className="min-w-[9ch] text-center">{reconciling ? 'Reconciling…' : 'Reconcile'}</span>
                </button>
              </div>
            )}
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

const KindTile = memo(({ row }: { row: KindRollup }) => {
  const has = row.total > 0;
  const drifted = row.drifted > 0;
  // A kind CF can't expose AND that has nothing → honest "unsupported" treatment (never a fake 0-count).
  const platformUnsupported = !has && Boolean(row.spec.platformNote);

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

  return (
    <div
      data-testid="ns-kind-tile"
      data-kind={row.spec.key}
      data-count={row.total}
      title={row.spec.platformNote || `${row.total} ${row.spec.label}`}
      className={classNames(
        'group relative rounded-xl border p-3 transition-colors',
        has
          ? 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 hover:border-bolt-elements-item-contentAccent/50'
          : 'border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className={classNames(
            row.spec.icon,
            'text-xl shrink-0',
            has ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textTertiary',
          )}
          aria-hidden="true"
        />
        <span
          className={classNames('mt-1 h-1.5 w-1.5 rounded-full shrink-0', dot)}
          aria-hidden="true"
        />
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
        <p className="mt-1 text-[9px] text-bolt-elements-textTertiary/70 leading-tight">None yet</p>
      )}
    </div>
  );
});

KindTile.displayName = 'NamespaceSummary.KindTile';
