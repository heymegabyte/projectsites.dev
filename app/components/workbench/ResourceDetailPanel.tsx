/**
 * @file Resource Detail — the editor "Resources" tab's GENERIC per-kind drill-in.
 *
 * @remarks
 * Opened when a business owner clicks a resource card in {@link ResourceOverviewPanel}. It shows ONE
 * resource's contents by driving the two READ verbs the platform exposes over every kind uniformly:
 *   - `list` → the resource's children (D1 tables, KV keys, R2 objects, Vectorize vectors, workflow
 *     runs, connections, …), rendered as a scannable list/table.
 *   - `get`  → ONE child (a table's row page, one KV value, one R2 object, one run's status), rendered
 *     as a key-value inspector + (for tabular payloads) a rows table.
 *
 * ONE component serves EVERY kind because the worker returns the adapter's uniform `AdapterResult`
 * envelope (`{ ok, data?, error?, correlationId }`, see `adapter.ts`) and this panel renders that
 * shape GENERICALLY — a primitive/array/object walker — never a per-kind bespoke view. New kinds light
 * up automatically; unknown payload shapes still render as pretty JSON, never a crash.
 *
 * The embedded editor has no cross-origin session, so it talks to the parent admin over `postMessage`:
 *   - `PS_RES_DETAIL_REQUEST { kind, action, environment, params? }` →
 *     `GET /api/sites/:siteId/resources/:kind/detail?action=…` → `PS_RES_DETAIL_RESPONSE { result }`.
 * The caller NEVER names a CF id — only the kind + action + bounded params; the worker server-resolves
 * the id from a registry row the site owns. Dark behind the surface's flag (a 404 "not enabled" →
 * `{ ok:false, enabled:false }`) → a friendly "not enabled" state, never a scary error.
 *
 * Honest states, always: loading · disabled · a typed adapter error (`not_registered` "nothing
 * connected yet" / `not_supported` / `table_not_found` / `cf_unauthorized`) shown as a friendly card ·
 * an empty result · the data. Style mirrors `./ResourceOverviewPanel` + `./SiteTablesPanel` EXACTLY
 * (UnoCSS `bolt-elements-*` tokens, phosphor `i-ph:*`, black + cyan, ≥24px targets, aria-labels,
 * focus-visible rings, `motion-reduce:*`).
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type ResDetailResponseMessage,
  type ResourceDetailResult,
} from '~/lib/embed/embedded-mode';

// ── Types ────────────────────────────────────────────────────────────────────

type ResourceEnvironment = 'preview' | 'production';

/** What the overview hands the detail panel to identify the clicked resource (never a CF id). */
export interface ResourceDetailTarget {
  /** The resource kind (`d1` | `kv` | `r2` | `vectorize` | `workflow` | `durable_object` | …). */
  kind: string;
  /** The environment the resource belongs to. */
  environment: ResourceEnvironment;
  /** Human concept label for the header (e.g. `main_db`), best-effort. */
  concept?: string;
  /** The Worker binding it's exposed under, for the header subtitle. */
  bindingName?: string;
}

/** The safe, non-identifier operands forwarded into the adapter's `list`/`get` (a CF id is NEVER one). */
type DetailParams = NonNullable<Extract<import('~/lib/embed/embedded-mode').ResDetailRequestMessage, { type: 'PS_RES_DETAIL_REQUEST' }>['params']>;

type DetailState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: ResourceDetailResult };

/** A promise pending a bridge reply, matched by correlationId. */
interface Pending {
  resolve: (msg: ParentToChildMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'not enabled';

let correlationCounter = 0;
function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `resdetail_${++correlationCounter}`;
}

/** A human title for a `resource_kind` — strips separators + Title-Cases each word. */
function titleForKind(kind: string): string {
  const raw = (kind || 'Resource').replace(/[_-]+/g, ' ').trim();

  if (!raw) {
    return 'Resource';
  }

  return raw
    .split(/\s+/)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Map a raw kind to a phosphor icon (mirrors ResourceOverviewPanel's mapping). */
function iconForKind(kind: string): string {
  const k = (kind || '').toLowerCase();

  if (k.includes('d1') || k.includes('database') || k.includes('sql')) return 'i-ph:database-duotone';
  if (k.includes('kv') || k.includes('key')) return 'i-ph:key-duotone';
  if (k.includes('r2') || k.includes('bucket') || k.includes('storage') || k.includes('object')) return 'i-ph:cloud-duotone';
  if (k.includes('queue')) return 'i-ph:queue-duotone';
  if (k.includes('function') || k.includes('worker') || k.includes('wfp') || k.includes('dispatch')) return 'i-ph:function-duotone';
  if (k.includes('do') || k.includes('durable')) return 'i-ph:cube-duotone';
  if (k.includes('vectorize') || k.includes('vector') || k.includes('index')) return 'i-ph:graph-duotone';
  if (k.includes('workflow')) return 'i-ph:flow-arrow-duotone';
  if (k.includes('connection') || k.includes('mcp')) return 'i-ph:plugs-connected-duotone';
  if (k.includes('analytics') || k.includes('observability')) return 'i-ph:chart-line-duotone';

  return 'i-ph:cube-duotone';
}

/**
 * Discover, GENERICALLY, the primary "collection" inside an adapter `list`/`get` payload — the first
 * array-of-objects field (D1 `tables`/`rows`, KV `keys`, R2 `objects`, Vectorize `vectors`, workflow
 * `runs`/`instances`, connection list). Returns the field name + rows so the renderer can show a table
 * without hard-coding any kind. Falls back to `null` (→ key-value inspector) when no such array exists.
 */
function findCollection(data: unknown): { field: string; rows: Record<string, unknown>[] } | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  // Prefer well-known collection names first (stable column order), then any array-of-objects.
  const preferred = ['rows', 'tables', 'keys', 'objects', 'vectors', 'runs', 'instances', 'connections', 'items', 'namespaces'];
  const record = data as Record<string, unknown>;
  const arrayFields = Object.keys(record).filter((k) => Array.isArray(record[k]));
  const ordered = [
    ...preferred.filter((k) => arrayFields.includes(k)),
    ...arrayFields.filter((k) => !preferred.includes(k)),
  ];

  for (const field of ordered) {
    const arr = record[field] as unknown[];

    if (arr.length === 0) {
      // An empty array is still a valid (empty) collection — surface it as such, not as key-value.
      return { field, rows: [] };
    }

    if (arr.every((el) => el !== null && typeof el === 'object' && !Array.isArray(el))) {
      return { field, rows: arr as Record<string, unknown>[] };
    }

    // Array of primitives → wrap each into `{ value }` so it renders as a one-column table.
    return { field, rows: arr.map((v) => ({ value: v })) };
  }

  return null;
}

/** The scalar/summary fields of a payload (everything that ISN'T the primary collection) — for the header meta. */
function scalarEntries(data: unknown, collectionField: string | null): [string, unknown][] {
  if (!data || typeof data !== 'object') {
    return [];
  }

  return Object.entries(data as Record<string, unknown>).filter(
    ([k, v]) => k !== collectionField && (v === null || typeof v !== 'object'),
  );
}

/** Render one cell value compactly + safely (objects → JSON, null → em dash, long strings truncated by CSS). */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

/** Humanize a token for a label (`resource_kind` → "Resource Kind"). */
function humanize(token: string): string {
  const raw = (token || '').replace(/[_-]+/g, ' ').trim();

  if (!raw) {
    return '';
  }

  return raw
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** A friendly, human sentence for a typed adapter error code (honest, never a raw code dump). */
function friendlyError(result: ResourceDetailResult): { title: string; hint: string; tone: 'muted' | 'warn' } {
  const code = result.error?.code ?? 'error';
  const message = result.error?.message ?? 'This resource could not be read.';

  switch (code) {
    case 'not_registered':
      return { title: 'Nothing here yet', hint: 'This resource isn’t connected to your site yet.', tone: 'muted' };
    case 'not_supported':
      return { title: 'Not available', hint: message, tone: 'warn' };
    case 'table_not_found':
    case 'invalid_table':
      return { title: 'Not found', hint: message, tone: 'warn' };
    case 'cf_unauthorized':
      return { title: 'Couldn’t connect', hint: 'We couldn’t reach this resource right now. Try again in a moment.', tone: 'warn' };
    case 'not_implemented':
      return { title: 'Coming soon', hint: 'Reading this resource this way is on the way.', tone: 'muted' };
    default:
      return { title: 'Couldn’t load', hint: message, tone: 'warn' };
  }
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * The generic resource detail panel. Renders as an in-tab drill-in over one resource; `onBack` returns
 * to the overview. Loads `list` on mount; a click on a listed child that has an addressable id
 * (`name`/`key`/`id`) issues a `get` to inspect that child.
 */
export const ResourceDetailPanel = memo(({ target, onBack }: { target: ResourceDetailTarget; onBack: () => void }) => {
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  /** The child currently being inspected via `get` (null = the resource-level `list` view). */
  const [child, setChild] = useState<{ label: string; params: DetailParams } | null>(null);

  const pendingRef = useRef<Map<string, Pending>>(new Map());

  /** Send a bridge message + await the reply matched by correlationId (mirrors ResourceOverviewPanel). */
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

  // ONE parent-message listener; resolve by correlationId via the live ref (repo []-deps stale-ref rule).
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_DETAIL_RESPONSE') {
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

  /** Load a `list` (action='list') or a child `get` (action='get' + params) for the target resource. */
  const load = useCallback(
    async (action: 'list' | 'get', params?: DetailParams) => {
      setState({ status: 'loading' });

      if (!isEmbedded) {
        setState({ status: 'error', message: 'Open this from the ProjectSites admin to see your resources.' });
        return;
      }

      try {
        const reply = (await request({
          type: 'PS_RES_DETAIL_REQUEST',
          correlationId: nextCorrelationId(),
          kind: target.kind,
          action,
          environment: target.environment,
          params,
        })) as ResDetailResponseMessage;

        if (!reply.ok) {
          if (reply.enabled === false || (reply.error && reply.error.includes(DISABLED_404))) {
            setState({ status: 'disabled' });
            return;
          }

          setState({ status: 'error', message: reply.error || 'Could not load this resource.' });
          return;
        }

        setState({ status: 'ready', result: reply.result ?? { ok: false, error: { code: 'empty', message: 'No result.' } } });
      } catch (err) {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Could not load this resource.' });
      }
    },
    [request, target.kind, target.environment],
  );

  // On mount + whenever the child selection changes: load the right view.
  useEffect(() => {
    if (child) {
      void load('get', child.params);
    } else {
      void load('list');
    }
  }, [child, load]);

  /**
   * Compute the `get` params to inspect a clicked list row, GENERICALLY: a D1 table row → `{ table }`;
   * a KV/R2 row → `{ key }`; a workflow/DO/connection row → `{ id }`; a vectorize vector → `{ ids:[id] }`.
   * Returns null when the row has no addressable child id (→ not clickable). Never invents an id.
   */
  const childParamsForRow = useCallback(
    (row: Record<string, unknown>): { label: string; params: DetailParams } | null => {
      const k = target.kind.toLowerCase();
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined);

      if (k.includes('d1') && str(row.name)) {
        return { label: str(row.name)!, params: { table: str(row.name)! } };
      }

      if ((k.includes('kv') || k.includes('r2')) && str(row.name ?? row.key)) {
        const key = str(row.name ?? row.key)!;
        return { label: key, params: { key } };
      }

      if (k.includes('vector') && str(row.id)) {
        return { label: str(row.id)!, params: { ids: [str(row.id)!] } };
      }

      const id = str(row.id ?? row.name ?? row.key);

      if ((k.includes('workflow') || k.includes('durable') || k.includes('connection') || k.includes('queue')) && id) {
        return { label: id, params: { id } };
      }

      return null;
    },
    [target.kind],
  );

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <DetailHeader
        target={target}
        child={child}
        onBack={onBack}
        onClearChild={() => setChild(null)}
        onRefresh={() => (child ? void load('get', child.params) : void load('list'))}
      />

      {state.status === 'loading' && <Spinner label={child ? `Loading ${child.label}…` : 'Loading…'} />}
      {state.status === 'disabled' && <DisabledCard />}
      {state.status === 'error' && <ErrorCard message={state.message} onRetry={() => (child ? void load('get', child.params) : void load('list'))} />}

      {state.status === 'ready' &&
        (state.result.ok ? (
          <ResultView
            result={state.result}
            inChild={Boolean(child)}
            childParamsForRow={childParamsForRow}
            onInspectChild={setChild}
          />
        ) : (
          <AdapterErrorCard result={state.result} onRetry={() => (child ? void load('get', child.params) : void load('list'))} />
        ))}
    </div>
  );
});

ResourceDetailPanel.displayName = 'ResourceDetailPanel';

// ── Header ───────────────────────────────────────────────────────────────────

const DetailHeader = memo(
  ({
    target,
    child,
    onBack,
    onClearChild,
    onRefresh,
  }: {
    target: ResourceDetailTarget;
    child: { label: string; params: DetailParams } | null;
    onBack: () => void;
    onClearChild: () => void;
    onRefresh: () => void;
  }) => (
    <div className="flex items-center gap-2.5 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
      <button
        type="button"
        onClick={child ? onClearChild : onBack}
        aria-label={child ? 'Back to resource' : 'Back to resources'}
        title={child ? 'Back to resource' : 'Back to resources'}
        className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer shrink-0"
      >
        <div className="i-ph:arrow-left text-sm" />
      </button>

      <div className={classNames(iconForKind(target.kind), 'text-xl text-bolt-elements-item-contentAccent shrink-0')} aria-hidden="true" />

      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-bolt-elements-textPrimary truncate" title={child ? child.label : target.concept || titleForKind(target.kind)}>
          {child ? child.label : target.concept || titleForKind(target.kind)}
        </h2>
        <p className="text-[10px] text-bolt-elements-textTertiary truncate">
          {titleForKind(target.kind)}
          {target.bindingName ? ` · ${target.bindingName}` : ''}
          {` · ${humanize(target.environment)}`}
          {child ? ' · viewing one item' : ''}
        </p>
      </div>

      <button
        type="button"
        onClick={onRefresh}
        aria-label="Refresh"
        title="Refresh"
        className="ml-auto min-h-[24px] min-w-[24px] flex items-center justify-center rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer shrink-0"
      >
        <div className="i-ph:arrows-clockwise text-sm" />
      </button>
    </div>
  ),
);

DetailHeader.displayName = 'ResourceDetailPanel.Header';

// ── Result view (generic) ─────────────────────────────────────────────────────

const ResultView = memo(
  ({
    result,
    inChild,
    childParamsForRow,
    onInspectChild,
  }: {
    result: ResourceDetailResult;
    inChild: boolean;
    childParamsForRow: (row: Record<string, unknown>) => { label: string; params: DetailParams } | null;
    onInspectChild: (child: { label: string; params: DetailParams }) => void;
  }) => {
    const data = result.data;
    const collection = useMemo(() => findCollection(data), [data]);
    const scalars = useMemo(() => scalarEntries(data, collection?.field ?? null), [data, collection]);

    return (
      <div className="flex-1 overflow-auto modern-scrollbar px-4 py-4 space-y-4" data-testid="resource-detail">
        {/* Scalar summary — the resource/child's own key-values (dimensions, counts, name, status). */}
        {scalars.length > 0 && (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="resource-detail-scalars">
            {scalars.map(([k, v]) => (
              <div key={k} className="rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 min-w-0">
                <dt className="text-[9px] uppercase tracking-wider text-bolt-elements-textTertiary truncate">{humanize(k)}</dt>
                <dd className="text-xs font-mono text-bolt-elements-textPrimary truncate" title={renderCell(v)}>
                  {renderCell(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {/* Primary collection — rendered as a scannable table (rows clickable when addressable). */}
        {collection ? (
          collection.rows.length === 0 ? (
            <EmptyResult inChild={inChild} />
          ) : (
            <CollectionTable
              field={collection.field}
              rows={collection.rows}
              childParamsForRow={childParamsForRow}
              onInspectChild={onInspectChild}
            />
          )
        ) : scalars.length === 0 ? (
          // No collection AND no scalars — show the raw payload rather than a blank pane (never a dead end).
          <RawJson data={data} />
        ) : null}
      </div>
    );
  },
);

ResultView.displayName = 'ResourceDetailPanel.ResultView';

const CollectionTable = memo(
  ({
    field,
    rows,
    childParamsForRow,
    onInspectChild,
  }: {
    field: string;
    rows: Record<string, unknown>[];
    childParamsForRow: (row: Record<string, unknown>) => { label: string; params: DetailParams } | null;
    onInspectChild: (child: { label: string; params: DetailParams }) => void;
  }) => {
    // Columns = union of keys across the first rows (bounded), stable order (first-seen).
    const columns = useMemo(() => {
      const seen: string[] = [];

      for (const row of rows.slice(0, 50)) {
        for (const k of Object.keys(row)) {
          if (!seen.includes(k)) seen.push(k);
        }
      }

      return seen.slice(0, 12);
    }, [rows]);

    return (
      <section>
        <div className="flex items-center gap-2 mb-2">
          <div className="i-ph:list-bullets text-sm text-bolt-elements-item-contentAccent shrink-0" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-bolt-elements-textSecondary">{humanize(field)}</h3>
          <span className="text-[10px] text-bolt-elements-textTertiary">
            {rows.length} {rows.length === 1 ? 'item' : 'items'}
          </span>
        </div>

        <div className="overflow-auto modern-scrollbar rounded-lg border border-bolt-elements-borderColor">
          <table className="w-full text-left border-collapse" data-testid="resource-detail-table">
            <thead>
              <tr className="bg-bolt-elements-background-depth-2">
                {columns.map((col) => (
                  <th key={col} className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary font-semibold px-3 py-2 whitespace-nowrap border-b border-bolt-elements-borderColor">
                    {humanize(col)}
                  </th>
                ))}
                <th className="w-8 border-b border-bolt-elements-borderColor" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const child = childParamsForRow(row);
                const clickable = Boolean(child);

                return (
                  <tr
                    key={i}
                    className={classNames(
                      'border-b border-bolt-elements-borderColor/50 last:border-b-0',
                      clickable
                        ? 'hover:bg-bolt-elements-background-depth-2 cursor-pointer focus-within:bg-bolt-elements-background-depth-2'
                        : '',
                    )}
                    data-testid="resource-detail-row"
                  >
                    {columns.map((col) => (
                      <td key={col} className="text-[11px] font-mono text-bolt-elements-textSecondary px-3 py-1.5 max-w-[240px] truncate" title={renderCell(row[col])}>
                        {renderCell(row[col])}
                      </td>
                    ))}
                    <td className="px-2 py-1.5 text-right">
                      {clickable && child && (
                        <button
                          type="button"
                          onClick={() => onInspectChild(child)}
                          aria-label={`Open ${child.label}`}
                          title={`Open ${child.label}`}
                          className="min-h-[24px] min-w-[24px] inline-flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
                        >
                          <div className="i-ph:caret-right text-sm" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    );
  },
);

CollectionTable.displayName = 'ResourceDetailPanel.CollectionTable';

const RawJson = memo(({ data }: { data: unknown }) => {
  const text = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);

  return (
    <pre className="text-[11px] font-mono text-bolt-elements-textSecondary bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg p-3 overflow-auto modern-scrollbar" data-testid="resource-detail-raw">
      {text}
    </pre>
  );
});

RawJson.displayName = 'ResourceDetailPanel.RawJson';

// ── States (spinner / empty / disabled / errors) ──────────────────────────────

const Spinner = memo(({ label }: { label: string }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-2 p-8 text-center" role="status" aria-live="polite" data-testid="resource-detail-loading">
    <div className="i-ph:circle-notch text-2xl text-bolt-elements-item-contentAccent animate-spin motion-reduce:animate-none" />
    <p className="text-xs text-bolt-elements-textSecondary">{label}</p>
  </div>
));

Spinner.displayName = 'ResourceDetailPanel.Spinner';

const EmptyResult = memo(({ inChild }: { inChild: boolean }) => (
  <div className="flex flex-col items-center justify-center gap-2 py-10 text-center" data-testid="resource-detail-empty">
    <div className="i-ph:tray text-3xl text-bolt-elements-textTertiary" />
    <p className="text-sm font-medium text-bolt-elements-textSecondary">Nothing here yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[280px]">
      {inChild ? 'This item has no rows yet.' : 'This resource is empty right now. When your site writes data here, it shows up.'}
    </p>
  </div>
));

EmptyResult.displayName = 'ResourceDetailPanel.EmptyResult';

const DisabledCard = memo(() => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="resource-detail-disabled">
    <div className="i-ph:lock-key text-3xl text-bolt-elements-textTertiary" />
    <p className="text-sm font-medium text-bolt-elements-textSecondary">Resources isn’t enabled yet</p>
    <p className="text-[11px] text-bolt-elements-textTertiary max-w-[260px]">Once it’s turned on, you can browse this resource’s contents here — nothing to set up.</p>
  </div>
));

DisabledCard.displayName = 'ResourceDetailPanel.DisabledCard';

const ErrorCard = memo(({ message, onRetry }: { message: string; onRetry: () => void }) => (
  <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="resource-detail-error">
    <div className="i-ph:warning-circle text-3xl text-red-400" />
    <p className="text-xs text-bolt-elements-textSecondary max-w-[280px]">{message}</p>
    <button
      type="button"
      onClick={onRetry}
      className="min-h-[24px] mt-1 text-[11px] font-medium px-3 py-1.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
    >
      <div className="i-ph:arrow-clockwise" /> Retry
    </button>
  </div>
));

ErrorCard.displayName = 'ResourceDetailPanel.ErrorCard';

/** Honest render of a TYPED adapter error (`not_registered` / `not_supported` / `table_not_found` / …). */
const AdapterErrorCard = memo(({ result, onRetry }: { result: ResourceDetailResult; onRetry: () => void }) => {
  const friendly = friendlyError(result);
  const retryable = result.error?.retryable === true;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8 text-center" data-testid="resource-detail-adapter-error">
      <div
        className={classNames(
          friendly.tone === 'warn' ? 'i-ph:warning text-amber-400/90' : 'i-ph:tray text-bolt-elements-textTertiary',
          'text-3xl',
        )}
      />
      <p className="text-sm font-medium text-bolt-elements-textSecondary">{friendly.title}</p>
      <p className="text-[11px] text-bolt-elements-textTertiary max-w-[280px]">{friendly.hint}</p>
      {retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[24px] mt-1 text-[11px] font-medium px-3 py-1.5 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
        >
          <div className="i-ph:arrow-clockwise" /> Try again
        </button>
      )}
    </div>
  );
});

AdapterErrorCard.displayName = 'ResourceDetailPanel.AdapterErrorCard';
