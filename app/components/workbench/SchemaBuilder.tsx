/**
 * @file Schema Builder — a guided, visual DDL builder for a site's OWN dedicated Cloudflare D1.
 *
 * @remarks
 * The Database tab's "Schema" sub-view. An owner shapes their OWN per-site D1 with forms instead of SQL:
 *   • Create table   — a name + typed column rows (type · PK · NOT NULL · UNIQUE · DEFAULT)
 *   • Add column     — pick a table, define one column
 *   • Rename column  — pick a table + column → new name
 *   • Drop column    — pick a table + column (DESTRUCTIVE → type-to-confirm)
 *   • Create index   — pick a table + columns (+ UNIQUE + optional name)
 *
 * Every action compiles to a SAFE statement via the pure {@link module:app/components/workbench/schema-builder-logic}
 * planners (which reuse the proven `schema-ddl` generators — double-quoted identifiers, validated names) and runs
 * through the SAME per-site exec rail the grid + SQL navigator use: `PS_RES_MUTATE { kind:'d1', action:'exec' }`
 * → the worker's confirm-gated single-statement executor bound to the site's SERVER-RESOLVED D1 id (this panel
 * never sees a DB id it could tamper with — SECURITY-INVARIANTS INV-1). The SQL is ALWAYS previewed before it
 * runs; a DESTRUCTIVE statement (DROP column) is type-to-confirmed AND sent with `confirm:true`. When the
 * `per_site_data` flag is dark the rail 404s → an honest "not enabled" state, never a scary error (INV-3).
 *
 * Style matches the editor conventions exactly (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*` icons) —
 * mirrors {@link module:app/components/workbench/SiteTablesPanel}.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { PanelShell, PanelHeader } from './panel';
import {
  isEmbedded,
  onParentMessage,
  postToParent,
  type ParentToChildMessage,
  type ResMutateResponseMessage,
  type SiteDbTablesResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  COLUMN_TYPE_OPTIONS,
  planAddColumn,
  planCreateIndex,
  planCreateTable,
  planDropColumn,
  planRenameColumn,
  SchemaPlanError,
  suggestIndexName,
  type ColumnDraft,
  type SchemaPlan,
} from './schema-builder-logic';

// ── Bridge plumbing (mirrors SiteTablesPanel's proven correlationId request pattern) ─────────────────

const REQUEST_TIMEOUT_MS = 20_000;
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

  return `schema_${++correlationCounter}`;
}

/** One exec round-trip result (rowsWritten for a DDL write; ok:false + error otherwise). Never throws. */
interface ExecResult {
  ok: boolean;
  rowsWritten?: number;
  error?: string;
  disabled?: boolean;
}

// ── The five guided operations ────────────────────────────────────────────────

type Op = 'createTable' | 'addColumn' | 'renameColumn' | 'dropColumn' | 'createIndex';

const OPS: ReadonlyArray<{ value: Op; label: string; icon: string }> = [
  { value: 'createTable', label: 'New table', icon: 'i-ph:table-duotone' },
  { value: 'addColumn', label: 'Add column', icon: 'i-ph:plus-circle-duotone' },
  { value: 'renameColumn', label: 'Rename column', icon: 'i-ph:pencil-duotone' },
  { value: 'dropColumn', label: 'Drop column', icon: 'i-ph:trash-duotone' },
  { value: 'createIndex', label: 'Create index', icon: 'i-ph:lightning-duotone' },
];

const EMPTY_COLUMN: ColumnDraft = { name: '', type: 'TEXT' };

export interface SchemaBuilderProps {
  /**
   * Optional: open straight to "New table" (the empty-state launchpad passes this so the owner's first click
   * lands in the builder, per the embarrassingly-easy bar). Defaults to `createTable`.
   */
  initialOp?: Op;

  /** Optional: called after a successful apply so the parent (Table-view) can refresh its table list. */
  onApplied?: () => void;
}

/**
 * The Schema Builder panel. Loads the site's table list once (for the pickers), renders the active operation's
 * form, previews the compiled SQL, and applies it through the per-site exec rail.
 */
export const SchemaBuilder = memo(({ initialOp = 'createTable', onApplied }: SchemaBuilderProps) => {
  const [op, setOp] = useState<Op>(initialOp);

  // Table list (for the add/rename/drop/index pickers).
  const [tables, setTables] = useState<string[]>([]);
  const [tablesState, setTablesState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading');
  const [tablesError, setTablesError] = useState('');

  // Column list for the selected table (rename/drop/index pickers) — loaded on table select.
  const [tableColumns, setTableColumns] = useState<string[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);

  // ── Create-table form ──
  const [newTableName, setNewTableName] = useState('');
  const [newCols, setNewCols] = useState<ColumnDraft[]>([{ name: 'id', type: 'INTEGER', primaryKey: true }]);

  // ── Add-column form ──
  const [addTable, setAddTable] = useState('');
  const [addCol, setAddCol] = useState<ColumnDraft>({ ...EMPTY_COLUMN });

  // ── Rename-column form ──
  const [renameTable, setRenameTable] = useState('');
  const [renameFrom, setRenameFrom] = useState('');
  const [renameTo, setRenameTo] = useState('');

  // ── Drop-column form ──
  const [dropTable, setDropTable] = useState('');
  const [dropCol, setDropCol] = useState('');
  const [dropConfirmText, setDropConfirmText] = useState('');

  // ── Create-index form ──
  const [indexTable, setIndexTable] = useState('');
  const [indexCols, setIndexCols] = useState<string[]>([]);
  const [indexUnique, setIndexUnique] = useState(false);
  const [indexName, setIndexName] = useState('');

  // ── Apply state ──
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [applyOk, setApplyOk] = useState<string | null>(null);

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
      if (msg.type !== 'PS_SITEDB_TABLES_RESPONSE' && msg.type !== 'PS_RES_MUTATE_RESPONSE') {
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

  /** Run ONE statement through the per-site exec rail. `confirm` is required for destructive DDL. */
  const execSql = useCallback(
    async (sql: string, confirm: boolean): Promise<ExecResult> => {
      let reply: ResMutateResponseMessage;

      try {
        reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'd1',
          action: 'exec',
          input: { sql, params: [] },
          confirm,
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
    setTablesState('loading');

    if (!isEmbedded) {
      setTablesState('error');
      setTablesError('Open this from the ProjectSites admin to build your schema.');

      return;
    }

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
        setTablesError(reply.error || 'Could not load your tables.');

        return;
      }

      setTables((reply.tables ?? []).map((t) => t.name));
      setTablesState('ready');
    } catch (err) {
      setTablesState('error');
      setTablesError(err instanceof Error ? err.message : 'Could not load your tables.');
    }
  }, [request]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  /** Read one table's column names (for the rename/drop/index pickers) via a read-only exec (no confirm). */
  const loadColumns = useCallback(
    async (table: string) => {
      if (!table) {
        setTableColumns([]);
        return;
      }

      setColumnsLoading(true);

      try {
        // pragma_table_info as a table-function → column names. Table name binds as a VALUE (D1 supports it).
        const reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'd1',
          action: 'exec',
          input: { sql: 'SELECT name FROM pragma_table_info(?1)', params: [table] },
          confirm: false,
        })) as ResMutateResponseMessage;
        const rows = (reply.result?.data as { rows?: Array<{ name?: string }> } | undefined)?.rows ?? [];
        setTableColumns(rows.map((r) => String(r.name ?? '')).filter(Boolean));
      } catch {
        setTableColumns([]);
      } finally {
        setColumnsLoading(false);
      }
    },
    [request],
  );

  // When a picker's table changes, load its columns.
  const pickerTable =
    op === 'addColumn'
      ? addTable
      : op === 'renameColumn'
        ? renameTable
        : op === 'dropColumn'
          ? dropTable
          : op === 'createIndex'
            ? indexTable
            : '';
  useEffect(() => {
    if (op !== 'createTable' && pickerTable) {
      void loadColumns(pickerTable);
    } else {
      setTableColumns([]);
    }
  }, [op, pickerTable, loadColumns]);

  // Reset transient apply feedback whenever the operation or its key inputs change.
  useEffect(() => {
    setApplyError('');
    setApplyOk(null);
  }, [op, newTableName, addTable, renameTable, dropTable, indexTable]);

  // ── Compile the active form into a plan (memoized so the SQL preview is live) ──
  const compiled = useMemo((): { plan: SchemaPlan | null; error: string | null } => {
    try {
      switch (op) {
        case 'createTable':
          return { plan: planCreateTable(newTableName, newCols, { requirePk: false }), error: null };
        case 'addColumn':
          if (!addTable) {
            return { plan: null, error: 'Pick a table.' };
          }

          return { plan: planAddColumn(addTable, addCol), error: null };
        case 'renameColumn':
          if (!renameTable) {
            return { plan: null, error: 'Pick a table.' };
          }

          return { plan: planRenameColumn(renameTable, renameFrom, renameTo), error: null };
        case 'dropColumn':
          if (!dropTable) {
            return { plan: null, error: 'Pick a table.' };
          }

          return { plan: planDropColumn(dropTable, dropCol), error: null };
        case 'createIndex':
          if (!indexTable) {
            return { plan: null, error: 'Pick a table.' };
          }

          return {
            plan: planCreateIndex(indexTable, indexCols, { name: indexName, unique: indexUnique }),
            error: null,
          };
        default:
          return { plan: null, error: null };
      }
    } catch (err) {
      return { plan: null, error: err instanceof SchemaPlanError ? err.message : 'Could not build the statement.' };
    }
  }, [
    op,
    newTableName,
    newCols,
    addTable,
    addCol,
    renameTable,
    renameFrom,
    renameTo,
    dropTable,
    dropCol,
    indexTable,
    indexCols,
    indexName,
    indexUnique,
  ]);

  const isDestructive = useMemo(() => (compiled.plan?.statements ?? []).some((s) => s.destructive), [compiled.plan]);

  // A destructive op requires the owner to type the exact "drop" phrase before Apply enables.
  const destructiveGateOk = !isDestructive || dropConfirmText.trim().toUpperCase() === 'DROP';

  const apply = useCallback(async () => {
    if (!compiled.plan) {
      return;
    }

    setApplying(true);
    setApplyError('');
    setApplyOk(null);

    let lastSummary = '';

    for (const stmt of compiled.plan.statements) {
      const res = await execSql(stmt.sql, stmt.destructive);

      if (!res.ok) {
        setApplying(false);
        setApplyError(
          res.disabled ? 'Your site database isn’t enabled yet.' : res.error || 'The change could not be applied.',
        );

        return;
      }

      lastSummary = stmt.summary;
    }

    setApplying(false);
    setApplyOk(lastSummary || 'Change applied');
    setDropConfirmText('');

    // Refresh the table list + notify the parent so the grid reflects the new shape.
    void loadTables();

    if (pickerTable) {
      void loadColumns(pickerTable);
    }

    onApplied?.();
  }, [compiled.plan, execSql, loadTables, loadColumns, pickerTable, onApplied]);

  // ── Render ──
  return (
    <PanelShell testId="schema-builder">
      <Header />

      {tablesState === 'disabled' ? (
        <DisabledState />
      ) : (
        <div className="flex-1 overflow-auto modern-scrollbar">
          {/* Operation picker */}
          <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b border-bolt-elements-borderColor">
            {OPS.map((o) => {
              const active = op === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setOp(o.value)}
                  data-testid={`schema-op-${o.value}`}
                  aria-pressed={active}
                  className={classNames(
                    'min-h-[24px] flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                    active
                      ? 'bg-bolt-elements-item-contentAccent text-[#061018] shadow-[0_2px_10px_-2px_rgba(0,229,255,0.5)]'
                      : 'text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3',
                  )}
                >
                  <div className={classNames(o.icon, 'text-sm')} aria-hidden />
                  {o.label}
                </button>
              );
            })}
          </div>

          <div className="p-4 space-y-4 max-w-[640px]">
            {tablesState === 'error' && (
              <div className="text-[11px] text-red-400 flex items-center gap-1.5" role="alert">
                <div className="i-ph:warning-circle" /> {tablesError}
              </div>
            )}

            {/* Active operation form */}
            {op === 'createTable' && (
              <CreateTableForm name={newTableName} onName={setNewTableName} columns={newCols} onColumns={setNewCols} />
            )}

            {op === 'addColumn' && (
              <div className="space-y-3">
                <TablePicker
                  label="Table"
                  tables={tables}
                  value={addTable}
                  onChange={setAddTable}
                  loading={tablesState === 'loading'}
                />
                {addTable && <ColumnFields draft={addCol} onChange={setAddCol} idPrefix="add" />}
              </div>
            )}

            {op === 'renameColumn' && (
              <div className="space-y-3">
                <TablePicker
                  label="Table"
                  tables={tables}
                  value={renameTable}
                  onChange={(t) => {
                    setRenameTable(t);
                    setRenameFrom('');
                  }}
                  loading={tablesState === 'loading'}
                />
                {renameTable && (
                  <>
                    <ColumnPicker
                      label="Column to rename"
                      columns={tableColumns}
                      value={renameFrom}
                      onChange={setRenameFrom}
                      loading={columnsLoading}
                    />
                    <TextField
                      label="New name"
                      value={renameTo}
                      onChange={setRenameTo}
                      placeholder="new_column_name"
                      testId="schema-rename-to"
                    />
                  </>
                )}
              </div>
            )}

            {op === 'dropColumn' && (
              <div className="space-y-3">
                <TablePicker
                  label="Table"
                  tables={tables}
                  value={dropTable}
                  onChange={(t) => {
                    setDropTable(t);
                    setDropCol('');
                  }}
                  loading={tablesState === 'loading'}
                />
                {dropTable && (
                  <ColumnPicker
                    label="Column to drop"
                    columns={tableColumns}
                    value={dropCol}
                    onChange={setDropCol}
                    loading={columnsLoading}
                  />
                )}
              </div>
            )}

            {op === 'createIndex' && (
              <div className="space-y-3">
                <TablePicker
                  label="Table"
                  tables={tables}
                  value={indexTable}
                  onChange={(t) => {
                    setIndexTable(t);
                    setIndexCols([]);
                    setIndexName('');
                  }}
                  loading={tablesState === 'loading'}
                />
                {indexTable && (
                  <>
                    <MultiColumnPicker
                      columns={tableColumns}
                      selected={indexCols}
                      onChange={(cols) => {
                        setIndexCols(cols);

                        if (!indexName) {
                          setIndexName(suggestIndexName(indexTable, cols));
                        }
                      }}
                      loading={columnsLoading}
                    />
                    <label className="flex items-center gap-2 text-[12px] text-bolt-elements-textSecondary cursor-pointer">
                      <input
                        type="checkbox"
                        checked={indexUnique}
                        onChange={(e) => setIndexUnique(e.target.checked)}
                        data-testid="schema-index-unique"
                        className="h-3.5 w-3.5 accent-[color:var(--ps-accent)]"
                      />
                      Unique index (values must not repeat)
                    </label>
                    <TextField
                      label="Index name (optional)"
                      value={indexName}
                      onChange={setIndexName}
                      placeholder={suggestIndexName(indexTable, indexCols)}
                      testId="schema-index-name"
                    />
                  </>
                )}
              </div>
            )}

            {/* SQL preview */}
            {(compiled.plan || compiled.error) && (
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary flex items-center gap-1.5">
                  <div className="i-ph:code" /> SQL preview
                </div>
                {compiled.error ? (
                  <div
                    className="text-[11px] text-amber-400 flex items-center gap-1.5"
                    role="status"
                    data-testid="schema-preview-hint"
                  >
                    <div className="i-ph:info" /> {compiled.error}
                  </div>
                ) : (
                  <pre
                    className="overflow-x-auto modern-scrollbar rounded-lg bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor border-l-2 border-l-bolt-elements-item-contentAccent/50 px-3 py-2 text-[11px] font-mono text-bolt-elements-textSecondary whitespace-pre-wrap"
                    data-testid="schema-sql-preview"
                  >
                    {compiled.plan!.statements.map((s) => `${s.sql};`).join('\n')}
                  </pre>
                )}
              </div>
            )}

            {/* Destructive gate */}
            {isDestructive && compiled.plan && (
              <div
                className="rounded-lg border border-red-400/40 bg-red-400/5 p-3 space-y-2"
                data-testid="schema-destructive-gate"
              >
                <p className="text-[11px] text-red-300 flex items-start gap-1.5">
                  <span className="i-ph:warning-octagon mt-0.5 shrink-0" aria-hidden="true" />
                  <span>
                    This permanently removes the column and its data. Type{' '}
                    <span className="font-mono font-semibold">DROP</span> to confirm.
                  </span>
                </p>
                <input
                  type="text"
                  value={dropConfirmText}
                  onChange={(e) => setDropConfirmText(e.target.value)}
                  placeholder="DROP"
                  aria-label="Type DROP to confirm"
                  data-testid="schema-drop-confirm"
                  className="w-full rounded border border-red-400/40 bg-bolt-elements-background-depth-2 px-2 py-1 text-[12px] font-mono text-bolt-elements-textPrimary focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                />
              </div>
            )}

            {/* Apply + feedback */}
            <div className="flex items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => void apply()}
                disabled={!compiled.plan || applying || !destructiveGateOk}
                data-testid="schema-apply"
                className={classNames(
                  'min-h-[24px] text-[13px] font-semibold px-4 py-2 rounded-lg flex items-center gap-2 transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent',
                  !compiled.plan || applying || !destructiveGateOk
                    ? 'bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary border border-bolt-elements-borderColor opacity-60 cursor-not-allowed'
                    : isDestructive
                      ? 'bg-red-500 text-white hover:shadow-[0_4px_18px_-4px_rgba(239,68,68,0.6)] hover:-translate-y-px motion-reduce:hover:translate-y-0 cursor-pointer'
                      : 'bg-bolt-elements-item-contentAccent text-[#061018] hover:shadow-[0_4px_18px_-4px_rgba(0,229,255,0.55)] hover:-translate-y-px motion-reduce:hover:translate-y-0 cursor-pointer',
                )}
              >
                <div
                  className={
                    applying
                      ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none'
                      : isDestructive
                        ? 'i-ph:trash'
                        : 'i-ph:check-bold'
                  }
                />
                <span className="min-w-[7ch] text-center">
                  {applying ? 'Applying…' : isDestructive ? 'Drop column' : 'Apply change'}
                </span>
              </button>

              {applyOk && (
                <span
                  className="text-[11px] text-emerald-400 flex items-center gap-1.5"
                  role="status"
                  data-testid="schema-apply-ok"
                >
                  <div className="i-ph:check-circle" /> {applyOk}
                </span>
              )}
              {applyError && (
                <span
                  className="text-[11px] text-red-400 flex items-center gap-1.5"
                  role="alert"
                  data-testid="schema-apply-error"
                >
                  <div className="i-ph:warning-circle" /> {applyError}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </PanelShell>
  );
});

SchemaBuilder.displayName = 'SchemaBuilder';

// ── Header ─────────────────────────────────────────────────────────────────

const Header = memo(() => (
  <PanelHeader
    icon="i-ph:blueprint-duotone"
    title="Schema builder"
    subtitle="Shape your database — no SQL required · your database"
  />
));

Header.displayName = 'SchemaBuilder.Header';

const DisabledState = memo(() => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="schema-disabled">
    <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
    <p className="text-sm font-medium text-bolt-elements-textSecondary">Per-site data isn't enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">
      Once your site's own database is turned on, you can build tables and columns here — nothing to set up.
    </p>
  </div>
));

DisabledState.displayName = 'SchemaBuilder.DisabledState';

// ── Reusable field primitives ────────────────────────────────────────────────

const FIELD_LABEL = 'block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary mb-1';
const FIELD_INPUT =
  'w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-2 py-1.5 text-[12px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent';

const TextField = memo(
  ({
    label,
    value,
    onChange,
    placeholder,
    testId,
  }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    testId: string;
  }) => (
    <div>
      <label className={FIELD_LABEL}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        data-testid={testId}
        className={classNames(FIELD_INPUT, 'font-mono')}
      />
    </div>
  ),
);
TextField.displayName = 'SchemaBuilder.TextField';

const TablePicker = memo(
  ({
    label,
    tables,
    value,
    onChange,
    loading,
  }: {
    label: string;
    tables: string[];
    value: string;
    onChange: (v: string) => void;
    loading: boolean;
  }) => (
    <div>
      <label className={FIELD_LABEL}>{label}</label>
      {loading ? (
        <div className="text-[11px] text-bolt-elements-textTertiary flex items-center gap-1.5">
          <div className="i-ph:circle-notch animate-spin" /> Loading tables…
        </div>
      ) : tables.length === 0 ? (
        <p className="text-[11px] text-bolt-elements-textTertiary">No tables yet — create one first.</p>
      ) : (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid="schema-table-picker"
          className={classNames(FIELD_INPUT, 'font-mono cursor-pointer')}
        >
          <option value="">Choose a table…</option>
          {tables.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
    </div>
  ),
);
TablePicker.displayName = 'SchemaBuilder.TablePicker';

const ColumnPicker = memo(
  ({
    label,
    columns,
    value,
    onChange,
    loading,
  }: {
    label: string;
    columns: string[];
    value: string;
    onChange: (v: string) => void;
    loading: boolean;
  }) => (
    <div>
      <label className={FIELD_LABEL}>{label}</label>
      {loading ? (
        <div className="text-[11px] text-bolt-elements-textTertiary flex items-center gap-1.5">
          <div className="i-ph:circle-notch animate-spin" /> Loading columns…
        </div>
      ) : (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid="schema-column-picker"
          className={classNames(FIELD_INPUT, 'font-mono cursor-pointer')}
        >
          <option value="">Choose a column…</option>
          {columns.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )}
    </div>
  ),
);
ColumnPicker.displayName = 'SchemaBuilder.ColumnPicker';

const MultiColumnPicker = memo(
  ({
    columns,
    selected,
    onChange,
    loading,
  }: {
    columns: string[];
    selected: string[];
    onChange: (cols: string[]) => void;
    loading: boolean;
  }) => {
    const toggle = (c: string) => {
      onChange(selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c]);
    };
    return (
      <div>
        <label className={FIELD_LABEL}>Columns to index (in order)</label>
        {loading ? (
          <div className="text-[11px] text-bolt-elements-textTertiary flex items-center gap-1.5">
            <div className="i-ph:circle-notch animate-spin" /> Loading columns…
          </div>
        ) : columns.length === 0 ? (
          <p className="text-[11px] text-bolt-elements-textTertiary">No columns found.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5" data-testid="schema-index-columns">
            {columns.map((c) => {
              const on = selected.includes(c);
              const order = selected.indexOf(c) + 1;

              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => toggle(c)}
                  aria-pressed={on}
                  className={classNames(
                    'min-h-[24px] flex items-center gap-1 px-2 py-1 text-[11px] font-mono rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer',
                    on
                      ? 'border-bolt-elements-item-contentAccent bg-bolt-elements-item-backgroundAccent/15 text-bolt-elements-item-contentAccent'
                      : 'border-bolt-elements-borderColor text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
                  )}
                >
                  {on && <span className="text-[9px] font-bold">{order}</span>}
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  },
);
MultiColumnPicker.displayName = 'SchemaBuilder.MultiColumnPicker';

// ── Column definition fields (type · PK · NOT NULL · UNIQUE · DEFAULT) ──────────

const ColumnFields = memo(
  ({ draft, onChange, idPrefix }: { draft: ColumnDraft; onChange: (d: ColumnDraft) => void; idPrefix: string }) => (
    <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={FIELD_LABEL}>Column name</label>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="column_name"
            spellCheck={false}
            data-testid={`${idPrefix}-col-name`}
            className={classNames(FIELD_INPUT, 'font-mono')}
          />
        </div>
        <div>
          <label className={FIELD_LABEL}>Type</label>
          <select
            value={draft.type}
            onChange={(e) => onChange({ ...draft, type: e.target.value as ColumnDraft['type'] })}
            data-testid={`${idPrefix}-col-type`}
            className={classNames(FIELD_INPUT, 'cursor-pointer')}
          >
            {COLUMN_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Flag
          label="Primary key"
          checked={!!draft.primaryKey}
          onChange={(v) => onChange({ ...draft, primaryKey: v })}
          testId={`${idPrefix}-col-pk`}
        />
        <Flag
          label="Required (NOT NULL)"
          checked={!!draft.notNull}
          onChange={(v) => onChange({ ...draft, notNull: v })}
          testId={`${idPrefix}-col-notnull`}
        />
        <Flag
          label="Unique"
          checked={!!draft.unique}
          onChange={(v) => onChange({ ...draft, unique: v })}
          testId={`${idPrefix}-col-unique`}
        />
      </div>
      <div>
        <label className={FIELD_LABEL}>Default value (optional)</label>
        <input
          type="text"
          value={draft.defaultValue ?? ''}
          onChange={(e) => onChange({ ...draft, defaultValue: e.target.value })}
          placeholder="e.g. 0, CURRENT_TIMESTAMP, or plain text"
          spellCheck={false}
          data-testid={`${idPrefix}-col-default`}
          className={classNames(FIELD_INPUT, 'font-mono')}
        />
      </div>
    </div>
  ),
);
ColumnFields.displayName = 'SchemaBuilder.ColumnFields';

const Flag = memo(
  ({
    label,
    checked,
    onChange,
    testId,
  }: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    testId: string;
  }) => (
    <label className="flex items-center gap-1.5 text-[11px] text-bolt-elements-textSecondary cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="h-3.5 w-3.5 accent-[color:var(--ps-accent)]"
      />
      {label}
    </label>
  ),
);
Flag.displayName = 'SchemaBuilder.Flag';

// ── Create-table form (name + N column rows) ────────────────────────────────────

const CreateTableForm = memo(
  ({
    name,
    onName,
    columns,
    onColumns,
  }: {
    name: string;
    onName: (v: string) => void;
    columns: ColumnDraft[];
    onColumns: (c: ColumnDraft[]) => void;
  }) => {
    const updateCol = (idx: number, next: ColumnDraft) => onColumns(columns.map((c, i) => (i === idx ? next : c)));
    const removeCol = (idx: number) => onColumns(columns.filter((_, i) => i !== idx));
    const addCol = () => onColumns([...columns, { name: '', type: 'TEXT' }]);

    return (
      <div className="space-y-3">
        <TextField
          label="Table name"
          value={name}
          onChange={onName}
          placeholder="customers"
          testId="schema-new-table-name"
        />
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Columns</div>
          {columns.map((col, idx) => (
            <div key={idx} className="relative" data-testid="schema-new-col-row">
              <ColumnFields draft={col} onChange={(next) => updateCol(idx, next)} idPrefix={`new-${idx}`} />
              {columns.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeCol(idx)}
                  aria-label={`Remove column ${idx + 1}`}
                  data-testid={`schema-remove-col-${idx}`}
                  className="absolute top-2 right-2 min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer"
                >
                  <div className="i-ph:x text-sm" />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={addCol}
            data-testid="schema-add-col"
            className="min-h-[24px] text-[11px] font-medium px-2.5 py-1 rounded border border-dashed border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-item-contentAccent hover:border-bolt-elements-item-contentAccent/60 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:plus" /> Add column
          </button>
        </div>
      </div>
    );
  },
);
CreateTableForm.displayName = 'SchemaBuilder.CreateTableForm';
