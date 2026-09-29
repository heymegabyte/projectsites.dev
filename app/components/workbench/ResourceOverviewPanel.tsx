/**
 * @file Resources Overview — the editor "Resources" tab's per-site platform-resource inventory.
 *
 * @remarks
 * Shows a business owner every Cloudflare primitive their site is wired to (D1 databases, KV
 * namespaces, R2 buckets, queues, Workers-for-Platforms functions, …) for a chosen environment
 * (preview | production), GROUPED by resource kind × environment. Each card carries the kind icon,
 * the Worker binding it's exposed under, its lifecycle state, its tenancy, a DRIFT badge when the
 * server flagged it out of desired state, and the last successful sync. A one-click "Reconcile"
 * button asks the server to bring the resources back to desired state, then refreshes.
 *
 * The embedded editor has no cross-origin session, so it CANNOT fetch the worker directly — it talks
 * to the parent admin (which holds the bearer + `selectedSite`) over `postMessage`. Two bridge pairs:
 *   - `PS_RES_OVERVIEW_REQUEST`  → `GET  /api/sites/:siteId/resources?environment=…`   → { resources }
 *   - `PS_RES_RECONCILE_REQUEST` → `POST /api/sites/:siteId/resources/reconcile`        → { reconciled, drift }
 * Both are DARK behind the surface's flag (a 404 whose message includes "not enabled" → the admin
 * replies `{ ok:false, enabled:false }`) — when off, this panel shows a friendly "not enabled yet"
 * state, never a scary error.
 *
 * READ + reconcile only: this is a status surface, not a provisioning form. Resources the site
 * COULD add (server-known, not yet connected) render as muted "available to add" cards with a
 * coming-soon note rather than a dead click; anything the platform can't manage shows an
 * "unsupported" chip. Empty registry → an empty-state launchpad whose one obvious action is Reconcile.
 *
 * Style mirrors the sibling `./SiteTablesPanel` + `./Preview` EXACTLY (UnoCSS `bolt-elements-*`
 * tokens, phosphor `i-ph:*` icons, black + cyan, ≥24px targets, aria-labels, focus-visible rings,
 * prefers-reduced-motion via `motion-reduce:*`).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type ResOverviewResponseMessage,
  type ResReconcileResponseMessage,
  type ResourceOverviewEntry,
} from '~/lib/embed/embedded-mode';
import { ResourceDetailPanel, type ResourceDetailTarget } from './ResourceDetailPanel';
import { NamespaceSummary } from './NamespaceSummary';

// ── Types ────────────────────────────────────────────────────────────────────

/** The environments the resource inventory can be scoped to (the env selector). */
type ResourceEnvironment = 'preview' | 'production';

const ENVIRONMENTS: { value: ResourceEnvironment; label: string }[] = [
  { value: 'preview', label: 'Preview' },
  { value: 'production', label: 'Production' },
];

type OverviewState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; environment: string; resources: ResourceOverviewEntry[] };

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'not enabled';

/**
 * How often the inventory silently re-fetches while the tab is foregrounded (visibility-aware poll,
 * per `real-time-data-no-manual-refresh`). 45s sits in the 15–60s band — current without hammering
 * the bridge. The poll PAUSES while `document.hidden` and refreshes immediately on foreground.
 */
const POLL_INTERVAL_MS = 45_000;

/** Monotonic per-module fallback so every request gets a unique correlationId. */
let correlationCounter = 0;
function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `res_${++correlationCounter}`;
}

/**
 * Map a raw `resource_kind` to a phosphor icon. Best-effort + case-insensitive substring match, so
 * new kinds still render a sensible glyph; unknown kinds fall back to a generic cube. Distinct
 * icons per family (database / key-value / storage / queue / function / …) let the owner scan the
 * inventory at a glance.
 */
function iconForKind(kind: string): string {
  const k = (kind || '').toLowerCase();

  if (k.includes('d1') || k.includes('database') || k.includes('sql')) {
    return 'i-ph:database-duotone';
  }

  if (k.includes('kv') || k.includes('key')) {
    return 'i-ph:key-duotone';
  }

  if (k.includes('r2') || k.includes('bucket') || k.includes('storage') || k.includes('object')) {
    return 'i-ph:cloud-duotone';
  }

  if (k.includes('queue')) {
    return 'i-ph:queue-duotone';
  }

  if (k.includes('function') || k.includes('worker') || k.includes('wfp') || k.includes('dispatch')) {
    return 'i-ph:function-duotone';
  }

  if (k.includes('do') || k.includes('durable')) {
    return 'i-ph:cube-duotone';
  }

  if (k.includes('vectorize') || k.includes('vector') || k.includes('index')) {
    return 'i-ph:graph-duotone';
  }

  if (k.includes('ai') || k.includes('model')) {
    return 'i-ph:sparkle-duotone';
  }

  if (k.includes('workflow')) {
    return 'i-ph:flow-arrow-duotone';
  }

  if (k.includes('secret') || k.includes('env') || k.includes('var')) {
    return 'i-ph:lock-key-duotone';
  }

  return 'i-ph:cube-duotone';
}

/** A human title for a `resource_kind` — strips separators + Title-Cases each word. */
function titleForKind(kind: string): string {
  const raw = (kind || 'Resource').replace(/[_-]+/g, ' ').trim();

  if (!raw) {
    return 'Resource';
  }

  return raw
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * Classify a resource for the card's visual treatment. A `connected` resource is bound + live; an
 * `available` resource is server-known but not yet wired (muted, coming-soon); `unsupported` is a
 * resource the platform can't manage. Derived from `lifecycle_state` so the server drives it.
 */
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

/** Title-Case a lifecycle/tenancy token for display (`not_connected` → "Not Connected"). */
function humanizeToken(token: string): string {
  const raw = (token || '').replace(/[_-]+/g, ' ').trim();

  if (!raw) {
    return '';
  }

  return raw
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Format an ISO timestamp as a compact relative "N ago"; falls back to the raw string. */
function relativeTime(iso: string | undefined): string {
  if (!iso) {
    return 'never synced';
  }

  const then = Date.parse(iso);

  if (Number.isNaN(then)) {
    return iso;
  }

  const secondsAgo = Math.max(0, Math.round((Date.now() - then) / 1000));

  if (secondsAgo < 60) {
    return 'just now';
  }

  const minutes = Math.round(secondsAgo / 60);

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** A stable group key + label for the kind × environment grouping. */
interface ResourceGroup {
  key: string;
  kind: string;
  environment: string;
  entries: ResourceOverviewEntry[];
}

/** Group a flat resource list by `resource_kind` then `environment`, sorted for a stable render. */
function groupResources(resources: ResourceOverviewEntry[]): ResourceGroup[] {
  const map = new Map<string, ResourceGroup>();

  for (const entry of resources) {
    const kind = entry.resource_kind || 'resource';
    const environment = entry.environment || 'default';
    const key = `${kind}::${environment}`;

    let group = map.get(key);

    if (!group) {
      group = { key, kind, environment, entries: [] };
      map.set(key, group);
    }

    group.entries.push(entry);
  }

  return [...map.values()].sort((a, b) =>
    a.kind === b.kind ? a.environment.localeCompare(b.environment) : a.kind.localeCompare(b.kind),
  );
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * The Resources Overview panel — mounted as the workbench "Resources" tab. Loads the site's
 * platform-resource inventory for the selected environment on mount, then keeps it CURRENT with a
 * visibility-aware poll (re-fetches on an interval, pauses while the tab is hidden, refreshes
 * immediately on foreground) — no manual Refresh/Reconcile button (per
 * `real-time-data-no-manual-refresh`). Drift reconciliation runs automatically + silently on the
 * same cycle; a subtle "updated Ns ago" affordance is the only freshness signal.
 */
export const ResourceOverviewPanel = memo(() => {
  const [environment, setEnvironment] = useState<ResourceEnvironment>('production');
  const [overview, setOverview] = useState<OverviewState>({ status: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
  /** Wall-clock ms of the last successful inventory load — drives the live "updated Ns ago" chip. */
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  /** The resource the owner clicked to drill into — non-null renders {@link ResourceDetailPanel}. */
  const [selected, setSelected] = useState<ResourceDetailTarget | null>(null);

  /** Open the generic detail drill-in for a clicked resource card (never passes a CF id — kind + env only). */
  const openDetail = useCallback(
    (entry: ResourceOverviewEntry) => {
      const env = entry.environment === 'preview' || entry.environment === 'production' ? entry.environment : environment;
      setSelected({
        kind: entry.resource_kind,
        environment: env,
        concept: entry.resource_concept || undefined,
        bindingName: entry.binding_name || undefined,
      });
    },
    [environment],
  );

  /*
   * The repo has a known empty-deps stale-ref bug: a single `onParentMessage` listener registered
   * once in `useEffect([])` closes over the FIRST render's state (see MEMORY §[]-deps stale-ref and
   * the sibling SiteTablesPanel). We register ONE listener and read the LATEST pending map through a
   * ref inside the handler, so replies always resolve against the live pending set — regardless of
   * how many renders have happened. Cleaned up on unmount (unsubscribe + reject anything in flight).
   */
  const pendingRef = useRef<Map<string, Pending>>(new Map());

  /**
   * Send a bridge message + await the reply matched by correlationId. Rejects on timeout so a
   * dropped parent never hangs the UI. Resolves with the raw `ParentToChildMessage`.
   */
  const request = useCallback((message: Parameters<typeof postToParent>[0]): Promise<ParentToChildMessage> => {
    return new Promise<ParentToChildMessage>((resolve, reject) => {
      const correlationId = (message as { correlationId: string }).correlationId;
      const timer = setTimeout(() => {
        pendingRef.current.delete(correlationId);
        reject(new Error('The request timed out. Check the admin connection and retry.'));
      }, REQUEST_TIMEOUT_MS);

      pendingRef.current.set(correlationId, { resolve, reject, timer });
      postToParent(message);
    });
  }, []);

  // Register exactly ONE parent-message listener; resolve by correlationId via the live ref.
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_OVERVIEW_RESPONSE' && msg.type !== 'PS_RES_RECONCILE_RESPONSE') {
        return;
      }

      const correlationId = msg.correlationId;

      if (!correlationId) {
        return;
      }

      const pending = pendingRef.current.get(correlationId);

      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      pendingRef.current.delete(correlationId);
      pending.resolve(msg);
    });

    return () => {
      unsubscribe();

      // Reject anything still in flight on unmount so no promise dangles.
      for (const [, pending] of pendingRef.current) {
        clearTimeout(pending.timer);
        pending.reject(new Error('cancelled'));
      }

      pendingRef.current.clear();
    };
  }, []);

  /**
   * Load (or reload) the resource inventory for the given environment.
   *
   * @param env - the environment to scope the inventory to.
   * @param silent - when `true` (a background poll / foreground refresh), the current view is kept
   *   on-screen instead of flashing the loading spinner — freshness is invisible, per the mandate.
   */
  const loadOverview = useCallback(
    async (env: ResourceEnvironment, silent = false) => {
      if (!silent) {
        setOverview({ status: 'loading' });
      }

      if (!isEmbedded) {
        setOverview({
          status: 'error',
          message: 'Open this from the ProjectSites admin to see your resources.',
        });
        return;
      }

      try {
        const reply = (await request({
          type: 'PS_RES_OVERVIEW_REQUEST',
          correlationId: nextCorrelationId(),
          environment: env,
        })) as ResOverviewResponseMessage;

        if (!reply.ok) {
          // Dark-flag 404 → friendly disabled state, not an error card.
          if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
            setOverview({ status: 'disabled' });
            return;
          }

          // On a silent background poll, keep the last good view rather than replacing it with an
          // error card for a transient blip — a manual refresh is gone, so don't punish the user.
          if (!silent) {
            setOverview({ status: 'error', message: reply.error || 'Could not load your resources.' });
          }

          return;
        }

        setOverview({
          status: 'ready',
          environment: reply.environment ?? env,
          resources: reply.resources ?? [],
        });
        setLastLoadedAt(Date.now());
      } catch (err) {
        if (!silent) {
          setOverview({
            status: 'error',
            message: err instanceof Error ? err.message : 'Could not load your resources.',
          });
        }
      }
    },
    [request],
  );

  /** Latest `loadOverview` + `environment`, read by the poll effect so it never re-subscribes. */
  const loadRef = useRef(loadOverview);
  loadRef.current = loadOverview;
  const environmentRef = useRef(environment);
  environmentRef.current = environment;

  // On mount + whenever the environment changes: load the inventory (foreground, shows spinner).
  useEffect(() => {
    void loadOverview(environment);
  }, [environment, loadOverview]);

  /*
   * Visibility-aware real-time poll (per `real-time-data-no-manual-refresh`). While the tab is
   * FOREGROUNDED, silently re-fetch every POLL_INTERVAL_MS so the inventory + its drift reconcile
   * stay current with ZERO clicks. While `document.hidden`, the interval no-ops (no wasted bridge
   * traffic); returning to the foreground refreshes IMMEDIATELY. Registered once — it reads the
   * latest loader/env through refs, so it survives env changes without tearing down the timer.
   */
  useEffect(() => {
    if (!isEmbedded) {
      return;
    }

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      void loadRef.current(environmentRef.current, true);
    };

    const interval = setInterval(tick, POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        void loadRef.current(environmentRef.current, true);
      }
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /*
   * AUTOMATIC + SILENT drift reconcile (per `real-time-data-no-manual-refresh` — reconciliation is
   * never a button). Asks the server to heal drift for the current environment, then silently
   * refreshes the inventory. Success is invisible (the drift badges just clear on the next poll);
   * only a genuine failure surfaces a non-fatal notice. Runs on the poll cycle when drift exists —
   * never from a click.
   */
  const reconcile = useCallback(async () => {
    if (!isEmbedded) {
      return;
    }

    try {
      const reply = (await request({
        type: 'PS_RES_RECONCILE_REQUEST',
        correlationId: nextCorrelationId(),
        environment: environmentRef.current,
      })) as ResReconcileResponseMessage;

      if (!reply.ok) {
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setOverview({ status: 'disabled' });
          return;
        }

        // Silent-by-default: only a residual/failed heal is worth a quiet, dismissible note.
        setNotice(reply.error || null);
        return;
      }

      const residual = Array.isArray(reply.drift) ? reply.drift.length : 0;

      if (residual > 0) {
        setNotice(`${residual} resource${residual === 1 ? '' : 's'} still need attention.`);
      }
    } catch {
      // A transient reconcile failure is swallowed — the next automatic cycle retries.
    } finally {
      // Silently refresh the inventory to reflect the reconcile outcome (no spinner flash).
      void loadRef.current(environmentRef.current, true);
    }
  }, [request]);

  /*
   * Kick an automatic silent reconcile whenever drift is present in a freshly-loaded inventory —
   * self-healing on the same real-time cycle, never a click. A ref-guard makes it fire once per
   * observed drift set so a persistent-drift poll doesn't spam reconcile requests.
   */
  const lastDriftReconcileKey = useRef<string>('');
  useEffect(() => {
    if (overview.status !== 'ready') {
      return;
    }

    const driftedIds = overview.resources
      .filter((r) => Boolean(r.drift_code))
      .map((r) => r.id)
      .sort()
      .join('|');

    if (driftedIds && driftedIds !== lastDriftReconcileKey.current) {
      lastDriftReconcileKey.current = driftedIds;
      void reconcile();
    } else if (!driftedIds) {
      lastDriftReconcileKey.current = '';
    }
  }, [overview, reconcile]);

  const groups = useMemo(
    () => (overview.status === 'ready' ? groupResources(overview.resources) : []),
    [overview],
  );

  const driftCount = useMemo(
    () =>
      overview.status === 'ready' ? overview.resources.filter((r) => Boolean(r.drift_code)).length : 0,
    [overview],
  );

  const totalCount = overview.status === 'ready' ? overview.resources.length : 0;

  // When a resource card is clicked, drill into the GENERIC per-kind detail view (list/get).
  if (selected) {
    return <ResourceDetailPanel target={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <Header
        environment={environment}
        onEnvironment={setEnvironment}
        lastLoadedAt={lastLoadedAt}
        subtitle={
          overview.status === 'ready'
            ? totalCount === 0
              ? 'No resources yet · your platform infrastructure'
              : `${totalCount} resource${totalCount === 1 ? '' : 's'}${driftCount > 0 ? ` · ${driftCount} drifted` : ''} · your platform infrastructure`
            : 'Your platform infrastructure'
        }
      />

      {overview.status === 'loading' && <Spinner label="Loading your resources…" />}
      {overview.status === 'disabled' && <DisabledCard />}
      {overview.status === 'error' && (
        <ErrorCard message={overview.message} onRetry={() => void loadOverview(environment)} />
      )}

      {overview.status === 'ready' &&
        (groups.length === 0 ? (
          <EmptyLaunchpad />
        ) : (
          <div className="flex-1 overflow-auto modern-scrollbar px-4 py-4 space-y-6" data-testid="resources-groups">
            {/* Per-site WfP-namespace SUMMARY — a prominent rollup of every resource in the namespace,
                derived from the SAME inventory (no extra fetch). The at-a-glance accounting sits above
                the per-kind cards. Reconcile runs automatically + silently, so no button is passed. */}
            <NamespaceSummary resources={overview.resources} environment={overview.environment} />

            {groups.map((group) => (
              <ResourceGroupSection key={group.key} group={group} onComingSoon={setNotice} onOpen={openDetail} />
            ))}
          </div>
        ))}

      {/* Inline notice — reconcile result / coming-soon / non-fatal error (never a dead click). */}
      {notice && (
        <div
          className="border-t border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-2 text-[11px] text-bolt-elements-textSecondary flex items-center gap-2"
          data-testid="resources-notice"
          role="status"
        >
          <div className="i-ph:info text-bolt-elements-item-contentAccent shrink-0" />
          <span className="flex-1">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:x text-xs" />
          </button>
        </div>
      )}
    </div>
  );
});

ResourceOverviewPanel.displayName = 'ResourceOverviewPanel';

// ── Header ───────────────────────────────────────────────────────────────────

const Header = memo(
  ({
    environment,
    onEnvironment,
    lastLoadedAt,
    subtitle,
  }: {
    environment: ResourceEnvironment;
    onEnvironment: (env: ResourceEnvironment) => void;
    /** Wall-clock ms of the last successful inventory load, or `null` before the first load. */
    lastLoadedAt: number | null;
    subtitle: string;
  }) => (
    <div className="relative flex items-center gap-3 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0 overflow-hidden">
      {/* Subtle brand wash behind the header — sets the cinematic black+cyan tone from the first pixel. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'linear-gradient(90deg, color-mix(in oklch, #00e5ff 8%, transparent), transparent 40%)',
        }}
      />
      <div className="relative flex items-center justify-center h-9 w-9 rounded-xl border border-bolt-elements-item-contentAccent/30 bg-bolt-elements-item-contentAccent/[0.08] shrink-0">
        <div className="i-ph:stack-duotone text-xl text-bolt-elements-item-contentAccent" />
      </div>
      <div className="relative min-w-0">
        <h2 className="text-sm font-semibold text-bolt-elements-textPrimary tracking-tight">Resources</h2>
        <p className="text-[10px] text-bolt-elements-textTertiary truncate">{subtitle}</p>
      </div>

      <div className="relative ml-auto flex items-center gap-2 shrink-0">
        {/* Live freshness affordance — the ONLY refresh signal (self-updating; no manual button). */}
        <LiveFreshness lastLoadedAt={lastLoadedAt} />

        {/* Environment selector — preview | production */}
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
                  'min-h-[24px] px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                  active
                    ? 'bg-bolt-elements-item-contentAccent text-[#061018]'
                    : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                )}
              >
                {env.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  ),
);

Header.displayName = 'ResourceOverviewPanel.Header';

// ── Live freshness affordance ─────────────────────────────────────────────────

/**
 * A subtle, self-ticking "updated Ns ago" chip with a quiet live pulse — the ONLY freshness signal,
 * standing in for the removed manual Refresh/Reconcile buttons (per `real-time-data-no-manual-refresh`).
 * Re-renders on its own ~15s cadence so the relative label stays honest without any user action, and
 * pauses ticking while the tab is hidden. Never a button — freshness is invisible + automatic.
 */
const LiveFreshness = memo(({ lastLoadedAt }: { lastLoadedAt: number | null }) => {
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) {
        forceTick((n) => n + 1);
      }
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const label = lastLoadedAt ? `Updated ${relativeTime(new Date(lastLoadedAt).toISOString())}` : 'Live';

  return (
    <span
      className="hidden sm:inline-flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary tabular-nums select-none"
      data-testid="resources-live-freshness"
      title="This view updates itself automatically"
      role="status"
      aria-live="off"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-bolt-elements-item-contentAccent animate-pulse motion-reduce:animate-none"
      />
      {label}
    </span>
  );
});

LiveFreshness.displayName = 'ResourceOverviewPanel.LiveFreshness';

// ── Shared: spinner + error + disabled ───────────────────────────────────────

const Spinner = memo(({ label }: { label: string }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center"
    role="status"
    aria-live="polite"
    data-testid="resources-loading"
  >
    <div className="i-ph:circle-notch text-2xl text-bolt-elements-item-contentAccent animate-spin motion-reduce:animate-none" />
    <p className="text-xs text-bolt-elements-textSecondary">{label}</p>
  </div>
));

Spinner.displayName = 'ResourceOverviewPanel.Spinner';

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

ErrorCard.displayName = 'ResourceOverviewPanel.ErrorCard';

const DisabledCard = memo(() => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="resources-disabled"
  >
    <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
    <p className="text-sm font-medium text-bolt-elements-textSecondary">Resources isn't enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
      Your platform resource view is on the way. Once it's turned on, every database, bucket, and
      function your site uses shows up here — nothing to set up.
    </p>
  </div>
));

DisabledCard.displayName = 'ResourceOverviewPanel.DisabledCard';

// ── Empty launchpad ──────────────────────────────────────────────────────────

const EmptyLaunchpad = memo(() => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center"
    data-testid="resources-empty"
  >
    <div className="i-ph:stack text-4xl text-bolt-elements-textTertiary" />
    <div className="space-y-1">
      <p className="text-sm font-semibold text-bolt-elements-textPrimary">No resources yet</p>
      <p className="text-[11px] text-bolt-elements-textTertiary max-w-[300px]">
        When your site uses a database, storage bucket, queue, or function, it appears here
        automatically — this view keeps itself up to date, nothing to run.
      </p>
    </div>
    {/* A quiet "watching" pulse — the surface self-detects; there is no button to press. */}
    <span
      className="inline-flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary select-none"
      role="status"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full bg-bolt-elements-item-contentAccent animate-pulse motion-reduce:animate-none"
      />
      Watching for new resources
    </span>
  </div>
));

EmptyLaunchpad.displayName = 'ResourceOverviewPanel.EmptyLaunchpad';

// ── Group section (kind × environment) ───────────────────────────────────────

const ResourceGroupSection = memo(
  ({
    group,
    onComingSoon,
    onOpen,
  }: {
    group: ResourceGroup;
    onComingSoon: (label: string) => void;
    onOpen: (entry: ResourceOverviewEntry) => void;
  }) => (
    <section data-testid="resources-group">
      <div className="flex items-center gap-2 mb-2.5">
        <div className="flex items-center justify-center h-6 w-6 rounded-lg border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.06] shrink-0">
          <div className={classNames(iconForKind(group.kind), 'text-sm text-bolt-elements-item-contentAccent')} />
        </div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-bolt-elements-textSecondary">
          {titleForKind(group.kind)}
        </h3>
        <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary uppercase tracking-wider">
          <div className="i-ph:git-branch text-[9px]" />
          {humanizeToken(group.environment)}
        </span>
        <span className="text-[10px] text-bolt-elements-textTertiary tabular-nums">
          {group.entries.length} item{group.entries.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-bolt-elements-borderColor/60 to-transparent ml-1" aria-hidden="true" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {group.entries.map((entry) => (
          <ResourceCard key={entry.id} entry={entry} onComingSoon={onComingSoon} onOpen={onOpen} />
        ))}
      </div>
    </section>
  ),
);

ResourceGroupSection.displayName = 'ResourceOverviewPanel.ResourceGroupSection';

// ── Resource card ────────────────────────────────────────────────────────────

const ResourceCard = memo(
  ({
    entry,
    onComingSoon,
    onOpen,
  }: {
    entry: ResourceOverviewEntry;
    onComingSoon: (label: string) => void;
    onOpen: (entry: ResourceOverviewEntry) => void;
  }) => {
    const availability = availabilityFor(entry);
    const drifted = Boolean(entry.drift_code);
    // Only a CONNECTED resource can be drilled into — an available/unsupported card keeps its own affordance.
    const openable = availability === 'connected';
    const open = openable ? () => onOpen(entry) : undefined;

    const availabilityChip =
      availability === 'connected'
        ? { label: 'Connected', cls: 'text-emerald-400 border-emerald-400/40 bg-emerald-400/10', icon: 'i-ph:plugs-connected' }
        : availability === 'available'
          ? { label: 'Available to add', cls: 'text-bolt-elements-textTertiary border-bolt-elements-borderColor bg-bolt-elements-background-depth-2', icon: 'i-ph:plus-circle' }
          : { label: 'Unsupported', cls: 'text-amber-400/90 border-amber-400/40 bg-amber-400/10', icon: 'i-ph:prohibit' };

    const isAddable = availability === 'available';

    return (
      <div
        className={classNames(
          'group relative overflow-hidden rounded-xl border p-3.5 flex flex-col gap-2.5 transition-all duration-150 motion-reduce:transition-none',
          drifted
            ? 'border-amber-400/50 bg-amber-400/[0.04]'
            : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2',
          availability === 'available' && 'opacity-80',
          openable &&
            'cursor-pointer hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 hover:border-bolt-elements-item-contentAccent/60 hover:bg-bolt-elements-background-depth-3 hover:shadow-lg hover:shadow-bolt-elements-item-contentAccent/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
        )}
        data-testid="resources-card"
        data-availability={availability}
        data-drift={drifted ? entry.drift_code : undefined}
        role={openable ? 'button' : undefined}
        tabIndex={openable ? 0 : undefined}
        aria-label={openable ? `Open ${entry.resource_concept || titleForKind(entry.resource_kind)}` : undefined}
        onClick={open}
        onKeyDown={
          openable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(entry);
                }
              }
            : undefined
        }
      >
        {/* Cinematic left accent rail — cyan when connected, amber when drifted, muted otherwise. */}
        <span
          aria-hidden="true"
          className={classNames(
            'absolute left-0 top-0 bottom-0 w-0.5',
            drifted
              ? 'bg-amber-400/70'
              : availability === 'connected'
                ? 'bg-bolt-elements-item-contentAccent/70'
                : 'bg-bolt-elements-borderColor',
          )}
        />

        {/* Top row — kind icon + concept + drift badge */}
        <div className="flex items-start gap-2.5">
          <div
            className={classNames(
              'flex items-center justify-center h-9 w-9 rounded-xl shrink-0 transition-colors',
              availability === 'connected'
                ? 'border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.08]'
                : 'border border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-1',
            )}
            aria-hidden="true"
          >
            <div
              className={classNames(
                iconForKind(entry.resource_kind),
                'text-xl',
                availability === 'connected'
                  ? 'text-bolt-elements-item-contentAccent'
                  : 'text-bolt-elements-textTertiary',
              )}
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-bolt-elements-textPrimary truncate" title={entry.resource_concept}>
              {entry.resource_concept || titleForKind(entry.resource_kind)}
            </p>
            <p className="text-[10px] text-bolt-elements-textTertiary truncate">{titleForKind(entry.resource_kind)}</p>
          </div>
          {drifted && (
            <span
              className="shrink-0 inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-amber-400/50 bg-amber-400/15 text-amber-300"
              data-testid="resources-drift-badge"
              title={`Drift: ${entry.drift_code}`}
            >
              <div className="i-ph:warning text-[9px]" />
              {humanizeToken(entry.drift_code as string)}
            </span>
          )}
        </div>

        {/* Binding name */}
        {entry.binding_name ? (
          <div className="flex items-center gap-1.5 min-w-0" title={`Binding: ${entry.binding_name}`}>
            <div className="i-ph:plug text-[11px] text-bolt-elements-textTertiary shrink-0" />
            <code className="text-[11px] font-mono text-bolt-elements-textSecondary truncate">{entry.binding_name}</code>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-[10px] text-bolt-elements-textTertiary italic">
            <div className="i-ph:plug text-[11px] shrink-0" />
            No binding
          </div>
        )}

        {/* Chips — lifecycle + tenancy + availability */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textTertiary">
            <div className="i-ph:circle-half text-[9px]" />
            {humanizeToken(entry.lifecycle_state) || 'Unknown'}
          </span>
          <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textTertiary">
            <div className="i-ph:users-three text-[9px]" />
            {humanizeToken(entry.tenancy) || 'Tenancy n/a'}
          </span>
          <span className={classNames('inline-flex items-center gap-1 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full border', availabilityChip.cls)}>
            <div className={classNames(availabilityChip.icon, 'text-[9px]')} />
            {availabilityChip.label}
          </span>
        </div>

        {/* Footer — last sync + optional add affordance */}
        <div className="flex items-center gap-2 mt-0.5 pt-2 border-t border-bolt-elements-borderColor/50">
          <div className="i-ph:clock-clockwise text-[11px] text-bolt-elements-textTertiary shrink-0" />
          <span className="text-[10px] text-bolt-elements-textTertiary flex-1 truncate" title={entry.last_sync_at}>
            {relativeTime(entry.last_sync_at)}
          </span>
          {isAddable && (
            <button
              type="button"
              onClick={() => onComingSoon(`Adding ${entry.resource_concept || titleForKind(entry.resource_kind)} is coming next.`)}
              data-testid="resources-add"
              className="min-h-[24px] text-[10px] font-medium px-2 py-1 rounded border border-bolt-elements-item-contentAccent/50 bg-bolt-elements-background-depth-1 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:plus" /> Add
            </button>
          )}
        </div>
      </div>
    );
  },
);

ResourceCard.displayName = 'ResourceOverviewPanel.ResourceCard';
