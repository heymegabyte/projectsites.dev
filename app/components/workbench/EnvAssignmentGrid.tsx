/**
 * @module app/components/workbench/EnvAssignmentGrid
 * @description Environment-assignment grid for the editor Resources tab (Data & Resource Platform, FIRE 5).
 * Shows, for ONE resource kind, which CF resource is bound in **preview** vs **production** — so an owner can
 * see at a glance whether their preview + production environments each have a resource, and what it's called.
 *
 * It derives the grid from the SAME overview endpoint the Resources tab already uses
 * (`PS_RES_OVERVIEW_REQUEST` → `GET /api/sites/:siteId/resources?environment=…`), issuing one request per
 * environment and filtering to the target kind — so it needs NO new bridge message and NO CF id is ever named
 * (the overview surfaces only display names + lifecycle state, never a CF id — INV-6). A never-provisioned
 * environment reads as an honest "Not provisioned" cell, never an error.
 *
 * @packageDocumentation
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';

import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  onParentMessage,
  postToParent,
  type ResourceOverviewEntry,
  type ResOverviewResponseMessage,
} from '~/lib/embed/embedded-mode';

const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'not enabled';
const ENVIRONMENTS = ['preview', 'production'] as const;
type Env = (typeof ENVIRONMENTS)[number];

/**
 * Visibility-aware poll cadence (per `real-time-data-no-manual-refresh`): the grid silently re-fetches
 * both environments every 30s while foregrounded — there is NO manual Refresh control. The poll pauses
 * while `document.hidden` and refreshes immediately when the tab returns to the foreground.
 */
const POLL_INTERVAL_MS = 30_000;

/** One environment's slot in the grid — the resolved resource (if any) for the kind in that environment. */
interface EnvSlot {
  present: boolean;
  displayName?: string;
  lifecycleState?: string;
  bindingName?: string;
}

type GridState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: EnvSlot; production: EnvSlot };

let correlationCounter = 0;
function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `envgrid_${++correlationCounter}`;
}

/** Does an entry name the target kind? Tolerant of synonym-ish labels (`database`→d1, `bucket`→r2). */
function matchesKind(entry: ResourceOverviewEntry, kind: string): boolean {
  const k = kind.toLowerCase();
  const rk = (entry.resource_kind || '').toLowerCase();
  if (rk === k) return true;
  if (k.includes('d1') && (rk.includes('d1') || rk.includes('sql') || rk.includes('database'))) return true;
  if (k.includes('kv') && (rk.includes('kv') || rk.includes('key'))) return true;
  if (k.includes('r2') && (rk.includes('r2') || rk.includes('bucket') || rk.includes('object'))) return true;
  return false;
}

/** Reduce an environment's overview rows to the slot for the target kind (first matching account-resource). */
function slotFor(entries: ResourceOverviewEntry[], kind: string): EnvSlot {
  const match = entries.find((e) => matchesKind(e, kind));
  if (!match) return { present: false };
  return {
    bindingName: match.binding_name,
    displayName: (match as { resource_display_name?: string }).resource_display_name ?? match.resource_concept ?? match.resource_kind,
    lifecycleState: match.lifecycle_state,
    present: true,
  };
}

export interface EnvAssignmentGridProps {
  /** The resource kind (`d1` | `kv` | `r2`) the grid shows preview↔production for. */
  kind: string;
  /** The environment currently open in the panel (highlighted as the active column). */
  environment: Env;
}

/**
 * The preview↔production environment-assignment grid for one kind. Loads both environments' overviews on mount
 * (via the existing overview bridge) and renders a two-column card showing each environment's resource, its
 * lifecycle state, and its binding — honest "Not provisioned" when an environment has no resource of the kind.
 */
export const EnvAssignmentGrid = memo(function EnvAssignmentGrid({ kind, environment }: EnvAssignmentGridProps) {
  const [state, setState] = useState<GridState>({ status: 'loading' });
  const pendingRef = useRef<Map<string, { resolve: (m: ResOverviewResponseMessage) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>(
    new Map(),
  );

  // ONE parent-message listener resolving overview replies by correlationId (repo []-deps stale-ref rule).
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_OVERVIEW_RESPONSE') return;
      const cid = msg.correlationId;
      if (!cid) return;
      const pending = pendingRef.current.get(cid);
      if (!pending) return;
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

  const requestOverview = useCallback((env: Env): Promise<ResOverviewResponseMessage> => {
    return new Promise((resolve, reject) => {
      const cid = nextCorrelationId();
      const timer = setTimeout(() => {
        pendingRef.current.delete(cid);
        reject(new Error('The request timed out.'));
      }, REQUEST_TIMEOUT_MS);
      pendingRef.current.set(cid, { reject, resolve, timer });
      postToParent({ type: 'PS_RES_OVERVIEW_REQUEST', correlationId: cid, environment: env });
    });
  }, []);

  /**
   * Load (or silently reload) both environments' slots.
   *
   * @param silent - when `true` (a background poll / foreground refresh), the current grid stays
   *   on-screen (no loading flash) and a transient failure keeps the last good view — freshness is
   *   invisible, per `real-time-data-no-manual-refresh`.
   */
  const load = useCallback(async (silent = false) => {
    if (!silent) setState({ status: 'loading' });
    if (!isEmbedded) {
      setState({ status: 'error', message: 'Open this from the ProjectSites admin to see environments.' });
      return;
    }
    try {
      const [preview, production] = await Promise.all([requestOverview('preview'), requestOverview('production')]);

      // Either reply being flag-dark means the whole surface is off.
      for (const reply of [preview, production]) {
        if (!reply.ok && (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404)))) {
          setState({ status: 'disabled' });
          return;
        }
      }
      if (!preview.ok && !production.ok) {
        if (!silent) setState({ status: 'error', message: preview.error || production.error || 'Could not load environments.' });
        return;
      }

      setState({
        preview: slotFor(preview.resources ?? [], kind),
        production: slotFor(production.resources ?? [], kind),
        status: 'ready',
      });
    } catch (err) {
      if (!silent) setState({ status: 'error', message: err instanceof Error ? err.message : 'Could not load environments.' });
    }
  }, [kind, requestOverview]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * Visibility-aware real-time poll (per `real-time-data-no-manual-refresh`) — the manual Refresh
   * control is gone; the grid keeps ITSELF current. Registered once; it reads the latest loader
   * through a ref so a kind change never tears down the timer. Pauses while `document.hidden`,
   * refreshes immediately on foreground, cleaned up on unmount.
   */
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!isEmbedded) return undefined;

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadRef.current(true);
    };

    const interval = setInterval(tick, POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (typeof document !== 'undefined' && !document.hidden) void loadRef.current(true);
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (state.status === 'disabled') return null;

  return (
    <div data-testid="resource-env-grid" className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="i-ph:git-branch-duotone text-sm text-bolt-elements-item-contentAccent" aria-hidden="true" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-bolt-elements-textSecondary">
          Environments
        </span>
        {/* Live affordance — the grid self-updates on a visibility-aware poll; no manual Refresh
            (per `real-time-data-no-manual-refresh`). */}
        {state.status === 'ready' && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-[9px] text-bolt-elements-textTertiary select-none"
            role="status"
            aria-live="off"
            title="This view updates itself automatically"
          >
            <span
              aria-hidden="true"
              className="h-1 w-1 rounded-full bg-bolt-elements-item-contentAccent animate-pulse motion-reduce:animate-none"
            />
            Live
          </span>
        )}
      </div>

      {state.status === 'loading' && (
        <div className="flex items-center gap-2 px-1 py-2 text-xs text-bolt-elements-textTertiary">
          <div className="i-ph:circle-notch animate-spin motion-reduce:animate-none text-sm" />
          Loading environments…
        </div>
      )}

      {state.status === 'error' && (
        <p className="px-1 py-2 text-xs text-red-300">{state.message}</p>
      )}

      {state.status === 'ready' && (
        <div className="grid grid-cols-2 gap-1.5">
          {ENVIRONMENTS.map((envName) => {
            const slot = envName === 'preview' ? state.preview : state.production;
            const active = envName === environment;
            return (
              <div
                key={envName}
                data-testid={`resource-env-cell-${envName}`}
                className={classNames(
                  'rounded-lg border px-2.5 py-2',
                  active
                    ? 'border-bolt-elements-item-contentAccent/50 bg-bolt-elements-item-backgroundAccent/30'
                    : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-1',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={classNames(
                      'text-[10px] font-semibold uppercase tracking-wider',
                      active ? 'text-bolt-elements-item-contentAccent' : 'text-bolt-elements-textTertiary',
                    )}
                  >
                    {envName}
                  </span>
                  {active && (
                    <span className="text-[9px] rounded bg-bolt-elements-item-backgroundAccent px-1 py-px text-bolt-elements-item-contentAccent">
                      viewing
                    </span>
                  )}
                </div>

                {slot.present ? (
                  <div className="mt-1 space-y-0.5">
                    <p className="text-xs font-medium text-bolt-elements-textPrimary truncate" title={slot.displayName}>
                      {slot.displayName}
                    </p>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {slot.lifecycleState && (
                        <span
                          className={classNames(
                            'text-[9px] rounded px-1 py-px',
                            slot.lifecycleState === 'active'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary',
                          )}
                        >
                          {slot.lifecycleState}
                        </span>
                      )}
                      {slot.bindingName && (
                        <span className="text-[9px] font-mono text-bolt-elements-textTertiary truncate" title={slot.bindingName}>
                          {slot.bindingName}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 text-[11px] text-bolt-elements-textTertiary italic">Not provisioned</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
