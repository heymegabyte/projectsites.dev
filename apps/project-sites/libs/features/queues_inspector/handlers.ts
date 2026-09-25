/**
 * @module libs/features/queues_inspector/handlers
 * @description Hono routes for the read-only Queues Inspector (flag: `queues_inspector`).
 *
 * | Method | Path                       | Auth        | Purpose                                       |
 * | ------ | -------------------------- | ----------- | --------------------------------------------- |
 * | GET    | /api/admin/queues          | super-admin | List the account's Cloudflare Queues          |
 * | GET    | /api/admin/queues/:id      | super-admin | Describe one queue (settings + producers/consumers) |
 *
 * Security model (mirrors kv/r2/vectorize_inspector):
 *   - 404 when the `queues_inspector` flag is off OR the caller is not a platform
 *     super-admin (never leak existence).
 *   - READ-ONLY: list + describe only. No publish / purge / delete is exposed.
 *   - Cloudflare credentials stay SERVER-side (`resolveCfCredentials` → the worker global
 *     key / token); the browser never sees an account token. The account is
 *     `env.CF_ACCOUNT_ID` (server-derived), NEVER client-supplied.
 *   - `:id` is a validated slug/hex (no REST-path injection). It is NOT an authz boundary —
 *     the super-admin gate is; an unknown id 404s from CF → honest `found:false`.
 *   - Queues are SHARED platform resources (job pipelines / workflow queues), not tenant-owned —
 *     a super-admin debug view, like the KV/R2/Vectorize inspectors.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { isSuperAdmin } from '../../../src/services/sysadmin.js';
import { resolveCfCredentials, cfAuthHeaders } from '../../../src/services/cf_credentials.js';
import { QueueIdSchema } from './schemas.js';

type AppContext = { Bindings: Env; Variables: Variables };

/** Feature flag key — 404 when off so feature existence is never leaked. */
const FLAG_KEY = 'queues_inspector' as const;

/** Subset of the Cloudflare Queues REST shapes we read. */
interface CfQueueEndpoint {
  type?: string;
  script?: string;
  service?: string;
}
interface CfQueueRow {
  queue_id?: string;
  queue_name?: string;
  created_on?: string | null;
  modified_on?: string | null;
  producers?: CfQueueEndpoint[];
  consumers?: CfQueueEndpoint[];
  settings?: { delivery_delay?: number; message_retention_period?: number } | null;
}

export const queuesInspector = new Hono<AppContext>();

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

/** Structured operational telemetry — never logs message data, only op shape + outcome + latency. */
function logQ(c: Context<AppContext>, fields: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'queues_inspector',
      request_id: c.get('requestId') ?? null,
      ...fields,
    }),
  );
}

/**
 * Call the Cloudflare account REST API server-side. Fail-soft — returns `{ ok:false, reason }`
 * (never throws) so a credential/API failure surfaces as an honest "not available".
 */
async function cfAccount(
  c: Context<AppContext>,
  path: string,
): Promise<{ status: number; ok: boolean; result: unknown; reason?: string }> {
  const auth = await resolveCfCredentials(c.env, null);
  const acct = c.env.CF_ACCOUNT_ID;
  if (!auth || !acct) return { status: 0, ok: false, result: null, reason: 'no_credentials' };
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/${path}`, {
      headers: { ...cfAuthHeaders(auth), 'Content-Type': 'application/json' },
    });
    const json = (await res.json().catch(() => null)) as { result?: unknown } | null;
    return { status: res.status, ok: res.ok, result: json?.result ?? null };
  } catch {
    return { status: 0, ok: false, result: null, reason: 'fetch_error' };
  }
}

/** Normalize a producer/consumer endpoint to `{ type, script }` (worker script or service). */
function endpoint(e: CfQueueEndpoint): { type: string; script: string | null } {
  return { type: String(e?.type ?? 'unknown'), script: e?.script ?? e?.service ?? null };
}

// ─── GET /api/admin/queues ───────────────────────────────────────────────────
queuesInspector.get('/api/admin/queues', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const t0 = Date.now();
  const r = await cfAccount(c, 'queues');
  if (!r.ok) {
    logQ(c, { route: 'queues', outcome: 'unavailable', status: r.status, reason: r.reason, latency_ms: Date.now() - t0 });
    return c.json({ queues: [], available: false, reason: r.reason ?? `cf_${r.status}` });
  }
  const rows = (Array.isArray(r.result) ? r.result : []) as CfQueueRow[];
  const queues = rows
    .map((q) => ({
      id: String(q?.queue_id ?? ''),
      name: String(q?.queue_name ?? ''),
      producers: (q?.producers ?? []).length,
      consumers: (q?.consumers ?? []).length,
      created: q?.created_on ?? null,
      modified: q?.modified_on ?? null,
    }))
    .filter((q) => q.id);
  logQ(c, { route: 'queues', outcome: 'ok', count: queues.length, latency_ms: Date.now() - t0 });
  return c.json({ queues, available: true });
});

// ─── GET /api/admin/queues/:id ───────────────────────────────────────────────
queuesInspector.get('/api/admin/queues/:id', async (c) => {
  const block = await gate(c);
  if (block) return block;

  const parse = QueueIdSchema.safeParse(c.req.param('id'));
  if (!parse.success) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Unknown queue' } }, 404);
  }
  const id = parse.data;

  const t0 = Date.now();
  const r = await cfAccount(c, `queues/${id}`);
  if (r.status === 404) {
    logQ(c, { route: 'queue', outcome: 'miss', latency_ms: Date.now() - t0 });
    return c.json({ found: false, id });
  }
  if (!r.ok) {
    logQ(c, { route: 'queue', outcome: 'unavailable', status: r.status, latency_ms: Date.now() - t0 });
    return c.json({ found: false, id, available: false, reason: r.reason ?? `cf_${r.status}` });
  }
  const q = (r.result ?? {}) as CfQueueRow;
  logQ(c, { route: 'queue', outcome: 'ok', latency_ms: Date.now() - t0 });
  return c.json({
    found: true,
    id,
    name: String(q?.queue_name ?? ''),
    created: q?.created_on ?? null,
    modified: q?.modified_on ?? null,
    settings: {
      deliveryDelaySeconds: q?.settings?.delivery_delay ?? null,
      messageRetentionSeconds: q?.settings?.message_retention_period ?? null,
    },
    producers: (q?.producers ?? []).map(endpoint),
    consumers: (q?.consumers ?? []).map(endpoint),
  });
});
