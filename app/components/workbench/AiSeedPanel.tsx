/**
 * @file AI seed — fill a site's OWN per-site D1 table with realistic sample rows the platform AI generates (FIRE 6).
 *
 * @remarks
 * The Database tab's "Seed with AI" sub-view. An owner picks one of their OWN tables, chooses how many rows and
 * (optionally) a one-line context hint, and the platform AI generates realistic rows that MATCH the table's real
 * columns + types. The rows are PREVIEWED first, then a confirm-gated insert runs through the SAME per-site exec
 * rail everything else uses (`PS_RES_MUTATE { kind:'d1', action:'exec', input:{ sql, params }, confirm:true }` →
 * the worker's single-statement, PARAMETERIZED executor bound to the site's SERVER-RESOLVED D1 id — never a CF id
 * the caller supplies; SECURITY-INVARIANTS INV-1/INV-9).
 *
 * The AI call uses the SAME same-origin `/api/llmcall` path the SQL navigator's Ask-AI uses (routes to
 * ProjectSites AI / DeepSeek when `PS_BOLT_AI=true` — cheap, no per-user keys, no shared-DB path). The model is
 * grounded STRICTLY on the table's real schema (so it can't invent a column) and told to emit ONLY a JSON array;
 * the robust parser ({@link module:app/components/workbench/data-ingest-logic} `extractSeedRows`) drops any extra
 * key + fills any missing one, then the same param-bound {@link buildInsertPlan} chunks + binds the rows. Values
 * are BOUND, never concatenated.
 *
 * Style matches the editor conventions (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*` icons, black+cyan per
 * docs/ULTIMATE-UI-DIRECTION.md).
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '~/utils/constants';
import {
  isEmbedded,
  onParentMessage,
  postToParent,
  type ParentToChildMessage,
  type ResMutateResponseMessage,
  type SiteDbRowsResponseMessage,
  type SiteDbTablesResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  AI_SEED_DEFAULT_ROWS,
  AI_SEED_MAX_ROWS,
  AI_SEED_MIN_ROWS,
  buildInsertPlan,
  buildSeedSystemPrompt,
  clampSeedRowCount,
  extractSeedRows,
  seedColumnsToMappings,
  type SeedColumn,
} from './data-ingest-logic';

// ── Bridge plumbing (mirrors SchemaBuilder / ImportPanel) ─────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const DISABLED_404 = 'Per-site data is not enabled';

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

  return `seed_${++correlationCounter}`;
}

interface ExecResult {
  ok: boolean;
  rowsWritten?: number;
  error?: string;
  disabled?: boolean;
}

/** Columns that the DB fills itself — never asked of the AI, never inserted. */
const AUTO_COLUMNS = new Set(['id', 'rowid', 'created_at', 'updated_at', 'submitted_at']);

export interface AiSeedPanelProps {
  /**
   * Optional: open the guided Schema builder to create the FIRST table. Wired by {@link DatabasePanel} to
   * swap this overlay to the schema builder, so the "no tables yet" empty state is a launchpad — never a
   * dead-end. When absent (standalone), the empty state falls back to a plain "create a table first" note.
   */
  onCreateTable?: () => void;
}

export const AiSeedPanel = memo(({ onCreateTable }: AiSeedPanelProps = {}) => {
  const [tables, setTables] = useState<string[]>([]);
  const [tablesState, setTablesState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading');
  const [selectedTable, setSelectedTable] = useState('');
  const [columns, setColumns] = useState<SeedColumn[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);

  const [rowCount, setRowCount] = useState(AI_SEED_DEFAULT_ROWS);
  const [hint, setHint] = useState('');

  const [generating, setGenerating] = useState(false);
  const [previewRows, setPreviewRows] = useState<string[][] | null>(null);
  const [genError, setGenError] = useState('');

  const [inserting, setInserting] = useState(false);
  const [insertNote, setInsertNote] = useState<string | null>(null);
  const [insertError, setInsertError] = useState('');

  const pendingRef = useRef<Map<string, Pending>>(new Map());

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

  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (
        msg.type !== 'PS_SITEDB_TABLES_RESPONSE' &&
        msg.type !== 'PS_SITEDB_ROWS_RESPONSE' &&
        msg.type !== 'PS_RES_MUTATE_RESPONSE'
      ) {
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

  const execSql = useCallback(
    async (sql: string, params: (string | number | null)[]): Promise<ExecResult> => {
      let reply: ResMutateResponseMessage;

      try {
        reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'd1',
          action: 'exec',
          input: { sql, params },
          confirm: true,
        })) as ResMutateResponseMessage;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'The database could not be reached.' };
      }

      if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
        return { ok: false, disabled: true, error: DISABLED_404 };
      }

      if (reply.error) {
        return { ok: false, error: reply.error };
      }

      const result = reply.result;

      if (!result) {
        return { ok: false, error: 'No response from the database. Retry in a moment.' };
      }

      if (!result.ok) {
        return { ok: false, error: result.error?.message ?? 'The statement could not run.' };
      }

      const data = (result.data ?? {}) as { rowsWritten?: number };

      return { ok: true, rowsWritten: data.rowsWritten ?? 0 };
    },
    [request],
  );

  const loadTables = useCallback(async () => {
    if (!isEmbedded) {
      setTablesState('error');
      return;
    }

    setTablesState('loading');

    try {
      const reply = (await request({
        type: 'PS_SITEDB_TABLES_REQUEST',
        correlationId: nextCorrelationId(),
      })) as SiteDbTablesResponseMessage;

      if (!reply.ok) {
        if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
          setTablesState('disabled');
          return;
        }

        setTablesState('error');

        return;
      }

      setTables((reply.tables ?? []).map((t) => t.name));
      setTablesState('ready');
    } catch {
      setTablesState('error');
    }
  }, [request]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  /** Read the selected table's columns + types (via a 1-row page) → the insertable SeedColumn set. */
  const loadColumns = useCallback(
    async (table: string) => {
      if (!table) {
        setColumns([]);
        return;
      }

      setColumnsLoading(true);
      setPreviewRows(null);
      setInsertNote(null);

      try {
        const reply = (await request({
          type: 'PS_SITEDB_ROWS_REQUEST',
          correlationId: nextCorrelationId(),
          table,
          limit: 1,
          offset: 0,
        })) as SiteDbRowsResponseMessage;

        const cols = (reply.columns ?? []) as Array<{ name: string; type?: string }>;
        const seedCols: SeedColumn[] = cols
          .filter((c) => !AUTO_COLUMNS.has(c.name.toLowerCase()))
          .map((c) => ({ name: c.name, type: mapSqliteType(c.type) }));
        setColumns(seedCols);
      } catch {
        setColumns([]);
      } finally {
        setColumnsLoading(false);
      }
    },
    [request],
  );

  const onSelectTable = useCallback(
    (t: string) => {
      setSelectedTable(t);
      setGenError('');
      setInsertError('');
      void loadColumns(t);
    },
    [loadColumns],
  );

  /** Ask the platform AI for realistic rows grounded on the table schema, then PREVIEW them (never auto-insert). */
  const generate = useCallback(async () => {
    if (!selectedTable || columns.length === 0 || generating) {
      return;
    }

    setGenerating(true);
    setGenError('');
    setInsertNote(null);
    setPreviewRows(null);

    try {
      const n = clampSeedRowCount(rowCount);
      const system = buildSeedSystemPrompt(selectedTable, columns, n, hint);

      const res = await fetch('/api/llmcall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system,
          message: `Generate ${n} realistic sample row(s) for "${selectedTable}" as a JSON array.`,
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
        throw new Error(data.message ?? 'The assistant did not return data.');
      }

      const rows = extractSeedRows(data.text, columns);

      if (rows.length === 0) {
        throw new Error('The assistant did not return usable rows. Try again or lower the row count.');
      }

      setPreviewRows(rows);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'The assistant could not generate data.');
    } finally {
      setGenerating(false);
    }
  }, [selectedTable, columns, rowCount, hint, generating]);

  /** Insert the previewed rows through the per-site exec rail (chunked, param-bound, confirm-gated). */
  const insertRows = useCallback(async () => {
    if (!previewRows || previewRows.length === 0 || !selectedTable) {
      return;
    }

    setInserting(true);
    setInsertError('');
    setInsertNote(null);

    try {
      const plan = buildInsertPlan(selectedTable, seedColumnsToMappings(columns), previewRows);
      let written = 0;
      const errors: string[] = [];

      for (const batch of plan.batches) {
        const res = await execSql(batch.sql, batch.params);

        if (res.disabled) {
          errors.push('Per-site data was disabled mid-insert.');
          break;
        }

        if (res.ok) {
          written += res.rowsWritten ?? batch.rowCount;
        } else {
          errors.push(res.error ?? 'A batch failed.');
        }
      }

      if (errors.length > 0 && written === 0) {
        setInsertError(errors[0]);
      } else {
        setInsertNote(`Added ${written} row${written === 1 ? '' : 's'} to ${selectedTable}.`);
        setPreviewRows(null);
      }
    } catch (err) {
      setInsertError(err instanceof Error ? err.message : 'The rows could not be inserted.');
    } finally {
      setInserting(false);
    }
  }, [previewRows, selectedTable, columns, execSql]);

  // ── Non-embedded / disabled / empty states ──
  if (!isEmbedded) {
    return (
      <Shell>
        <EmptyNote icon="i-ph:plug" title="Open from the ProjectSites admin">
          AI seeding fills your site&rsquo;s own database, which the admin resolves securely.
        </EmptyNote>
      </Shell>
    );
  }

  if (tablesState === 'disabled') {
    return (
      <Shell>
        <EmptyNote icon="i-ph:database" title="Your database isn't turned on yet">
          Once your site&rsquo;s database is enabled, you can seed tables with sample data here.
        </EmptyNote>
      </Shell>
    );
  }

  if (tablesState === 'ready' && tables.length === 0) {
    return (
      <Shell>
        <EmptyNote icon="i-ph:table" title="Create a table first">
          Add a table in the Schema builder, then come back to fill it with realistic sample data.
        </EmptyNote>
        {/* Never a dead-end: the CTA opens the guided Schema builder so an owner can make their first
            table right here (per embarrassingly-easy-to-use + real-time-data-no-manual-refresh siblings). */}
        {onCreateTable && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={onCreateTable}
              data-testid="seed-empty-create-table"
              className="min-h-[24px] text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-2 bg-bolt-elements-item-contentAccent text-[#061018] hover:shadow-[0_4px_18px_-4px_rgba(0,229,255,0.55)] hover:-translate-y-px motion-reduce:hover:translate-y-0 transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              <div className="i-ph:plus-circle text-base" aria-hidden /> Create Table
            </button>
          </div>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex items-center gap-2 mb-4">
        <div className="i-ph:sparkle-duotone text-lg text-bolt-elements-item-contentAccent" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary tracking-tight">Seed with sample data</h3>
          <p className="text-[11px] text-bolt-elements-textTertiary">
            Let AI fill a table with realistic rows that match your columns — preview before it&rsquo;s added.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {/* Table + row count + hint */}
        <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 space-y-3">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Table</span>
            <select
              value={selectedTable}
              onChange={(e) => onSelectTable(e.target.value)}
              data-testid="seed-table"
              className={SEED_SELECT_CLASS}
            >
              <option value="">Pick a table…</option>
              {tables.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          {selectedTable && (
            <>
              {columnsLoading ? (
                <p className="text-[11px] text-bolt-elements-textTertiary flex items-center gap-1.5">
                  <div className="i-ph:spinner animate-spin" aria-hidden /> Reading columns…
                </p>
              ) : columns.length === 0 ? (
                <p className="text-[11px] text-amber-400">
                  This table has no fillable columns (only auto columns like id/created_at).
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5" data-testid="seed-columns">
                  {columns.map((c) => (
                    <span
                      key={c.name}
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-bolt-elements-background-depth-3 text-bolt-elements-textSecondary"
                    >
                      {c.name}
                      <span className="text-bolt-elements-textTertiary"> · {c.type.toLowerCase()}</span>
                    </span>
                  ))}
                </div>
              )}

              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                  How many rows ({AI_SEED_MIN_ROWS}–{AI_SEED_MAX_ROWS})
                </span>
                <input
                  type="number"
                  min={AI_SEED_MIN_ROWS}
                  max={AI_SEED_MAX_ROWS}
                  value={rowCount}
                  onChange={(e) => setRowCount(clampSeedRowCount(Number(e.target.value)))}
                  data-testid="seed-row-count"
                  className="mt-1 w-24 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-[12px] font-mono tabular-nums text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
                />
              </label>

              <label className="block">
                <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                  Context (optional)
                </span>
                <input
                  type="text"
                  value={hint}
                  onChange={(e) => setHint(e.target.value)}
                  placeholder="e.g. customers of a coffee shop in Seattle"
                  data-testid="seed-hint"
                  className="mt-1 w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent"
                />
              </label>

              <button
                type="button"
                onClick={generate}
                disabled={columns.length === 0 || generating}
                data-testid="seed-generate"
                className={classNames(
                  'min-h-[24px] text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-2 transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                  columns.length === 0 || generating
                    ? 'bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary border border-bolt-elements-borderColor opacity-60 cursor-not-allowed'
                    : 'bg-bolt-elements-item-contentAccent text-[#061018] hover:shadow-[0_4px_18px_-4px_rgba(0,229,255,0.55)] hover:-translate-y-px motion-reduce:hover:translate-y-0 cursor-pointer',
                )}
              >
                {generating ? (
                  <>
                    <div className="i-ph:spinner animate-spin motion-reduce:animate-none" aria-hidden /> Generating…
                  </>
                ) : (
                  <>
                    <div className="i-ph:magic-wand" aria-hidden />
                    <span className="min-w-[12ch] text-center">Generate rows</span>
                  </>
                )}
              </button>
            </>
          )}
        </div>

        {genError && (
          <div className="text-[11px] text-red-400 flex items-center gap-1.5" role="alert">
            <div className="i-ph:warning-circle" aria-hidden /> {genError}
          </div>
        )}

        {/* Preview + confirm insert */}
        {previewRows && previewRows.length > 0 && (
          <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 overflow-hidden">
            <div className="px-3 py-2 border-b border-bolt-elements-borderColor flex items-center justify-between">
              <span className="text-[11px] font-medium text-bolt-elements-textSecondary">
                Preview — {previewRows.length} generated row{previewRows.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="overflow-auto modern-scrollbar max-h-[240px]">
              <table className="w-full text-[11px] tabular-nums" data-testid="seed-preview-table">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th
                        key={c.name}
                        className="sticky top-0 z-10 text-left px-2 py-1 font-mono text-bolt-elements-textTertiary bg-bolt-elements-background-depth-2 border-b border-bolt-elements-borderColor whitespace-nowrap after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-bolt-elements-item-contentAccent/20"
                      >
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, r) => (
                    <tr
                      key={r}
                      className="odd:bg-transparent even:bg-bolt-elements-background-depth-1/40 hover:bg-bolt-elements-item-backgroundAccent/[0.07] transition-colors motion-reduce:transition-none"
                    >
                      {row.map((cell, c) => (
                        <td
                          key={c}
                          className="px-2 py-1 font-mono text-bolt-elements-textSecondary border-b border-bolt-elements-borderColor/40 whitespace-nowrap max-w-[200px] truncate"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 border-t border-bolt-elements-borderColor flex items-center gap-3">
              <button
                type="button"
                onClick={insertRows}
                disabled={inserting}
                data-testid="seed-insert"
                className={classNames(
                  'min-h-[24px] text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-2 transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                  inserting
                    ? 'bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary border border-bolt-elements-borderColor opacity-60 cursor-not-allowed'
                    : 'bg-bolt-elements-item-contentAccent text-[#061018] hover:shadow-[0_4px_18px_-4px_rgba(0,229,255,0.55)] hover:-translate-y-px motion-reduce:hover:translate-y-0 cursor-pointer',
                )}
              >
                {inserting ? (
                  <>
                    <div className="i-ph:spinner animate-spin motion-reduce:animate-none" aria-hidden /> Adding…
                  </>
                ) : (
                  <>
                    <div className="i-ph:check" aria-hidden />
                    <span className="min-w-[10ch] text-center">Add {previewRows.length} rows</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={generate}
                disabled={generating || inserting}
                data-testid="seed-regenerate"
                className="min-h-[24px] text-[12px] px-3 py-1.5 rounded-md border border-bolt-elements-borderColor text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors disabled:opacity-40 flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
              >
                <div className="i-ph:arrow-clockwise" aria-hidden /> Regenerate
              </button>
            </div>
          </div>
        )}

        {insertNote && (
          <div className="text-[11px] text-emerald-400 flex items-center gap-1.5" role="status">
            <div className="i-ph:check-circle" aria-hidden /> {insertNote}
          </div>
        )}
        {insertError && (
          <div className="text-[11px] text-red-400 flex items-center gap-1.5" role="alert">
            <div className="i-ph:warning-circle" aria-hidden /> {insertError}
          </div>
        )}
      </div>
    </Shell>
  );
});

AiSeedPanel.displayName = 'AiSeedPanel';

/** Map a SQLite column type string (from PRAGMA table_info) to a seed storage class. */
function mapSqliteType(type: string | undefined): SeedColumn['type'] {
  const t = (type ?? '').toUpperCase();

  if (t.includes('INT')) {
    return 'INTEGER';
  }

  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM') || t.includes('DEC')) {
    return 'REAL';
  }

  if (t.includes('BLOB')) {
    return 'BLOB';
  }

  return 'TEXT';
}

// ── Local presentational helpers ──────────────────────────────────────────────────────────────────────

const Shell = memo(({ children }: { children: React.ReactNode }) => (
  // `[color-scheme:dark]` forces the native <select> popup, <option> list, and number-input spinners
  // to render dark — otherwise they show the browser's white default and break the black+cyan theme.
  <div className="h-full overflow-auto modern-scrollbar p-4 [color-scheme:dark] bg-bolt-elements-background-depth-1" data-testid="ai-seed-panel">
    <div className="max-w-[720px]">{children}</div>
  </div>
));
Shell.displayName = 'AiSeedPanel.Shell';

/**
 * Branded dark <select> — `appearance-none` removes the OS chevron (a gray glyph) and a cyan SVG
 * chevron is painted via background-image; cyan focus ring; on-brand black+cyan at every state.
 */
const SEED_SELECT_CLASS = classNames(
  'mt-1 w-full appearance-none rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1',
  'px-3 py-1.5 pr-8 text-[12px] text-bolt-elements-textPrimary cursor-pointer transition-colors',
  'hover:border-bolt-elements-item-contentAccent/50',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent focus-visible:border-bolt-elements-item-contentAccent/60',
  "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22%2300e5ff%22%20stroke-width%3D%222.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22/%3E%3C/svg%3E')]",
  'bg-[length:14px] bg-[right_0.6rem_center] bg-no-repeat',
  '[&>option]:bg-bolt-elements-background-depth-1 [&>option]:text-bolt-elements-textPrimary',
);

const EmptyNote = memo(({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) => (
  <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
    <div className={classNames(icon, 'text-4xl text-bolt-elements-item-contentAccent')} aria-hidden />
    <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">{title}</h3>
    <p className="text-[12px] text-bolt-elements-textTertiary max-w-[320px]">{children}</p>
  </div>
));
EmptyNote.displayName = 'AiSeedPanel.EmptyNote';
