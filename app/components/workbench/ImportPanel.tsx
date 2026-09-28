/**
 * @file Import — bring a CSV or JSON file INTO the site's OWN per-site Cloudflare D1 (FIRE 6).
 *
 * @remarks
 * The Database tab's "Import" sub-view. An owner drops (or pastes) a CSV/JSON file → we auto-detect its columns +
 * types → they MAP each column to a target column (existing table or a brand-new one) → preview the first rows →
 * and import runs a chunked, PARAMETERIZED batch INSERT through the SAME per-site exec rail the grid + schema
 * builder use (`PS_RES_MUTATE { kind:'d1', action:'exec', input:{ sql, params }, confirm:true }` → the worker's
 * confirm-gated single-statement executor bound to the site's SERVER-RESOLVED D1 id — SECURITY-INVARIANTS
 * INV-1/INV-9). Values are BOUND as `?` params, never concatenated (the safety keystone lives in the pure,
 * unit-tested {@link module:app/components/workbench/data-ingest-logic}); big files chunk under the D1 bound-param
 * cap; rows imported + per-batch errors are reported HONESTLY.
 *
 * Style matches the editor conventions (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*` icons, cinematic
 * black+cyan per docs/ULTIMATE-UI-DIRECTION.md) — mirrors {@link module:app/components/workbench/SchemaBuilder}.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  onParentMessage,
  postToParent,
  type ParentToChildMessage,
  type ResMutateResponseMessage,
  type SiteDbTablesResponseMessage,
} from '~/lib/embed/embedded-mode';
import {
  buildCreateTableForImport,
  buildInsertPlan,
  type ColumnMapping,
  type DetectedType,
  IngestError,
  inferMappings,
  isSafeIdent,
  parseCsv,
  parseJsonRows,
  slugifyColumnName,
  type ParsedGrid,
} from './data-ingest-logic';

// ── Bridge plumbing (mirrors SchemaBuilder's proven correlationId request pattern) ────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const DISABLED_404 = 'Per-site data is not enabled';
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — a generous CSV/JSON; bigger should be a proper migration.
const PREVIEW_ROWS = 8;

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

  return `import_${++correlationCounter}`;
}

/** One exec round-trip result. Never throws. */
interface ExecResult {
  ok: boolean;
  rowsWritten?: number;
  error?: string;
  disabled?: boolean;
}

const TYPE_OPTIONS: ReadonlyArray<{ value: DetectedType; label: string }> = [
  { value: 'TEXT', label: 'Text' },
  { value: 'INTEGER', label: 'Number' },
  { value: 'REAL', label: 'Decimal' },
];

type Stage = 'pick' | 'map';
type TargetMode = 'new' | 'existing';

interface ImportProgress {
  done: number;
  total: number;
  rowsWritten: number;
  errors: string[];
}

export const ImportPanel = memo(() => {
  // ── Source ──
  const [stage, setStage] = useState<Stage>('pick');
  const [fileName, setFileName] = useState('');
  const [rawText, setRawText] = useState('');
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [hasHeader, setHasHeader] = useState(true);
  const [parseError, setParseError] = useState('');

  // ── Target ──
  const [tables, setTables] = useState<string[]>([]);
  const [tablesState, setTablesState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading');
  const [targetMode, setTargetMode] = useState<TargetMode>('new');
  const [newTableName, setNewTableName] = useState('');
  const [existingTable, setExistingTable] = useState('');
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);

  // ── Import run ──
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [importError, setImportError] = useState('');

  const pendingRef = useRef<Map<string, Pending>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  /** Run ONE statement through the per-site exec rail. `confirm` is required for writes. */
  const execSql = useCallback(
    async (sql: string, params: (string | number | null)[], confirm: boolean): Promise<ExecResult> => {
      let reply: ResMutateResponseMessage;

      try {
        reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: 'd1',
          action: 'exec',
          input: { sql, params },
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

  // ── Parse the source text into a grid + default mappings ──
  const grid: ParsedGrid | null = useMemo(() => {
    if (!rawText.trim()) {
      return null;
    }

    try {
      const parsed = format === 'json' ? parseJsonRows(rawText) : parseCsv(rawText, { hasHeader });
      setParseError('');

      return parsed;
    } catch (err) {
      setParseError(err instanceof IngestError ? err.message : 'Could not read the file. Check the format.');
      return null;
    }
  }, [rawText, format, hasHeader]);

  // When a fresh grid parses, seed the default column mappings + a suggested new-table name.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only on a fresh parse; name/file are read once
  useEffect(() => {
    if (grid && grid.headers.length > 0) {
      setMappings(inferMappings(grid));

      if (!newTableName) {
        setNewTableName(fileName ? slugifyColumnName(fileName.replace(/\.[^.]+$/, '')) : 'imported_data');
      }
    }
  }, [grid]);

  const acceptFile = useCallback((file: File) => {
    setParseError('');
    setProgress(null);
    setImportError('');

    if (file.size > MAX_FILE_BYTES) {
      setParseError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB.`);
      return;
    }

    const isJson = /\.json$/i.test(file.name) || file.type === 'application/json';
    setFormat(isJson ? 'json' : 'csv');
    setFileName(file.name);

    const reader = new FileReader();

    reader.onload = () => {
      setRawText(typeof reader.result === 'string' ? reader.result : '');
      setStage('map');
    };
    reader.onerror = () => setParseError('Could not read that file.');
    reader.readAsText(file);
  }, []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];

      if (file) {
        acceptFile(file);
      }
    },
    [acceptFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();

      const file = e.dataTransfer.files?.[0];

      if (file) {
        acceptFile(file);
      }
    },
    [acceptFile],
  );

  const updateMapping = useCallback((index: number, patch: Partial<ColumnMapping>) => {
    setMappings((prev) => prev.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }, []);

  const targetTable = targetMode === 'new' ? newTableName.trim() : existingTable;
  const includedCount = mappings.filter((m) => m.include).length;

  const canImport =
    !!grid &&
    grid.rows.length > 0 &&
    includedCount > 0 &&
    isSafeIdent(targetTable) &&
    (targetMode === 'existing' ? !!existingTable : true) &&
    !importing;

  const runImport = useCallback(async () => {
    if (!grid || !isSafeIdent(targetTable)) {
      setImportError('Choose a valid destination table.');
      return;
    }

    setImporting(true);
    setImportError('');
    setProgress(null);

    try {
      // 1. Create the table first when targeting a NEW one.
      if (targetMode === 'new') {
        const createSql = buildCreateTableForImport(targetTable, mappings);
        const created = await execSql(createSql, [], true);

        if (created.disabled) {
          setImportError('Per-site data is not enabled for this site yet.');
          setImporting(false);

          return;
        }

        if (!created.ok) {
          setImportError(`Could not create the table: ${created.error}`);
          setImporting(false);

          return;
        }
      }

      // 2. Build the chunked, parameterized INSERT plan + run each batch, reporting honestly.
      const plan = buildInsertPlan(targetTable, mappings, grid.rows);
      const prog: ImportProgress = { done: 0, total: plan.batches.length, rowsWritten: 0, errors: [] };
      setProgress({ ...prog });

      for (let i = 0; i < plan.batches.length; i++) {
        const batch = plan.batches[i];
        const res = await execSql(batch.sql, batch.params, true);
        prog.done = i + 1;

        if (res.disabled) {
          prog.errors.push('Per-site data was disabled mid-import.');
          setProgress({ ...prog });
          break;
        }

        if (res.ok) {
          prog.rowsWritten += res.rowsWritten ?? batch.rowCount;
        } else {
          prog.errors.push(`Rows ${i * batch.rowCount + 1}–${i * batch.rowCount + batch.rowCount}: ${res.error}`);
        }

        setProgress({ ...prog });
      }

      // Refresh the table list so a new table shows up immediately.
      void loadTables();
    } catch (err) {
      setImportError(err instanceof IngestError ? err.message : 'The import could not run.');
    } finally {
      setImporting(false);
    }
  }, [grid, targetTable, targetMode, mappings, execSql, loadTables]);

  const reset = useCallback(() => {
    setStage('pick');
    setRawText('');
    setFileName('');
    setMappings([]);
    setProgress(null);
    setImportError('');
    setParseError('');

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // ── Non-embedded / disabled states ──
  if (!isEmbedded) {
    return (
      <PanelShell>
        <EmptyNote icon="i-ph:plug" title="Open from the ProjectSites admin">
          Import runs against your site&rsquo;s own database, which the admin resolves securely.
        </EmptyNote>
      </PanelShell>
    );
  }

  if (tablesState === 'disabled') {
    return (
      <PanelShell>
        <EmptyNote icon="i-ph:database" title="Your database isn't turned on yet">
          Once your site&rsquo;s database is enabled, you can import spreadsheets and JSON here.
        </EmptyNote>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      {/* Header */}
      <div className="flex items-center gap-2 mb-4">
        <div className="i-ph:upload-simple-duotone text-lg text-bolt-elements-item-contentAccent" aria-hidden />
        <div>
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary tracking-tight">Import data</h3>
          <p className="text-[11px] text-bolt-elements-textTertiary">
            Bring a CSV or JSON file into your database — we detect the columns for you.
          </p>
        </div>
        {stage === 'map' && (
          <button
            type="button"
            onClick={reset}
            data-testid="import-reset"
            className="ml-auto min-h-[24px] flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md border border-bolt-elements-borderColor text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:arrow-counter-clockwise" aria-hidden /> Start over
          </button>
        )}
      </div>

      {/* Stage 1 — pick a file */}
      {stage === 'pick' && (
        <div className="space-y-3">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            className="group/drop rounded-xl border-2 border-dashed border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-8 text-center transition-all duration-150 motion-reduce:transition-none hover:border-bolt-elements-item-contentAccent/60 hover:bg-bolt-elements-item-contentAccent/[0.04] hover:shadow-[inset_0_0_40px_-20px_rgba(0,229,255,0.4)]"
            data-testid="import-dropzone"
          >
            <div
              className="i-ph:file-arrow-up-duotone text-4xl text-bolt-elements-item-contentAccent mx-auto mb-3 transition-transform duration-150 motion-safe:group-hover/drop:-translate-y-0.5"
              aria-hidden
            />
            <p className="text-[13px] text-bolt-elements-textSecondary mb-1">Drag a CSV or JSON file here</p>
            <p className="text-[11px] text-bolt-elements-textTertiary mb-4">or</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              data-testid="import-choose-file"
              className="min-h-[24px] text-[13px] font-semibold px-4 py-2 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bolt-elements-background-depth-1 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              Choose a file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,.tsv,text/csv,application/json"
              onChange={onFileChange}
              className="hidden"
              data-testid="import-file-input"
            />
          </div>

          <div className="text-center text-[11px] text-bolt-elements-textTertiary">or paste your data</div>
          <textarea
            value={rawText}
            onChange={(e) => {
              setRawText(e.target.value);
              setFormat(
                e.target.value.trim().startsWith('[') || e.target.value.trim().startsWith('{') ? 'json' : 'csv',
              );
            }}
            onBlur={() => rawText.trim() && setStage('map')}
            placeholder={'name,email\nAlice,alice@example.com\nBob,bob@example.com'}
            rows={5}
            data-testid="import-paste"
            className="w-full rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-[12px] font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent resize-y"
          />
          {rawText.trim() && (
            <button
              type="button"
              onClick={() => setStage('map')}
              data-testid="import-paste-continue"
              className="min-h-[24px] text-[13px] font-semibold px-4 py-2 rounded-lg bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
            >
              Continue
            </button>
          )}
          {parseError && (
            <div className="text-[11px] text-red-400 flex items-center gap-1.5" role="alert">
              <div className="i-ph:warning-circle" aria-hidden /> {parseError}
            </div>
          )}
        </div>
      )}

      {/* Stage 2 — map columns + preview + import */}
      {stage === 'map' && (
        <div className="space-y-4">
          {parseError && (
            <div className="text-[11px] text-red-400 flex items-center gap-1.5" role="alert">
              <div className="i-ph:warning-circle" aria-hidden /> {parseError}
            </div>
          )}

          {grid && grid.headers.length > 0 && (
            <>
              {/* Source summary + format toggle */}
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-bolt-elements-textTertiary">
                <span className="flex items-center gap-1.5">
                  <div className="i-ph:file-text" aria-hidden />
                  {fileName || 'pasted data'}
                </span>
                <span className="font-mono tabular-nums">
                  {grid.rows.length} row{grid.rows.length === 1 ? '' : 's'} · {grid.headers.length} columns
                </span>
                {format === 'csv' && (
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={hasHeader}
                      onChange={(e) => setHasHeader(e.target.checked)}
                      data-testid="import-has-header"
                      className="accent-bolt-elements-item-contentAccent"
                    />
                    First row is a header
                  </label>
                )}
              </div>

              {/* Destination */}
              <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 space-y-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-bolt-elements-textTertiary">
                  Destination
                </div>
                <div className="flex gap-2">
                  <TargetToggle
                    active={targetMode === 'new'}
                    onClick={() => setTargetMode('new')}
                    icon="i-ph:plus-circle"
                    label="New table"
                    testId="import-target-new"
                  />
                  <TargetToggle
                    active={targetMode === 'existing'}
                    onClick={() => setTargetMode('existing')}
                    icon="i-ph:table"
                    label="Existing table"
                    testId="import-target-existing"
                    disabled={tables.length === 0}
                  />
                </div>
                {targetMode === 'new' ? (
                  <input
                    type="text"
                    value={newTableName}
                    onChange={(e) => setNewTableName(e.target.value)}
                    placeholder="new_table_name"
                    data-testid="import-new-table-name"
                    className={classNames(
                      'w-full rounded-md border bg-bolt-elements-background-depth-1 px-3 py-1.5 text-[12px] font-mono text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                      newTableName && !isSafeIdent(newTableName.trim())
                        ? 'border-red-500/60'
                        : 'border-bolt-elements-borderColor',
                    )}
                  />
                ) : (
                  <select
                    value={existingTable}
                    onChange={(e) => setExistingTable(e.target.value)}
                    data-testid="import-existing-table"
                    className="w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-[12px] text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                  >
                    <option value="">Pick a table…</option>
                    {tables.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                )}
                {targetMode === 'new' && newTableName && !isSafeIdent(newTableName.trim()) && (
                  <p className="text-[11px] text-red-400">
                    Use letters, numbers and underscores only (must start with a letter).
                  </p>
                )}
              </div>

              {/* Column mapping */}
              <div className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 overflow-hidden">
                <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 px-3 py-2 border-b border-bolt-elements-borderColor text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">
                  <span>Use</span>
                  <span>From (source)</span>
                  <span>To (column)</span>
                  <span>Type</span>
                </div>
                <div className="max-h-[220px] overflow-auto">
                  {mappings.map((m, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[auto_1fr_1fr_auto] gap-2 items-center px-3 py-1.5 border-b border-bolt-elements-borderColor/40 last:border-0"
                    >
                      <input
                        type="checkbox"
                        checked={m.include}
                        onChange={(e) => updateMapping(i, { include: e.target.checked })}
                        aria-label={`Include ${m.sourceHeader}`}
                        data-testid={`import-col-include-${i}`}
                        className="accent-bolt-elements-item-contentAccent"
                      />
                      <span className="text-[12px] text-bolt-elements-textSecondary truncate" title={m.sourceHeader}>
                        {m.sourceHeader}
                      </span>
                      <input
                        type="text"
                        value={m.targetColumn}
                        onChange={(e) => updateMapping(i, { targetColumn: e.target.value })}
                        disabled={!m.include}
                        data-testid={`import-col-name-${i}`}
                        className={classNames(
                          'rounded border bg-bolt-elements-background-depth-1 px-2 py-1 text-[11px] font-mono text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent disabled:opacity-40',
                          m.include && !isSafeIdent(m.targetColumn)
                            ? 'border-red-500/60'
                            : 'border-bolt-elements-borderColor',
                        )}
                      />
                      <select
                        value={m.type}
                        onChange={(e) => updateMapping(i, { type: e.target.value as DetectedType })}
                        disabled={!m.include}
                        aria-label={`Type for ${m.sourceHeader}`}
                        data-testid={`import-col-type-${i}`}
                        className="rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-1 text-[11px] text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer disabled:opacity-40"
                      >
                        {TYPE_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* Preview */}
              <details className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2">
                <summary className="cursor-pointer px-3 py-2 text-[11px] font-medium text-bolt-elements-textSecondary select-none">
                  Preview first {Math.min(PREVIEW_ROWS, grid.rows.length)} rows
                </summary>
                <div className="overflow-auto modern-scrollbar max-h-[200px] border-t border-bolt-elements-borderColor">
                  <table className="w-full text-[11px] tabular-nums" data-testid="import-preview-table">
                    <thead>
                      <tr>
                        {mappings
                          .filter((m) => m.include)
                          .map((m, i) => (
                            <th
                              key={i}
                              className="sticky top-0 z-10 text-left px-2 py-1 font-mono text-bolt-elements-textTertiary bg-bolt-elements-background-depth-2 border-b border-bolt-elements-borderColor whitespace-nowrap after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-bolt-elements-item-contentAccent/20"
                            >
                              {m.targetColumn}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {grid.rows.slice(0, PREVIEW_ROWS).map((row, r) => (
                        <tr
                          key={r}
                          className="odd:bg-transparent even:bg-bolt-elements-background-depth-1/40 hover:bg-bolt-elements-item-backgroundAccent/[0.07] transition-colors motion-reduce:transition-none"
                        >
                          {mappings
                            .filter((m) => m.include)
                            .map((m, c) => (
                              <td
                                key={c}
                                className="px-2 py-1 font-mono text-bolt-elements-textSecondary border-b border-bolt-elements-borderColor/40 whitespace-nowrap max-w-[160px] truncate"
                              >
                                {row[m.sourceIndex] ?? ''}
                              </td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              {/* Import action + honest progress */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={runImport}
                  disabled={!canImport}
                  data-testid="import-run"
                  className={classNames(
                    'min-h-[24px] text-[13px] font-semibold px-5 py-2 rounded-lg flex items-center gap-2 transition-all duration-150 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent',
                    !canImport
                      ? 'bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary border border-bolt-elements-borderColor opacity-60 cursor-not-allowed'
                      : 'bg-bolt-elements-item-contentAccent text-bolt-elements-background-depth-1 hover:shadow-[0_4px_18px_-4px_rgba(0,229,255,0.55)] hover:-translate-y-px motion-reduce:hover:translate-y-0 cursor-pointer',
                  )}
                >
                  {importing ? (
                    <>
                      <div className="i-ph:spinner animate-spin motion-reduce:animate-none" aria-hidden /> Importing…
                    </>
                  ) : (
                    <>
                      <div className="i-ph:download-simple" aria-hidden />
                      <span className="min-w-[10ch] text-center">Import {grid.rows.length} rows</span>
                    </>
                  )}
                </button>
                {includedCount === 0 && <span className="text-[11px] text-amber-400">Select at least one column.</span>}
              </div>

              {progress && (
                <div
                  className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 space-y-2"
                  role="status"
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-bolt-elements-textSecondary">
                      {progress.done === progress.total
                        ? 'Import complete'
                        : `Importing batch ${progress.done} / ${progress.total}`}
                    </span>
                    <span className="font-mono tabular-nums text-bolt-elements-item-contentAccent">
                      {progress.rowsWritten} rows added
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-bolt-elements-background-depth-3 overflow-hidden">
                    <div
                      className="h-full bg-bolt-elements-item-contentAccent transition-all duration-150"
                      style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }}
                    />
                  </div>
                  {progress.errors.length > 0 && (
                    <ul className="text-[11px] text-red-400 space-y-0.5 max-h-[80px] overflow-auto">
                      {progress.errors.map((e, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <div className="i-ph:warning-circle mt-0.5 shrink-0" aria-hidden /> {e}
                        </li>
                      ))}
                    </ul>
                  )}
                  {progress.done === progress.total && progress.errors.length === 0 && (
                    <p className="text-[11px] text-emerald-400 flex items-center gap-1.5">
                      <div className="i-ph:check-circle" aria-hidden /> All {progress.rowsWritten} rows imported into{' '}
                      <span className="font-mono">{targetTable}</span>.
                    </p>
                  )}
                </div>
              )}

              {importError && (
                <div className="text-[11px] text-red-400 flex items-center gap-1.5" role="alert">
                  <div className="i-ph:warning-circle" aria-hidden /> {importError}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </PanelShell>
  );
});

ImportPanel.displayName = 'ImportPanel';

// ── Small presentational helpers (kept local — mirror SchemaBuilder's inline sub-components) ───────────

const PanelShell = memo(({ children }: { children: React.ReactNode }) => (
  <div className="h-full overflow-auto p-4" data-testid="import-panel">
    <div className="max-w-[720px]">{children}</div>
  </div>
));
PanelShell.displayName = 'ImportPanel.Shell';

const EmptyNote = memo(({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) => (
  <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
    <div className={classNames(icon, 'text-4xl text-bolt-elements-item-contentAccent')} aria-hidden />
    <h3 className="text-sm font-semibold text-bolt-elements-textPrimary">{title}</h3>
    <p className="text-[12px] text-bolt-elements-textTertiary max-w-[320px]">{children}</p>
  </div>
));
EmptyNote.displayName = 'ImportPanel.EmptyNote';

const TargetToggle = memo(
  ({
    active,
    onClick,
    icon,
    label,
    testId,
    disabled,
  }: {
    active: boolean;
    onClick: () => void;
    icon: string;
    label: string;
    testId: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={classNames(
        'min-h-[24px] flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
        active
          ? 'border-bolt-elements-item-contentAccent/60 bg-bolt-elements-item-backgroundAccent/10 text-bolt-elements-item-contentAccent'
          : 'border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary',
      )}
    >
      <div className={classNames(icon, 'text-sm')} aria-hidden />
      {label}
    </button>
  ),
);
TargetToggle.displayName = 'ImportPanel.TargetToggle';
