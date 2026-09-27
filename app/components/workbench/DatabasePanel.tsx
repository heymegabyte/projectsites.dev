/**
 * @file Database — the ONE consolidated per-site data surface in the editor.
 *
 * @remarks
 * Brian's 2026-09-27 directive (FIRE 1): the editor's three data tabs (`Data` → the shared-platform-D1
 * `DataPanel`, `Database` → the per-site `SiteTablesPanel`, `Resources` → the per-site resource console)
 * collapse into ONE **Database** tab. Its sub-nav is a segmented BUTTON bar — **Table-view · SQL
 * navigator · KV manager** — and EVERYTHING targets the site's OWN dedicated per-site Cloudflare D1
 * (+ its KV), NEVER the shared platform DB and NEVER another site's. The shared-platform-D1 surface
 * (Visitor Events / Snapshots / form_submissions / `/data-overview`) is REMOVED from the editor.
 *
 * Sub-views:
 *  - **Table-view** — the read grid over the site's OWN D1 ({@link SiteTablesPanel}, `PS_SITEDB_*`).
 *  - **SQL navigator** — a per-site D1 SQL workspace, tucked behind a remembered **Advanced/Developer**
 *    toggle (SQL is NOT hidden, it's tucked — 2026-09-26 override). Runs through the per-site adapter
 *    (`PS_RES_MUTATE { kind:'d1', action:'exec' }` → `data_d1_exec`), NEVER the super-admin shared-D1
 *    `/sql/*` path. Mutating statements are confirm-gated; D1's `rowsWritten` is the ground truth.
 *  - **KV manager** — the site's OWN KV, a **$10/mo Stripe add-on**. Until purchased this is an honest
 *    LOCKED-UPSELL card (never a dead/mock control) — the buy button is the seam for FIRE 3's entitlement
 *    + checkout + provision-on-purchase wiring.
 *
 * Isolation is SERVER-resolved for every sub-view: the worker resolves the site's CF ids from the
 * registry for the OWNED site+environment; this panel never sees or sends a CF id it could tamper with
 * (SECURITY-INVARIANTS INV-1/INV-2). Dark flags surface as friendly "not enabled yet" states (404 →
 * disabled), never scary errors (INV-3). Style matches the editor conventions exactly (UnoCSS
 * `bolt-elements-*` tokens, phosphor `i-ph:*` icons).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type ResMutateResponseMessage,
} from '~/lib/embed/embedded-mode';
import { SiteTablesPanel } from './SiteTablesPanel';
import { fieldTypeFor, type FieldKind } from './field-types';

// ── Sub-nav model ────────────────────────────────────────────────────────────

type SubView = 'table' | 'sql' | 'kv';

interface SubNavItem {
  value: SubView;
  label: string;
  icon: string;
  /** When true this item only appears while the Advanced/Developer toggle is on. */
  advanced?: boolean;
}

const SUB_NAV: readonly SubNavItem[] = [
  { value: 'table', label: 'Table-view', icon: 'i-ph:table-duotone' },
  { value: 'sql', label: 'SQL navigator', icon: 'i-ph:terminal-window-duotone', advanced: true },
  { value: 'kv', label: 'KV manager', icon: 'i-ph:key-duotone' },
];

/** localStorage key remembering the user's Advanced/Developer preference (per 2026-09-26 override). */
const ADVANCED_KEY = 'ps_database_advanced';

function readAdvancedPref(): boolean {
  try {
    return localStorage.getItem(ADVANCED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAdvancedPref(on: boolean): void {
  try {
    localStorage.setItem(ADVANCED_KEY, on ? '1' : '0');
  } catch {
    // localStorage unavailable (private mode) — the toggle still works for the session
  }
}

// ── Container ────────────────────────────────────────────────────────────────

export const DatabasePanel = memo(() => {
  const [advanced, setAdvanced] = useState<boolean>(() => readAdvancedPref());
  const [subView, setSubView] = useState<SubView>('table');

  // If SQL is the active view and Advanced gets turned OFF, fall back to Table-view (never a blank body).
  useEffect(() => {
    if (!advanced && subView === 'sql') {
      setSubView('table');
    }
  }, [advanced, subView]);

  const toggleAdvanced = useCallback(() => {
    setAdvanced((cur) => {
      const next = !cur;
      writeAdvancedPref(next);
      return next;
    });
  }, []);

  const visibleNav = useMemo(() => SUB_NAV.filter((item) => !item.advanced || advanced), [advanced]);

  // Roving-tabindex keyboard nav across the segmented button bar (Left/Right/Home/End).
  const onNavKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

      if (!keys.includes(event.key)) {
        return;
      }

      event.preventDefault();

      const idx = visibleNav.findIndex((item) => item.value === subView);

      if (idx === -1) {
        return;
      }

      let nextIdx = idx;

      if (event.key === 'ArrowLeft') {
        nextIdx = (idx - 1 + visibleNav.length) % visibleNav.length;
      } else if (event.key === 'ArrowRight') {
        nextIdx = (idx + 1) % visibleNav.length;
      } else if (event.key === 'Home') {
        nextIdx = 0;
      } else if (event.key === 'End') {
        nextIdx = visibleNav.length - 1;
      }

      setSubView(visibleNav[nextIdx].value);
    },
    [visibleNav, subView],
  );

  return (
    <div
      className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary"
      data-testid="database-panel"
    >
      {/* Sub-nav button bar + Advanced/Developer toggle */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-bolt-elements-borderColor shrink-0">
        <div
          role="tablist"
          aria-label="Database views"
          onKeyDown={onNavKeyDown}
          className="flex items-center gap-1 rounded-lg bg-bolt-elements-background-depth-2 p-0.5"
        >
          {visibleNav.map((item) => {
            const active = subView === item.value;
            return (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={active}
                aria-pressed={active}
                tabIndex={active ? 0 : -1}
                data-testid={`database-subnav-${item.value}`}
                onClick={() => setSubView(item.value)}
                className={classNames(
                  'min-h-[24px] flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                  active
                    ? 'bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 shadow-sm'
                    : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
                )}
              >
                <div className={classNames(item.icon, 'text-sm')} aria-hidden />
                {item.label}
              </button>
            );
          })}
        </div>

        {/* Advanced/Developer toggle — tucks the SQL navigator until asked for; remembered. */}
        <button
          type="button"
          role="switch"
          aria-checked={advanced}
          data-testid="database-advanced-toggle"
          onClick={toggleAdvanced}
          title={advanced ? 'Hide the SQL navigator' : 'Show the SQL navigator (advanced)'}
          className={classNames(
            'ml-auto min-h-[24px] flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
            advanced
              ? 'border-bolt-elements-item-contentAccent/60 bg-bolt-elements-item-backgroundAccent/10 text-bolt-elements-item-contentAccent'
              : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
          )}
        >
          <div className={classNames(advanced ? 'i-ph:code-duotone' : 'i-ph:code', 'text-sm')} aria-hidden />
          <span className="min-w-[6ch] text-center">{advanced ? 'Developer' : 'Advanced'}</span>
        </button>
      </div>

      {/* Active sub-view — all three stay lightweight; only Table-view holds a live bridge on mount. */}
      <div className="relative flex-1 overflow-hidden">
        {subView === 'table' && <SiteTablesPanel />}
        {subView === 'sql' && advanced && <SqlNavigator />}
        {subView === 'kv' && <KvManager />}
      </div>
    </div>
  );
});

DatabasePanel.displayName = 'DatabasePanel';

// ── SQL navigator (per-site D1, via the resource-mutate bridge) ────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const DISABLED_404 = 'not enabled';

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let correlationCounter = 0;
function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `dbsql_${++correlationCounter}`;
}

/** The typed result the d1 `exec` adapter returns (mirrors `data_d1_exec` success data). */
interface SqlExecData {
  classification?: string;
  rows?: Record<string, unknown>[];
  columns?: { name: string; type?: string }[];
  rowsWritten?: number;
  durationMs?: number;
}

type SqlState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'disabled' }
  | { status: 'confirm'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SqlExecData };

/**
 * A lean per-site SQL runner. Sends `PS_RES_MUTATE { kind:'d1', action:'exec', input:{ sql, params } }`;
 * the worker classifies the statement (read-only vs mutating vs destructive) and only mutates with
 * `confirm:true`. Read results + the ground-truth `rowsWritten` render honestly; a `confirmation_required`
 * outcome shows a confirm affordance rather than silently running a destructive statement.
 */
const SqlNavigator = memo(() => {
  const [sql, setSql] = useState('');
  const [state, setState] = useState<SqlState>({ status: 'idle' });
  const pendingRef = useRef<Map<string, Pending>>(new Map());
  const lastSqlRef = useRef('');

  const request = useCallback((correlationId: string, sqlText: string, confirm: boolean): Promise<ParentToChildMessage> => {
    return new Promise<ParentToChildMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRef.current.delete(correlationId);
        reject(new Error('The request timed out. Check the admin connection and retry.'));
      }, REQUEST_TIMEOUT_MS);

      pendingRef.current.set(correlationId, { resolve, reject, timer });
      postToParent({
        type: 'PS_RES_MUTATE_REQUEST',
        correlationId,
        kind: 'd1',
        action: 'exec',
        input: { sql: sqlText },
        confirm,
      });
    });
  }, []);

  // ONE parent-message listener; resolve by correlationId via the live ref (avoids the empty-deps stale-ref bug).
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_MUTATE_RESPONSE') {
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

      for (const [, pending] of pendingRef.current) {
        clearTimeout(pending.timer);
        pending.reject(new Error('cancelled'));
      }

      pendingRef.current.clear();
    };
  }, []);

  const run = useCallback(
    async (confirm: boolean) => {
      const trimmed = sql.trim();

      if (!trimmed) {
        return;
      }

      if (!isEmbedded) {
        setState({ status: 'error', message: 'Open this from the ProjectSites admin to run SQL.' });
        return;
      }

      lastSqlRef.current = trimmed;
      setState({ status: 'running' });

      try {
        const reply = (await request(nextCorrelationId(), trimmed, confirm)) as ResMutateResponseMessage;

        // Transport failure (no site selected, network, 4xx) OR dark-flag 404.
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setState({ status: 'disabled' });
          return;
        }

        if (reply.error) {
          setState({ status: 'error', message: reply.error });
          return;
        }

        const result = reply.result;

        if (!result) {
          setState({ status: 'error', message: 'No response from the database. Retry in a moment.' });
          return;
        }

        // A typed error rides in result (not transport `error`) — e.g. confirmation_required / not_available.
        if (!result.ok) {
          const code = result.error?.code ?? '';
          const message = result.error?.message ?? 'The statement could not run.';

          if (code === 'confirmation_required' || /confirm/i.test(message)) {
            setState({ status: 'confirm', message });
            return;
          }

          setState({ status: 'error', message });
          return;
        }

        setState({ status: 'ready', data: (result.data ?? {}) as SqlExecData });
      } catch (err) {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'The statement could not run.' });
      }
    },
    [sql, request],
  );

  return (
    <div className="h-full flex flex-col" data-testid="database-sql">
      {/* Editor + run */}
      <div className="flex flex-col gap-2 p-3 border-b border-bolt-elements-borderColor shrink-0">
        <label htmlFor="database-sql-input" className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
          SQL — runs against your site's own database
        </label>
        <textarea
          id="database-sql-input"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter runs the statement (read-only path; mutating asks to confirm).
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void run(false);
            }
          }}
          spellCheck={false}
          placeholder="SELECT * FROM your_table LIMIT 25;"
          data-testid="database-sql-textarea"
          className="w-full h-28 resize-y rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-xs font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void run(false)}
            disabled={state.status === 'running' || !sql.trim()}
            data-testid="database-sql-run"
            className="min-h-[24px] text-[12px] font-semibold px-3 py-1.5 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 enabled:hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            {state.status === 'running' ? (
              <div className="i-ph:circle-notch animate-spin" />
            ) : (
              <div className="i-ph:play" />
            )}
            <span className="min-w-[7ch] text-center">{state.status === 'running' ? 'Running…' : 'Run'}</span>
          </button>
          <span className="text-[10px] text-bolt-elements-textTertiary">⌘/Ctrl + Enter</span>
        </div>
      </div>

      {/* Result */}
      <div className="flex-1 overflow-auto modern-scrollbar min-h-0">
        {state.status === 'idle' && (
          <div className="flex flex-col items-center justify-center gap-2 p-8 text-center h-full" data-testid="database-sql-idle">
            <div className="i-ph:terminal-window text-3xl text-bolt-elements-textTertiary" />
            <p className="text-xs text-bolt-elements-textSecondary max-w-[280px]">
              Write a query and press Run. Reads return rows; writes ask you to confirm before they change data.
            </p>
          </div>
        )}

        {state.status === 'disabled' && (
          <div
            className="flex flex-col items-center justify-center gap-3 p-8 text-center h-full"
            data-testid="database-sql-disabled"
          >
            <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
            <p className="text-sm font-medium text-bolt-elements-textSecondary">The SQL navigator isn't enabled yet</p>
            <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
              Your site's own database is on the way. Once it's turned on, you can run SQL here — nothing to set up.
            </p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center h-full" data-testid="database-sql-error">
            <div className="i-ph:warning-circle text-3xl text-red-400" />
            <p className="text-xs text-bolt-elements-textSecondary max-w-[320px] break-words">{state.message}</p>
            <button
              type="button"
              onClick={() => void run(false)}
              className="min-h-[24px] mt-1 text-[11px] font-medium px-3 py-1.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:arrow-clockwise" /> Retry
            </button>
          </div>
        )}

        {state.status === 'confirm' && (
          <div
            className="flex flex-col items-center justify-center gap-3 p-8 text-center h-full"
            data-testid="database-sql-confirm"
          >
            <div className="i-ph:seal-warning text-3xl text-amber-400" />
            <p className="text-sm font-semibold text-bolt-elements-textPrimary">This statement changes data</p>
            <p className="text-[11px] text-bolt-elements-textSecondary max-w-[320px] break-words">{state.message}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void run(true)}
                data-testid="database-sql-confirm-run"
                className="min-h-[24px] text-[12px] font-semibold px-3.5 py-2 rounded-lg bg-amber-500 text-bolt-elements-background-depth-1 hover:opacity-90 transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-amber-400 cursor-pointer"
              >
                <div className="i-ph:check" /> Run it anyway
              </button>
              <button
                type="button"
                onClick={() => setState({ status: 'idle' })}
                className="min-h-[24px] text-[12px] font-medium px-3.5 py-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {state.status === 'ready' && <SqlResult data={state.data} />}
      </div>
    </div>
  );
});

SqlNavigator.displayName = 'DatabasePanel.SqlNavigator';

/** Map a raw SQLite declared type to a display formatter kind (best-effort — SQLite is dynamically typed). */
function kindForType(rawType: string | undefined): FieldKind {
  const t = (rawType || '').toUpperCase();

  if (t.includes('INT')) {
    return 'number';
  }

  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM') || t.includes('DEC')) {
    return 'number';
  }

  if (t.includes('BOOL')) {
    return 'boolean';
  }

  if (t.includes('DATE') || t.includes('TIME')) {
    return 'date';
  }

  if (t.includes('JSON')) {
    return 'json';
  }

  return 'text';
}

function formatCell(value: unknown, kind: FieldKind): string {
  if (value === null || value === undefined) {
    return '';
  }

  try {
    const formatted = fieldTypeFor(kind).format(value);
    return formatted === '' ? String(value) : formatted;
  } catch {
    return String(value);
  }
}

/** Render one exec result: a rows grid for reads, or the ground-truth `rowsWritten` for writes. */
const SqlResult = memo(({ data }: { data: SqlExecData }) => {
  const rows = data.rows ?? [];

  // Derive columns: prefer the adapter's column list, else the first row's keys.
  const columnNames = useMemo(() => {
    if (data.columns && data.columns.length > 0) {
      return data.columns.map((c) => c.name);
    }

    return rows.length > 0 ? Object.keys(rows[0]) : [];
  }, [data.columns, rows]);

  const kinds = useMemo(() => {
    if (data.columns && data.columns.length > 0) {
      return data.columns.map((c) => kindForType(c.type));
    }

    return columnNames.map(() => 'text' as FieldKind);
  }, [data.columns, columnNames]);

  const wrote = typeof data.rowsWritten === 'number' && data.rowsWritten > 0;

  return (
    <div className="p-3" data-testid="database-sql-result">
      {/* Effect summary strip */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
        {data.classification && (
          <span className="uppercase tracking-wider px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary">
            {data.classification}
          </span>
        )}
        {wrote && (
          <span
            className="px-2 py-0.5 rounded-full bg-bolt-elements-item-backgroundAccent/15 text-bolt-elements-item-contentAccent"
            data-testid="database-sql-rows-written"
          >
            {data.rowsWritten} row{data.rowsWritten === 1 ? '' : 's'} written
          </span>
        )}
        {typeof data.durationMs === 'number' && (
          <span className="text-bolt-elements-textTertiary">{data.durationMs} ms</span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 p-6 text-center" data-testid="database-sql-noresults">
          <div className="i-ph:check-circle text-2xl text-bolt-elements-item-contentAccent" />
          <p className="text-xs text-bolt-elements-textSecondary">
            {wrote ? 'Done. Your change was applied.' : 'The statement ran — it returned no rows.'}
          </p>
        </div>
      ) : (
        <div className="overflow-auto modern-scrollbar rounded-md border border-bolt-elements-borderColor">
          <table className="min-w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="bg-bolt-elements-background-depth-2">
                {columnNames.map((name) => (
                  <th
                    key={name}
                    className="text-left px-3 py-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary font-medium border-b border-bolt-elements-borderColor whitespace-nowrap"
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri} className="hover:bg-bolt-elements-item-backgroundActive transition-colors">
                  {columnNames.map((name, ci) => {
                    const value = row[name];
                    const isNull = value === null || value === undefined;
                    return (
                      <td
                        key={name}
                        className={classNames(
                          'px-3 py-1.5 border-b border-bolt-elements-borderColor/30 whitespace-nowrap max-w-[280px] truncate',
                          isNull ? 'text-bolt-elements-textTertiary italic' : 'text-bolt-elements-textSecondary',
                        )}
                        title={isNull ? 'null' : formatCell(value, kinds[ci])}
                      >
                        {isNull ? '—' : formatCell(value, kinds[ci])}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});

SqlResult.displayName = 'DatabasePanel.SqlResult';

// ── KV manager (locked-upsell until the $10/mo add-on is purchased) ────────────

/**
 * The site's OWN Cloudflare KV — a **$10/mo Stripe add-on** (per the resource model). Until it's
 * purchased this renders an HONEST locked-upsell card, never a dead/mock control (SECURITY-INVARIANTS
 * INV-3 — never call an unsupported control complete). The Unlock button is the seam for FIRE 3's
 * entitlement check + Stripe checkout + provision-on-purchase (BOTH prod + preview KV). Clicking it
 * today surfaces an inline "coming soon" note rather than dead-air the click.
 */
const KvManager = memo(() => {
  const [note, setNote] = useState<string | null>(null);

  const onUnlock = useCallback(() => {
    setNote('Key-value storage checkout is landing shortly — this is where you’ll add it in one click.');
    setTimeout(() => setNote(null), 3600);
  }, []);

  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-8 text-center" data-testid="database-kv">
      <div className="relative">
        <div className="i-ph:key-duotone text-5xl text-bolt-elements-item-contentAccent" />
        <div className="absolute -bottom-1 -right-1 i-ph:lock-simple-fill text-lg text-bolt-elements-textTertiary" />
      </div>

      <div className="space-y-1 max-w-[340px]">
        <h3 className="text-base font-semibold text-bolt-elements-textPrimary">Add key-value storage</h3>
        <p className="text-[12px] text-bolt-elements-textSecondary">
          Fast, simple storage for settings, feature flags, sessions, and cached data — right beside your database.
        </p>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-bolt-elements-textPrimary">$10</span>
        <span className="text-[12px] text-bolt-elements-textTertiary">/ month</span>
      </div>

      <button
        type="button"
        onClick={onUnlock}
        data-testid="database-kv-unlock"
        className="min-h-[24px] text-[13px] font-semibold px-5 py-2.5 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 hover:opacity-90 transition-opacity flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
      >
        <div className="i-ph:lock-key-open" /> Unlock KV storage
      </button>

      <ul className="text-left text-[11px] text-bolt-elements-textTertiary space-y-1.5 max-w-[300px]">
        <li className="flex items-start gap-2">
          <div className="i-ph:check-circle text-bolt-elements-item-contentAccent mt-0.5 shrink-0" />
          <span>Both your live site and its preview get their own KV — set up automatically.</span>
        </li>
        <li className="flex items-start gap-2">
          <div className="i-ph:check-circle text-bolt-elements-item-contentAccent mt-0.5 shrink-0" />
          <span>Browse, add, and edit keys here once it's on — no config, no dashboards.</span>
        </li>
        <li className="flex items-start gap-2">
          <div className="i-ph:check-circle text-bolt-elements-item-contentAccent mt-0.5 shrink-0" />
          <span>Cancel anytime — your database keeps working without it.</span>
        </li>
      </ul>

      {note && (
        <div
          className="mt-1 border border-bolt-elements-borderColor rounded-md bg-bolt-elements-background-depth-2 px-3 py-2 text-[11px] text-bolt-elements-textSecondary flex items-center gap-2"
          data-testid="database-kv-note"
          role="status"
        >
          <div className="i-ph:sparkle text-bolt-elements-item-contentAccent" />
          <span>{note}</span>
        </div>
      )}
    </div>
  );
});

KvManager.displayName = 'DatabasePanel.KvManager';
