/**
 * @file Resource Detail — the editor "Resources" tab's GENERIC per-kind drill-in + WRITE surface.
 *
 * @remarks
 * Opened when a business owner clicks a resource card in {@link ResourceOverviewPanel}. It shows ONE
 * resource's contents by driving the two READ verbs the platform exposes over every kind uniformly:
 *   - `list` → the resource's children (D1 tables, KV keys, R2 objects, Vectorize vectors, workflow
 *     runs, connections, …), rendered as a scannable list/table.
 *   - `get`  → ONE child (a table's row page, one KV value, one R2 object, one run's status), rendered
 *     as a key-value inspector + (for tabular payloads) a rows table.
 *
 * AND it now drives the platform's uniform WRITE verb — `mutate(scope, {action, ...input, confirm})` →
 * `AdapterResult` (adapter.ts) — via a supports-driven control strip:
 *   - a prominent **Provision** button when the resource is not yet connected (`not_registered` / an
 *     "available to add" card) and the kind is provisionable (d1/kv/r2);
 *   - per-action controls: KV `put` (key+value+TTL) / `delete` (key); R2 `delete` (object key); D1
 *     `exec` (SQL textarea + params); Vectorize `delete` (ids); Workflow `start`/`terminate`/… ;
 *     generic named-action buttons for the rest.
 *   Which controls appear is DRIVEN by the kind's declared `supports.mutations` (a compile-time
 *   constant per adapter, mirrored here) — the server RE-VALIDATES `action ∈ supports.mutations`, so a
 *   control can never reach an unwired verb. DESTRUCTIVE actions (delete/terminate/reset/destroy/drop)
 *   open a confirm dialog, then send `confirm:true`.
 *
 * ONE component serves EVERY kind because the worker returns the adapter's uniform `AdapterResult`
 * envelope (`{ ok, data?, error?, correlationId }`, see `adapter.ts`) and this panel renders that
 * shape GENERICALLY — a primitive/array/object walker — never a per-kind bespoke view. New kinds light
 * up automatically; unknown payload shapes still render as pretty JSON, never a crash.
 *
 * The embedded editor has no cross-origin session, so it talks to the parent admin over `postMessage`:
 *   - `PS_RES_DETAIL_REQUEST { kind, action, environment, params? }` →
 *     `GET /api/sites/:siteId/resources/:kind/detail?action=…` → `PS_RES_DETAIL_RESPONSE { result }`.
 *   - `PS_RES_MUTATE_REQUEST { kind, action, environment, input?, confirm? }` →
 *     `POST /api/sites/:siteId/resources/:kind/mutate` → `PS_RES_MUTATE_RESPONSE { result }`.
 * The caller NEVER names a CF id — only the kind + action + bounded params/input; the worker
 * server-resolves (or PRODUCES, for `provision`) the id. Dark behind the surface's flag (a 404 "not
 * enabled" → `{ ok:false, enabled:false }`) → a friendly "not enabled" state, never a scary error.
 *
 * Honest states, always: loading · disabled · a typed adapter error (`not_registered` "nothing
 * connected yet" / `not_supported` / `table_not_found` / `cf_unauthorized`) shown as a friendly card ·
 * an empty result · the data · a mutation's typed result (success + what-changed / confirmation_required
 * / not_available). Style mirrors `./ResourceOverviewPanel` + `./SiteTablesPanel` EXACTLY (UnoCSS
 * `bolt-elements-*` tokens, phosphor `i-ph:*`, black + cyan, ≥24px targets, aria-labels, focus-visible
 * rings, `motion-reduce:*`). After a successful mutate, the detail refetches so the change shows.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { classNames } from '~/utils/classNames';
import { ConfirmationDialog } from '~/components/ui/Dialog';
import {
  isEmbedded,
  postToParent,
  onParentMessage,
  type ParentToChildMessage,
  type ResDetailResponseMessage,
  type ResMutateResponseMessage,
  type ResourceDetailResult,
} from '~/lib/embed/embedded-mode';
import { fieldTypeFor, type FieldKind } from './field-types';

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
  /**
   * The overview's availability verdict for this card, when known: `available` = server-known but NOT
   * yet connected (→ lead with Provision); `connected` = a live resource (→ read + per-action writes).
   * Absent → inferred from the load result (`not_registered` ⇒ treat as available-to-provision).
   */
  availability?: 'connected' | 'available' | 'unsupported';
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

/** The outcome of a mutate round-trip, rendered inline under the write controls (honest, never faked). */
type MutateOutcome =
  | { kind: 'success'; action: string; result: Record<string, unknown> }
  | { kind: 'confirmation'; action: string; message: string }
  | { kind: 'not_available'; action: string; message: string }
  | { kind: 'error'; action: string; message: string };

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 20_000;
const DISABLED_404 = 'not enabled';

/**
 * The named mutations each kind's adapter declares (`supports.mutations`) — mirrored here so the write
 * controls render WITHOUT a round-trip; the worker RE-VALIDATES `action ∈ supports.mutations`, so this
 * is a UI hint, never the authority. Keep in lock-step with the adapters' `supports.mutations` blocks.
 */
const MUTATIONS_FOR_KIND: Record<string, readonly string[]> = {
  d1: ['exec', 'provision'],
  kv: ['put', 'delete', 'provision'],
  r2: ['put', 'delete', 'provision'],
  vectorize: ['upsert', 'delete'],
  workflow: ['start', 'pause', 'resume', 'restart', 'terminate'],
  durable_object: ['status_probe', 'reset'],
  queue: ['send'],
  connection: [],
  analytics_engine: [],
};

/** Actions that DESTROY / irreversibly change existing state → gated behind a confirm dialog + `confirm:true`. */
const DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  'delete',
  'terminate',
  'reset',
  'destroy',
  'drop',
  'restart',
  'purge',
  'revoke',
]);

/** The provisioning action (creates real, billable CF infra) — always confirm-gated. */
const PROVISION_ACTION = 'provision';

let correlationCounter = 0;
function nextCorrelationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `resdetail_${++correlationCounter}`;
}

/** Resolve which named mutations to offer for a kind (falls back to none for an unknown kind). */
function mutationsForKind(kind: string): readonly string[] {
  const k = (kind || '').toLowerCase();

  if (MUTATIONS_FOR_KIND[k]) {
    return MUTATIONS_FOR_KIND[k];
  }

  // Tolerate synonym-ish kinds (e.g. `database` → d1) so a slightly-off label still offers the right verbs.
  if (k.includes('d1') || k.includes('sql')) return MUTATIONS_FOR_KIND.d1;
  if (k.includes('kv') || k.includes('key')) return MUTATIONS_FOR_KIND.kv;
  if (k.includes('r2') || k.includes('bucket') || k.includes('object')) return MUTATIONS_FOR_KIND.r2;
  if (k.includes('vector')) return MUTATIONS_FOR_KIND.vectorize;
  if (k.includes('workflow')) return MUTATIONS_FOR_KIND.workflow;
  if (k.includes('durable') || k.includes('do')) return MUTATIONS_FOR_KIND.durable_object;
  if (k.includes('queue')) return MUTATIONS_FOR_KIND.queue;

  return [];
}

/** True when a kind can be provisioned (its adapter declares the `provision` mutation). */
function canProvision(kind: string): boolean {
  return mutationsForKind(kind).includes(PROVISION_ACTION);
}

/** Human label for a named action button (`status_probe` → "Status Probe", `terminate` → "Terminate"). */
function labelForAction(action: string): string {
  return humanize(action);
}

/** A phosphor icon for a named action (best-effort; falls back to a generic play icon). */
function iconForAction(action: string): string {
  switch (action) {
    case PROVISION_ACTION:
      return 'i-ph:sparkle-duotone';
    case 'delete':
    case 'destroy':
    case 'drop':
    case 'purge':
      return 'i-ph:trash-duotone';
    case 'terminate':
      return 'i-ph:stop-circle-duotone';
    case 'reset':
    case 'restart':
      return 'i-ph:arrow-counter-clockwise-duotone';
    case 'pause':
      return 'i-ph:pause-circle-duotone';
    case 'resume':
    case 'start':
      return 'i-ph:play-circle-duotone';
    case 'status_probe':
      return 'i-ph:heartbeat-duotone';
    case 'send':
      return 'i-ph:paper-plane-tilt-duotone';
    default:
      return 'i-ph:lightning-duotone';
  }
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

/**
 * Infer a {@link FieldKind} from a RAW value (no schema exists for a generic adapter collection, unlike
 * SiteTablesPanel's SQLite `PRAGMA` types) so the shared field-type formatters render numbers/bools/json
 * nicely across ANY kind's rows. Best-effort: a JS number/boolean maps directly; an object/array is JSON;
 * an ISO-ish date string reads as a date; everything else is text (which stringifies).
 */
function kindForValue(value: unknown): FieldKind {
  if (typeof value === 'number') {
    return 'number';
  }

  if (typeof value === 'boolean') {
    return 'boolean';
  }

  if (value !== null && typeof value === 'object') {
    return 'json';
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value)) {
    return 'date';
  }

  return 'text';
}

/**
 * Format a generic cell for display: null/undefined → `null` sentinel (the caller renders a muted em-dash);
 * a JS `true`/`false` → `true`/`false` (never the SQLite `✓`/`''` affordance, which would silently hide a
 * `false`); otherwise the shared field-type formatter, with a String() fallback so it NEVER throws.
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  const kind = kindForValue(value);

  try {
    const formatted = fieldTypeFor(kind).format(value);
    return formatted === '' ? String(value) : formatted;
  } catch {
    return String(value);
  }
}

/** Escape one field for RFC-4180 CSV (quote when it contains a comma, quote, CR, or LF; double inner quotes). */
function csvField(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  const s = typeof value === 'object' ? safeJson(value) : String(value);

  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

/** JSON.stringify that never throws (cyclic/oddball values fall back to String()). */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Build an RFC-4180 CSV from the CURRENTLY-LOADED rows over the given column set + trigger a client-side
 * download. Header row + one row per record, CRLF-free cells quoted per {@link csvField}. Fail-soft: a
 * sandboxed frame with no `URL.createObjectURL` just no-ops (the table still shows the data).
 */
export function buildCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const header = columns.map((c) => csvField(c)).join(',');
  const body = rows.map((row) => columns.map((c) => csvField(row[c])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

/** Download the current collection page as a CSV file named for the collection field. */
function exportCollectionCsv(field: string, columns: string[], rows: Record<string, unknown>[]): void {
  const csv = buildCsv(columns, rows);

  try {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${field || 'rows'}-1-${rows.length}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // download unavailable (sandboxed) — fail soft; the table still shows the data
  }
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

/** True when a read result's error means "not connected yet" (⇒ lead with the Provision affordance). */
function isNotRegistered(result: ResourceDetailResult | null): boolean {
  return Boolean(result && result.ok === false && (result.error?.code === 'not_registered' || result.error?.code === 'not_provisioned'));
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * The generic resource detail panel. Renders as an in-tab drill-in over one resource; `onBack` returns
 * to the overview. Loads `list` on mount; a click on a listed child that has an addressable id
 * (`name`/`key`/`id`) issues a `get` to inspect that child. A supports-driven write strip drives the
 * platform's uniform `mutate` verb (provision + per-action controls, destructive confirm).
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
  // Handles BOTH the detail read reply AND the mutate reply (each carries its own correlationId).
  useEffect(() => {
    const unsubscribe = onParentMessage((msg) => {
      if (msg.type !== 'PS_RES_DETAIL_RESPONSE' && msg.type !== 'PS_RES_MUTATE_RESPONSE') {
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

  /**
   * Run a NAMED mutation via the bridge (`PS_RES_MUTATE_REQUEST`), return the classified {@link MutateOutcome}
   * for inline rendering. NEVER names a CF id — only the kind + action + bounded `input` (+ confirm). Honest:
   * a `confirmation_required` / `not_available` adapter result is surfaced as such, never a fake success.
   */
  const mutate = useCallback(
    async (action: string, input?: Record<string, unknown>, confirm?: boolean): Promise<MutateOutcome> => {
      if (!isEmbedded) {
        return { kind: 'error', action, message: 'Open this from the ProjectSites admin to make changes.' };
      }

      try {
        const reply = (await request({
          type: 'PS_RES_MUTATE_REQUEST',
          correlationId: nextCorrelationId(),
          kind: target.kind,
          action,
          environment: target.environment,
          input,
          confirm,
        })) as ResMutateResponseMessage;

        if (!reply.ok) {
          if (reply.enabled === false) {
            return { kind: 'error', action, message: 'This surface isn’t enabled.' };
          }

          return { kind: 'error', action, message: reply.error || 'That action didn’t go through.' };
        }

        const result = reply.result;

        if (!result) {
          return { kind: 'error', action, message: 'No result returned.' };
        }

        if (result.ok) {
          return { kind: 'success', action, result: (result.data as Record<string, unknown>) ?? {} };
        }

        const code = result.error?.code ?? 'error';
        const message = result.error?.message ?? 'That action couldn’t be completed.';

        if (code === 'confirmation_required') {
          return { kind: 'confirmation', action, message };
        }

        if (code === 'not_available' || code === 'not_supported' || code === 'quota_at_cap') {
          return { kind: 'not_available', action, message };
        }

        return { kind: 'error', action, message };
      } catch (err) {
        return { kind: 'error', action, message: err instanceof Error ? err.message : 'That action didn’t go through.' };
      }
    },
    [request, target.kind, target.environment],
  );

  /** Refetch the current view (list or the open child) — called after a successful mutate so the change shows. */
  const refresh = useCallback(() => {
    if (child) {
      void load('get', child.params);
    } else {
      void load('list');
    }
  }, [child, load]);

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

  const currentResult = state.status === 'ready' ? state.result : null;
  const notRegistered = target.availability === 'available' || isNotRegistered(currentResult);
  const mutations = useMemo(() => mutationsForKind(target.kind), [target.kind]);
  // The write strip stays mounted once the panel has EVER settled (ready/error) — so a post-mutate refetch
  // (which flips the body to a loading spinner) never unmounts the controls or drops the success/outcome
  // card mid-refresh. It's hidden only during the very FIRST load (nothing settled yet) or when the surface
  // is flag-dark (`disabled`). Gated on the kind actually offering a mutation.
  const [everSettled, setEverSettled] = useState(false);
  useEffect(() => {
    if (state.status === 'ready' || state.status === 'error') setEverSettled(true);
  }, [state.status]);
  const showWrite = mutations.length > 0 && state.status !== 'disabled' && (everSettled || state.status === 'ready' || state.status === 'error');

  return (
    <div className="h-full flex flex-col bg-bolt-elements-background-depth-1 text-bolt-elements-textPrimary">
      <DetailHeader
        target={target}
        child={child}
        onBack={onBack}
        onClearChild={() => setChild(null)}
        onRefresh={refresh}
      />

      {showWrite && (
        <WriteControls
          kind={target.kind}
          mutations={mutations}
          notRegistered={notRegistered}
          currentChild={child}
          mutate={mutate}
          onMutated={refresh}
        />
      )}

      {state.status === 'loading' && <Spinner label={child ? `Loading ${child.label}…` : 'Loading…'} />}
      {state.status === 'disabled' && <DisabledCard />}
      {state.status === 'error' && <ErrorCard message={state.message} onRetry={refresh} />}

      {state.status === 'ready' &&
        (state.result.ok ? (
          <ResultView
            result={state.result}
            inChild={Boolean(child)}
            childParamsForRow={childParamsForRow}
            onInspectChild={setChild}
          />
        ) : (
          <AdapterErrorCard result={state.result} onRetry={refresh} />
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

// ── Write controls (supports-driven) ───────────────────────────────────────────

/**
 * The supports-driven WRITE strip. Renders the right controls for the kind's declared mutations:
 *   - `provision` → a prominent Provision button (lead with it when the resource isn't connected yet);
 *   - KV → put (key/value/TTL) + delete (key); R2 → delete (object key); D1 → exec (SQL + params);
 *   - Vectorize → delete (ids); generic named-action buttons for the rest (workflow/DO/queue verbs).
 * DESTRUCTIVE actions (delete/terminate/reset/…) + provision open a confirm dialog then send `confirm:true`.
 * The classified {@link MutateOutcome} renders inline; a success refetches the detail via `onMutated`.
 */
const WriteControls = memo(
  ({
    kind,
    mutations,
    notRegistered,
    currentChild,
    mutate,
    onMutated,
  }: {
    kind: string;
    mutations: readonly string[];
    notRegistered: boolean;
    currentChild: { label: string; params: DetailParams } | null;
    mutate: (action: string, input?: Record<string, unknown>, confirm?: boolean) => Promise<MutateOutcome>;
    onMutated: () => void;
  }) => {
    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<MutateOutcome | null>(null);
    /** The action currently awaiting a confirm-dialog decision (destructive / provision), with its input. */
    const [confirming, setConfirming] = useState<{ action: string; input?: Record<string, unknown>; label: string } | null>(null);

    const k = kind.toLowerCase();
    const has = useCallback((action: string) => mutations.includes(action), [mutations]);

    /** Run a mutation now (already confirmed if needed): set busy, send, classify, refetch on success. */
    const run = useCallback(
      async (action: string, input?: Record<string, unknown>, confirm?: boolean) => {
        setBusyAction(action);
        setOutcome(null);

        const result = await mutate(action, input, confirm);
        setBusyAction(null);
        setOutcome(result);

        if (result.kind === 'success') {
          onMutated();
        }
      },
      [mutate, onMutated],
    );

    /** Route an action: destructive/provision → open the confirm dialog; everything else runs immediately. */
    const dispatch = useCallback(
      (action: string, input: Record<string, unknown> | undefined, label: string) => {
        if (DESTRUCTIVE_ACTIONS.has(action) || action === PROVISION_ACTION) {
          setConfirming({ action, input, label });
          return;
        }

        void run(action, input);
      },
      [run],
    );

    const confirmDialog =
      confirming &&
      (() => {
        const destructive = DESTRUCTIVE_ACTIONS.has(confirming.action);
        const title =
          confirming.action === PROVISION_ACTION
            ? `Provision this ${titleForKind(kind)}?`
            : `${labelForAction(confirming.action)} ${confirming.label}?`;
        const description =
          confirming.action === PROVISION_ACTION
            ? `This creates a real, dedicated ${titleForKind(kind)} for your site on Cloudflare. It may count toward your plan. Continue?`
            : `This ${destructive ? 'permanently changes' : 'changes'} “${confirming.label}”. This can’t be undone. Continue?`;

        return (
          <ConfirmationDialog
            isOpen={true}
            title={title}
            description={description}
            confirmLabel={confirming.action === PROVISION_ACTION ? 'Provision' : labelForAction(confirming.action)}
            cancelLabel="Cancel"
            variant={destructive ? 'destructive' : 'default'}
            isLoading={busyAction === confirming.action}
            onClose={() => setConfirming(null)}
            onConfirm={() => {
              const pending = confirming;
              setConfirming(null);
              void run(pending.action, pending.input, true);
            }}
          />
        );
      })();

    // The named actions that get a plain button (everything that ISN'T rendered as a bespoke form control).
    const bespoke = new Set<string>();
    if (has('put') && (k.includes('kv') || k.includes('r2'))) bespoke.add('put');
    if (has('delete') && (k.includes('kv') || k.includes('r2') || k.includes('vector'))) bespoke.add('delete');
    if (has('exec') && k.includes('d1')) bespoke.add('exec');
    const genericActions = mutations.filter((m) => m !== PROVISION_ACTION && !bespoke.has(m));

    return (
      <div className="shrink-0 border-b border-bolt-elements-borderColor bg-bolt-elements-background-depth-2/40 px-4 py-3 space-y-3" data-testid="resource-detail-write">
        {/* Provision — lead with it when the resource isn't connected yet. */}
        {has(PROVISION_ACTION) && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="resource-mutate-provision"
              disabled={busyAction !== null}
              onClick={() => dispatch(PROVISION_ACTION, undefined, titleForKind(kind))}
              className={classNames(
                'min-h-[32px] inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
                notRegistered
                  ? 'bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3'
                  : 'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary hover:bg-bolt-elements-background-depth-3',
              )}
            >
              <div className={classNames(busyAction === PROVISION_ACTION ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : iconForAction(PROVISION_ACTION), 'text-sm')} />
              {notRegistered ? `Provision ${titleForKind(kind)}` : 'Re-provision'}
            </button>
            {notRegistered && (
              <span className="text-[10px] text-bolt-elements-textTertiary">Creates a dedicated resource for your site.</span>
            )}
          </div>
        )}

        {/* KV put — key + value + optional TTL. */}
        {bespoke.has('put') && k.includes('kv') && (
          <KvPutForm busy={busyAction === 'put'} onSubmit={(input) => dispatch('put', input, String(input.key))} />
        )}

        {/* R2 put (create/overwrite an object) — key + value. */}
        {bespoke.has('put') && k.includes('r2') && (
          <R2PutForm busy={busyAction === 'put'} onSubmit={(input) => dispatch('put', input, String(input.key))} />
        )}

        {/* Delete by key (KV / R2) — key input, destructive. */}
        {bespoke.has('delete') && (k.includes('kv') || k.includes('r2')) && (
          <KeyDeleteForm
            label={k.includes('r2') ? 'object key' : 'key'}
            busy={busyAction === 'delete'}
            defaultKey={currentChild && typeof currentChild.params.key === 'string' ? currentChild.params.key : ''}
            onSubmit={(key) => dispatch('delete', { key }, key)}
          />
        )}

        {/* Vectorize delete by ids — comma/space-separated ids, destructive. */}
        {bespoke.has('delete') && k.includes('vector') && (
          <VectorDeleteForm busy={busyAction === 'delete'} onSubmit={(ids) => dispatch('delete', { ids }, `${ids.length} vector${ids.length === 1 ? '' : 's'}`)} />
        )}

        {/* D1 exec — SQL textarea + optional JSON params. Mutating SQL is confirm-gated server-side. */}
        {bespoke.has('exec') && k.includes('d1') && (
          <D1ExecForm
            busy={busyAction === 'exec'}
            onSubmit={(input, isDestructive) =>
              isDestructive ? setConfirming({ action: 'exec', input, label: 'this SQL statement' }) : void run('exec', input, true)
            }
          />
        )}

        {/* Generic named-action buttons (workflow start/pause/…, DO status_probe/reset, queue send, …). */}
        {genericActions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="resource-mutate-actions">
            {genericActions.map((action) => (
              <GenericActionButton
                key={action}
                action={action}
                busy={busyAction === action}
                disabled={busyAction !== null}
                onRun={(input) => dispatch(action, input, labelForAction(action))}
              />
            ))}
          </div>
        )}

        {outcome && <MutateOutcomeCard outcome={outcome} onDismiss={() => setOutcome(null)} />}

        {confirmDialog}
      </div>
    );
  },
);

WriteControls.displayName = 'ResourceDetailPanel.WriteControls';

// ── Per-action forms ────────────────────────────────────────────────────────────

const inputClass =
  'w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2.5 py-1.5 text-xs font-mono text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent';

const primaryBtnClass =
  'min-h-[32px] inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

const dangerBtnClass =
  'min-h-[32px] inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed';

const KvPutForm = memo(({ busy, onSubmit }: { busy: boolean; onSubmit: (input: Record<string, unknown>) => void }) => {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [ttl, setTtl] = useState('');

  const submit = () => {
    if (!key.trim()) return;

    const input: Record<string, unknown> = { key: key.trim(), value };
    const ttlNum = Number(ttl);
    if (ttl.trim() && Number.isFinite(ttlNum) && ttlNum >= 60) input.expirationTtl = Math.trunc(ttlNum);
    onSubmit(input);
  };

  return (
    <div className="space-y-1.5" data-testid="resource-mutate-kv-put">
      <label className="block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Write a key</label>
      <input className={inputClass} placeholder="key" aria-label="KV key to write" value={key} onChange={(e) => setKey(e.target.value)} />
      <textarea className={classNames(inputClass, 'min-h-[52px] resize-y')} placeholder="value" aria-label="KV value" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="flex items-center gap-2">
        <input className={classNames(inputClass, 'w-32')} placeholder="TTL secs (≥60)" aria-label="Optional TTL in seconds" inputMode="numeric" value={ttl} onChange={(e) => setTtl(e.target.value)} />
        <button type="button" className={primaryBtnClass} disabled={busy || !key.trim()} onClick={submit}>
          <div className={classNames(busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:floppy-disk-duotone', 'text-sm')} /> Write key
        </button>
      </div>
    </div>
  );
});

KvPutForm.displayName = 'ResourceDetailPanel.KvPutForm';

const R2PutForm = memo(({ busy, onSubmit }: { busy: boolean; onSubmit: (input: Record<string, unknown>) => void }) => {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');

  const submit = () => {
    if (!key.trim()) return;

    onSubmit({ key: key.trim(), value });
  };

  return (
    <div className="space-y-1.5" data-testid="resource-mutate-r2-put">
      <label className="block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Write an object</label>
      <input className={inputClass} placeholder="object key" aria-label="R2 object key to write" value={key} onChange={(e) => setKey(e.target.value)} />
      <textarea className={classNames(inputClass, 'min-h-[52px] resize-y')} placeholder="contents" aria-label="R2 object contents" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button" className={primaryBtnClass} disabled={busy || !key.trim()} onClick={submit}>
        <div className={classNames(busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:floppy-disk-duotone', 'text-sm')} /> Write object
      </button>
    </div>
  );
});

R2PutForm.displayName = 'ResourceDetailPanel.R2PutForm';

const KeyDeleteForm = memo(
  ({ label, busy, defaultKey, onSubmit }: { label: string; busy: boolean; defaultKey: string; onSubmit: (key: string) => void }) => {
    const [key, setKey] = useState(defaultKey);

    // Reflect a newly-selected child key into the delete field.
    useEffect(() => {
      setKey(defaultKey);
    }, [defaultKey]);

    return (
      <div className="space-y-1.5" data-testid="resource-mutate-key-delete">
        <label className="block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Delete a {label}</label>
        <div className="flex items-center gap-2">
          <input className={inputClass} placeholder={label} aria-label={`The ${label} to delete`} value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="button" className={dangerBtnClass} disabled={busy || !key.trim()} onClick={() => key.trim() && onSubmit(key.trim())}>
            <div className={classNames(busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:trash-duotone', 'text-sm')} /> Delete
          </button>
        </div>
      </div>
    );
  },
);

KeyDeleteForm.displayName = 'ResourceDetailPanel.KeyDeleteForm';

const VectorDeleteForm = memo(({ busy, onSubmit }: { busy: boolean; onSubmit: (ids: string[]) => void }) => {
  const [raw, setRaw] = useState('');

  const ids = useMemo(() => raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean), [raw]);

  return (
    <div className="space-y-1.5" data-testid="resource-mutate-vector-delete">
      <label className="block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Delete vectors by id</label>
      <div className="flex items-center gap-2">
        <input className={inputClass} placeholder="id1, id2, id3" aria-label="Vector ids to delete (comma or space separated)" value={raw} onChange={(e) => setRaw(e.target.value)} />
        <button type="button" className={dangerBtnClass} disabled={busy || ids.length === 0} onClick={() => ids.length > 0 && onSubmit(ids)}>
          <div className={classNames(busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:trash-duotone', 'text-sm')} /> Delete{ids.length > 0 ? ` (${ids.length})` : ''}
        </button>
      </div>
    </div>
  );
});

VectorDeleteForm.displayName = 'ResourceDetailPanel.VectorDeleteForm';

const D1ExecForm = memo(({ busy, onSubmit }: { busy: boolean; onSubmit: (input: Record<string, unknown>, isDestructive: boolean) => void }) => {
  const [sql, setSql] = useState('');
  const [paramsRaw, setParamsRaw] = useState('');
  const [paramsError, setParamsError] = useState<string | null>(null);

  // Best-effort client hint (the WORKER classifies authoritatively): flag likely-destructive DDL/DML so the
  // confirm dialog fires up-front. The server re-classifies + gates regardless, so this is only UX.
  const likelyDestructive = /^\s*(drop|truncate|alter|delete)\b/i.test(sql) && !/\bwhere\b/i.test(sql.replace(/^\s*delete\b/i, 'delete'));
  const likelyMutating = /^\s*(insert|update|delete|replace|create|alter|drop|truncate)\b/i.test(sql);

  const submit = () => {
    if (!sql.trim()) return;

    setParamsError(null);

    let params: unknown[] | undefined;

    if (paramsRaw.trim()) {
      try {
        const parsed = JSON.parse(paramsRaw);

        if (!Array.isArray(parsed)) {
          setParamsError('Params must be a JSON array, e.g. ["a", 1, true].');
          return;
        }

        params = parsed;
      } catch {
        setParamsError('Params must be valid JSON (an array of values).');
        return;
      }
    }

    const input: Record<string, unknown> = { sql: sql.trim() };
    if (params) input.params = params;
    // A mutating statement is confirm-gated (destructive → dialog; other mutating → the server still
    // requires confirm:true, which we pass). A read-only statement runs with no confirm.
    onSubmit(input, likelyDestructive || likelyMutating);
  };

  return (
    <div className="space-y-1.5" data-testid="resource-mutate-d1-exec">
      <label className="block text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">Run SQL</label>
      <textarea
        className={classNames(inputClass, 'min-h-[64px] resize-y')}
        placeholder="SELECT * FROM my_table LIMIT 10;"
        aria-label="SQL statement to run"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
      />
      <input
        className={inputClass}
        placeholder='params (JSON array, optional) — e.g. ["a", 1]'
        aria-label="Bound SQL parameters as a JSON array"
        value={paramsRaw}
        onChange={(e) => setParamsRaw(e.target.value)}
      />
      {paramsError && <p className="text-[10px] text-red-400">{paramsError}</p>}
      <div className="flex items-center gap-2">
        <button type="button" className={likelyDestructive ? dangerBtnClass : primaryBtnClass} disabled={busy || !sql.trim()} onClick={submit}>
          <div className={classNames(busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : 'i-ph:play-duotone', 'text-sm')} /> Run
        </button>
        {likelyMutating && (
          <span className="text-[10px] text-amber-400/90">
            {likelyDestructive ? 'This looks destructive — you’ll confirm first.' : 'This modifies data — you’ll confirm first.'}
          </span>
        )}
      </div>
    </div>
  );
});

D1ExecForm.displayName = 'ResourceDetailPanel.D1ExecForm';

const GenericActionButton = memo(
  ({ action, busy, disabled, onRun }: { action: string; busy: boolean; disabled: boolean; onRun: (input?: Record<string, unknown>) => void }) => {
    const destructive = DESTRUCTIVE_ACTIONS.has(action);
    // Instance-scoped verbs need an id; ask for it inline so the button isn't a dead control.
    const needsInstance = ['pause', 'resume', 'restart', 'terminate'].includes(action);
    const needsObject = ['status_probe', 'reset'].includes(action);
    const needsMessages = action === 'send';
    const [value, setValue] = useState('');

    if (needsInstance || needsObject || needsMessages) {
      const field = needsInstance ? 'instanceId' : needsObject ? 'objectId' : 'messages';
      const placeholder = needsMessages ? 'message body' : needsInstance ? 'run instance id' : 'object id';
      const buildInput = (): Record<string, unknown> => (needsMessages ? { messages: [value.trim()] } : { [field]: value.trim() });

      return (
        <div className="flex items-center gap-1.5">
          <input className={classNames(inputClass, 'w-40')} placeholder={placeholder} aria-label={`${labelForAction(action)} — ${placeholder}`} value={value} onChange={(e) => setValue(e.target.value)} />
          <button
            type="button"
            data-testid={`resource-mutate-action-${action}`}
            disabled={disabled || !value.trim()}
            onClick={() => value.trim() && onRun(buildInput())}
            className={destructive ? dangerBtnClass : primaryBtnClass}
          >
            <div className={classNames(busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : iconForAction(action), 'text-sm')} />
            {labelForAction(action)}
          </button>
        </div>
      );
    }

    return (
      <button
        type="button"
        data-testid={`resource-mutate-action-${action}`}
        disabled={disabled}
        onClick={() => onRun()}
        className={destructive ? dangerBtnClass : primaryBtnClass}
      >
        <div className={classNames(busy ? 'i-ph:circle-notch animate-spin motion-reduce:animate-none' : iconForAction(action), 'text-sm')} />
        {labelForAction(action)}
      </button>
    );
  },
);

GenericActionButton.displayName = 'ResourceDetailPanel.GenericActionButton';

/** Renders the classified {@link MutateOutcome} inline — honest success/confirmation/not-available/error. */
const MutateOutcomeCard = memo(({ outcome, onDismiss }: { outcome: MutateOutcome; onDismiss: () => void }) => {
  const config: Record<MutateOutcome['kind'], { icon: string; tone: string; title: string }> = {
    success: { icon: 'i-ph:check-circle-duotone', tone: 'text-emerald-400', title: `${labelForAction(outcome.action)} succeeded` },
    confirmation: { icon: 'i-ph:shield-warning-duotone', tone: 'text-amber-400', title: 'Confirmation needed' },
    not_available: { icon: 'i-ph:prohibit-duotone', tone: 'text-bolt-elements-textTertiary', title: 'Not available' },
    error: { icon: 'i-ph:warning-circle-duotone', tone: 'text-red-400', title: `${labelForAction(outcome.action)} didn’t go through` },
  };
  const c = config[outcome.kind];

  return (
    <div
      className="flex items-start gap-2 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-2"
      role="status"
      aria-live="polite"
      data-testid="resource-mutate-outcome"
    >
      <div className={classNames(c.icon, c.tone, 'text-base shrink-0 mt-0.5')} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className={classNames('text-xs font-semibold', c.tone)}>{c.title}</p>
        {outcome.kind === 'success' ? (
          <WhatChanged result={outcome.result} />
        ) : (
          <p className="text-[11px] text-bolt-elements-textTertiary break-words">{outcome.message}</p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        title="Dismiss"
        className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer shrink-0"
      >
        <div className="i-ph:x text-sm" />
      </button>
    </div>
  );
});

MutateOutcomeCard.displayName = 'ResourceDetailPanel.MutateOutcomeCard';

/** The "what changed" summary of a successful mutation — the AdapterResult's own scalar fields, humanized. */
const WhatChanged = memo(({ result }: { result: Record<string, unknown> }) => {
  const entries = Object.entries(result).filter(([, v]) => v === null || typeof v !== 'object');

  if (entries.length === 0) {
    return <p className="text-[11px] text-bolt-elements-textTertiary">Done.</p>;
  }

  return (
    <dl className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-center gap-1">
          <dt className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary">{humanize(k)}</dt>
          <dd className="text-[11px] font-mono text-bolt-elements-textSecondary">{renderCell(v)}</dd>
        </div>
      ))}
    </dl>
  );
});

WhatChanged.displayName = 'ResourceDetailPanel.WhatChanged';

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
    /** The collection row whose full field set is open in the side drawer (null = drawer closed). */
    const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);

    // Close the drawer whenever the underlying data changes (a refetch / child switch) so it never
    // shows a row that no longer exists in the current result.
    useEffect(() => {
      setDetailRow(null);
    }, [data]);

    return (
      <div className="relative flex-1 overflow-auto modern-scrollbar px-4 py-4 space-y-4" data-testid="resource-detail">
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
              onOpenRow={setDetailRow}
            />
          )
        ) : scalars.length === 0 ? (
          // No collection AND no scalars — show the raw payload rather than a blank pane (never a dead end).
          <RawJson data={data} />
        ) : null}

        {/* Row-detail drawer — the clicked row's FULL field set, keyboard-closeable, focus-restoring. */}
        {detailRow && <RowDrawer row={detailRow} onClose={() => setDetailRow(null)} />}
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
    onOpenRow,
  }: {
    field: string;
    rows: Record<string, unknown>[];
    childParamsForRow: (row: Record<string, unknown>) => { label: string; params: DetailParams } | null;
    onInspectChild: (child: { label: string; params: DetailParams }) => void;
    onOpenRow: (row: Record<string, unknown>) => void;
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

    // CSV exports EVERY column of the loaded rows (not the 12-column display cap), so nothing is silently dropped.
    const csvColumns = useMemo(() => {
      const seen: string[] = [];

      for (const row of rows) {
        for (const k of Object.keys(row)) {
          if (!seen.includes(k)) seen.push(k);
        }
      }

      return seen;
    }, [rows]);

    return (
      <section>
        <div className="flex items-center gap-2 mb-2">
          <div className="i-ph:list-bullets text-sm text-bolt-elements-item-contentAccent shrink-0" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-bolt-elements-textSecondary">{humanize(field)}</h3>
          <span className="text-[10px] text-bolt-elements-textTertiary">
            {rows.length} {rows.length === 1 ? 'item' : 'items'}
          </span>
          <button
            type="button"
            onClick={() => exportCollectionCsv(field, csvColumns, rows)}
            data-testid="resource-detail-export-csv"
            aria-label="Export the loaded rows as CSV"
            title="Export the loaded rows as CSV"
            className="ml-auto min-h-[24px] text-[10px] font-medium px-2 py-1 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-bolt-elements-item-contentAccent hover:bg-bolt-elements-background-depth-3 transition-colors flex items-center gap-1 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:download-simple" /> Export CSV
          </button>
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

                return (
                  <tr
                    key={i}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenRow(row)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpenRow(row);
                      }
                    }}
                    aria-label={`View row ${i + 1} details`}
                    className="border-b border-bolt-elements-borderColor/50 last:border-b-0 hover:bg-bolt-elements-background-depth-2 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-bolt-elements-item-contentAccent"
                    data-testid="resource-detail-row"
                  >
                    {columns.map((col) => {
                      const value = row[col];
                      const isNull = value === null || value === undefined;
                      return (
                        <td
                          key={col}
                          className={classNames(
                            'text-[11px] font-mono px-3 py-1.5 max-w-[240px] truncate',
                            isNull ? 'text-bolt-elements-textTertiary italic' : 'text-bolt-elements-textSecondary',
                          )}
                          title={isNull ? 'null' : formatValue(value)}
                        >
                          {isNull ? '—' : formatValue(value)}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5 text-right">
                      {child && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onInspectChild(child);
                          }}
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

/**
 * Row-detail drawer — mirrors {@link SiteTablesPanel}'s `RowDrawer`: a right-aligned side panel showing the
 * clicked collection row's FULL key/value set. Esc + a close button + the scrim close it; focus is restored
 * to the invoking row on unmount (the row keeps its DOM focus target). `role=dialog` + `aria-modal` +
 * `aria-label` for a11y. Cell values format via the shared field-type formatter (null → muted em-dash).
 */
const RowDrawer = memo(({ row, onClose }: { row: Record<string, unknown>; onClose: () => void }) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  /** The element focused when the drawer opened — restored on close so keyboard focus never gets lost. */
  const restoreRef = useRef<Element | null>(null);

  // Esc closes; capture the previously-focused element on open + restore it on unmount; focus the close button.
  useEffect(() => {
    restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', onKey);
    closeRef.current?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      const el = restoreRef.current;
      if (el && typeof (el as HTMLElement).focus === 'function') {
        (el as HTMLElement).focus();
      }
    };
  }, [onClose]);

  const entries = useMemo(() => Object.entries(row), [row]);

  return (
    <div className="absolute inset-0 z-20 flex justify-end" role="dialog" aria-modal="true" aria-label="Row detail">
      <button type="button" aria-label="Close row detail" onClick={onClose} className="absolute inset-0 bg-black/40 cursor-default" />
      <div
        className="animated fadeInRight relative w-[min(420px,80%)] h-full bg-bolt-elements-background-depth-2 border-l border-bolt-elements-borderColor shadow-2xl flex flex-col motion-reduce:animate-none"
        data-testid="resource-detail-row-drawer"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-bolt-elements-borderColor shrink-0">
          <div className="i-ph:rows-duotone text-bolt-elements-item-contentAccent" aria-hidden="true" />
          <h3 className="text-sm font-semibold text-bolt-elements-textPrimary flex-1">Row detail</h3>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="min-h-[24px] min-w-[24px] flex items-center justify-center rounded hover:bg-bolt-elements-background-depth-3 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bolt-elements-item-contentAccent cursor-pointer"
          >
            <div className="i-ph:x text-sm" />
          </button>
        </div>
        <div className="flex-1 overflow-auto modern-scrollbar p-4 space-y-3">
          {entries.map(([key, value]) => {
            const isNull = value === null || value === undefined;
            return (
              <div key={key} className="space-y-0.5">
                <span className="text-[10px] uppercase tracking-wider text-bolt-elements-textTertiary font-medium">{humanize(key)}</span>
                <div
                  className={classNames(
                    'text-xs font-mono break-words whitespace-pre-wrap rounded bg-bolt-elements-background-depth-1 border border-bolt-elements-borderColor px-2.5 py-1.5',
                    isNull ? 'text-bolt-elements-textTertiary italic' : 'text-bolt-elements-textSecondary',
                  )}
                >
                  {isNull ? '—' : formatValue(value)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

RowDrawer.displayName = 'ResourceDetailPanel.RowDrawer';

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
