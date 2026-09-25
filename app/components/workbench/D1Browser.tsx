/**
 * @module components/workbench/D1Browser
 *
 * D1 resource browser for the Data panel — a read-only inspector for the account's Cloudflare D1
 * databases (resource discovery + Overview metadata), symmetric with the KV/R2/Vectorize/Queues
 * browsers (all target shared platform resources at super-admin scope). Sibling of
 * {@link ./QueuesBrowser}.
 *
 * The embedded editor has no cross-origin session, so — like the other Data tabs — it asks the
 * Angular admin parent to proxy the read via the postMessage bridge:
 *   child → parent  `PS_D1_REQUEST`  { op:'databases'|'overview'|'tables'|'export', databaseId?, … }
 *   parent → child  `PS_D1_RESPONSE` { ok, data?, error? }   (parent calls GET/POST /api/admin/d1/* )
 *
 * The worker enforces super-admin server-side and exposes list + Overview metadata (file size, table
 * count, region, read-replication, version) + a SCHEMA BROWSER (tables/views/indexes/triggers catalog
 * with CREATE SQL; a selected table's columns + primary/foreign keys are parsed CLIENT-SIDE from its
 * CREATE SQL — D1's REST `/query` blocks `PRAGMA` — and its indexes come from the catalog) + a
 * SQL-dump EXPORT (a read of the DB into a .sql dump — no
 * data mutation, but it briefly makes the DB unavailable; the export UI warns + confirms before
 * running, then the client polls the async job to a signed download URL). No query / write / restore.
 * `available:false` / `found:false` distinguish a credential/API failure from a genuinely empty
 * account, surfaced honestly (never a fabricated 0, empty list, or download URL).
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  D1ColumnInfo,
  D1DatabaseSummary,
  D1DatabasesData,
  D1ExportData,
  D1ForeignKey,
  D1OverviewData,
  D1RequestMessage,
  D1ResponseMessage,
  D1SchemaObjectSummary,
  D1TablesData,
} from '~/lib/embed/embedded-mode';
import {
  classifyExportResponse,
  columnNullLabel,
  columnTypeLabel,
  dbLabel,
  filterSchemaObjects,
  formatBytes,
  formatCount,
  isBrowsableObject,
  parseCreateTableColumns,
  parseForeignKeys,
  parseIndexColumns,
  schemaCountsLabel,
  timeTravelInfo,
} from './d1-browser-logic';

/** One index of the selected table (from the catalog objects + its parsed CREATE SQL). */
interface TableIndex {
  name: string;
  sql: string | null;
  unique: boolean;
  columns: string[];
}

export interface D1BrowserProps {
  /** Post a bridge request to the admin parent (DataPanel's existing helper). */
  readonly postToParent: (msg: D1RequestMessage) => void;
}

/** A pending bridge round-trip keyed by correlationId. */
type Pending = (res: D1ResponseMessage) => void;

/** Client-side export poll bounds — up to MAX × DELAY of waiting before surfacing "taking longer". */
const MAX_EXPORT_POLLS = 12;
const EXPORT_POLL_DELAY_MS = 1500;
type ExportUiStatus = 'idle' | 'confirming' | 'running' | 'done' | 'error';

/** Best-effort clipboard copy for identifiers/DDL — silently no-ops where the API is unavailable. */
function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    // clipboard unavailable (permissions / insecure context) — non-critical
  }
}

/**
 * Read-only Cloudflare D1 browser: database list → Overview metadata (size, table count, region,
 * read-replication, version). Self-manages the PS_D1_RESPONSE listener.
 */
export const D1Browser = memo(({ postToParent }: D1BrowserProps) => {
  const pending = useRef<Map<string, Pending>>(new Map());

  const [databases, setDatabases] = useState<D1DatabaseSummary[] | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overview, setOverview] = useState<D1OverviewData | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportUiStatus>('idle');
  const [exportData, setExportData] = useState<D1ExportData | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // Schema browser: object catalog + the currently-inspected object's columns.
  const [tables, setTables] = useState<D1TablesData | null>(null);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tableFilter, setTableFilter] = useState('');
  const [selectedObject, setSelectedObject] = useState<D1SchemaObjectSummary | null>(null);
  const [columns, setColumns] = useState<D1ColumnInfo[]>([]);
  const [foreignKeys, setForeignKeys] = useState<D1ForeignKey[]>([]);
  const [indexes, setIndexes] = useState<TableIndex[]>([]);
  const [ddlOpen, setDdlOpen] = useState(false);

  // Resolve pending bridge requests by correlationId.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const data = e.data as Partial<D1ResponseMessage> | undefined;

      if (!data || data.type !== 'PS_D1_RESPONSE' || typeof data.correlationId !== 'string') {
        return;
      }

      const resolve = pending.current.get(data.correlationId);

      if (resolve) {
        pending.current.delete(data.correlationId);
        resolve(data as D1ResponseMessage);
      }
    };
    window.addEventListener('message', onMessage);

    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** Post a PS_D1_REQUEST and resolve with the matching PS_D1_RESPONSE (30s timeout → error). */
  const request = useCallback(
    (msg: Omit<D1RequestMessage, 'type' | 'correlationId'>): Promise<D1ResponseMessage> => {
      const correlationId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pending.current.delete(correlationId)) {
            resolve({ type: 'PS_D1_RESPONSE', correlationId, ok: false, error: 'Request timed out' });
          }
        }, 30_000);
        pending.current.set(correlationId, (res) => {
          clearTimeout(timer);
          resolve(res);
        });
        postToParent({ type: 'PS_D1_REQUEST', correlationId, ...msg });
      });
    },
    [postToParent],
  );

  // Load databases on mount.
  useEffect(() => {
    let live = true;
    void request({ op: 'databases' }).then((res) => {
      if (!live) {
        return;
      }

      if (res.ok && res.data && 'databases' in res.data) {
        const data = res.data as D1DatabasesData;
        setDatabases(data.databases);
        setUnavailableReason(data.available ? null : (data.reason ?? 'D1 not available'));
      } else {
        setDatabases([]);
        setUnavailableReason(res.error ?? 'D1 manager not available');
      }
    });

    return () => {
      live = false;
    };
  }, [request]);

  const openDatabase = useCallback(
    async (id: string): Promise<void> => {
      setSelectedId(id);
      setOverview(null);
      setDetailError(null);
      setDetailLoading(true);

      // Reset any export flow from the previously-selected database.
      setExportStatus('idle');
      setExportData(null);
      setExportError(null);

      // Reset the schema browser and load this database's catalog in parallel with the overview.
      setTables(null);
      setSelectedObject(null);
      setColumns([]);
      setForeignKeys([]);
      setIndexes([]);
      setTableFilter('');
      setDdlOpen(false);
      setTablesLoading(true);

      const [ovRes, tblRes] = await Promise.all([
        request({ op: 'overview', databaseId: id }),
        request({ op: 'tables', databaseId: id }),
      ]);
      setDetailLoading(false);
      setTablesLoading(false);

      if (ovRes.ok && ovRes.data && 'found' in ovRes.data) {
        setOverview(ovRes.data as D1OverviewData);
      } else {
        setDetailError(ovRes.error ?? 'Could not load database overview');
      }

      if (tblRes.ok && tblRes.data && 'objects' in tblRes.data) {
        setTables(tblRes.data as D1TablesData);
      } else {
        setTables({ found: false, id, objects: [], available: false, reason: tblRes.error ?? 'Schema not available' });
      }
    },
    [request],
  );

  /**
   * Inspect one schema object. Columns are parsed synchronously from the object's CREATE SQL — the CF
   * D1 REST `/query` authorizer blocks `PRAGMA table_info`, so the DDL (already in the catalog) is the
   * column source. A view/virtual/unparseable object yields `[]` → the UI shows its raw DDL instead.
   */
  const selectObject = useCallback(
    (obj: D1SchemaObjectSummary): void => {
      setSelectedObject(obj);
      setDdlOpen(false);

      const browsable = isBrowsableObject(obj.type);
      setColumns(browsable ? parseCreateTableColumns(obj.sql) : []);
      setForeignKeys(browsable ? parseForeignKeys(obj.sql) : []);

      /*
       * Indexes for a TABLE: catalog objects of type 'index' whose tbl_name === this table (the
       * catalog already fetched them; their columns/UNIQUE are parsed from each index's CREATE SQL).
       */
      setIndexes(
        obj.type === 'table'
          ? (tables?.objects ?? [])
              .filter((o) => o.type === 'index' && o.tableName === obj.name)
              .map((o) => ({ name: o.name, sql: o.sql, ...parseIndexColumns(o.sql) }))
          : [],
      );
    },
    [tables],
  );

  /** Column names that are foreign keys — drives the inline "FK" badge in the columns grid. */
  const fkColumns = useMemo(() => new Set(foreignKeys.map((f) => f.column)), [foreignKeys]);

  /** Honest Backups & recovery facts for the selected database (retention + the CLI restore command). */
  const ttInfo = useMemo(() => timeTravelInfo(overview?.name ?? selectedId ?? ''), [overview?.name, selectedId]);

  /**
   * Run (or resume) the SQL-dump export for the selected database, driving the worker's async poll
   * from the client: each round-trip returns complete / processing / error; on `processing` we resume
   * with the bookmark after a short delay, bounded by MAX_EXPORT_POLLS. `classifyExportResponse` is the
   * pure decision core (never treats a URL-less "complete" as success → no fabricated download).
   */
  const runExport = useCallback(async (): Promise<void> => {
    if (!selectedId) {
      return;
    }

    setExportStatus('running');
    setExportData(null);
    setExportError(null);

    let bookmark: string | undefined;

    for (let i = 0; i < MAX_EXPORT_POLLS; i++) {
      const res = await request({ op: 'export', databaseId: selectedId, currentBookmark: bookmark });
      const action = classifyExportResponse(res);

      if (action.kind === 'done') {
        setExportData(action.data);
        setExportStatus('done');

        return;
      }

      if (action.kind === 'error') {
        setExportError(action.message);
        setExportStatus('error');

        return;
      }

      bookmark = action.bookmark; // processing → resume with the bookmark after a short delay
      await new Promise((r) => setTimeout(r, EXPORT_POLL_DELAY_MS));
    }
    setExportError('Export is taking longer than expected — try again in a moment.');
    setExportStatus('error');
  }, [request, selectedId]);

  const isEmpty = useMemo(
    () => databases !== null && databases.length === 0 && !unavailableReason,
    [databases, unavailableReason],
  );

  const filteredObjects = useMemo(
    () => (tables?.objects ? filterSchemaObjects(tables.objects, tableFilter) : []),
    [tables, tableFilter],
  );

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="data-d1-browser" style={{ colorScheme: 'dark' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium text-bolt-elements-textSecondary">D1 databases</span>
        <span
          className="text-[10px] text-bolt-elements-textTertiary"
          title="The worker exposes list + Overview metadata (size, table count, region, read-replication) + a SQL-dump export (briefly makes the DB unavailable; warned + confirmed). No query, write, or restore."
        >
          Overview + SQL export
        </span>
      </div>

      {unavailableReason && (
        <div
          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300"
          data-testid="data-d1-unavailable"
          role="note"
        >
          D1 not available ({unavailableReason}).
        </div>
      )}

      {isEmpty && (
        <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
          No D1 databases on this account.
        </div>
      )}

      {databases && databases.length > 0 && (
        <div className="flex flex-col gap-2 md:flex-row md:items-start">
          {/* Database list */}
          <div className="md:w-1/2 min-w-0">
            <ul className="max-h-80 overflow-auto rounded-md border border-bolt-elements-borderColor/40 modern-scrollbar">
              {databases.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    data-testid="data-d1-database"
                    onClick={() => void openDatabase(d.id)}
                    className={
                      'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] cursor-pointer border-b border-bolt-elements-borderColor/20 ' +
                      (selectedId === d.id
                        ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                        : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-2')
                    }
                  >
                    <span className="truncate font-mono">{dbLabel(d)}</span>
                    {d.version && (
                      <span className="shrink-0 text-[9px] text-bolt-elements-textTertiary">{d.version}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Database overview */}
          <div className="md:w-1/2 min-w-0">
            {!selectedId && (
              <div className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2 px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
                Select a database to view its metadata.
              </div>
            )}
            {selectedId && (
              <div
                className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2"
                data-testid="data-d1-overview"
              >
                <div className="border-b border-bolt-elements-borderColor/30 px-3 py-1.5">
                  <span className="truncate font-mono text-[11px] text-bolt-elements-textPrimary" title={selectedId}>
                    {overview?.name || selectedId}
                  </span>
                </div>
                {detailLoading && <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Loading…</div>}
                {detailError && <div className="px-3 py-3 text-[11px] text-red-400">{detailError}</div>}
                {overview && !detailLoading && !overview.found && (
                  <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Database not found.</div>
                )}
                {overview && !detailLoading && overview.found && (
                  <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 p-3 text-[11px]">
                    <dt className="text-bolt-elements-textTertiary">Size</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">
                      {formatBytes(overview.fileSize ?? null)}
                    </dd>
                    <dt className="text-bolt-elements-textTertiary">Tables</dt>
                    <dd className="font-mono text-bolt-elements-textPrimary tabular-nums">
                      {formatCount(overview.numTables ?? null)}
                    </dd>
                    <dt className="text-bolt-elements-textTertiary">Region</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary">{overview.region ?? '—'}</dd>
                    <dt className="text-bolt-elements-textTertiary">Read replication</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary">{overview.readReplication ?? '—'}</dd>
                    <dt className="text-bolt-elements-textTertiary">Version</dt>
                    <dd className="font-mono text-bolt-elements-textSecondary break-all">{overview.version ?? '—'}</dd>
                    <dt className="text-bolt-elements-textTertiary">Database id</dt>
                    <dd className="font-mono text-bolt-elements-textTertiary break-all text-[10px]">{overview.id}</dd>
                  </dl>
                )}
                {overview && !detailLoading && overview.found && (
                  <div className="border-t border-bolt-elements-borderColor/30 p-3" data-testid="data-d1-export">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-bolt-elements-textSecondary">Export SQL</span>
                      {exportStatus === 'idle' && (
                        <button
                          type="button"
                          data-testid="data-d1-export-start"
                          onClick={() => setExportStatus('confirming')}
                          className="cursor-pointer rounded border border-bolt-elements-borderColor/50 px-2 py-1 text-[10px] text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3"
                        >
                          Export SQL dump…
                        </button>
                      )}
                    </div>

                    {exportStatus === 'confirming' && (
                      <div className="mt-2 flex flex-col gap-2" role="note">
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-300">
                          Exporting produces a <strong>SQL text dump</strong> (not a .sqlite file) and briefly makes
                          this database <strong>unavailable to serve queries</strong> while it runs — export at low
                          traffic. The download link is valid ~1 hour.
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            data-testid="data-d1-export-confirm"
                            onClick={() => void runExport()}
                            className="cursor-pointer rounded border border-amber-500/40 bg-amber-500/20 px-2 py-1 text-[10px] text-amber-200 hover:bg-amber-500/30"
                          >
                            Start export
                          </button>
                          <button
                            type="button"
                            onClick={() => setExportStatus('idle')}
                            className="cursor-pointer rounded border border-bolt-elements-borderColor/50 px-2 py-1 text-[10px] text-bolt-elements-textTertiary hover:bg-bolt-elements-background-depth-3"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {exportStatus === 'running' && (
                      <div
                        className="mt-2 text-[10px] text-bolt-elements-textTertiary"
                        data-testid="data-d1-export-running"
                      >
                        Exporting… the database is briefly unavailable while this runs.
                      </div>
                    )}

                    {exportStatus === 'done' && exportData?.signedUrl && (
                      <div className="mt-2 flex flex-col gap-1.5" data-testid="data-d1-export-done">
                        <a
                          href={exportData.signedUrl}
                          download={exportData.filename || 'd1-export.sql'}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex w-fit cursor-pointer items-center gap-1 rounded border border-green-500/40 bg-green-500/15 px-2 py-1 text-[10px] text-green-300 hover:bg-green-500/25"
                        >
                          ↓ Download {exportData.filename || 'SQL dump'}
                        </a>
                        <span className="text-[9px] text-bolt-elements-textTertiary">
                          Link valid ~1 hour. SQL text dump, not a native .sqlite file.
                        </span>
                        <button
                          type="button"
                          onClick={() => setExportStatus('idle')}
                          className="w-fit cursor-pointer text-[9px] text-bolt-elements-textTertiary underline"
                        >
                          Export again
                        </button>
                      </div>
                    )}

                    {exportStatus === 'error' && (
                      <div className="mt-2 flex flex-col gap-1.5" data-testid="data-d1-export-error">
                        <span className="text-[10px] text-red-400">Export failed: {exportError}</span>
                        <button
                          type="button"
                          onClick={() => setExportStatus('idle')}
                          className="w-fit cursor-pointer text-[9px] text-bolt-elements-textTertiary underline"
                        >
                          Try again
                        </button>
                      </div>
                    )}

                    {/* Point-in-time recovery — Time Travel is CLI-only (no REST API), surfaced honestly
                       (no fake one-click restore button). The SQL-dump export above is the portable backup. */}
                    <div
                      className="mt-3 border-t border-bolt-elements-borderColor/20 pt-2"
                      data-testid="data-d1-timetravel"
                    >
                      <span className="text-[11px] font-medium text-bolt-elements-textSecondary">
                        Point-in-time recovery
                      </span>
                      <p className="mt-1 text-[10px] leading-relaxed text-bolt-elements-textTertiary">
                        {ttInfo.retentionNote}
                      </p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <code
                          className="min-w-0 flex-1 truncate rounded bg-bolt-elements-background-depth-3 px-1.5 py-1 font-mono text-[9px] text-bolt-elements-textSecondary"
                          title={ttInfo.restoreCommand}
                        >
                          {ttInfo.restoreCommand}
                        </code>
                        <button
                          type="button"
                          data-testid="data-d1-timetravel-copy"
                          onClick={() => copyText(ttInfo.restoreCommand)}
                          className="shrink-0 cursor-pointer text-[9px] text-bolt-elements-textTertiary underline hover:text-bolt-elements-textSecondary"
                        >
                          Copy
                        </button>
                      </div>
                      <p className="mt-1 text-[9px] italic leading-relaxed text-bolt-elements-textTertiary">
                        {ttInfo.caveat}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Schema browser — full-width catalog of tables/views/indexes/triggers + per-table columns + DDL */}
      {selectedId && overview?.found && (
        <div
          className="rounded-md border border-bolt-elements-borderColor/40 bg-bolt-elements-background-depth-2"
          data-testid="data-d1-schema"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-bolt-elements-borderColor/30 px-3 py-1.5">
            <span className="text-[11px] font-medium text-bolt-elements-textSecondary">Schema</span>
            {tables?.counts && (
              <span className="text-[10px] text-bolt-elements-textTertiary">{schemaCountsLabel(tables.counts)}</span>
            )}
          </div>

          {tablesLoading && (
            <div className="px-3 py-3 text-[11px] text-bolt-elements-textTertiary">Loading schema…</div>
          )}

          {!tablesLoading && tables && !tables.available && tables.reason && (
            <div
              className="m-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-300"
              role="note"
            >
              Schema not available ({tables.reason}).
            </div>
          )}

          {!tablesLoading && tables?.available && tables.objects.length === 0 && (
            <div className="px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
              No tables in this database.
            </div>
          )}

          {!tablesLoading && tables?.available && tables.objects.length > 0 && (
            <div className="flex flex-col md:flex-row">
              {/* Object list */}
              <div className="min-w-0 border-b border-bolt-elements-borderColor/20 md:w-2/5 md:border-b-0 md:border-r">
                <div className="p-2">
                  <input
                    type="text"
                    value={tableFilter}
                    onChange={(e) => setTableFilter(e.target.value)}
                    placeholder="Search tables, views, indexes…"
                    aria-label="Search schema objects"
                    data-testid="data-d1-schema-search"
                    className="w-full rounded border border-bolt-elements-borderColor/50 bg-bolt-elements-background-depth-3 px-2 py-1 text-[11px] text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:outline-none focus:ring-1 focus:ring-bolt-elements-item-contentAccent/40"
                  />
                </div>
                <ul className="max-h-72 overflow-auto modern-scrollbar">
                  {filteredObjects.length === 0 && (
                    <li className="px-3 py-4 text-center text-[10px] text-bolt-elements-textTertiary">No matches.</li>
                  )}
                  {filteredObjects.map((o) => (
                    <li key={`${o.type}:${o.name}`}>
                      <button
                        type="button"
                        data-testid="data-d1-schema-object"
                        onClick={() => selectObject(o)}
                        className={
                          'flex w-full items-center gap-2 border-b border-bolt-elements-borderColor/10 px-3 py-1 text-left text-[11px] cursor-pointer ' +
                          (selectedObject?.name === o.name && selectedObject?.type === o.type
                            ? 'bg-bolt-elements-item-contentAccent/15 text-bolt-elements-textPrimary'
                            : 'text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3')
                        }
                      >
                        <span
                          className="shrink-0 rounded border border-bolt-elements-borderColor/40 px-1 text-[8px] uppercase tracking-wide text-bolt-elements-textTertiary"
                          title={o.type}
                        >
                          {o.type.slice(0, 3)}
                        </span>
                        <span className="truncate font-mono">{o.name}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Selected object: columns (tables/views) + DDL */}
              <div className="min-w-0 md:w-3/5">
                {!selectedObject && (
                  <div className="px-3 py-6 text-center text-[11px] text-bolt-elements-textTertiary">
                    Select a table to view its columns and DDL.
                  </div>
                )}
                {selectedObject && (
                  <div className="p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-bolt-elements-textPrimary">
                        {selectedObject.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyText(selectedObject.name)}
                        className="shrink-0 cursor-pointer text-[9px] text-bolt-elements-textTertiary underline hover:text-bolt-elements-textSecondary"
                      >
                        Copy name
                      </button>
                    </div>

                    {isBrowsableObject(selectedObject.type) && (
                      <>
                        {columns.length > 0 && (
                          <div data-testid="data-d1-columns">
                            <div className="overflow-auto rounded border border-bolt-elements-borderColor/30">
                              <table className="w-full text-[10px]">
                                <thead>
                                  <tr className="text-bolt-elements-textTertiary">
                                    <th className="px-2 py-1 text-left font-medium">Column</th>
                                    <th className="px-2 py-1 text-left font-medium">Type</th>
                                    <th className="px-2 py-1 text-left font-medium">Null</th>
                                    <th className="px-2 py-1 text-left font-medium">Default</th>
                                    <th className="px-2 py-1 text-left font-medium">Key</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {columns.map((col) => (
                                    <tr key={col.cid} className="border-t border-bolt-elements-borderColor/20">
                                      <td className="px-2 py-1 font-mono text-bolt-elements-textPrimary">{col.name}</td>
                                      <td className="px-2 py-1 font-mono text-bolt-elements-textSecondary">
                                        {columnTypeLabel(col.type)}
                                      </td>
                                      <td className="px-2 py-1 text-bolt-elements-textTertiary">
                                        {columnNullLabel(col)}
                                      </td>
                                      <td className="px-2 py-1 font-mono text-bolt-elements-textTertiary">
                                        {col.defaultValue ?? '—'}
                                      </td>
                                      <td className="px-2 py-1">
                                        <span className="flex flex-wrap gap-1">
                                          {col.pk > 0 && (
                                            <span
                                              className="rounded bg-bolt-elements-item-contentAccent/15 px-1 text-[8px] text-bolt-elements-item-contentAccent"
                                              title={`Primary key (position ${col.pk})`}
                                            >
                                              PK
                                            </span>
                                          )}
                                          {fkColumns.has(col.name) && (
                                            <span
                                              className="rounded bg-purple-500/20 px-1 text-[8px] text-purple-300"
                                              title="Foreign key"
                                            >
                                              FK
                                            </span>
                                          )}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            <div className="mt-1 text-[9px] text-bolt-elements-textTertiary">
                              Parsed from CREATE SQL (Cloudflare&apos;s D1 API doesn&apos;t expose PRAGMA over REST).
                            </div>
                          </div>
                        )}
                        {columns.length === 0 && (
                          <div className="text-[10px] text-bolt-elements-textTertiary">
                            Column details unavailable — see the CREATE SQL below.
                          </div>
                        )}
                      </>
                    )}

                    {indexes.length > 0 && (
                      <div className="mt-3" data-testid="data-d1-indexes">
                        <div className="mb-1 text-[9px] font-medium uppercase tracking-wide text-bolt-elements-textTertiary">
                          Indexes ({indexes.length})
                        </div>
                        <ul className="flex flex-col gap-1">
                          {indexes.map((ix) => (
                            <li
                              key={ix.name}
                              className="flex items-baseline justify-between gap-2 text-[10px]"
                              data-testid="data-d1-index"
                            >
                              <span
                                className="min-w-0 truncate font-mono text-bolt-elements-textSecondary"
                                title={ix.sql ?? ix.name}
                              >
                                {ix.name}
                                {ix.columns.length > 0 && (
                                  <span className="text-bolt-elements-textTertiary"> ({ix.columns.join(', ')})</span>
                                )}
                              </span>
                              {ix.unique && (
                                <span className="shrink-0 rounded bg-bolt-elements-item-contentAccent/15 px-1 text-[8px] text-bolt-elements-item-contentAccent">
                                  UNIQUE
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {foreignKeys.length > 0 && (
                      <div className="mt-3" data-testid="data-d1-fks">
                        <div className="mb-1 text-[9px] font-medium uppercase tracking-wide text-bolt-elements-textTertiary">
                          Foreign keys ({foreignKeys.length})
                        </div>
                        <ul className="flex flex-col gap-1">
                          {foreignKeys.map((fk, i) => (
                            <li
                              key={`${fk.column}-${i}`}
                              className="font-mono text-[10px] text-bolt-elements-textSecondary"
                              data-testid="data-d1-fk"
                            >
                              {fk.column} <span aria-hidden="true">→</span> {fk.refTable}
                              {fk.refColumn ? `.${fk.refColumn}` : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {selectedObject.sql && (
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => setDdlOpen((v) => !v)}
                          data-testid="data-d1-ddl-toggle"
                          className="flex items-center gap-1 cursor-pointer text-[10px] text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
                        >
                          <span aria-hidden="true">{ddlOpen ? '▾' : '▸'}</span> CREATE SQL
                        </button>
                        {ddlOpen && (
                          <div className="mt-1">
                            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-bolt-elements-borderColor/30 bg-bolt-elements-background-depth-3 p-2 font-mono text-[10px] text-bolt-elements-textSecondary">
                              {selectedObject.sql}
                            </pre>
                            <button
                              type="button"
                              onClick={() => copyText(selectedObject.sql ?? '')}
                              className="mt-1 cursor-pointer text-[9px] text-bolt-elements-textTertiary underline hover:text-bolt-elements-textSecondary"
                            >
                              Copy DDL
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
