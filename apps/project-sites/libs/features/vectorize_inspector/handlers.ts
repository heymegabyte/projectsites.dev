/**
 * @module libs/features/vectorize_inspector/handlers
 * @description Hono routes for the read-only Vectorize Index Inspector (flag: `vectorize_inspector`).
 *
 * | Method | Path                                | Auth        | Purpose                                     |
 * | ------ | ----------------------------------- | ----------- | ------------------------------------------- |
 * | GET    | /api/admin/vectorize/indexes        | super-admin | List the account's Vectorize indexes        |
 * | GET    | /api/admin/vectorize/indexes/:name  | super-admin | Describe one index (config + vector count)  |
 *
 * Security model (mirrors kv_inspector / r2_inspector):
 *   - 404 when the `vectorize_inspector` flag is off OR the caller is not a platform
 *     super-admin (never leak existence).
 *   - READ-ONLY: list + describe only. No insert / query / delete is exposed.
 *   - Cloudflare credentials stay SERVER-side (`resolveCfCredentials` → the worker global
 *     key / token); the browser never sees an account token. The account is
 *     `env.CF_ACCOUNT_ID` (server-derived), NEVER client-supplied.
 *   - `:name` is a validated slug (no REST-path injection). It is NOT an authz boundary —
 *     the super-admin gate is; an unknown index 404s from CF → honest `found:false`.
 *   - Vectorize indexes are SHARED platform resources (RAG / embeddings), not tenant-owned —
 *     a super-admin debug view, like the KV/R2 inspectors.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { isSuperAdmin } from '../../../src/services/sysadmin.js';
import { resolveCfCredentials, cfAuthHeaders } from '../../../src/services/cf_credentials.js';
import { VectorizeIndexNameSchema } from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };

/** Feature flag key — 404 when off so feature existence is never leaked. */
const FLAG_KEY = 'vectorize_inspector' as const;

/** The subset of the Cloudflare Vectorize v2 index shape we read. */
interface CfIndexRow {
  name?: string;
  description?: string | null;
  created_on?: string | null;
  modified_on?: string | null;
  config?: { dimensions?: number; metric?: string } | null;
}
interface CfIndexInfo {
  vectorCount?: number;
  vector_count?: number;
  processedUpToMutation?: string | null;
}

export const vectorizeInspector = new Hono<AppContext>();

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
 * rail. Never logs vector data — only the operation shape, outcome, and latency.
 */
function logVec(c: Context<AppContext>, fields: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'vectorize_inspector',
      request_id: c.get('requestId') ?? null,
      ...fields,
    }),
  );
}

/**
 * Call the Cloudflare Vectorize v2 REST API server-side. Fail-soft — returns
 * `{ ok:false, reason }` (never throws) so a credential/API failure surfaces as an
 * honest "not available", never a fabricated empty result.
 */
async function cfVectorize(
  c: Context<AppContext>,
  path: string,
): Promise<{ status: number; ok: boolean; result: unknown; reason?: string }> {
  const auth = await resolveCfCredentials(c.env, null);
  const acct = c.env.CF_ACCOUNT_ID;
  if (!auth || !acct) return { status: 0, ok: false, result: null, reason: 'no_credentials' };
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/vectorize/v2/${path}`,
      { headers: { ...cfAuthHeaders(auth), 'Content-Type': 'application/json' } },
    );
    const json = (await res.json().catch(() => null)) as { result?: unknown } | null;
    return { status: res.status, ok: res.ok, result: json?.result ?? null };
  } catch {
    return { status: 0, ok: false, result: null, reason: 'fetch_error' };
  }
}

// ─── GET /api/admin/vectorize/indexes ────────────────────────────────────────
vectorizeInspector.get('/api/admin/vectorize/indexes', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const t0 = Date.now();
  const r = await cfVectorize(c, 'indexes');
  if (!r.ok) {
    logVec(c, { route: 'vectorize/indexes', outcome: 'unavailable', status: r.status, reason: r.reason, latency_ms: Date.now() - t0 });
    // Honest "not available" — distinguishes a credential/API failure from a real empty account.
    return c.json({ indexes: [], available: false, reason: r.reason ?? `cf_${r.status}` });
  }
  const rows = (Array.isArray(r.result) ? r.result : []) as CfIndexRow[];
  const indexes = rows
    .map((i) => ({
      name: String(i?.name ?? ''),
      dimensions: i?.config?.dimensions ?? null,
      metric: i?.config?.metric ?? null,
      description: i?.description ?? null,
      created: i?.created_on ?? null,
      modified: i?.modified_on ?? null,
    }))
    .filter((i) => i.name);
  logVec(c, { route: 'vectorize/indexes', outcome: 'ok', count: indexes.length, latency_ms: Date.now() - t0 });
  return c.json({ indexes, available: true });
});

// ─── GET /api/admin/vectorize/indexes/:name ──────────────────────────────────
vectorizeInspector.get('/api/admin/vectorize/indexes/:name', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const parse = VectorizeIndexNameSchema.safeParse(c.req.param('name'));
  if (!parse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown index' } }, 404);
  }
  const name = parse.data;

  const t0 = Date.now();
  const r = await cfVectorize(c, `indexes/${name}`);
  if (r.status === 404) {
    logVec(c, { route: 'vectorize/index', outcome: 'miss', latency_ms: Date.now() - t0 });
    return c.json({ found: false, name }); // honest — the index doesn't exist
  }
  if (!r.ok) {
    logVec(c, { route: 'vectorize/index', outcome: 'unavailable', status: r.status, latency_ms: Date.now() - t0 });
    return c.json({ found: false, name, available: false, reason: r.reason ?? `cf_${r.status}` });
  }
  const idx = (r.result ?? {}) as CfIndexRow;
  // Vector count + freshness from /info — best-effort; omitted (null) honestly if unavailable.
  const info = await cfVectorize(c, `indexes/${name}/info`);
  const infoR = (info.ok ? info.result : null) as CfIndexInfo | null;
  logVec(c, { route: 'vectorize/index', outcome: 'ok', latency_ms: Date.now() - t0 });
  return c.json({
    found: true,
    name,
    dimensions: idx?.config?.dimensions ?? null,
    metric: idx?.config?.metric ?? null,
    description: idx?.description ?? null,
    created: idx?.created_on ?? null,
    modified: idx?.modified_on ?? null,
    vectorCount: infoR?.vectorCount ?? infoR?.vector_count ?? null,
    processedUpToMutation: infoR?.processedUpToMutation ?? null,
  });
});
