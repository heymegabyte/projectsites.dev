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
  requestDbQuery,
  type ParentToChildMessage,
  type SiteDbQueryResponseMessage,
  type SiteDbTablesResponseMessage,
  type SiteDbRowsResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  addSavedQuery,
  removeSavedQuery,
  recordHistoryEntry,
  previewQuery,
  relativeTime,
  nextRailIndex,
  siteSqlKey,
  explainQuery,
  explainPlanHint,
  analyzeRowLimit,
  isExpensiveScan,
  DEFAULT_ROW_LIMIT,
  type SavedQuery,
  type HistoryEntry,
  type ExplainHint,
} from './data-panel-logic';
import { DataGrid } from './DataGrid';
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
import { buildExplainDispatch, explainDisabledReason } from './sql-explain-logic';

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const DISABLED_404 = 'not enabled';

/**
 * localStorage keys are computed per-site via {@link siteSqlKey} (scoped by the site's OWN D1
 * `databaseId` so one browser's history/saved never bleed across sites). Until the tables response
 * yields a `databaseId`, reads/writes use the `__shared` fallback bucket; the rail re-hydrates from the
 * site-scoped bucket once the id arrives.
 */

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

/**
 * The leading SQL statement verb (SELECT / INSERT / UPDATE / DELETE / CREATE / DROP / ALTER / PRAGMA / …),
 * uppercased — drives the result "classification" pill. Strips a leading block/line comment first. Pure.
 */
function classifySql(sql: string): string {
  const stripped = sql
    .trim()
    .replace(/^\/\*[\s\S]*?\*\//, '')
    .replace(/^(?:--[^\n]*\n\s*)+/, '')
    .trim();

  return (stripped.split(/\s+/, 1)[0] ?? '').toUpperCase();
}

/**
 * A destructive statement the console confirms before running (mirrors the Table-view's type-to-confirm):
 * any DROP / TRUNCATE / ALTER, and a DELETE/UPDATE with no WHERE (touches every row). INSERT/CREATE/SELECT
 * run immediately. Pure — safe SQL string inspection only (the statement still runs on the site's OWN D1).
 */
function isDestructiveSql(sql: string): boolean {
  const verb = classifySql(sql);

  if (verb === 'DROP' || verb === 'TRUNCATE' || verb === 'ALTER') {
    return true;
  }

  if (verb === 'DELETE' || verb === 'UPDATE') {
    return !/\bWHERE\b/i.test(sql);
  }

  return false;
}

/** A promise pending a bridge reply, resolved by correlationId when the parent answers. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The normalized SQL-console result. Sourced from `POST /api/sites/:siteId/db/query` (the per-site D1
 * console endpoint) via {@link requestDbQuery} — `rows` + D1 `meta` mapped to the display fields below.
 * `classification` is the leading statement verb (derived client-side for the effect pill).
 */
interface SqlExecData {
  classification?: string;
  rows?: Record<string, unknown>[];
  columns?: { name: string; type?: string }[];
  rowsWritten?: number;
  rowsRead?: number;
  durationMs?: number;

  /** Total rows the query matched before the server-side cap (may exceed `rows.length`). */
  rowCount?: number;

  /** `true` when the result was capped server-side (the grid shows a "first N rows" note). */
  truncated?: boolean;
}

type SqlState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'disabled' }
  | { status: 'confirm'; message: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: SqlExecData; wasExplain: boolean };

// ── Persistence helpers (best-effort localStorage — never breaks a run) ──────

/** Read the timestamped history list from the site-scoped bucket; tolerates legacy string[] entries. */
function readHistory(databaseId: string | undefined): HistoryEntry[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(siteSqlKey('history', databaseId)) : null;
    const parsed = raw ? JSON.parse(raw) : [];

    if (!Array.isArray(parsed)) {
      return [];
    }

    // Accept the timestamped shape; migrate a legacy string entry to a zero-time entry (still reloadable).
    return parsed
      .map((e): HistoryEntry | null => {
        if (typeof e === 'string') {
          return { query: e, ranAt: 0 };
        }

        if (e && typeof e.query === 'string') {
          return { query: e.query, ranAt: typeof e.ranAt === 'number' ? e.ranAt : 0 };
        }

        return null;
      })
      .filter((e): e is HistoryEntry => e !== null);
  } catch {
    return [];
  }
}

function persistHistory(databaseId: string | undefined, next: readonly HistoryEntry[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(siteSqlKey('history', databaseId), JSON.stringify(next));
    }
  } catch {
    /* quota / SSR / private-mode never breaks a run */
  }
}

function readSaved(databaseId: string | undefined): SavedQuery[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(siteSqlKey('saved', databaseId)) : null;
    const parsed = raw ? JSON.parse(raw) : [];

    return Array.isArray(parsed)
      ? parsed.filter((s): s is SavedQuery => !!s && typeof s.name === 'string' && typeof s.query === 'string')
      : [];
  } catch {
    return [];
  }
}

function persistSaved(databaseId: string | undefined, next: readonly SavedQuery[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(siteSqlKey('saved', databaseId), JSON.stringify(next));
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

  // The site's OWN D1 database id — scopes the history/saved localStorage buckets (never cross-site).
  const [databaseId, setDatabaseId] = useState<string | undefined>(undefined);

  // Timestamped query history + named saved queries — the Rev 6 persistent rail (recycled logic).
  const [history, setHistory] = useState<HistoryEntry[]>(() => readHistory(undefined));
  const [saved, setSaved] = useState<SavedQuery[]>(() => readSaved(undefined));
  const [railOpen, setRailOpen] = useState(true);
  const [saveName, setSaveName] = useState('');

  // The completion schema — the site's OWN tables (never shared-platform tables).
  const [schema, setSchema] = useState<SqlSchema | undefined>(undefined);

  // ── Ask (AI SQL assistant) — NL → SQL grounded on the site's OWN schema, run through the per-site path ──
  const [askOpen, setAskOpen] = useState(false);
  const [askQuestion, setAskQuestion] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askNote, setAskNote] = useState<string | null>(null);

  // Rev 7: a transient "sent to the chat" confirmation after AI "Explain this" (reuses the editor chat).
  const [explainSent, setExplainSent] = useState(false);

  const pendingRef = useRef<Map<string, Pending>>(new Map());
  const lastConfirmSqlRef = useRef('');

  // ── ONE parent-message listener; resolve by correlationId via the live ref (empty-deps stale-ref safe) ──
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      /*
       * The local `request` plumbing handles the schema reads (tables + per-table columns). The SQL run
       * itself resolves through `requestDbQuery` (its own self-contained bridge listener). Accepting ROWS
       * here fixes a latent drop: `gatherSchema` awaited PS_SITEDB_ROWS_RESPONSE that was never resolved.
       */
      if (msg.type !== 'PS_SITEDB_TABLES_RESPONSE' && msg.type !== 'PS_SITEDB_ROWS_RESPONSE') {
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

        // The site's OWN D1 id scopes the rail's localStorage buckets — re-hydrate from the site bucket.
        const id = (reply.databaseId ?? '').trim();

        if (id) {
          setDatabaseId(id);
          setHistory(readHistory(id));
          setSaved(readSaved(id));
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

  const recordHistory = useCallback(
    (query: string) => {
      setHistory((h) => {
        const next = recordHistoryEntry(h, query);
        persistHistory(databaseId, next);

        return next;
      });
    },
    [databaseId],
  );

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

    if (!tablesReply.ok || tablesReply.enabled === false) {
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

  // ── Execute one statement against the site's OWN D1 (POST /db/query) ────────
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

      /*
       * Client-side safety gate — a destructive statement asks for confirmation first (mirrors the
       * Table-view). The write still runs on the site's OWN isolated D1; this only prevents an accidental
       * DROP / mass-DELETE. EXPLAIN and an already-confirmed re-run never gate.
       */
      if (!confirm && !wasExplain && isDestructiveSql(trimmed)) {
        lastConfirmSqlRef.current = trimmed;
        setState({
          status: 'confirm',
          message: `This ${classifySql(trimmed)} statement changes data and can’t be undone. Run it?`,
        });

        return;
      }

      // Record the run on SEND (so a failed query stays re-runnable). Not for EXPLAIN (it's a helper action).
      if (!wasExplain) {
        recordHistory(trimmed);
      }

      lastConfirmSqlRef.current = trimmed;
      setState({ status: 'running' });

      try {
        /*
         * Purpose-built per-site SQL console endpoint: runs ONE statement against the site's OWN D1
         * (server-resolved id, shared-platform ids denylisted) and returns rows + D1 meta, or the real
         * SQL error verbatim. No classify/confirm round-trip — the console runs what you type.
         */
        const reply: SiteDbQueryResponseMessage = await requestDbQuery({ sql: trimmed });

        // Dark-flag 404 → friendly "not enabled yet" state (INV-3), never a scary error.
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setState({ status: 'disabled' });
          return;
        }

        // A real SQL error is surfaced verbatim — seeing the exact error IS the point of a console.
        if (!reply.ok || reply.error) {
          setState({ status: 'error', message: reply.error || 'The statement could not run.' });
          return;
        }

        const rows = reply.rows ?? [];

        // Enrich the completion schema with any columns this result exposed (real identifiers only).
        if (rows.length > 0) {
          const cols = Object.keys(rows[0]);
          setSchema((prev) => {
            const merged = new Set([...(prev?.columns ?? []), ...cols]);
            return { tables: prev?.tables ?? [], columns: [...merged] };
          });
        }

        const meta = reply.meta ?? {};
        const data: SqlExecData = {
          classification: classifySql(trimmed),
          rows,
          rowCount: reply.rowCount ?? rows.length,
          truncated: reply.truncated,
          rowsWritten: typeof meta.rows_written === 'number' ? meta.rows_written : undefined,
          rowsRead: typeof meta.rows_read === 'number' ? meta.rows_read : undefined,
          durationMs: typeof meta.duration === 'number' ? Math.round(meta.duration) : undefined,
        };

        setState({ status: 'ready', data, wasExplain });
      } catch (err) {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'The statement could not run.' });
      }
    },
    [recordHistory],
  );

  const run = useCallback(() => void runQuery(sql, false, false), [sql, runQuery]);

  /**
   * Ask the platform AI for a SQLite statement grounded on the site's schema, drop it into the editor, AND
   * immediately RUN it so the answer (rows / the matching tables) shows up — Brian asked "show me any table
   * that starts with cus" and expected the table to appear, not just see SQL. The query stays visible in the
   * editor and results render below; writes still confirm-gate through {@link runQuery}. Uses `/api/llmcall`
   * which, when `PS_BOLT_AI=true`, routes to ProjectSites AI (the platform model) — no CF id, no shared DB.
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

      // Show the SQL in the editor AND run it so the result appears immediately (writes still confirm-gate).
      setSql(generated);
      setAskNote('Ran the SQL the AI wrote — results are below, and the query is in the editor to tweak.');
      setAskOpen(false);
      void runQuery(generated, false, false);
    } catch (err) {
      setAskError(err instanceof Error ? err.message : 'The assistant could not answer that.');
    } finally {
      setAskBusy(false);
    }
  }, [askQuestion, askBusy, gatherSchema, runQuery]);

  /**
   * Open a table by name from a results grid (Fix: clicking a `name` cell in a `sqlite_master` table list
   * drills into that table). Formulates `SELECT * FROM "<name>" LIMIT 500` and runs it — the value is
   * validated against the site's OWN known tables (from the completion schema) so a stray cell can never
   * inject SQL, and the identifier is double-quoted. Only wired for the `name` column (see the results grid).
   */
  const openTableFromResult = useCallback(
    (column: string, value: string) => {
      const name = (value ?? '').trim();
      const known = schema?.tables ?? [];

      // Guard: only drill into a REAL table from this site's schema, and only from a name-like column.
      if (column !== 'name' || !name || !known.includes(name)) {
        return;
      }

      const next = `SELECT * FROM "${name}" LIMIT ${DEFAULT_ROW_LIMIT};`;
      setSql(next);
      void runQuery(next, false, false);
    },
    [schema, runQuery],
  );

  // "Bare SELECT with no LIMIT" advice — drives BOTH the always-on LIMIT 500 button and the amber nudge.
  const rowLimitAdvice = useMemo(() => analyzeRowLimit(sql), [sql]);

  /**
   * Run the current query capped at {@link DEFAULT_ROW_LIMIT} rows so a big table is safe to preview.
   * A bare `SELECT`/`WITH…SELECT` with no `LIMIT` runs the `LIMIT 500`-appended variant; an
   * already-bounded or non-SELECT statement runs UNCHANGED (never a double-`LIMIT` syntax error).
   */
  const runWithLimit = useCallback(
    () => void runQuery(rowLimitAdvice.limitedSql, false, false),
    [rowLimitAdvice, runQuery],
  );

  const explain = useCallback(() => {
    const wrapped = explainQuery(sql);

    if (wrapped) {
      void runQuery(wrapped, false, true);
    }
  }, [sql, runQuery]);

  const confirmRun = useCallback(() => void runQuery(lastConfirmSqlRef.current, true, false), [runQuery]);

  /*
   * AI "Explain this" (Rev 7): hand the current query + a sample of its result rows to the EXISTING editor
   * AI chat for a plain-English explanation. REUSES the chat via a `PS_SUBMIT_PROMPT` bridge message (the
   * same one the admin uses to auto-submit a prompt) — the SqlNavigator + the chat share this editor iframe,
   * so the message flows child to parent and the admin relays it straight back into the chat conversation.
   * No new worker endpoint, no direct model call. Disabled-with-reason when there's no query (never a dead
   * control). `sql` is what's in the editor; the sampled rows come from a ready result.
   */
  const explainDisabled = explainDisabledReason({ sql });
  const explainResult = useCallback(() => {
    const rows = state.status === 'ready' ? (state.data.rows ?? []) : [];

    // `siteId`/`slug` default to '' — the chat's PS_SUBMIT_PROMPT handler reads only `prompt`.
    const dispatch = buildExplainDispatch({ sql, rows });

    if (!dispatch) {
      return;
    }

    /*
     * Reuse the editor AI chat: `PS_SUBMIT_PROMPT` is the message the parent admin relays straight into
     * `Chat.client.tsx`'s handler (`append({ role:'user', ... })`). We raw-post it to the parent the same
     * way Preview.tsx asks the admin to open the domain menu — the admin's BoltEmbedService validates
     * event.origin, so '*' is safe. Standalone editor (no parent) → no-op. No new endpoint, no direct AI call.
     */
    try {
      window.parent?.postMessage({ ...dispatch, correlationId: nextCorrelationId() }, '*');
      setExplainSent(true);
    } catch {
      /* no admin parent — nothing to relay */
    }
  }, [sql, state]);

  // ── History + saved-query actions ──────────────────────────────────────────
  /** Recall a history entry: drop it into the editor AND re-run it (a one-click "run this again"). */
  const recallHistory = useCallback(
    (query: string) => {
      setSql(query);
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
      persistSaved(databaseId, next);

      return next;
    });
    setSaveName('');
  }, [saveName, sql, databaseId]);

  /** Load a saved query into the editor (does NOT auto-run — the user reviews, then Runs). */
  const loadSaved = useCallback((query: string) => {
    setSql(query);
  }, []);

  const deleteSaved = useCallback(
    (name: string) => {
      setSaved((prev) => {
        const next = removeSavedQuery(prev, name);
        persistSaved(databaseId, next);

        return next;
      });
    },
    [databaseId],
  );

  return (
    <div
      className="h-full flex flex-col bg-bolt-elements-background-depth-1 [color-scheme:dark] accent-[color:var(--ps-accent,#00e5ff)]"
      data-testid="database-sql"
    >
      {/* ── Toolbar: starters · templates · history · saved · save-as ── */}
      <div className="p-3 border-b border-bolt-elements-borderColor/60 space-y-2 shrink-0 bg-bolt-elements-background-depth-2/40 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center h-8 w-8 rounded-lg border border-[#00e5ff4c] bg-[#00e5ff14] shrink-0">
            <div className="i-ph:terminal-window-duotone text-base text-bolt-elements-item-contentAccent" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-bolt-elements-textPrimary">SQL navigator</h2>
            <p className="text-[10px] text-bolt-elements-textSecondary truncate">
              Runs against your site&rsquo;s own database — writes ask before they change data
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textSecondary mr-0.5">Starters</span>
          {STARTERS.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => {
                // Populate-before-run (WLK-05): drop the preset SQL into the editor so the user SEES
                // it, then presses Run. Never auto-execute — the query must be visible first.
                setSql(s.query);
                setExplainSent(false);
              }}
              data-testid="database-sql-starter"
              title="Load this query into the editor — review it, then press Run"
              className="min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-[#00e5ff66] hover:text-bolt-elements-textPrimary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
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
            className="min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border border-[#00e5ff66] text-bolt-elements-item-contentAccent hover:bg-[#00e5ff1a] transition-colors flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
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
              'min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border flex items-center gap-1 transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
              askOpen
                ? 'border-[#00e5ff99] bg-[#00e5ff26] text-bolt-elements-item-contentAccent shadow-[0_0_0_1px_rgba(0,229,255,0.15),0_2px_12px_-4px_rgba(0,229,255,0.4)]'
                : 'border-[#00e5ff66] text-bolt-elements-item-contentAccent hover:bg-[#00e5ff1a]',
            )}
          >
            <div className="i-ph:sparkle" /> Ask AI
          </button>
          <button
            type="button"
            onClick={() => setRailOpen((v) => !v)}
            data-testid="database-sql-rail-toggle"
            aria-expanded={railOpen}
            aria-controls="database-sql-rail"
            title="Show or hide the saved queries + run-history rail (this browser)"
            className={classNames(
              'min-h-[24px] text-[10px] rounded-full px-2.5 py-0.5 border flex items-center gap-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
              railOpen
                ? 'border-[#00e5ff66] text-bolt-elements-item-contentAccent bg-[#00e5ff14]'
                : 'border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:border-[#00e5ff66] hover:text-bolt-elements-textPrimary',
            )}
          >
            <div className="i-ph:clock-counter-clockwise" /> Saved &amp; history
            {saved.length + history.length > 0 && (
              <span className="tabular-nums opacity-80">({saved.length + history.length})</span>
            )}
          </button>
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
              className="w-24 min-h-[24px] rounded-full bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor px-2.5 py-0.5 text-[10px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-[#00e5ff80]"
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
                  : 'border-[#00e5ff66] text-bolt-elements-item-contentAccent hover:bg-[#00e5ff1a] cursor-pointer',
              )}
            >
              <div className="i-ph:bookmark-simple" /> Save
            </button>
          </span>
        </div>

        {/* Ask AI — plain-English → SQL grounded on the site's OWN schema, dropped into the editor to review */}
        {askOpen && (
          <div
            data-testid="database-sql-ask"
            className="rounded-md border border-[#00e5ff4c] bg-[#00e5ff0d] p-2.5 space-y-2 motion-safe:animate-[fadeIn_140ms_ease-out]"
          >
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-bolt-elements-textSecondary">
              <div className="i-ph:sparkle-duotone text-bolt-elements-item-contentAccent" aria-hidden /> Ask your
              database
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
                className="min-w-0 flex-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2.5 py-1 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:border-[#00e5ff80] focus:ring-1 focus:ring-[#00e5ff66] transition-colors"
              />
              <button
                type="button"
                onClick={() => void askSql()}
                disabled={askBusy || !askQuestion.trim()}
                data-testid="database-sql-ask-submit"
                className={classNames(
                  'min-h-[24px] flex shrink-0 items-center gap-1 rounded px-2.5 py-1 text-[11px] font-semibold transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                  askBusy || !askQuestion.trim()
                    ? 'cursor-not-allowed bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary opacity-60'
                    : 'cursor-pointer bg-[#00e5ff26] text-bolt-elements-item-contentAccent hover:bg-[#00e5ff40]',
                )}
              >
                <div className={askBusy ? 'i-ph:circle-notch animate-spin' : 'i-ph:arrow-right'} />
                <span className="min-w-[6ch] text-center">{askBusy ? 'Writing…' : 'Write SQL'}</span>
              </button>
            </div>
            <p className="text-[9px] italic text-bolt-elements-textSecondary">
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
            className="flex items-center gap-2 rounded-md border border-[#00e5ff4c] bg-[#00e5ff12] px-2.5 py-1.5 text-[11px] text-bolt-elements-textSecondary motion-safe:animate-[fadeIn_160ms_ease-out]"
            data-testid="database-sql-ask-note"
            role="status"
          >
            <div className="i-ph:check-circle-duotone text-bolt-elements-item-contentAccent shrink-0" aria-hidden />
            <span>{askNote}</span>
          </div>
        )}
      </div>

      {/* ── Body: editor + results (left) · saved & history rail (right) ── */}
      <div className="flex flex-1 min-h-0">
        <div className="flex flex-col flex-1 min-w-0">
          {/* ── Editor + run/explain ── */}
          <div className="flex flex-col gap-2 p-3 border-b border-bolt-elements-borderColor/60 shrink-0">
            <label
              htmlFor="database-sql-input"
              className="text-[10px] uppercase tracking-wider text-bolt-elements-textSecondary"
            >
              SQL — runs against your site&rsquo;s own database
            </label>
            <SqlEditor
              value={sql}
              onValueChange={(next) => {
                setSql(next);
                setExplainSent(false); // a new edit invalidates the "sent to chat" confirmation
              }}
              onRun={run}
              schema={schema}
              minRows={4}
              placeholder="SELECT * FROM your_table LIMIT 25;"
              testId="database-sql-textarea"
              id="database-sql-input"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={run}
                disabled={state.status === 'running' || !sql.trim()}
                data-testid="database-sql-run"
                className="min-h-[24px] text-[12px] font-semibold px-3.5 py-1.5 rounded-lg bg-bolt-elements-item-contentAccent text-[#061018] enabled:hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
              >
                {state.status === 'running' ? (
                  <div className="i-ph:circle-notch animate-spin" />
                ) : (
                  <div className="i-ph:play" />
                )}
                <span className="min-w-[7ch] text-center">{state.status === 'running' ? 'Running…' : 'Run'}</span>
              </button>
              <button
                type="button"
                onClick={runWithLimit}
                disabled={state.status === 'running' || !sql.trim()}
                data-testid="database-sql-limit"
                title={`Preview safely — run the current query capped at the first ${DEFAULT_ROW_LIMIT} rows (a bare SELECT gets LIMIT ${DEFAULT_ROW_LIMIT}; an already-bounded query runs unchanged)`}
                className="min-h-[24px] text-[11px] font-medium px-3 py-1.5 rounded-lg border border-[#00e5ff66] bg-[#00e5ff1a] text-bolt-elements-item-contentAccent enabled:hover:bg-[#00e5ff33] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
              >
                <div className="i-ph:rows" />
                {/* Reserve the widest label so the button never jitters (buttons-accommodate-largest-text). */}
                <span className="min-w-[9ch] text-center whitespace-nowrap">Run · LIMIT {DEFAULT_ROW_LIMIT}</span>
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
              <button
                type="button"
                onClick={explainResult}
                disabled={!!explainDisabled}
                data-testid="database-sql-ai-explain"
                aria-label="Explain this query and its results in plain English using the editor AI chat"
                title={explainDisabled ?? 'Ask the AI to explain this query and its results in plain English (opens in chat)'}
                className="min-h-[24px] text-[11px] font-medium px-3 py-1.5 rounded-lg border border-[#00e5ff66] bg-[#00e5ff14] text-bolt-elements-item-contentAccent enabled:hover:bg-[#00e5ff26] disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
              >
                <div className="i-ph:sparkle" /> Explain with AI
              </button>
              {explainSent && (
                <span
                  className="flex items-center gap-1 text-[10px] text-bolt-elements-item-contentAccent motion-safe:animate-[fadeIn_160ms_ease-out]"
                  data-testid="database-sql-ai-explain-sent"
                  role="status"
                >
                  <div className="i-ph:chat-circle-dots-duotone shrink-0" aria-hidden /> Sent to chat
                </span>
              )}
              {rowLimitAdvice.needsLimit && state.status !== 'running' && (
                <button
                  type="button"
                  onClick={runWithLimit}
                  data-testid="database-sql-add-limit"
                  title={`This SELECT has no LIMIT — it can return every row and scan the whole table. Run a bounded first ${rowLimitAdvice.limit} rows instead (you can still Run the full query).`}
                  className="min-h-[24px] text-[10px] font-medium text-amber-300 rounded-lg px-2.5 py-1.5 flex items-center gap-1 border border-amber-300/30 hover:bg-amber-300/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 cursor-pointer"
                >
                  <div className="i-ph:warning" /> Add LIMIT {rowLimitAdvice.limit}
                </button>
              )}
              <span className="text-[10px] text-bolt-elements-textSecondary ml-auto">⌘/Ctrl + Enter to run</span>
            </div>
          </div>

          {/* ── Result ── */}
          <div className="flex-1 overflow-auto modern-scrollbar min-h-0">
            {state.status === 'idle' && (
              <div
                className="flex flex-col items-center justify-center gap-3 p-8 text-center h-full"
                data-testid="database-sql-idle"
              >
                <div className="flex items-center justify-center h-14 w-14 rounded-2xl border border-[#00e5ff40] bg-[#00e5ff0f]">
                  <div
                    className="i-ph:terminal-window-duotone text-2xl text-bolt-elements-item-contentAccent"
                    aria-hidden
                  />
                </div>
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
                <p className="text-sm font-medium text-bolt-elements-textSecondary">
                  The SQL navigator isn&rsquo;t enabled yet
                </p>
                <p className="text-[11px] text-bolt-elements-textSecondary max-w-[260px]">
                  Your site&rsquo;s own database is on the way. Once it&rsquo;s turned on, you can run SQL here —
                  nothing to set up.
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
                <p className="text-[11px] text-bolt-elements-textSecondary max-w-[320px] break-words">
                  {state.message}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={confirmRun}
                    data-testid="database-sql-confirm-run"
                    className="min-h-[24px] text-[12px] font-semibold px-3.5 py-2 rounded-lg bg-amber-500 text-[#061018] hover:opacity-90 transition-opacity flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-amber-400 cursor-pointer"
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

            {state.status === 'ready' && (
              <SqlResult data={state.data} wasExplain={state.wasExplain} onOpenValue={openTableFromResult} />
            )}
          </div>
        </div>

        {railOpen && (
          <QueryHistoryRail
            history={history}
            saved={saved}
            onRun={recallHistory}
            onLoadSaved={loadSaved}
            onDeleteSaved={deleteSaved}
          />
        )}
      </div>
    </div>
  );
});

SqlNavigator.displayName = 'SqlNavigator';

// ── Saved-queries + run-history rail (Rev 6) ─────────────────────────────────

/**
 * The persistent side rail beside the SQL console: your NAMED saved queries (click-to-load, delete) on
 * top, then the recent RUN history (click to reload + re-run, truncated preview + relative time). Both
 * lists are keyboard-navigable (↑/↓ move focus with wrap, Enter activates the focused row). Empty state
 * is a quiet note ("Run a query to start your history"), never a dead/broken panel. Client-side only —
 * the data comes from localStorage via {@link SqlNavigator}; there is NO endpoint.
 */
const QueryHistoryRail = memo(
  ({
    history,
    saved,
    onRun,
    onLoadSaved,
    onDeleteSaved,
  }: {
    history: readonly HistoryEntry[];
    saved: readonly SavedQuery[];
    onRun: (query: string) => void;
    onLoadSaved: (query: string) => void;
    onDeleteSaved: (name: string) => void;
  }) => {
    // A `now` captured once per render keeps the relative-time labels stable within a paint.
    const now = Date.now();

    // ↑/↓ keyboard nav within EACH list (indices are per-list; Enter activates the focused row).
    const historyRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const savedRefs = useRef<(HTMLButtonElement | null)[]>([]);

    const onListKeyDown = useCallback(
      (
        e: React.KeyboardEvent,
        index: number,
        count: number,
        refs: React.MutableRefObject<(HTMLButtonElement | null)[]>,
      ) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
          return;
        }

        e.preventDefault();

        const next = nextRailIndex(e.key, index, count);
        refs.current[next]?.focus();
      },
      [],
    );

    return (
      <aside
        id="database-sql-rail"
        data-testid="database-sql-rail"
        aria-label="Saved queries and run history"
        className="w-60 shrink-0 border-l border-bolt-elements-borderColor/60 bg-bolt-elements-background-depth-2/30 overflow-auto modern-scrollbar flex flex-col"
      >
        {/* Saved queries */}
        <div className="p-2.5 border-b border-bolt-elements-borderColor/40">
          <div className="flex items-center gap-1.5 mb-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textSecondary">
            <div className="i-ph:bookmark-simple text-bolt-elements-item-contentAccent" aria-hidden /> Saved queries
            {saved.length > 0 && <span className="tabular-nums">({saved.length})</span>}
          </div>

          {saved.length === 0 ? (
            <p
              className="text-[10px] text-bolt-elements-textSecondary italic px-0.5"
              data-testid="database-sql-saved-empty"
            >
              Name a query and press Save to keep it here.
            </p>
          ) : (
            <ul className="space-y-0.5" data-testid="database-sql-saved-list">
              {saved.map((s, i) => (
                <li
                  key={s.name}
                  className="group flex items-center gap-1 rounded hover:bg-bolt-elements-item-backgroundActive"
                >
                  <button
                    ref={(el) => (savedRefs.current[i] = el)}
                    type="button"
                    onClick={() => onLoadSaved(s.query)}
                    onKeyDown={(e) => onListKeyDown(e, i, saved.length, savedRefs)}
                    title={s.query}
                    data-testid="database-sql-saved-load"
                    className="flex-1 min-w-0 text-left px-1.5 py-1 text-[11px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary flex items-center gap-1.5 rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                  >
                    <div
                      className="i-ph:bookmark-simple-fill text-bolt-elements-item-contentAccent shrink-0 text-xs"
                      aria-hidden
                    />
                    <span className="truncate font-medium">{s.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteSaved(s.name)}
                    aria-label={`Delete saved query ${s.name}`}
                    title="Delete this saved query"
                    data-testid="database-sql-saved-delete"
                    className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-red-400 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer transition-opacity"
                  >
                    <div className="i-ph:trash text-xs" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Run history */}
        <div className="p-2.5 flex-1">
          <div className="flex items-center gap-1.5 mb-1.5 text-[10px] uppercase tracking-wider text-bolt-elements-textSecondary">
            <div className="i-ph:clock-counter-clockwise text-bolt-elements-item-contentAccent" aria-hidden /> Recent
            runs
            {history.length > 0 && <span className="tabular-nums">({history.length})</span>}
          </div>

          {history.length === 0 ? (
            <p
              className="text-[10px] text-bolt-elements-textSecondary italic px-0.5"
              data-testid="database-sql-history-empty"
            >
              Run a query to start your history.
            </p>
          ) : (
            <ul className="space-y-0.5" data-testid="database-sql-history-list">
              {history.map((h, i) => (
                <li key={`${h.ranAt}-${i}`}>
                  <button
                    ref={(el) => (historyRefs.current[i] = el)}
                    type="button"
                    onClick={() => onRun(h.query)}
                    onKeyDown={(e) => onListKeyDown(e, i, history.length, historyRefs)}
                    title={`${h.query}\n\nClick to reload and run again`}
                    data-testid="database-sql-history-item"
                    className="w-full text-left px-1.5 py-1 rounded hover:bg-bolt-elements-item-backgroundActive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer group"
                  >
                    <span className="block truncate font-mono text-[11px] text-bolt-elements-textSecondary group-hover:text-bolt-elements-textPrimary">
                      {previewQuery(h.query)}
                    </span>
                    <span className="block text-[9px] text-bolt-elements-textSecondary tabular-nums">
                      {relativeTime(h.ranAt, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    );
  },
);

QueryHistoryRail.displayName = 'SqlNavigator.QueryHistoryRail';

// ── Result grid (typed cells + ground-truth cost meta) ───────────────────────

/**
 * Render one exec result: a rows grid for reads, or the ground-truth `rowsWritten` for writes. After an
 * EXPLAIN, an index hint (`explainPlanHint`) teaches whether the query is index-optimized.
 */
const SqlResult = memo(
  ({
    data,
    wasExplain,
    onOpenValue,
  }: {
    data: SqlExecData;
    wasExplain: boolean;

    /** Drill-in handler for a table-name result cell (wired to the `name` column of a `sqlite_master` list). */
    onOpenValue?: (column: string, value: string) => void;
  }) => {
    const rows = useMemo(() => data.rows ?? [], [data.rows]);

    const columnNames = useMemo(() => {
      if (data.columns && data.columns.length > 0) {
        return data.columns.map((c) => c.name);
      }

      return rows.length > 0 ? Object.keys(rows[0]) : [];
    }, [data.columns, rows]);

    const wrote = typeof data.rowsWritten === 'number' && data.rowsWritten > 0;
    const planHint: ExplainHint | null = useMemo(() => (wasExplain ? explainPlanHint(rows) : null), [wasExplain, rows]);

    // Show the returned row count for reads (not writes — those report rowsWritten, and not EXPLAIN plans).
    const showRowCount = !wrote && !wasExplain && rows.length > 0;

    const hintClass =
      planHint?.level === 'good'
        ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
        : planHint?.level === 'warn'
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          : 'border-[#00e5ff66] bg-[#00e5ff1a] text-bolt-elements-item-contentAccent';

    return (
      <div className="p-3" data-testid="database-sql-result">
        {/* Effect summary strip — classification + ground-truth cost meta */}
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px]">
          {data.classification && (
            <span className="uppercase tracking-wider px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary">
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
          {showRowCount && (
            <span
              className="px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary tabular-nums"
              data-testid="database-sql-row-count"
            >
              {(data.rowCount ?? rows.length).toLocaleString()} {(data.rowCount ?? rows.length) === 1 ? 'row' : 'rows'}
            </span>
          )}
          {data.truncated && (
            <span
              className="px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-200 tabular-nums"
              data-testid="database-sql-truncated"
              title="The result was capped for a safe preview. Add a tighter WHERE/LIMIT to see the rest."
            >
              first {rows.length.toLocaleString()} shown
            </span>
          )}
          {typeof data.rowsRead === 'number' && data.rowsRead > 0 && (
            <span
              className="px-2 py-0.5 rounded-full bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary tabular-nums"
              data-testid="database-sql-rows-read"
            >
              {data.rowsRead.toLocaleString()} read
            </span>
          )}
          {typeof data.durationMs === 'number' && (
            <span className="text-bolt-elements-textSecondary tabular-nums">{data.durationMs} ms</span>
          )}
          {isExpensiveScan(data.rowsRead) && (
            <span
              className="flex items-center gap-1 text-amber-300"
              data-testid="database-sql-scan-warn"
              role="status"
              title="This query read a large number of rows — add an index on the column(s) you filter or join by to keep it fast at scale."
            >
              <div className="i-ph:warning" aria-hidden /> expensive scan — {data.rowsRead!.toLocaleString()} rows read
            </span>
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

          /*
           * The SAME grid form the Table-view uses — typed cells, sortable headers, search, pagination,
           * and honest whole-result export — so a SQL result reads exactly like a browsed table.
           */
          <DataGrid
            columns={columnNames}
            rows={rows}
            testId="database-sql-result-grid"
            exportName="query-result"
            maxHeightClass="max-h-[48vh]"
            onOpenValue={onOpenValue}
          />
        )}
      </div>
    );
  },
);

SqlResult.displayName = 'SqlNavigator.SqlResult';
