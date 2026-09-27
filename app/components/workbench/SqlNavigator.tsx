/**
 * @file SQL navigator — the RICH per-site D1 SQL workspace for the editor Database tab.
 *
 * @remarks
 * Brian's 2026-09-27 directive (recycle, don't reimplement thin): the Database tab's SQL sub-view was
 * shipped as a bare `<textarea>` while the PROVEN rich SQL editor from `DataPanel.tsx` sat orphaned.
 * This component RECYCLES those proven building blocks — the syntax-highlighted + schema-completing
 * {@link SqlEditor} (`./sql-highlight` + `./sql-complete`), the localStorage query HISTORY + named SAVED
 * queries (`addToSqlHistory` / `addSavedQuery` / `removeSavedQuery` from `./data-panel-logic`), the
 * `EXPLAIN QUERY PLAN` cost affordance (`explainQuery` / `explainPlanHint`), and the typed result-cell
 * formatting (`classifyCell` from `./data-cell-format`) — but RE-POINTS execution at the customer's OWN
 * per-site D1, never the shared platform DB.
 *
 * Isolation (SECURITY-INVARIANTS INV-1/INV-2/INV-9): execution goes through the SAME server-resolved
 * per-site adapter the Table-view uses — `PS_RES_MUTATE_REQUEST { kind:'d1', action:'exec',
 * input:{ sql, params } }` → `POST /api/sites/:siteId/resources/d1/mutate`. The caller NEVER supplies a
 * CF id; the worker resolves the site's `d1_database_id` for the OWNED site+environment and binds
 * `params[]` as VALUES. The worker classifies each statement (read-only vs mutating vs destructive) and
 * only mutates with `confirm:true`; D1's `rowsWritten` is the ground truth. The completion schema is the
 * site's OWN tables (`PS_SITEDB_TABLES_REQUEST`) so autocomplete only ever suggests identifiers that
 * actually exist — never a fabricated column, never a shared-platform table.
 *
 * Ask (AI SQL assistant): the "Ask AI" toggle recycles the retired DataPanel AskPanel's grounded-NL idea
 * onto the per-site path. It reads the site's OWN full schema (tables + `PRAGMA table_info` columns over the
 * per-site bridge — never the shared DB), asks the PLATFORM AI (`/api/llmcall` → ProjectSites AI when
 * `PS_BOLT_AI=true`, never per-user keys) for a single SQLite statement grounded ONLY on those real
 * identifiers, and DROPS the SQL into the editor for review — it is NEVER auto-run. The user runs it through
 * the SAME per-site exec path above, so writes are still confirm-gated. Pure prompt/extraction logic lives
 * in `./sql-ask-logic` for unit testing.
 *
 * DARK behind the `per_site_data` flag: a 404 becomes a friendly "not enabled yet" state (INV-3), never
 * a scary error. Style follows `docs/ULTIMATE-UI-DIRECTION.md` — black + cyan, cinematic, honest states,
 * WCAG 2.2 AA (≥24px targets, focus-visible rings, `role="status"` on async regions).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type ResMutateResponseMessage,
  type SiteDbTablesResponseMessage,
  type SiteDbRowsResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  addToSqlHistory,
  addSavedQuery,
  removeSavedQuery,
  explainQuery,
  explainPlanHint,
  type SavedQuery,
  type ExplainHint,
} from './data-panel-logic';
import { classifyCell } from './data-cell-format';
import type { SqlSchema } from './sql-complete';
import { SqlEditor } from './SqlEditor';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '~/utils/constants';
import {
  buildAskSystemPrompt,
  extractSqlFromModel,
  formatSchemaForPrompt,
  type AskColumn,
  type AskTableSchema,
} from './sql-ask-logic';

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const DISABLED_404 = 'not enabled';

/** localStorage keys — per-browser, best-effort; scoped to the per-site navigator (distinct from the shared console). */
const SQL_HISTORY_KEY = 'ps-sitedb-sql-history';
const SQL_SAVED_KEY = 'ps-sitedb-sql-saved';

/** One-click starters that assume nothing about the schema (blank DB is the first-run reality). */
const STARTERS: readonly { label: string; query: string }[] = [
  { label: 'List tables', query: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;" },
  { label: 'Table sizes', query: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';" },
];

/** A CREATE TABLE template dropped into the editor (edit name + columns, then Run). */
const NEW_TABLE_TEMPLATE = `CREATE TABLE my_table (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);`;

// ── Bridge plumbing ────────────────────────────────────────────────────────

let correlationCounter = 0;
function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `sqlnav_${++correlationCounter}`;
}

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The typed result the d1 `exec` adapter returns (mirrors the worker's `data_d1_exec` success data). */
interface SqlExecData {
  classification?: string;
  rows?: Record<string, unknown>[];
  columns?: { name: string; type?: string }[];
  rowsWritten?: number;
  rowsRead?: number;
  durationMs?: number;
}

type SqlState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'disabled' }
  | { status: 'confirm'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SqlExecData; wasExplain: boolean };

// ── Persistence helpers (best-effort localStorage — never breaks a run) ──────

function readHistory(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SQL_HISTORY_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function persistHistory(next: readonly string[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SQL_HISTORY_KEY, JSON.stringify(next));
    }
  } catch {
    /* quota / SSR / private-mode never breaks a run */
  }
}

function readSaved(): SavedQuery[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SQL_SAVED_KEY) : null;
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((s): s is SavedQuery => !!s && typeof s.name === 'string' && typeof s.query === 'string')
      : [];
  } catch {
    return [];
  }
}

function persistSaved(next: readonly SavedQuery[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SQL_SAVED_KEY, JSON.stringify(next));
    }
  } catch {
    /* best-effort */
  }
}

// ── Component ──────────────────────────────────────────────────────────────

/**
 * A rich per-site SQL runner. Sends `PS_RES_MUTATE { kind:'d1', action:'exec', input:{ sql, params } }`;
 * the worker classifies the statement and only mutates with `confirm:true`. Read results + the
 * ground-truth `rowsWritten`/`rowsRead` render honestly; a `confirmation_required` outcome shows a
 * confirm affordance rather than silently running a destructive statement.
 */
export const SqlNavigator = memo(() => {
  const [sql, setSql] = useState('');
  const [state, setState] = useState<SqlState>({ status: 'idle' });

  // Query history + named saved queries (recycled from the proven console).
  const [history, setHistory] = useState<string[]>(() => readHistory());
  const [saved, setSaved] = useState<SavedQuery[]>(() => readSaved());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  // The completion schema — the site's OWN tables (never shared-platform tables).
  const [schema, setSchema] = useState<SqlSchema | undefined>(undefined);

  // ── Ask (AI SQL assistant) — NL → SQL grounded on the site's OWN schema, run through the per-site path ──
  const [askOpen, setAskOpen] = useState(false);
  const [askQuestion, setAskQuestion] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askNote, setAskNote] = useState<string | null>(null);

  const pendingRef = useRef<Map<string, Pending>>(new Map());
  const lastConfirmSqlRef = useRef('');

  // ── ONE parent-message listener; resolve by correlationId via the live ref (empty-deps stale-ref safe) ──
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_MUTATE_RESPONSE' && msg.type !== 'PS_SITEDB_TABLES_RESPONSE') {
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

  // ── Load the completion schema once (the site's OWN tables) ────────────────
  useEffect(() => {
    if (!isEmbedded) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const reply = (await request({
          type: 'PS_SITEDB_TABLES_REQUEST',
          correlationId: nextCorrelationId(),
        })) as SiteDbTablesResponseMessage;

        if (cancelled || !reply.ok) {
          return;
        }

        const tables = (reply.tables ?? []).map((t) => t.name);
        // Column completion is populated on demand from each result set (see `run`). Seed with tables.
        setSchema((prev) => ({ tables, columns: prev?.columns ?? [] }));
      } catch {
        // best-effort — completion degrades to keywords-only when the schema can't load
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [request]);

  const recordHistory = useCallback((query: string) => {
    setHistory((h) => {
      const next = addToSqlHistory(h, query);
      persistHistory(next);
      return next;
    });
  }, []);

  // ── Ask (AI SQL assistant): gather the site's OWN schema → platform AI → drop SQL into the editor ──

  /**
   * Read the site's OWN full schema (each table's columns via `PRAGMA table_info`, over the per-site
   * bridge) so the model is grounded ONLY on identifiers that exist. Fetches columns per table in
   * parallel; a table whose columns can't be read is still passed by name (better than dropping it).
   */
  const gatherSchema = useCallback(async (): Promise<AskTableSchema[]> => {
    const tablesReply = (await request({
      type: 'PS_SITEDB_TABLES_REQUEST',
      correlationId: nextCorrelationId(),
    })) as SiteDbTablesResponseMessage;

    if (!tablesReply.ok || (tablesReply.enabled === false)) {
      throw new Error(tablesReply.error ?? 'Could not read your database schema.');
    }

    const names = (tablesReply.tables ?? []).map((t) => t.name);

    const withColumns = await Promise.all(
      names.map(async (name): Promise<AskTableSchema> => {
        try {
          const rowsReply = (await request({
            type: 'PS_SITEDB_ROWS_REQUEST',
            correlationId: nextCorrelationId(),
            table: name,
            limit: 1,
            offset: 0,
          })) as SiteDbRowsResponseMessage;

          const columns = (rowsReply.columns ?? []) as AskColumn[];
          return { name, columns };
        } catch {
          return { name, columns: [] };
        }
      }),
    );

    return withColumns;
  }, [request]);

  /**
   * Ask the platform AI for a SQLite statement grounded on the site's schema, then DROP it into the editor
   * for review (never auto-run). The user runs it via the normal per-site exec path (confirm-gated writes).
   * Uses `/api/llmcall` which, when `PS_BOLT_AI=true`, routes to ProjectSites AI (the platform model) rather
   * than per-user keys — so no CF id and no shared-DB path is ever touched.
   */
  const askSql = useCallback(async () => {
    const q = askQuestion.trim();

    if (!q || askBusy) {
      return;
    }

    if (!isEmbedded) {
      setAskError('Open this from the ProjectSites admin to use the AI assistant.');
      return;
    }

    setAskBusy(true);
    setAskError(null);
    setAskNote(null);

    try {
      const tables = await gatherSchema();
      const system = buildAskSystemPrompt(formatSchemaForPrompt(tables));

      const res = await fetch('/api/llmcall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system,
          message: q,
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
          streamOutput: false,
        }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `The assistant is unavailable (HTTP ${res.status}).`);
      }

      const data = (await res.json()) as { text?: string; error?: boolean; message?: string };

      if (data.error || typeof data.text !== 'string') {
        throw new Error(data.message ?? 'The assistant did not return SQL.');
      }

      const generated = extractSqlFromModel(data.text);

      if (!generated) {
        throw new Error('The assistant did not return SQL. Try rephrasing your question.');
      }

      setSql(generated);
      setAskNote('SQL is ready in the editor — review it, then Run. Writes ask before they change data.');
      setAskOpen(false);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : 'The assistant could not answer that.');
    } finally {
      setAskBusy(false);
    }
  }, [askQuestion, askBusy, gatherSchema]);

  // ── Execute one statement against the site's OWN D1 ────────────────────────
  const runQuery = useCallback(
    async (rawSql: string, confirm: boolean, wasExplain: boolean) => {
      const trimmed = rawSql.trim();

      if (!trimmed) {
        return;
      }

      if (!isEmbedded) {
        setState({ status: 'error', message: 'Open this from the ProjectSites admin to run SQL.' });
        return;
      }

      // Record the run on SEND (so a failed query stays re-runnable). Not for EXPLAIN (it's a helper action).
      if (!wasExplain) {
        recordHistory(trimmed);
      }

      lastConfirmSqlRef.current = trimmed;
      setState({ status: 'running' });

      try {
        const reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'd1',
          action: 'exec',
          input: { sql: trimmed },
          confirm,
        })) as ResMutateResponseMessage;

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

        const data = (result.data ?? {}) as SqlExecData;

        // Enrich the completion schema with any columns this result exposed (real identifiers only).
        if (data.columns && data.columns.length > 0) {
          const cols = data.columns.map((c) => c.name);
          setSchema((prev) => {
            const merged = new Set([...(prev?.columns ?? []), ...cols]);
            return { tables: prev?.tables ?? [], columns: [...merged] };
          });
        }

        setState({ status: 'ready', data, wasExplain });
      } catch (err) {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'The statement could not run.' });
      }
    },
    [request, recordHistory],
  );

  const run = useCallback(() => void runQuery(sql, false, false), [sql, runQuery]);

  const explain = useCallback(() => {
    const wrapped = explainQuery(sql);

    if (wrapped) {
      void runQuery(wrapped, false, true);
    }
  }, [sql, runQuery]);

  const confirmRun = useCallback(
    () => void runQuery(lastConfirmSqlRef.current, true, false),
    [runQuery],
  );

  // ── History + saved-query actions ──────────────────────────────────────────
  const recallHistory = useCallback(
    (query: string) => {
      setSql(query);
      setHistoryOpen(false);
      void runQuery(query, false, false);
    },
    [runQuery],
  );

  const saveCurrent = useCallback(() => {
    const name = saveName.trim();

    if (!name || !sql.trim()) {
      return;
    }

    setSaved((prev) => {
      const next = addSavedQuery(prev, name, sql);
      persistSaved(next);
      return next;
    });
    setSaveName('');
  }, [saveName, sql]);

  const loadSaved = useCallback((query: string) => {
    setSql(query);
    setSavedOpen(false);
  }, []);

  const deleteSaved = useCallback((name: string) => {
    setSaved((prev) => {
      const next = removeSavedQuery(prev, name);
      persistSaved(next);
      return next;
    });
  }, []);

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1" data-testid="database-sql">
      {/* ── Toolbar: starters · templates · history · saved · save-as ── */}
      <div className="p-3 border-b border-bolt-elements-borderColor/60 space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <div className="i-ph:terminal-window-duotone text-lg text-bolt-elements-item-contentAccent" aria-hidden />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-bolt-elements-textPrimary">SQL navigator</h2>
            <p className="text-[10px] text-bolt-elements-textTertiary truncate">
              Runs against your site&rsquo;s own database — writes ask before they change data
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary mr-0.5">Starters</span>
          {STARTERS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                setSql(s.query);
                void runQuery(s.query, false, false);
              }}
              data-testid="database-sql-starter"
              className="min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-bolt-elements-item-contentAccent/40 hover:text-bolt-elements-textPrimary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              {s.label}
            </button>
          ))}
          <span className="mx-0.5 h-3 w-px bg-bolt-elements-borderColor" aria-hidden />
          <button
            type="button"
            onClick={() => setSql(NEW_TABLE_TEMPLATE)}
            data-testid="database-sql-new-table"
            title="Drop a CREATE TABLE template into the editor — edit the name + columns, then Run"
            className="min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border border-bolt-elements-item-contentAccent/40 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:plus" /> New table
          </button>
          <button
            type="button"
            onClick={() => {
              setAskOpen((v) => !v);
              setAskError(null);
            }}
            data-testid="database-sql-ask-toggle"
            aria-expanded={askOpen}
            title="Ask in plain English — the AI writes the SQL from your site's own tables"
            className={classNames(
              'min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border flex items-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
              askOpen
                ? 'border-[#00e5ff]/60 bg-[#00e5ff]/10 text-[#00E5FF]'
                : 'border-[#00e5ff]/40 text-[#00E5FF] hover:bg-[#00e5ff]/10',
            )}
          >
            <div className="i-ph:sparkle" /> Ask AI
          </button>
          {history.length > 0 && (
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              data-testid="database-sql-history-toggle"
              aria-expanded={historyOpen}
              title="Recent queries you have run (this browser)"
              className="min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-bolt-elements-item-contentAccent/40 hover:text-bolt-elements-textPrimary transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:clock-counter-clockwise" /> History ({history.length})
            </button>
          )}
          {saved.length > 0 && (
            <button
              type="button"
              onClick={() => setSavedOpen((v) => !v)}
              data-testid="database-sql-saved-toggle"
              aria-expanded={savedOpen}
              title="Your saved queries (this browser) — click to recall into the editor"
              className="min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-bolt-elements-item-contentAccent/40 hover:text-bolt-elements-textPrimary transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:bookmark-simple" /> Saved ({saved.length})
            </button>
          )}
          <span className="inline-flex items-center gap-1">
            <input
              type="text"
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  saveCurrent();
                }
              }}
              placeholder="Name…"
              data-testid="database-sql-save-name"
              aria-label="Name to save the current query under"
              className="w-24 min-h-[24px] rounded-full bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-2.5 py-0.5 text-[10px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-bolt-elements-item-contentAccent/50"
            />
            <button
              type="button"
              onClick={saveCurrent}
              disabled={!saveName.trim() || !sql.trim()}
              data-testid="database-sql-save"
              title="Save the current query under this name for one-click reuse"
              className={classNames(
                'min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border flex items-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                !saveName.trim() || !sql.trim()
                  ? 'border-bolt-elements-borderColor text-bolt-elements-textTertiary cursor-not-allowed'
                  : 'border-bolt-elements-item-contentAccent/40 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-item-contentAccent/10 cursor-pointer',
              )}
            >
              <div className="i-ph:bookmark-simple" /> Save
            </button>
          </span>
        </div>

        {/* History dropdown */}
        {historyOpen && history.length > 0 && (
          <div
            data-testid="database-sql-history"
            className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 max-h-40 overflow-auto modern-scrollbar"
          >
            {history.map((h, i) => (
              <button
                key={i}
                type="button"
                onClick={() => recallHistory(h)}
                title={h}
                data-testid="database-sql-history-item"
                className="w-full text-left px-3 py-1.5 text-[11px] font-mono text-bolt-elements-textSecondary hover:bg-bolt-elements-item-backgroundActive hover:text-bolt-elements-textPrimary truncate border-b border-bolt-elements-borderColor/30 last:border-b-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
              >
                {h}
              </button>
            ))}
          </div>
        )}

        {/* Saved-queries dropdown */}
        {savedOpen && saved.length > 0 && (
          <div
            data-testid="database-sql-saved"
            className="rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 max-h-40 overflow-auto modern-scrollbar divide-y divide-bolt-elements-borderColor/30"
          >
            {saved.map((s) => (
              <div key={s.name} className="flex items-center gap-1 px-2 py-1">
                <button
                  type="button"
                  onClick={() => loadSaved(s.query)}
                  title={s.query}
                  data-testid="database-sql-saved-load"
                  className="flex-1 min-w-0 text-left px-1 py-0.5 text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent rounded cursor-pointer"
                >
                  <div className="i-ph:bookmark-simple-fill text-bolt-elements-item-contentAccent shrink-0" />
                  <span className="truncate font-medium">{s.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => deleteSaved(s.name)}
                  aria-label={`Delete saved query ${s.name}`}
                  title="Delete this saved query"
                  data-testid="database-sql-saved-delete"
                  className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-red-400 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                >
                  <div className="i-ph:trash text-xs" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Ask AI — plain-English → SQL grounded on the site's OWN schema, dropped into the editor to review */}
        {askOpen && (
          <div
            data-testid="database-sql-ask"
            className="rounded-md border border-[#00e5ff]/30 bg-[#00e5ff]/[0.04] p-2.5 space-y-2"
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-bolt-elements-textSecondary">
              <div className="i-ph:sparkle text-[#00E5FF]" /> Ask your database
            </div>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={askQuestion}
                onChange={(e) => setAskQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void askSql();
                  }
                }}
                placeholder="e.g. show the 10 most recent orders"
                data-testid="database-sql-ask-input"
                aria-label="Ask a question about your database in plain English"
                spellCheck={false}
                className="min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2.5 py-1 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-[#00e5ff]/50"
              />
              <button
                type="button"
                onClick={() => void askSql()}
                disabled={askBusy || !askQuestion.trim()}
                data-testid="database-sql-ask-submit"
                className={classNames(
                  'min-h-[24px] flex shrink-0 items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00e5ff]',
                  askBusy || !askQuestion.trim()
                    ? 'cursor-not-allowed bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary'
                    : 'cursor-pointer bg-[#00e5ff]/15 text-[#00E5FF] hover:bg-[#00e5ff]/25',
                )}
              >
                <div className={askBusy ? 'i-ph:circle-notch animate-spin' : 'i-ph:arrow-right'} />
                <span className="min-w-[6ch] text-center">{askBusy ? 'Writing…' : 'Write SQL'}</span>
              </button>
            </div>
            <p className="text-[9px] italic text-bolt-elements-textTertiary">
              The AI reads your site&rsquo;s own tables + columns and drafts the SQL into the editor. You review it and
              press Run — nothing runs automatically, and writes ask before they change data.
            </p>
            {askError && (
              <div
                className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-400"
                role="alert"
                data-testid="database-sql-ask-error"
              >
                {askError}
              </div>
            )}
          </div>
        )}

        {askNote && (
          <div
            className="flex items-center gap-2 rounded-md border border-[#00e5ff]/30 bg-[#00e5ff]/[0.06] px-2.5 py-1.5 text-[11px] text-bolt-elements-textSecondary"
            data-testid="database-sql-ask-note"
            role="status"
          >
            <div className="i-ph:check-circle text-[#00E5FF] shrink-0" />
            <span>{askNote}</span>
          </div>
        )}
      </div>

      {/* ── Editor + run/explain ── */}
      <div className="flex flex-col gap-2 p-3 border-b border-bolt-elements-borderColor/60 shrink-0">
        <label
          htmlFor="database-sql-input"
          className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary"
        >
          SQL — runs against your site&rsquo;s own database
        </label>
        <SqlEditor
          value={sql}
          onValueChange={setSql}
          onRun={run}
          schema={schema}
          minRows={4}
          placeholder="SELECT * FROM your_table LIMIT 25;"
          testId="database-sql-textarea"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={run}
            disabled={state.status === 'running' || !sql.trim()}
            data-testid="database-sql-run"
            className="min-h-[24px] text-[12px] font-semibold px-3.5 py-1.5 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 enabled:hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            {state.status === 'running' ? <div className="i-ph:circle-notch animate-spin" /> : <div className="i-ph:play" />}
            <span className="min-w-[7ch] text-center">{state.status === 'running' ? 'Running…' : 'Run'}</span>
          </button>
          <button
            type="button"
            onClick={explain}
            disabled={state.status === 'running' || !sql.trim()}
            data-testid="database-sql-explain"
            title="EXPLAIN QUERY PLAN — see which indexes your query uses (a read, never a change)"
            className="min-h-[24px] text-[11px] font-medium px-3 py-1.5 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary enabled:hover:bg-bolt-elements-background-depth-3 enabled:hover:text-bolt-elements-textPrimary disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:strategy" /> Explain
          </button>
          <span className="text-[10px] text-bolt-elements-textTertiary ml-auto">⌘/Ctrl + Enter to run</span>
        </div>
      </div>

      {/* ── Result ── */}
      <div className="flex-1 overflow-auto modern-scrollbar min-h-0">
        {state.status === 'idle' && (
          <div
            className="flex flex-col items-center justify-center gap-2 p-8 text-center h-full"
            data-testid="database-sql-idle"
          >
            <div className="i-ph:terminal-window text-3xl text-bolt-elements-textTertiary" />
            <p className="text-xs text-bolt-elements-textSecondary max-w-[300px]">
              Write a query and press Run. Reads return rows; writes ask you to confirm before they change data.
              Autocomplete suggests your real tables + columns as you type.
            </p>
          </div>
        )}

        {state.status === 'disabled' && (
          <div
            className="flex flex-col items-center justify-center gap-3 p-8 text-center h-full"
            data-testid="database-sql-disabled"
          >
            <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
            <p className="text-sm font-medium text-bolt-elements-textSecondary">The SQL navigator isn&rsquo;t enabled yet</p>
            <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
              Your site&rsquo;s own database is on the way. Once it&rsquo;s turned on, you can run SQL here — nothing to set up.
            </p>
          </div>
        )}

        {state.status === 'error' && (
          <div
            className="flex flex-col items-center justify-center gap-3 p-8 text-center h-full"
            data-testid="database-sql-error"
            role="alert"
          >
            <div className="i-ph:warning-circle text-3xl text-red-400" />
            <p className="text-xs text-bolt-elements-textSecondary max-w-[320px] break-words">{state.message}</p>
            <button
              type="button"
              onClick={run}
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
            role="alertdialog"
            aria-label="Confirm a data-changing statement"
          >
            <div className="i-ph:seal-warning text-3xl text-amber-400" />
            <p className="text-sm font-semibold text-bolt-elements-textPrimary">This statement changes data</p>
            <p className="text-[11px] text-bolt-elements-textSecondary max-w-[320px] break-words">{state.message}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={confirmRun}
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

        {state.status === 'ready' && <SqlResult data={state.data} wasExplain={state.wasExplain} />}
      </div>
    </div>
  );
});

SqlNavigator.displayName = 'SqlNavigator';

// ── Result grid (typed cells + ground-truth cost meta) ───────────────────────

/**
 * Render one exec result: a rows grid for reads, or the ground-truth `rowsWritten` for writes. After an
 * EXPLAIN, an index hint (`explainPlanHint`) teaches whether the query is index-optimized.
 */
const SqlResult = memo(({ data, wasExplain }: { data: SqlExecData; wasExplain: boolean }) => {
  const rows = useMemo(() => data.rows ?? [], [data.rows]);

  const columnNames = useMemo(() => {
    if (data.columns && data.columns.length > 0) {
      return data.columns.map((c) => c.name);
    }

    return rows.length > 0 ? Object.keys(rows[0]) : [];
  }, [data.columns, rows]);

  const wrote = typeof data.rowsWritten === 'number' && data.rowsWritten > 0;
  const planHint: ExplainHint | null = useMemo(() => (wasExplain ? explainPlanHint(rows) : null), [wasExplain, rows]);

  const hintClass =
    planHint?.level === 'good'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : planHint?.level === 'warn'
        ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
        : 'border-bolt-elements-item-contentAccent/40 bg-bolt-elements-item-contentAccent/10 text-bolt-elements-item-contentAccent';

  return (
    <div className="p-3" data-testid="database-sql-result">
      {/* Effect summary strip — classification + ground-truth cost meta */}
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
        {typeof data.rowsRead === 'number' && data.rowsRead > 0 && (
          <span
            className="px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-2 text-bolt-elements-textTertiary tabular-nums"
            data-testid="database-sql-rows-read"
          >
            {data.rowsRead} read
          </span>
        )}
        {typeof data.durationMs === 'number' && (
          <span className="text-bolt-elements-textTertiary tabular-nums">{data.durationMs} ms</span>
        )}
      </div>

      {/* EXPLAIN index hint */}
      {planHint && (
        <div
          className={classNames('mb-2 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px]', hintClass)}
          data-testid="database-sql-plan-hint"
          role="status"
        >
          <div
            className={classNames(
              'mt-0.5 shrink-0',
              planHint.level === 'good'
                ? 'i-ph:check-circle'
                : planHint.level === 'warn'
                  ? 'i-ph:warning'
                  : 'i-ph:info',
            )}
            aria-hidden
          />
          <span>{planHint.message}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="database-sql-noresults"
        >
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
                  {columnNames.map((name) => {
                    const classified = classifyCell(row[name]);
                    return (
                      <td
                        key={name}
                        className={classNames(
                          'px-3 py-1.5 border-b border-bolt-elements-borderColor/30 whitespace-nowrap max-w-[280px] truncate',
                          classified.className,
                        )}
                        title={classified.kind === 'null' ? 'null' : (classified.title ?? classified.display)}
                      >
                        {classified.kind === 'null' ? '—' : classified.display}
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

SqlResult.displayName = 'SqlNavigator.SqlResult';
