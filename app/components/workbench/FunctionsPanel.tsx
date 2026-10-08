/**
 * @file Functions — the editor Resources tab's per-site CODE-DEFINED Functions log (Resources
 * sub-tab #5, beside Media library + Site files + Buckets + Automations).
 *
 * A read-only, at-a-glance list of a site's Functions on Workers-for-Platforms: its deployed
 * `functions/` HTTP worker (one deployment unit, with real deploy status + bundle size) PLUS one
 * row per cron it declared in `functions/_scheduled.*`. Consumes the worker endpoint
 * `GET /api/sites/:siteId/functions` → `{ data:[{id,kind,name,status,cron,bundleBytes,deployed_at}],
 * functionsDeployed, wfpConfigured }`.
 *
 * DOCTRINE (ADR-0035, docs/FUNCTIONS-CONVERGENCE.md): Functions are CODE-DEFINED — owners author a
 * `functions/` folder in THIS editor's file tree, NOT a dashboard form. So this panel is a
 * READ/MANAGE VIEW that LISTS what's deployed; it is never an authoring form. The empty state points
 * the owner at the real authoring surface (the `functions/` folder), never a fake "create" button.
 *
 * The embedded editor has NO cross-origin session, so it talks to the parent admin (which holds the
 * bearer + `selectedSite`) over `postMessage`, via the typed sender `requestFunctions` in
 * `embedded-mode.ts` (the parent proxies to the worker). Every CF id + the siteId is server/parent-
 * resolved; this panel never sees or sends one. The DARK `site_functions` flag surfaces as a friendly
 * "not enabled yet" card (a 404 whose reply carries `enabled:false`), NEVER a crash/red console.
 * Loading · honest-empty · error · disabled are all handled.
 *
 * Real-time: the list SELF-updates on a visibility-aware 30s poll (per `real-time-data-no-manual-
 * refresh`) — no manual Refresh button; the silent refresh keeps the last good list on a transient
 * error and pauses while `document.hidden`.
 *
 * BRAND: black + cyan (#00E5FF primary) + purple (#7C3AED secondary), zero white/gray hard-codes —
 * every surface uses `--bolt-elements-*` tokens / UnoCSS `bolt-elements-*` classes. Every control
 * ≥24px, carries text OR an aria-label + title, has a cyan focus-visible ring. Motion is
 * `motion-reduce:*`-gated. Style mirrors the sibling `./AutomationsPanel` + `./BucketsPanel`.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader } from './panel';
import { isEmbedded, requestFunctions, type FunctionEntry } from '~/lib/embed/embedded-mode';

// ── Brand accents (mirror AutomationsPanel / BucketsPanel) ────────────────────
const PURPLE = '#7C3AED';
const PURPLE_INK = '#a97bff';

/**
 * Visibility-aware poll cadence (per `real-time-data-no-manual-refresh`): the functions list
 * silently re-fetches every 30s while foregrounded — there is NO manual Refresh button. Pauses
 * while `document.hidden`; refreshes immediately when the tab returns to the foreground.
 */
const POLL_INTERVAL_MS = 30_000;

// ── Formatting helpers ─────────────────────────────────────────────────────────

/** Compact relative time ("3d ago", "2h ago", "just now") from an ISO string. */
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

/** Human byte size ("1.2 KB", "834 B") — pure, for the deployed bundle size. */
export function formatBytes(bytes: number | null | undefined): string | undefined {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kb = bytes / 1024;

  if (kb < 1024) {
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }

  const mb = kb / 1024;

  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

/** Visual treatment for a function status — icon + brand accent. */
function statusMeta(status: string): { label: string; icon: string; color: string } {
  const s = (status || '').toLowerCase();

  if (s === 'deployed') {
    return { label: 'Deployed', icon: 'i-ph:check-circle-duotone', color: '#34d399' };
  }

  // not_deployed (declared but no live worker) — informative, not an error.
  return { label: 'Not deployed', icon: 'i-ph:circle-dashed-duotone', color: PURPLE_INK };
}

/** A phosphor glyph for a function kind. */
function iconForKind(kind: FunctionEntry['kind']): string {
  return kind === 'scheduled' ? 'i-ph:clock-countdown-duotone' : 'i-ph:brackets-curly-duotone';
}

/** The human sub-label for a function kind. */
function kindLabel(kind: FunctionEntry['kind']): string {
  return kind === 'scheduled' ? 'Scheduled' : 'HTTP endpoints';
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type FunctionsState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; functions: FunctionEntry[]; functionsDeployed: boolean; wfpConfigured: boolean };

const DISABLED_404 = 'not enabled';

/**
 * PURE mapper: a parent-bridge {@link FunctionsResponseMessage} reply → the panel's render state.
 * The single source of truth for BOTH the initial load and the silent refresh, so the two can
 * never drift — and (per the sibling `AutomationsPanel`/`MediaPageStats` pattern) it makes the
 * disabled / error / ready / honest-empty branches falsifiable WITHOUT mounting the panel.
 *
 * Contract:
 *  - `ok:false` + (`enabled === false` OR an error message containing "not enabled") → `disabled`
 *    (the DARK `site_functions` flag 404 — a friendly card, never a scary error).
 *  - `ok:false` otherwise → `error` with the reply's message (or a safe default).
 *  - `ok:true` → `ready` with the functions list + the two deploy signals (honest-empty `[]` stays
 *    a ready state, NOT an error — a site with no functions is a valid, expected state).
 *
 * @param reply - the parent admin's `PS_RES_FUNCTIONS_RESULT` reply.
 * @returns the derived {@link FunctionsState} (never `loading` — that's the pre-reply state).
 * @example deriveFunctionsState({ type:'PS_RES_FUNCTIONS_RESULT', ok:false, enabled:false }) // { status:'disabled' }
 */
export function deriveFunctionsState(reply: {
  ok: boolean;
  functions?: FunctionEntry[];
  functionsDeployed?: boolean;
  wfpConfigured?: boolean;
  enabled?: boolean;
  error?: string;
}): Exclude<FunctionsState, { status: 'loading' }> {
  if (!reply.ok) {
    if (reply.enabled === false || (reply.error != null && reply.error.includes(DISABLED_404))) {
      return { status: 'disabled' };
    }

    return { status: 'error', message: reply.error || 'Could not load your functions.' };
  }

  return {
    status: 'ready',
    functions: reply.functions ?? [],
    functionsDeployed: reply.functionsDeployed ?? false,
    wfpConfigured: reply.wfpConfigured ?? false,
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export const FunctionsPanel = memo(() => {
  const [state, setState] = useState<FunctionsState>({ status: 'loading' });

  /** Load (or reload) the site's functions. */
  const loadFunctions = useCallback(async () => {
    setState({ status: 'loading' });

    if (!isEmbedded) {
      setState({ status: 'error', message: 'Open this from the ProjectSites admin to see your functions.' });
      return;
    }

    try {
      setState(deriveFunctionsState(await requestFunctions()));
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not load your functions.',
      });
    }
  }, []);

  useEffect(() => {
    void loadFunctions();
  }, [loadFunctions]);

  /** Silent background refresh — keep the last good list on a transient error (no loading flash). */
  const refreshFunctions = useCallback(async () => {
    try {
      const reply = await requestFunctions();

      // Only a successful reply replaces the list — a transient error/disabled blip keeps the last
      // good render (no flash). Mirrors AutomationsPanel's silent-refresh contract.
      if (reply.ok) {
        setState(deriveFunctionsState(reply));
      }
    } catch {
      /* keep prior list on a transient refresh error */
    }
  }, []);

  /*
   * Visibility-aware real-time poll (per `real-time-data-no-manual-refresh`) — no manual Refresh
   * button; the list keeps ITSELF current via the silent `refreshFunctions`. Registered once; the
   * tick reads the latest state through a ref. Pauses while `document.hidden` or before the first
   * load settles / while disabled; refreshes immediately on foreground; cleaned up on unmount.
   */
  const refreshRef = useRef(refreshFunctions);
  refreshRef.current = refreshFunctions;

  const statusRef = useRef(state.status);
  statusRef.current = state.status;

  useEffect(() => {
    if (!isEmbedded) {
      return undefined;
    }

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      if (statusRef.current === 'disabled' || statusRef.current === 'loading') {
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

  if (state.status === 'disabled') {
    return (
      <PanelShell testId="functions-panel">
        <DisabledCard />
      </PanelShell>
    );
  }

  return (
    <PanelShell testId="functions-panel">
      <FunctionsHeader count={state.status === 'ready' ? state.functions.length : undefined} />

      <div className="flex-1 overflow-auto modern-scrollbar min-h-0">
        {state.status === 'loading' && <FunctionsSkeleton />}
        {state.status === 'error' && <ErrorCard message={state.message} onRetry={() => void loadFunctions()} />}
        {state.status === 'ready' &&
          (state.functions.length === 0 ? (
            <FunctionsEmpty wfpConfigured={state.wfpConfigured} />
          ) : (
            <ul className="divide-y divide-bolt-elements-borderColor/25" data-testid="functions-list">
              {state.functions.map((fn) => (
                <FunctionRow key={fn.id} fn={fn} />
              ))}
            </ul>
          ))}
      </div>
    </PanelShell>
  );
});

FunctionsPanel.displayName = 'FunctionsPanel';

// ── Header ───────────────────────────────────────────────────────────────────

const FunctionsHeader = memo(({ count }: { count?: number }) => (
  <PanelHeader
    icon="i-ph:brackets-curly-duotone"
    title="Functions"
    subtitle={
      count !== undefined && count > 0 ? (
        <span className="tabular-nums">
          <span className="text-bolt-elements-textSecondary font-medium">{count}</span> function
          {count === 1 ? '' : 's'} · code-defined on Cloudflare
        </span>
      ) : (
        'Code you deploy from your functions/ folder'
      )
    }
    actions={
      // Live affordance — the list self-updates on a visibility-aware poll; no manual Refresh.
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
    }
  />
));

FunctionsHeader.displayName = 'FunctionsPanel.Header';

// ── Row ──────────────────────────────────────────────────────────────────────

const FunctionRow = memo(({ fn }: { fn: FunctionEntry }) => {
  const sm = statusMeta(fn.status);
  const deployed = formatRelativeTime(fn.deployed_at);
  const size = formatBytes(fn.bundleBytes);

  return (
    <li
      className="group flex items-center gap-2.5 px-4 py-2.5 hover:bg-bolt-elements-item-backgroundActive transition-colors motion-reduce:transition-none"
      data-testid="functions-row"
    >
      <div
        className={classNames(iconForKind(fn.kind), 'text-base text-bolt-elements-textTertiary shrink-0')}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-bolt-elements-textPrimary truncate font-mono" title={fn.name}>
          {fn.name}
        </p>
        <p className="text-[10px] text-bolt-elements-textTertiary tabular-nums flex items-center gap-1 flex-wrap">
          <span>{kindLabel(fn.kind)}</span>
          {size && (
            <>
              <span className="text-bolt-elements-textTertiary/50" aria-hidden>
                ·
              </span>
              <span title={`Deployed bundle size: ${fn.bundleBytes} bytes`}>{size}</span>
            </>
          )}
          {deployed && (
            <>
              <span className="text-bolt-elements-textTertiary/50" aria-hidden>
                ·
              </span>
              <span title={fn.deployed_at ?? undefined}>deployed {deployed}</span>
            </>
          )}
        </p>
      </div>

      {/* Status badge — icon + label, color-coded, AA-contrast token colors. */}
      <span
        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0"
        style={{ borderColor: `color-mix(in oklch, ${sm.color} 45%, transparent)`, color: sm.color }}
        title={`Status: ${fn.status}`}
      >
        <div className={classNames(sm.icon, 'text-[11px]')} aria-hidden />
        {sm.label}
      </span>
    </li>
  );
});

FunctionRow.displayName = 'FunctionsPanel.Row';

// ── States ───────────────────────────────────────────────────────────────────

const FunctionsSkeleton = memo(() => (
  <ul className="divide-y divide-bolt-elements-borderColor/25" aria-busy="true" data-testid="functions-skeleton">
    {Array.from({ length: 5 }).map((_, i) => (
      <li key={i} className="flex items-center gap-2.5 px-4 py-3">
        <div className="h-5 w-5 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse shrink-0" />
        <div className="flex-1 space-y-1.5">
          <div className="h-2.5 w-2/5 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
          <div className="h-2 w-1/4 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
        </div>
        <div className="h-4 w-20 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse shrink-0" />
      </li>
    ))}
  </ul>
));

FunctionsSkeleton.displayName = 'FunctionsPanel.Skeleton';

/**
 * Honest empty — a launchpad to the REAL authoring surface (the `functions/` folder in the editor's
 * file tree), per ADR-0035 + `embarrassingly-easy-to-use`. Never a fake "create function" button:
 * Functions are code-defined, so the empty state teaches the one true way to add one.
 */
const FunctionsEmpty = memo(({ wfpConfigured }: { wfpConfigured: boolean }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center" data-testid="functions-empty">
    <div className="relative flex items-center justify-center h-16 w-16 rounded-2xl border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.06]">
      <div
        aria-hidden
        className="absolute inset-0 rounded-2xl opacity-60"
        style={{
          background: `radial-gradient(60% 60% at 50% 30%, color-mix(in oklch, ${PURPLE} 22%, transparent), transparent)`,
        }}
      />
      <div
        className="relative i-ph:brackets-curly-duotone text-3xl text-bolt-elements-item-contentAccent"
        aria-hidden
      />
    </div>
    <div className="space-y-1">
      <p className="text-sm font-semibold text-bolt-elements-textPrimary">No functions yet</p>
      <p className="text-[11px] text-bolt-elements-textTertiary max-w-[300px] leading-relaxed">
        Add server-side code by creating a{' '}
        <code className="font-mono text-bolt-elements-item-contentAccent">functions/</code> folder in your site&rsquo;s
        files — each file becomes an endpoint, and a{' '}
        <code className="font-mono text-bolt-elements-item-contentAccent">functions/_scheduled.ts</code> runs on a cron.
        They deploy automatically when you publish.
      </p>
      {!wfpConfigured && (
        <p className="text-[10px] text-bolt-elements-textTertiary/70 max-w-[300px] leading-relaxed pt-1">
          Note: the Functions runtime isn&rsquo;t provisioned on this environment yet, so published functions
          won&rsquo;t go live until it is.
        </p>
      )}
    </div>
  </div>
));

FunctionsEmpty.displayName = 'FunctionsPanel.Empty';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="functions-error">
    <div className="flex items-center justify-center h-12 w-12 rounded-2xl border border-red-400/30 bg-red-500/[0.07]">
      <div className="i-ph:warning-circle-duotone text-2xl text-red-400" aria-hidden />
    </div>
    <p className="text-xs text-bolt-elements-textSecondary max-w-[280px] leading-relaxed">{message}</p>
    <button
      type="button"
      onClick={onRetry}
      data-testid="functions-retry"
      className={classNames(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150 motion-reduce:transition-none cursor-pointer select-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent',
        'min-h-[28px] mt-1 px-3 py-1.5 text-[11px]',
        'border border-bolt-elements-item-contentAccent/35 bg-bolt-elements-item-contentAccent/[0.06] text-bolt-elements-item-contentAccent',
        'hover:bg-bolt-elements-item-contentAccent/[0.14] hover:border-bolt-elements-item-contentAccent/60',
      )}
    >
      <div className="i-ph:arrow-clockwise text-sm" /> Try again
    </button>
  </div>
));

ErrorCard.displayName = 'FunctionsPanel.ErrorCard';

/** Dark-flag card — friendly, never a scary error (per the 404 "not enabled" contract). */
const DisabledCard = memo(() => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="functions-disabled"
  >
    <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
      <div className="i-ph:lock-key-duotone text-3xl text-bolt-elements-textTertiary" aria-hidden />
    </div>
    <p className="text-sm font-semibold text-bolt-elements-textSecondary">Functions aren&rsquo;t enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px] leading-relaxed">
      This is on the way. Once it&rsquo;s turned on, the server-side code you deploy from your{' '}
      <code className="font-mono text-bolt-elements-textSecondary">functions/</code> folder shows up here.
    </p>
  </div>
));

DisabledCard.displayName = 'FunctionsPanel.DisabledCard';
