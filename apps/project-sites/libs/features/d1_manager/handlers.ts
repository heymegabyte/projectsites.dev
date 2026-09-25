/**
 * @module libs/features/d1_manager/handlers
 * @description Hono routes for the read-only D1 Manager (flag: `d1_manager`).
 *
 * | Method | Path                                   | Auth        | Purpose                                  |
 * | ------ | -------------------------------------- | ----------- | ---------------------------------------- |
 * | GET    | /api/admin/d1/databases                | super-admin | List the account's D1 databases          |
 * | GET    | /api/admin/d1/:databaseId/overview     | super-admin | One DB's metadata (size, table count, …) |
 *
 * Security model (mirrors kv_inspector / r2_inspector / vectorize_inspector):
 *   - 404 when the `d1_manager` flag is off OR the caller is not a platform super-admin
 *     (never leak existence).
 *   - READ-ONLY: list + overview only. No query / write / restore is exposed here (the raw
 *     SQL console lives behind its own super-admin gate; Time Travel restore is destructive
 *     and intentionally NOT surfaced by this read-only adapter).
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
import { D1DatabaseIdSchema } from './schemas.js';

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
