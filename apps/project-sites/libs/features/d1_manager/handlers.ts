/**
 * @module libs/features/d1_manager/handlers
 * @description Hono routes for the read-only D1 Manager (flag: `d1_manager`).
 *
 * | Method | Path                                   | Auth        | Purpose                                  |
 * | ------ | -------------------------------------- | ----------- | ---------------------------------------- |
 * | GET    | /api/admin/d1/databases                | super-admin | List the account's D1 databases          |
 * | GET    | /api/admin/d1/:databaseId/overview     | super-admin | One DB's metadata (size, table count, …) |
 * | POST   | /api/admin/d1/:databaseId/export       | super-admin | Full/scoped SQL-dump export (async poll) |
 *
 * Security model (mirrors kv_inspector / r2_inspector / vectorize_inspector):
 *   - 404 when the `d1_manager` flag is off OR the caller is not a platform super-admin
 *     (never leak existence).
 *   - Reads only — NO data mutation: list + overview + SQL-DUMP EXPORT (a read of the DB into a
 *     portable .sql text dump; it does NOT alter data). Export DOES briefly make the DB unavailable
 *     to serve queries while it runs (a CF platform behaviour, surfaced honestly in the response
 *     `note`), so it stays super-admin + flag-dark. No write / DDL / Time-Travel restore is exposed
 *     (the raw SQL console has its own super-admin gate; restore is destructive, intentionally absent).
 *   - Cloudflare credentials stay SERVER-side (`resolveCfCredentials` → the worker global
 *     key / token); the browser never sees an account token. The account is `env.CF_ACCOUNT_ID`
 *     (server-derived), NEVER client-supplied.
 *   - `:databaseId` is a validated UUID (no REST-path injection). It is NOT an authz boundary —
 *     the super-admin gate is. This is an ACCOUNT-WIDE super-admin debug view of the platform's
 *     shared D1 databases (like the KV/R2/Vectorize inspectors), NOT a per-tenant surface, so
 *     "never trust a client db id for tenant authz" is satisfied: authz is super-admin, not the id.
 *   - Honest "not available" (`available:false`) on a credential/API failure — never a fabricated
 *     empty list; `found:false` on a CF 404 — never a fabricated database.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { isSuperAdmin } from '../../../src/services/sysadmin.js';
import { resolveCfCredentials, cfAuthHeaders } from '../../../src/services/cf_credentials.js';
import { D1DatabaseIdSchema, D1ExportRequestSchema } from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };

/** Feature flag key — 404 when off so feature existence is never leaked. */
const FLAG_KEY = 'd1_manager' as const;

/** The subset of the Cloudflare D1 REST database shape we read. */
interface CfD1Row {
  uuid?: string;
  name?: string;
  created_at?: string | null;
  version?: string | null;
  num_tables?: number | null;
  file_size?: number | null;
  running_in_region?: string | null;
  read_replication?: { mode?: string | null } | null;
}

export const d1Manager = new Hono<AppContext>();

/** Combined flag+super-admin gate. Returns 404 (not 403) on any failure. */
async function gate(c: Context<AppContext>): Promise<Response | null> {
  const flagOn = await isFlagOn(c.env, FLAG_KEY, {});
  if (!flagOn) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  const userId = c.get('userId');
  if (!userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  const superAdmin = await isSuperAdmin(c.env, userId);
  if (!superAdmin) return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
  return null; // pass
}

/**
 * Structured operational telemetry (the Data-epic's "telemetry for query failures,
 * freshness, cost"). `console.warn(JSON.stringify(...))` is the repo's structured-log
 * rail. Never logs row data — only the operation shape, outcome, and latency.
 */
function logD1(c: Context<AppContext>, fields: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'd1_manager',
      request_id: c.get('requestId') ?? null,
      ...fields,
    }),
  );
}

/**
 * Call the Cloudflare D1 REST API server-side. Fail-soft — returns `{ ok:false, reason }`
 * (never throws) so a credential/API failure surfaces as an honest "not available", never a
 * fabricated empty result.
 */
async function cfD1(
  c: Context<AppContext>,
  path: string,
): Promise<{ status: number; ok: boolean; result: unknown; reason?: string }> {
  const auth = await resolveCfCredentials(c.env, null);
  const acct = c.env.CF_ACCOUNT_ID;
  if (!auth || !acct) return { status: 0, ok: false, result: null, reason: 'no_credentials' };
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database${path}`,
      { headers: { ...cfAuthHeaders(auth), 'Content-Type': 'application/json' } },
    );
    const json = (await res.json().catch(() => null)) as { result?: unknown } | null;
    return { status: res.status, ok: res.ok, result: json?.result ?? null };
  } catch {
    return { status: 0, ok: false, result: null, reason: 'fetch_error' };
  }
}

// ─── GET /api/admin/d1/databases ─────────────────────────────────────────────
d1Manager.get('/api/admin/d1/databases', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const t0 = Date.now();
  const r = await cfD1(c, '');
  if (!r.ok) {
    logD1(c, { route: 'd1/databases', outcome: 'unavailable', status: r.status, reason: r.reason, latency_ms: Date.now() - t0 });
    // Honest "not available" — distinguishes a credential/API failure from a real empty account.
    return c.json({ databases: [], available: false, reason: r.reason ?? `cf_${r.status}` });
  }
  const rows = (Array.isArray(r.result) ? r.result : []) as CfD1Row[];
  const databases = rows
    .map((d) => ({
      id: String(d?.uuid ?? ''),
      name: String(d?.name ?? ''),
      created: d?.created_at ?? null,
      version: d?.version ?? null,
    }))
    .filter((d) => d.id);
  logD1(c, { route: 'd1/databases', outcome: 'ok', count: databases.length, latency_ms: Date.now() - t0 });
  return c.json({ databases, available: true });
});

// ─── GET /api/admin/d1/:databaseId/overview ──────────────────────────────────
d1Manager.get('/api/admin/d1/:databaseId/overview', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const parse = D1DatabaseIdSchema.safeParse(c.req.param('databaseId'));
  if (!parse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown database' } }, 404);
  }
  const id = parse.data;

  const t0 = Date.now();
  const r = await cfD1(c, `/${id}`);
  if (r.status === 404) {
    logD1(c, { route: 'd1/overview', outcome: 'miss', latency_ms: Date.now() - t0 });
    return c.json({ found: false, id }); // honest — the database doesn't exist
  }
  if (!r.ok) {
    logD1(c, { route: 'd1/overview', outcome: 'unavailable', status: r.status, latency_ms: Date.now() - t0 });
    return c.json({ found: false, id, available: false, reason: r.reason ?? `cf_${r.status}` });
  }
  const db = (r.result ?? {}) as CfD1Row;
  logD1(c, { route: 'd1/overview', outcome: 'ok', latency_ms: Date.now() - t0 });
  return c.json({
    found: true,
    id,
    name: db?.name ?? null,
    // null (never a fabricated 0) when the CF API omits the metric.
    fileSize: typeof db?.file_size === 'number' ? db.file_size : null,
    numTables: typeof db?.num_tables === 'number' ? db.num_tables : null,
    version: db?.version ?? null,
    region: db?.running_in_region ?? null,
    readReplication: db?.read_replication?.mode ?? null,
  });
});

/**
 * POST to the Cloudflare D1 REST API server-side (the export polling flow needs a body). Fail-soft —
 * returns `{ ok:false, reason }` (never throws) so a credential/API failure surfaces honestly.
 */
async function cfD1Post(
  c: Context<AppContext>,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; ok: boolean; result: unknown; reason?: string }> {
  const auth = await resolveCfCredentials(c.env, null);
  const acct = c.env.CF_ACCOUNT_ID;
  if (!auth || !acct) return { status: 0, ok: false, result: null, reason: 'no_credentials' };
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/d1/database${path}`,
      {
        method: 'POST',
        headers: { ...cfAuthHeaders(auth), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const json = (await res.json().catch(() => null)) as { result?: unknown } | null;
    return { status: res.status, ok: res.ok, result: json?.result ?? null };
  } catch {
    return { status: 0, ok: false, result: null, reason: 'fetch_error' };
  }
}

/**
 * Back-to-back CF poll round-trips per request before returning `processing`. Bounds the Worker's
 * wall-time: a small/scoped export completes in 1–2 polls; a large one hands back the bookmark so
 * the client resumes — the Worker never blocks indefinitely.
 */
const MAX_EXPORT_POLLS = 6;

/** Honest caveat surfaced on EVERY export response (never present the dump as a native .sqlite file,
 *  and never hide CF's brief-unavailability behaviour). */
const EXPORT_NOTE =
  'Produces a SQL text dump (not a native .sqlite file). Cloudflare briefly makes the database ' +
  'unavailable to serve queries while the export runs — export during low traffic. The download link is valid ~1 hour.';

/** The outer `result` object of the CF D1 export response (the completed dump nests under `.result`). */
interface CfExportOuter {
  at_bookmark?: string;
  status?: string; // 'complete' | 'error' | absent/pending while in-progress
  messages?: unknown;
  error?: string;
  result?: { signed_url?: string; filename?: string } | null;
}

/** Coerce CF's `messages` (strings OR log objects) to a bounded string[] for the client. */
function messagesToStrings(m: unknown): string[] | undefined {
  if (!Array.isArray(m)) return undefined;
  return m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).slice(0, 20);
}

// ─── POST /api/admin/d1/:databaseId/export ───────────────────────────────────
// Full or scoped SQL-DUMP export via CF's async polling API. Super-admin + flag-dark. Resumable:
// a `processing` response carries a `bookmark` the client re-POSTs as `currentBookmark`.
d1Manager.post('/api/admin/d1/:databaseId/export', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const parse = D1DatabaseIdSchema.safeParse(c.req.param('databaseId'));
  if (!parse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown database' } }, 404);
  }
  const id = parse.data;

  const bodyParse = D1ExportRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!bodyParse.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid export options',
          details: bodyParse.error.flatten(),
        },
      },
      400,
    );
  }
  const opts = bodyParse.data;

  // Build CF `dump_options` from the validated body (scoping the export shrinks the unavailability window).
  const dumpOptions: Record<string, unknown> = {};
  if (opts.tables?.length) dumpOptions.tables = opts.tables;
  if (opts.schemaOnly) dumpOptions.no_data = true;
  if (opts.dataOnly) dumpOptions.no_schema = true;

  const t0 = Date.now();
  let bookmark = opts.currentBookmark;
  for (let i = 0; i < MAX_EXPORT_POLLS; i++) {
    const reqBody: Record<string, unknown> = { output_format: 'polling' };
    if (bookmark) reqBody.current_bookmark = bookmark;
    if (Object.keys(dumpOptions).length) reqBody.dump_options = dumpOptions;

    const r = await cfD1Post(c, `/${id}/export`, reqBody);
    if (r.status === 404) {
      logD1(c, { route: 'd1/export', outcome: 'miss', latency_ms: Date.now() - t0 });
      return c.json({ status: 'error', reason: 'database_not_found', note: EXPORT_NOTE });
    }
    if (!r.ok) {
      logD1(c, { route: 'd1/export', outcome: 'unavailable', status: r.status, reason: r.reason, latency_ms: Date.now() - t0 });
      return c.json({ status: 'unavailable', reason: r.reason ?? `cf_${r.status}`, note: EXPORT_NOTE });
    }
    const out = (r.result ?? {}) as CfExportOuter;
    bookmark = out.at_bookmark ?? bookmark;
    const signedUrl = out.result?.signed_url;
    if (out.status === 'complete' && signedUrl) {
      logD1(c, { route: 'd1/export', outcome: 'complete', polls: i + 1, latency_ms: Date.now() - t0 });
      return c.json({
        status: 'complete',
        signedUrl,
        filename: out.result?.filename,
        bookmark: out.at_bookmark,
        messages: messagesToStrings(out.messages),
        note: EXPORT_NOTE,
      });
    }
    if (out.status === 'error' || out.error) {
      logD1(c, { route: 'd1/export', outcome: 'error', latency_ms: Date.now() - t0 });
      return c.json({ status: 'error', reason: out.error ?? 'export_failed', messages: messagesToStrings(out.messages), note: EXPORT_NOTE });
    }
    // else: still processing → loop again with the fresh bookmark.
  }
  logD1(c, { route: 'd1/export', outcome: 'processing', polls: MAX_EXPORT_POLLS, latency_ms: Date.now() - t0 });
  return c.json({ status: 'processing', bookmark, note: EXPORT_NOTE });
});
