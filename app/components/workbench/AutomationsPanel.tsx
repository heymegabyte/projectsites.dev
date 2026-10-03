/**
 * @file Automations — the editor Resources tab's per-site automation/workflow log (RES-AUTO slice 2,
 * the FOURTH Resources section beside Media library + Site files + Buckets).
 *
 * A read-only, at-a-glance list of what ran for THIS site: every automation/workflow instance with
 * its kind, a status badge, and relative created/finished times. Consumes slice-1's endpoint
 * `GET /api/sites/:siteId/automations` → `{ data: [{ id, type, status, created_at, finished_at }] }`.
 *
 * The embedded editor has NO cross-origin session, so it talks to the parent admin (which holds the
 * bearer + `selectedSite`) over `postMessage`, via the typed sender `requestAutomations` in
 * `embedded-mode.ts` (the parent proxies to the worker). Every CF id + the siteId is server/parent-
 * resolved; this panel never sees or sends one. The DARK `site_automations` flag surfaces as a
 * friendly "not enabled yet" card (a 404 whose reply carries `enabled:false`), NEVER a crash/red
 * console. Loading · honest-empty · error · disabled are all handled.
 *
 * Real-time: the list SELF-updates on a visibility-aware 30s poll (per `real-time-data-no-manual-
 * refresh`) — no manual Refresh button; the silent refresh keeps the last good list on a transient
 * error and pauses while `document.hidden`.
 *
 * BRAND: black + cyan (#00E5FF primary) + purple (#7C3AED secondary), zero white/gray hard-codes —
 * every surface uses `--bolt-elements-*` tokens / UnoCSS `bolt-elements-*` classes. Every control
 * ≥24px, carries text OR an aria-label + title, has a cyan focus-visible ring. Motion is
 * `motion-reduce:*`-gated. Style mirrors the sibling `./BucketsPanel` + `./ResourcesPanel`.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader } from './panel';
import { isEmbedded, requestAutomations, type AutomationEntry } from '~/lib/embed/embedded-mode';

// ── Brand accents (mirror BucketsPanel / ResourcesPanel) ──────────────────────
const PURPLE = '#7C3AED';
const PURPLE_INK = '#a97bff';
const TEAL = '#22d3ee';

const DISABLED_404 = 'not enabled';

/**
 * Visibility-aware poll cadence (per `real-time-data-no-manual-refresh`): the automations list
 * silently re-fetches every 30s while foregrounded — there is NO manual Refresh button. Pauses
 * while `document.hidden`; refreshes immediately when the tab returns to the foreground.
 */
const POLL_INTERVAL_MS = 30_000;

// ── Formatting + status helpers ───────────────────────────────────────────────

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

/** Visual treatment for a job status — icon + brand accent (cyan running, green ok, red fail). */
function statusMeta(status: string): { label: string; icon: string; color: string; spin?: boolean } {
  const s = (status || '').toLowerCase();

  if (s === 'success' || s === 'succeeded' || s === 'complete' || s === 'completed' || s === 'published') {
    return { label: status, icon: 'i-ph:check-circle-duotone', color: '#34d399' };
  }

  if (s === 'failed' || s === 'error' || s === 'errored' || s === 'cancelled' || s === 'canceled') {
    return { label: status, icon: 'i-ph:x-circle-duotone', color: '#f87171' };
  }

  if (s === 'running' || s === 'in_progress' || s === 'processing' || s === 'generating') {
    return { label: status, icon: 'i-ph:circle-notch', color: 'var(--bolt-elements-item-contentAccent)', spin: true };
  }

  if (s === 'queued' || s === 'pending' || s === 'waiting') {
    return { label: status, icon: 'i-ph:clock-duotone', color: PURPLE_INK };
  }

  return { label: status || 'unknown', icon: 'i-ph:dot-outline-duotone', color: TEAL };
}

/** A phosphor glyph for an automation kind. */
function iconForType(type: string): string {
  const t = (type || '').toLowerCase();

  if (t.includes('site') || t.includes('generation') || t.includes('build')) {
    return 'i-ph:magic-wand-duotone';
  }

  if (t.includes('deploy') || t.includes('publish')) {
    return 'i-ph:rocket-launch-duotone';
  }

  if (t.includes('image') || t.includes('media') || t.includes('asset')) {
    return 'i-ph:image-duotone';
  }

  if (t.includes('email') || t.includes('notify') || t.includes('notification')) {
    return 'i-ph:envelope-duotone';
  }

  if (t.includes('drive') || t.includes('sync') || t.includes('import')) {
    return 'i-ph:arrows-clockwise-duotone';
  }

  return 'i-ph:gear-duotone';
}

// ── Types ──────────────────────────────────────────────────────────────────────

type AutomationsState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; automations: AutomationEntry[] };

// ── Component ────────────────────────────────────────────────────────────────

export const AutomationsPanel = memo(() => {
  const [state, setState] = useState<AutomationsState>({ status: 'loading' });

  /** Load (or reload) the site's automations. */
  const loadAutomations = useCallback(async () => {
    setState({ status: 'loading' });

    if (!isEmbedded) {
      setState({ status: 'error', message: 'Open this from the ProjectSites admin to see your automations.' });
      return;
    }

    try {
      const reply = await requestAutomations();

      if (!reply.ok) {
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setState({ status: 'disabled' });
          return;
        }

        setState({ status: 'error', message: reply.error || 'Could not load your automations.' });

        return;
      }

      setState({ status: 'ready', automations: reply.automations ?? [] });
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not load your automations.',
      });
    }
  }, []);

  useEffect(() => {
    void loadAutomations();
  }, [loadAutomations]);

  /** Silent background refresh — keep the last good list on a transient error (no loading flash). */
  const refreshAutomations = useCallback(async () => {
    try {
      const reply = await requestAutomations();

      if (reply.ok) {
        setState({ status: 'ready', automations: reply.automations ?? [] });
      }
    } catch {
      /* keep prior list on a transient refresh error */
    }
  }, []);

  /*
   * Visibility-aware real-time poll (per `real-time-data-no-manual-refresh`) — no manual Refresh
   * button; the list keeps ITSELF current via the silent `refreshAutomations`. Registered once; the
   * tick reads the latest state through a ref. Pauses while `document.hidden` or before the first
   * load settles / while disabled; refreshes immediately on foreground; cleaned up on unmount.
   */
  const refreshRef = useRef(refreshAutomations);
  refreshRef.current = refreshAutomations;

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
      <PanelShell testId="automations-panel">
        <DisabledCard />
      </PanelShell>
    );
  }

  return (
    <PanelShell testId="automations-panel">
      <AutomationsHeader count={state.status === 'ready' ? state.automations.length : undefined} />

      <div className="flex-1 overflow-auto modern-scrollbar min-h-0">
        {state.status === 'loading' && <AutomationsSkeleton />}
        {state.status === 'error' && <ErrorCard message={state.message} onRetry={() => void loadAutomations()} />}
        {state.status === 'ready' &&
          (state.automations.length === 0 ? (
            <AutomationsEmpty />
          ) : (
            <ul className="divide-y divide-bolt-elements-borderColor/25" data-testid="automations-list">
              {state.automations.map((a) => (
                <AutomationRow key={a.id} automation={a} />
              ))}
            </ul>
          ))}
      </div>
    </PanelShell>
  );
});

AutomationsPanel.displayName = 'AutomationsPanel';

// ── Header ───────────────────────────────────────────────────────────────────

const AutomationsHeader = memo(({ count }: { count?: number }) => (
  <PanelHeader
    icon="i-ph:lightning-duotone"
    title="Automations"
    subtitle={
      count !== undefined && count > 0 ? (
        <span className="tabular-nums">
          <span className="text-bolt-elements-textSecondary font-medium">{count}</span> automation
          {count === 1 ? '' : 's'} · newest first
        </span>
      ) : (
        'What ran for your site — builds, deploys & more'
      )
    }
    actions={
      // Live affordance — the list self-updates on a visibility-aware poll; no manual Refresh
      // (per `real-time-data-no-manual-refresh`).
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

AutomationsHeader.displayName = 'AutomationsPanel.Header';

// ── Row ──────────────────────────────────────────────────────────────────────

const AutomationRow = memo(({ automation }: { automation: AutomationEntry }) => {
  const sm = statusMeta(automation.status);
  const created = formatRelativeTime(automation.created_at);
  const finished = formatRelativeTime(automation.finished_at);

  return (
    <li
      className="group flex items-center gap-2.5 px-4 py-2.5 hover:bg-bolt-elements-item-backgroundActive transition-colors motion-reduce:transition-none"
      data-testid="automations-row"
    >
      <div
        className={classNames(iconForType(automation.type), 'text-base text-bolt-elements-textTertiary shrink-0')}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-bolt-elements-textPrimary truncate" title={automation.type}>
          {automation.type}
        </p>
        <p className="text-[10px] text-bolt-elements-textTertiary tabular-nums flex items-center gap-1">
          {created && <span title={automation.created_at}>Started {created}</span>}
          {finished && (
            <>
              <span className="text-bolt-elements-textTertiary/50" aria-hidden>
                ·
              </span>
              <span title={automation.finished_at ?? undefined}>finished {finished}</span>
            </>
          )}
          {!created && !finished && <span>{automation.id}</span>}
        </p>
      </div>

      {/* Status badge — icon + label, color-coded, AA-contrast token colors. */}
      <span
        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0"
        style={{ borderColor: `color-mix(in oklch, ${sm.color} 45%, transparent)`, color: sm.color }}
        title={`Status: ${automation.status}`}
      >
        <div
          className={classNames(sm.icon, 'text-[11px]', sm.spin && 'animate-spin motion-reduce:animate-none')}
          aria-hidden
        />
        {sm.label}
      </span>
    </li>
  );
});

AutomationRow.displayName = 'AutomationsPanel.Row';

// ── States ───────────────────────────────────────────────────────────────────

const AutomationsSkeleton = memo(() => (
  <ul className="divide-y divide-bolt-elements-borderColor/25" aria-busy="true" data-testid="automations-skeleton">
    {Array.from({ length: 6 }).map((_, i) => (
      <li key={i} className="flex items-center gap-2.5 px-4 py-3">
        <div className="h-5 w-5 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse shrink-0" />
        <div className="flex-1 space-y-1.5">
          <div className="h-2.5 w-2/5 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
          <div className="h-2 w-1/4 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse" />
        </div>
        <div className="h-4 w-16 rounded bg-bolt-elements-background-depth-3 motion-safe:animate-pulse shrink-0" />
      </li>
    ))}
  </ul>
));

AutomationsSkeleton.displayName = 'AutomationsPanel.Skeleton';

const AutomationsEmpty = memo(() => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center"
    data-testid="automations-empty"
  >
    <div className="relative flex items-center justify-center h-16 w-16 rounded-2xl border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.06]">
      <div
        aria-hidden
        className="absolute inset-0 rounded-2xl opacity-60"
        style={{
          background: `radial-gradient(60% 60% at 50% 30%, color-mix(in oklch, ${PURPLE} 22%, transparent), transparent)`,
        }}
      />
      <div className="relative i-ph:lightning-duotone text-3xl text-bolt-elements-item-contentAccent" aria-hidden />
    </div>
    <div className="space-y-1">
      <p className="text-sm font-semibold text-bolt-elements-textPrimary">No automations yet</p>
      <p className="text-[11px] text-bolt-elements-textTertiary max-w-[290px] leading-relaxed">
        When your site runs an automation — a build, a deploy, an image generation — it shows up here with its status
        and timing.
      </p>
    </div>
  </div>
));

AutomationsEmpty.displayName = 'AutomationsPanel.Empty';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="automations-error"
  >
    <div className="flex items-center justify-center h-12 w-12 rounded-2xl border border-red-400/30 bg-red-500/[0.07]">
      <div className="i-ph:warning-circle-duotone text-2xl text-red-400" aria-hidden />
    </div>
    <p className="text-xs text-bolt-elements-textSecondary max-w-[280px] leading-relaxed">{message}</p>
    <button
      type="button"
      onClick={onRetry}
      data-testid="automations-retry"
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

ErrorCard.displayName = 'AutomationsPanel.ErrorCard';

/** Dark-flag card — friendly, never a scary error (per the 404 "not enabled" contract). */
const DisabledCard = memo(() => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="automations-disabled"
  >
    <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
      <div className="i-ph:lock-key-duotone text-3xl text-bolt-elements-textTertiary" aria-hidden />
    </div>
    <p className="text-sm font-semibold text-bolt-elements-textSecondary">Automations aren&rsquo;t enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px] leading-relaxed">
      This is on the way. Once it&rsquo;s turned on, your site&rsquo;s automations show up here — nothing to set up.
    </p>
  </div>
));

DisabledCard.displayName = 'AutomationsPanel.DisabledCard';
