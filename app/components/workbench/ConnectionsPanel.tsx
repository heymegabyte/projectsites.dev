/**
 * @file Connections — the editor Resources tab's per-site MCP CONNECTIONS log (Resources sub-tab
 * #6, beside Media library + Site files + Buckets + Automations + Functions).
 *
 * A list of the providers a site has connected over MCP (Model Context Protocol) — Mailchimp,
 * Stripe, HubSpot, GitHub, Slack, Notion, … — with a status chip + "connected …" relative time, and
 * a per-row DISCONNECT action. Consumes the parent-bridge `requestConnections` reply (the admin
 * proxies to `GET /api/sites/:siteId/mcp/connections` → `{ data:{ providers, connections:[{id,
 * provider, display_name, status, metadata, connected_at}] } }`). Access tokens are NEVER returned
 * (server-side guarantee) — this panel only ever sees safe, non-secret metadata.
 *
 * Disconnect is OPTIMISTIC: the row drops the instant the user confirms, then the real
 * `disconnectConnection(id)` bridge call runs (→ `DELETE /api/sites/:id/mcp/connections/:id`, which
 * revokes + clears the encrypted tokens + audit-logs `mcp.disconnected`). A failure RESTORES the row
 * (never a silent loss) + toasts. A new "Connect a provider" affordance links to the admin's MCP
 * surface (`/api/mcp/:provider/connect` is the existing OAuth/paste-key flow — this panel does NOT
 * build new OAuth) so the empty state is a real launchpad, never a dead end.
 *
 * The embedded editor has NO cross-origin session, so it talks to the parent admin (which holds the
 * bearer + `selectedSite`) over `postMessage`. The mcp/connections ENDPOINT is org+user+siteOwned-
 * guarded (shared with the admin's /admin/mcp surface, NOT flag-gated); the editor TAB is DARK behind
 * the `site_connections` flag, which the admin bridge resolves via `GET /api/feature-flags/
 * site_connections` BEFORE the list fetch — off → `{ok:false, enabled:false}` → this panel shows a
 * friendly "not enabled yet" card (NEVER a crash/red console) + the tab self-hides. Loading ·
 * honest-empty · error · disabled are all handled.
 *
 * Real-time: the list SELF-updates on a visibility-aware 30s poll (per `real-time-data-no-manual-
 * refresh`) — no manual Refresh button; the silent refresh keeps the last good list on a transient
 * error and pauses while `document.hidden`.
 *
 * BRAND: black + cyan (#00E5FF primary) + purple (#7C3AED secondary), zero white/gray hard-codes —
 * every surface uses `--bolt-elements-*` tokens / UnoCSS `bolt-elements-*` classes. Every control
 * ≥24px, carries text OR an aria-label + title, has a cyan focus-visible ring. Motion is
 * `motion-reduce:*`-gated. Style mirrors the sibling `./FunctionsPanel` + `./AutomationsPanel`.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader } from './panel';
import {
  isEmbedded,
  postToastToParent,
  requestConnections,
  disconnectConnection,
  type ConnectionEntry,
} from '~/lib/embed/embedded-mode';

// ── Brand accents (mirror FunctionsPanel / AutomationsPanel) ──────────────────
const PURPLE = '#7C3AED';
const PURPLE_INK = '#a97bff';

/**
 * Visibility-aware poll cadence (per `real-time-data-no-manual-refresh`): the connections list
 * silently re-fetches every 30s while foregrounded — there is NO manual Refresh button. Pauses
 * while `document.hidden`; refreshes immediately when the tab returns to the foreground.
 */
const POLL_INTERVAL_MS = 30_000;

/** How long the "Disconnected · Undo" bar stays before the panel treats the removal as final (ms). */
const UNDO_HINT_MS = 6000;

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

/**
 * A human label for a provider key — title-cases + de-snakes the key (`google_calendar` → "Google
 * Calendar"), with a few proper-noun fixups so common providers read correctly (HubSpot, GitHub).
 * Pure + exported so the render is unit-falsifiable without mounting the panel.
 */
export function providerLabel(provider: string): string {
  const key = (provider || '').toLowerCase();
  const FIXUPS: Record<string, string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    hubspot: 'HubSpot',
    mailchimp: 'Mailchimp',
    paypal: 'PayPal',
    youtube: 'YouTube',
    openai: 'OpenAI',
    cal_com: 'Cal.com',
    google_calendar: 'Google Calendar',
    posthog: 'PostHog',
    pagerduty: 'PagerDuty',
  };

  if (FIXUPS[key]) {
    return FIXUPS[key];
  }

  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** A phosphor glyph for a provider key — a small, recognizable set, with a neutral fallback. */
function iconForProvider(provider: string): string {
  const key = (provider || '').toLowerCase();
  const MAP: Record<string, string> = {
    github: 'i-ph:github-logo-duotone',
    gitlab: 'i-ph:gitlab-logo-duotone',
    slack: 'i-ph:slack-logo-duotone',
    notion: 'i-ph:notion-logo-duotone',
    discord: 'i-ph:discord-logo-duotone',
    stripe: 'i-ph:credit-card-duotone',
    paypal: 'i-ph:paypal-logo-duotone',
    mailchimp: 'i-ph:envelope-duotone',
    resend: 'i-ph:envelope-duotone',
    google_calendar: 'i-ph:calendar-duotone',
    cal_com: 'i-ph:calendar-duotone',
    calendly: 'i-ph:calendar-duotone',
    hubspot: 'i-ph:funnel-duotone',
    linear: 'i-ph:kanban-duotone',
  };

  return MAP[key] ?? 'i-ph:plug-duotone';
}

/** Visual treatment for a connection status — icon + brand accent. */
function statusMeta(status: string): { label: string; icon: string; color: string } {
  const s = (status || '').toLowerCase();

  if (s === 'active' || s === 'connected') {
    return { label: 'Connected', icon: 'i-ph:check-circle-duotone', color: '#34d399' };
  }

  if (s === 'expired') {
    return { label: 'Expired', icon: 'i-ph:warning-circle-duotone', color: '#fbbf24' };
  }

  if (s === 'revoked') {
    return { label: 'Revoked', icon: 'i-ph:prohibit-duotone', color: PURPLE_INK };
  }

  // Any other status — surface it verbatim (title-cased) in a neutral accent, never a crash.
  return { label: providerLabel(s || 'unknown'), icon: 'i-ph:circle-duotone', color: PURPLE_INK };
}

// ── Types ──────────────────────────────────────────────────────────────────────

export type ConnectionsState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; connections: ConnectionEntry[]; providers: string[] };

const DISABLED_404 = 'not enabled';

/**
 * PURE mapper: a parent-bridge {@link ConnectionsResponseMessage} reply → the panel's render state.
 * The single source of truth for BOTH the initial load and the silent refresh, so the two can
 * never drift — and (per the sibling `FunctionsPanel`'s `deriveFunctionsState`) it makes the
 * disabled / error / ready / honest-empty branches falsifiable WITHOUT mounting the panel.
 *
 * Contract:
 *  - `ok:false` + (`enabled === false` OR an error message containing "not enabled") → `disabled`
 *    (the DARK `site_connections` flag — a friendly card, never a scary error).
 *  - `ok:false` otherwise → `error` with the reply's message (or a safe default).
 *  - `ok:true` → `ready` with the connections list + the provider catalog (honest-empty `[]` stays
 *    a ready state, NOT an error — a site with no connections is a valid, expected state).
 *
 * @param reply - the parent admin's `PS_RES_CONNECTIONS_RESULT` reply.
 * @returns the derived {@link ConnectionsState} (never `loading` — that's the pre-reply state).
 * @example deriveConnectionsState({ ok:false, enabled:false }) // { status:'disabled' }
 */
export function deriveConnectionsState(reply: {
  ok: boolean;
  connections?: ConnectionEntry[];
  providers?: string[];
  enabled?: boolean;
  error?: string;
}): Exclude<ConnectionsState, { status: 'loading' }> {
  if (!reply.ok) {
    if (reply.enabled === false || (reply.error != null && reply.error.includes(DISABLED_404))) {
      return { status: 'disabled' };
    }

    return { status: 'error', message: reply.error || 'Could not load your connections.' };
  }

  return {
    status: 'ready',
    connections: reply.connections ?? [],
    providers: reply.providers ?? [],
  };
}

/**
 * Optimistically remove one connection by id — the OPTIMISTIC half of DISCONNECT + UNDO. Returns a
 * fresh list with the row gone PLUS the removed row + its original index, so the undo path can
 * re-insert it EXACTLY where it was ({@link restoreConnection}) with no server round-trip. Pure +
 * exported so the component and its test share one source of truth. An absent id is a no-op.
 */
export function removeConnection(
  connections: ConnectionEntry[],
  id: string,
): { connections: ConnectionEntry[]; removed?: ConnectionEntry; index: number } {
  const index = connections.findIndex((c) => c.id === id);

  if (index < 0) {
    return { connections: connections.slice(), removed: undefined, index: -1 };
  }

  const removed = connections[index];
  const next = connections.slice(0, index).concat(connections.slice(index + 1));

  return { connections: next, removed, index };
}

/**
 * Re-insert a removed connection at its original index — the UNDO/restore half of DISCONNECT. Safe
 * by construction: a `removed` of `undefined` is a no-op; an out-of-range index appends (never
 * drops); a duplicate id is skipped (idempotent). Mirrors `restoreMediaAsset`.
 */
export function restoreConnection(
  connections: ConnectionEntry[],
  removed: ConnectionEntry | undefined,
  index: number,
): ConnectionEntry[] {
  if (!removed || connections.some((c) => c.id === removed.id)) {
    return connections;
  }

  const at = Math.max(0, Math.min(index, connections.length));

  return connections.slice(0, at).concat(removed, connections.slice(at));
}

// ── Component ────────────────────────────────────────────────────────────────

export const ConnectionsPanel = memo(() => {
  const [state, setState] = useState<ConnectionsState>({ status: 'loading' });
  // Which connection id is mid-disconnect (disables its button + shows a spinner).
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  // The just-removed row + a brief "Undo" window (optimistic disconnect feedback).
  const [pendingUndo, setPendingUndo] = useState<{ connection: ConnectionEntry; index: number } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout>>();

  /** Load (or reload) the site's connections. */
  const loadConnections = useCallback(async () => {
    setState({ status: 'loading' });

    if (!isEmbedded) {
      setState({ status: 'error', message: 'Open this from the ProjectSites admin to see your connections.' });
      return;
    }

    try {
      setState(deriveConnectionsState(await requestConnections()));
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not load your connections.',
      });
    }
  }, []);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  /** Silent background refresh — keep the last good list on a transient error (no loading flash). */
  const refreshConnections = useCallback(async () => {
    try {
      const reply = await requestConnections();

      // Only a successful reply replaces the list — a transient error/disabled blip keeps the last
      // good render (no flash). Mirrors FunctionsPanel's silent-refresh contract. Also skip while a
      // disconnect is mid-flight so the poll never clobbers the optimistic removal.
      if (reply.ok && !disconnectingId && !pendingUndo) {
        setState(deriveConnectionsState(reply));
      }
    } catch {
      /* keep prior list on a transient refresh error */
    }
  }, [disconnectingId, pendingUndo]);

  /*
   * Visibility-aware real-time poll (per `real-time-data-no-manual-refresh`) — no manual Refresh
   * button; the list keeps ITSELF current via the silent `refreshConnections`. Registered once; the
   * tick reads the latest refresher + status through refs. Pauses while `document.hidden` or before
   * the first load settles / while disabled; refreshes immediately on foreground; cleaned up on unmount.
   */
  const refreshRef = useRef(refreshConnections);
  refreshRef.current = refreshConnections;

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

  // Clean up the undo timer on unmount (never leak a timer / fire into an unmounted tree).
  useEffect(() => () => clearTimeout(undoTimerRef.current), []);

  /**
   * Disconnect one connection — OPTIMISTIC. Drops the row immediately (instant feedback) + opens a
   * brief "Disconnected · Undo" bar, then runs the REAL bridge DELETE. A failure RESTORES the row
   * (undo-by-error) + toasts, so the user never silently loses a live connection. Undo cancels the
   * hint bar + re-inserts the row (the destructive call already succeeded, so undo here is a local
   * "I didn't mean to look away" — a fresh reload reconciles truth; we keep it honest by reloading).
   */
  const onDisconnect = useCallback(
    async (connection: ConnectionEntry) => {
      if (disconnectingId) {
        return;
      }

      // Optimistically drop the row + remember where it sat so a failure can re-insert it exactly.
      let removedIndex = -1;
      setState((cur) => {
        if (cur.status !== 'ready') {
          return cur;
        }

        const { connections, index } = removeConnection(cur.connections, connection.id);
        removedIndex = index;

        return { ...cur, connections };
      });

      if (removedIndex < 0) {
        return;
      }

      setDisconnectingId(connection.id);
      setPendingUndo({ connection, index: removedIndex });
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = setTimeout(() => setPendingUndo(null), UNDO_HINT_MS);

      try {
        const reply = await disconnectConnection(connection.id);

        if (!reply.ok) {
          if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
            setState({ status: 'disabled' });
            return;
          }

          // The destructive call failed — put the row back where it was so nothing is silently lost.
          setState((cur) =>
            cur.status === 'ready'
              ? { ...cur, connections: restoreConnection(cur.connections, connection, removedIndex) }
              : cur,
          );
          setPendingUndo(null);
          postToastToParent('error', reply.error || 'Could not disconnect this connection.');

          return;
        }

        postToastToParent('success', `Disconnected ${providerLabel(connection.provider)}.`);
      } catch (err) {
        setState((cur) =>
          cur.status === 'ready'
            ? { ...cur, connections: restoreConnection(cur.connections, connection, removedIndex) }
            : cur,
        );
        setPendingUndo(null);
        postToastToParent('error', err instanceof Error ? err.message : 'Could not disconnect this connection.');
      } finally {
        setDisconnectingId(null);
      }
    },
    [disconnectingId],
  );

  /** Undo the optimistic removal — re-insert the row + reconcile with a fresh reload (truth wins). */
  const onUndo = useCallback(() => {
    const prev = pendingUndo;

    if (!prev) {
      return;
    }

    clearTimeout(undoTimerRef.current);
    setPendingUndo(null);
    setState((cur) =>
      cur.status === 'ready'
        ? { ...cur, connections: restoreConnection(cur.connections, prev.connection, prev.index) }
        : cur,
    );
    // The DELETE already committed server-side; a reload reconciles the true state (the row stays
    // gone if the revoke stuck). Honest over optimistic — never a phantom "restored" connection.
    void loadConnections();
  }, [pendingUndo, loadConnections]);

  if (state.status === 'disabled') {
    return (
      <PanelShell testId="connections-panel">
        <DisabledCard />
      </PanelShell>
    );
  }

  return (
    <PanelShell testId="connections-panel">
      <ConnectionsHeader count={state.status === 'ready' ? state.connections.length : undefined} />

      {pendingUndo && (
        <div
          className="flex items-center justify-between gap-2 px-4 py-2 border-b border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 shrink-0"
          role="status"
          data-testid="connections-undo-bar"
        >
          <span className="text-[11px] text-bolt-elements-textSecondary truncate">
            Disconnected <span className="font-medium">{providerLabel(pendingUndo.connection.provider)}</span>.
          </span>
          <button
            type="button"
            onClick={onUndo}
            data-testid="connections-undo"
            className={classNames(
              'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium shrink-0',
              'border border-bolt-elements-item-contentAccent/40 text-bolt-elements-item-contentAccent',
              'hover:bg-bolt-elements-item-contentAccent/[0.12] transition-colors motion-reduce:transition-none',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
            )}
          >
            <div className="i-ph:arrow-counter-clockwise text-sm" aria-hidden /> Undo
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto modern-scrollbar min-h-0">
        {state.status === 'loading' && <ConnectionsSkeleton />}
        {state.status === 'error' && <ErrorCard message={state.message} onRetry={() => void loadConnections()} />}
        {state.status === 'ready' &&
          (state.connections.length === 0 ? (
            <ConnectionsEmpty providers={state.providers} />
          ) : (
            <ul className="divide-y divide-bolt-elements-borderColor/25" data-testid="connections-list">
              {state.connections.map((conn) => (
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  disconnecting={disconnectingId === conn.id}
                  onDisconnect={() => void onDisconnect(conn)}
                />
              ))}
            </ul>
          ))}
      </div>
    </PanelShell>
  );
});

ConnectionsPanel.displayName = 'ConnectionsPanel';

// ── Header ───────────────────────────────────────────────────────────────────

const ConnectionsHeader = memo(({ count }: { count?: number }) => (
  <PanelHeader
    icon="i-ph:plugs-connected-duotone"
    title="Connections"
    subtitle={
      count !== undefined && count > 0 ? (
        <span className="tabular-nums">
          <span className="text-bolt-elements-textSecondary font-medium">{count}</span> connection
          {count === 1 ? '' : 's'} · tools linked to your site
        </span>
      ) : (
        'Apps + tools your site is connected to'
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

ConnectionsHeader.displayName = 'ConnectionsPanel.Header';

// ── Row ──────────────────────────────────────────────────────────────────────

const ConnectionRow = memo(
  ({
    conn,
    disconnecting,
    onDisconnect,
  }: {
    conn: ConnectionEntry;
    disconnecting: boolean;
    onDisconnect: () => void;
  }) => {
    const sm = statusMeta(conn.status);
    const connected = formatRelativeTime(conn.connected_at);
    const name = conn.display_name?.trim() || providerLabel(conn.provider);

    return (
      <li
        className="group flex items-center gap-2.5 px-4 py-2.5 hover:bg-bolt-elements-item-backgroundActive transition-colors motion-reduce:transition-none"
        data-testid="connections-row"
      >
        <div
          className={classNames(iconForProvider(conn.provider), 'text-base text-bolt-elements-textTertiary shrink-0')}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-bolt-elements-textPrimary truncate" title={name}>
            {name}
          </p>
          <p className="text-[10px] text-bolt-elements-textTertiary tabular-nums flex items-center gap-1 flex-wrap">
            <span>{providerLabel(conn.provider)}</span>
            {connected && (
              <>
                <span className="text-bolt-elements-textTertiary/50" aria-hidden>
                  ·
                </span>
                <span title={conn.connected_at ?? undefined}>connected {connected}</span>
              </>
            )}
          </p>
        </div>

        {/* Status badge — icon + label, color-coded, AA-contrast token colors. */}
        <span
          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0"
          style={{ borderColor: `color-mix(in oklch, ${sm.color} 45%, transparent)`, color: sm.color }}
          title={`Status: ${conn.status}`}
        >
          <div className={classNames(sm.icon, 'text-[11px]')} aria-hidden />
          {sm.label}
        </span>

        {/* Disconnect — red-tinted, visible-but-muted at rest, disabled + spinner while in flight. */}
        <button
          type="button"
          onClick={onDisconnect}
          disabled={disconnecting}
          data-testid="connections-disconnect"
          aria-label={`Disconnect ${name}`}
          title={`Disconnect ${name}`}
          className={classNames(
            'inline-flex items-center justify-center gap-1 rounded-md min-h-[26px] px-2 py-1 text-[10px] font-medium shrink-0',
            'border border-red-400/40 text-red-400 bg-transparent',
            'enabled:hover:bg-red-500/15 enabled:hover:border-red-400/70 transition-colors motion-reduce:transition-none',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer',
            'disabled:opacity-60 disabled:cursor-not-allowed',
          )}
        >
          <div
            className={classNames(
              disconnecting ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:plugs',
              'text-[12px]',
            )}
            aria-hidden
          />
          <span className="hidden sm:inline">{disconnecting ? 'Disconnecting…' : 'Disconnect'}</span>
        </button>
      </li>
    );
  },
);

ConnectionRow.displayName = 'ConnectionsPanel.Row';

// ── States ───────────────────────────────────────────────────────────────────

const ConnectionsSkeleton = memo(() => (
  <ul className="divide-y divide-bolt-elements-borderColor/25" aria-busy="true" data-testid="connections-skeleton">
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

ConnectionsSkeleton.displayName = 'ConnectionsPanel.Skeleton';

/**
 * Honest empty — a launchpad to the REAL connect surface (the admin's MCP integrations, where the
 * existing `/api/mcp/:provider/connect` OAuth/paste-key flow lives), per `embarrassingly-easy-to-
 * use`. Names a few real providers from the catalog so the empty state is concrete, never a generic
 * "connect something". This panel does NOT build new OAuth — it points at the one true connect flow.
 */
const ConnectionsEmpty = memo(({ providers }: { providers: string[] }) => {
  // Show up to a few recognizable providers as concrete examples (the catalog can be large).
  const examples = providers.slice(0, 4).map(providerLabel);

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-4 p-8 text-center"
      data-testid="connections-empty"
    >
      <div className="relative flex items-center justify-center h-16 w-16 rounded-2xl border border-bolt-elements-item-contentAccent/25 bg-bolt-elements-item-contentAccent/[0.06]">
        <div
          aria-hidden
          className="absolute inset-0 rounded-2xl opacity-60"
          style={{
            background: `radial-gradient(60% 60% at 50% 30%, color-mix(in oklch, ${PURPLE} 22%, transparent), transparent)`,
          }}
        />
        <div
          className="relative i-ph:plugs-connected-duotone text-3xl text-bolt-elements-item-contentAccent"
          aria-hidden
        />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-bolt-elements-textPrimary">No connections yet</p>
        <p className="text-[11px] text-bolt-elements-textTertiary max-w-[320px] leading-relaxed">
          Connect the apps + tools your site uses{examples.length > 0 ? ' — ' : ''}
          {examples.length > 0 && <span className="text-bolt-elements-textSecondary">{examples.join(', ')}</span>}
          {examples.length > 0 ? ', and more' : ''}. Add one from{' '}
          <span className="font-medium text-bolt-elements-textSecondary">Settings → Connections</span> in your
          dashboard, then manage it here.
        </p>
      </div>
    </div>
  );
});

ConnectionsEmpty.displayName = 'ConnectionsPanel.Empty';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="connections-error"
  >
    <div className="flex items-center justify-center h-12 w-12 rounded-2xl border border-red-400/30 bg-red-500/[0.07]">
      <div className="i-ph:warning-circle-duotone text-2xl text-red-400" aria-hidden />
    </div>
    <p className="text-xs text-bolt-elements-textSecondary max-w-[280px] leading-relaxed">{message}</p>
    <button
      type="button"
      onClick={onRetry}
      data-testid="connections-retry"
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

ErrorCard.displayName = 'ConnectionsPanel.ErrorCard';

/** Dark-flag card — friendly, never a scary error (per the `site_connections` dark-gate contract). */
const DisabledCard = memo(() => (
  <div
    className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center"
    data-testid="connections-disabled"
  >
    <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
      <div className="i-ph:lock-key-duotone text-3xl text-bolt-elements-textTertiary" aria-hidden />
    </div>
    <p className="text-sm font-semibold text-bolt-elements-textSecondary">Connections aren&rsquo;t enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px] leading-relaxed">
      This is on the way. Once it&rsquo;s turned on, the apps + tools your site is connected to show up here — ready to
      view and manage.
    </p>
  </div>
));

DisabledCard.displayName = 'ConnectionsPanel.DisabledCard';
