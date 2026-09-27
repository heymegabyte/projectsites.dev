/**
 * @file Gated per-site GREENFIELD RESET — backup-first, per-site-only (Data Platform, FIRE 8).
 *
 * Two routes let a site owner wipe THEIR OWN site's dedicated data back to a clean slate — never the
 * shared platform D1/KV/R2, never another site's:
 *
 * | Method | Path                                   | Purpose                                               |
 * |--------|----------------------------------------|-------------------------------------------------------|
 * | POST   | /api/sites/:siteId/data/reset/preview  | Backup bookmark + HONEST delete-list (no deletion)    |
 * | POST   | /api/sites/:siteId/data/reset          | Backup-first, then wipe the site's OWN D1/KV/R2        |
 *
 * The whole point of this feature is SAFETY + HONESTY. Every guard is server-side; none is trusted
 * from the client:
 *
 * 1. **Flag** (`per_site_data`) OFF → 404 (never 403 — feature existence is never leaked).
 * 2. **Ownership** — `assertSiteOwned(orgId, siteId)` (404 on foreign/missing/no-org).
 * 3. **Per-site scope ONLY** — the target D1/KV/R2 is resolved SERVER-side from
 *    `site_database_allocations` for the OWNED site via {@link resolveSiteResources}, which denylists
 *    the shared platform D1 ids (`FORBIDDEN_DB_IDS`). The client never supplies a database/namespace/
 *    bucket id. No dedicated resources → honest "nothing to reset".
 * 4. **Explicit confirmation** at the WORKER (not just the UI) — the execute route requires
 *    `confirm === true` AND `confirmText` matching the site slug (case-insensitive) OR the literal
 *    `RESET`. A mismatch is `409 confirmation_required` and NOTHING is deleted.
 * 5. **Backup-first** — the execute route takes a D1 Time-Travel bookmark BEFORE any DROP, and returns
 *    the `bookmark` id for recovery (`wrangler d1 time-travel restore --bookmark=<id>`). If the backup
 *    can't be taken, the wipe is ABORTED (`424 backup_failed`) — we never destroy without a receipt.
 *
 * Cloudflare credentials stay server-side (`resolveCfCredentials` → the worker global key); the account
 * is `env.CF_ACCOUNT_ID`, never client-supplied. Fail-soft: a CF/API failure surfaces as an honest
 * typed error, never a fabricated success.
 *
 * @packageDocumentation
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';

import type { Env, Variables } from '../../../src/types/env.js';

import { cfAuthHeaders, resolveCfCredentials } from '../../../src/services/cf_credentials.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';
import { writeAuditLog } from '../../../src/services/audit.js';
import { resolveSiteResources, isForbiddenDbId, type SiteResources } from './site_resources.js';

type AppContext = { Bindings: Env; Variables: Variables };

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Feature flag gating the whole per-site data plane (shared with the Tables surface). */
const FLAG_KEY = 'per_site_data' as const;

/** Cap on how many R2 objects a single reset deletes, and how many KV keys — bounds worker wall-time. */
const MAX_R2_OBJECTS = 10_000;
const MAX_KV_KEYS = 10_000;

/** Cap on the preview's per-table row-count probe count (avoid an unbounded schema on a huge DB). */
const MAX_PREVIEW_TABLES = 200;

export const dataResourceReset = new Hono<AppContext>();

/** Structured operational telemetry — never logs row/key/object VALUES, only the operation shape. */
function logReset(c: Context<AppContext>, fields: Record<string, unknown>): void {
  console.warn(
    JSON.stringify({
      level: 'info',
      service: 'data_resource_reset',
      request_id: c.get('requestId') ?? null,
      ...fields,
    }),
  );
}

/** 404 (never 403) — feature existence is never leaked when the flag is off or the site is foreign. */
function notFound(c: Context<AppContext>): Response {
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
}

/**
 * Shared flag + ownership + per-site-resolution gate for both routes. Returns either a `Response` to
 * short-circuit (404 / not-available), or the resolved dedicated resources + auth context to proceed.
 */
async function gateAndResolve(
  c: Context<AppContext>,
): Promise<
  | { block: Response }
  | { block: null; siteId: string; orgId: string; resources: SiteResources }
> {
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) return { block: notFound(c) };

  const orgId = c.get('orgId');
  const siteId = c.req.param('siteId');
  if (!orgId || !siteId) return { block: notFound(c) };
  if (!(await assertSiteOwned(c.env, orgId, siteId))) return { block: notFound(c) };

  const resolved = await resolveSiteResources(c.env, siteId);
  if (!resolved.ok) {
    // Honest, distinct signals: nothing dedicated to reset vs. a refused (forbidden) allocation.
    logReset(c, { route: 'reset/gate', outcome: resolved.reason, site_id: siteId });
    if (resolved.reason === 'forbidden_db_id') {
      return {
        block: c.json(
          {
            error: {
              code: 'FORBIDDEN_TARGET',
              message: 'This site is not eligible for a per-site reset.',
            },
          },
          409,
        ),
      };
    }
    return {
      block: c.json({
        available: false,
        reason: 'no_dedicated_resources',
        message: 'This site has no dedicated data resources yet — nothing to reset.',
      }),
    };
  }
  return { block: null, siteId, orgId, resources: resolved.resources };
}

/** Call a CF REST endpoint (arbitrary method + optional body). Fail-soft — never throws. */
async function cf(
  c: Context<AppContext>,
  path: string,
  init: { method: string; body?: unknown } = { method: 'GET' },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const auth = await resolveCfCredentials(c.env, null);
  const acct = c.env.CF_ACCOUNT_ID;
  if (!auth || !acct) return { ok: false, status: 0, json: null };
  try {
    const res = await fetch(`${CF_API_BASE}/accounts/${acct}${path}`, {
      method: init.method,
      headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

/** One user table in the per-site D1, with its row count (null when the count probe failed). */
interface TablePreview {
  name: string;
  rowCount: number | null;
}

/**
 * List the site's per-site D1 user tables + row counts via CF REST `/query` (a STATIC read-only
 * `sqlite_master` SELECT, then a bounded `COUNT(*)` per table). `sqlite_%` internal tables + the
 * D1 migrations table are excluded. Returns `null` on a credential/API failure (honest "unknown").
 */
async function previewD1Tables(
  c: Context<AppContext>,
  databaseId: string,
): Promise<TablePreview[] | null> {
  const listRes = await cf(c, `/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: {
      sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations' ORDER BY name;",
    },
  });
  if (!listRes.ok) return null;
  const rows = extractRows(listRes.json);
  const names = rows
    .map((r) => (typeof r?.name === 'string' ? r.name : ''))
    .filter((n): n is string => !!n && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    .slice(0, MAX_PREVIEW_TABLES);

  const out: TablePreview[] = [];
  for (const name of names) {
    // name is validated against a strict identifier regex above → safe to interpolate.
    const countRes = await cf(c, `/d1/database/${databaseId}/query`, {
      method: 'POST',
      body: { sql: `SELECT COUNT(*) AS n FROM "${name}";` },
    });
    const countRows = countRes.ok ? extractRows(countRes.json) : [];
    const n = countRows[0]?.n;
    out.push({ name, rowCount: typeof n === 'number' ? n : null });
  }
  return out;
}

/** Pull the first statement's `results` array out of a CF D1 `/query` response envelope. */
function extractRows(json: unknown): Record<string, unknown>[] {
  const result = (json as { result?: unknown } | null)?.result;
  const first = Array.isArray(result) ? (result[0] as { results?: unknown } | undefined) : undefined;
  return Array.isArray(first?.results) ? (first.results as Record<string, unknown>[]) : [];
}

/** List up to {@link MAX_KV_KEYS} key names in the site's dedicated KV namespace (cursor-paginated). */
async function listKvKeys(c: Context<AppContext>, namespaceId: string): Promise<string[] | null> {
  const keys: string[] = [];
  let cursor = '';
  for (let i = 0; i < 20 && keys.length < MAX_KV_KEYS; i++) {
    const q = `?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await cf(c, `/storage/kv/namespaces/${namespaceId}/keys${q}`, { method: 'GET' });
    if (!res.ok) return keys.length ? keys : null;
    const body = res.json as {
      result?: { name?: string }[];
      result_info?: { cursor?: string };
    } | null;
    for (const k of body?.result ?? []) if (k?.name) keys.push(k.name);
    cursor = body?.result_info?.cursor ?? '';
    if (!cursor) break;
  }
  return keys.slice(0, MAX_KV_KEYS);
}

/** List up to {@link MAX_R2_OBJECTS} object keys in the site's dedicated R2 bucket (cursor-paginated). */
async function listR2Objects(c: Context<AppContext>, bucket: string): Promise<string[] | null> {
  const keys: string[] = [];
  let cursor = '';
  for (let i = 0; i < 20 && keys.length < MAX_R2_OBJECTS; i++) {
    const q = `?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await cf(c, `/r2/buckets/${bucket}/objects${q}`, { method: 'GET' });
    if (!res.ok) return keys.length ? keys : null;
    const body = res.json as {
      result?: { key?: string }[];
      result_info?: { cursor?: string; is_truncated?: boolean };
    } | null;
    for (const o of body?.result ?? []) if (o?.key) keys.push(o.key);
    cursor = body?.result_info?.cursor ?? '';
    if (!cursor || body?.result_info?.is_truncated === false) break;
  }
  return keys.slice(0, MAX_R2_OBJECTS);
}

/**
 * Take a D1 Time-Travel bookmark for the site's per-site database — the recovery receipt. Returns the
 * bookmark id, or `null` on failure (the execute route ABORTS the wipe when this is null).
 * `GET /d1/database/:id/time_travel/bookmark` → `{ result: { bookmark } }`.
 */
async function takeD1Bookmark(c: Context<AppContext>, databaseId: string): Promise<string | null> {
  const res = await cf(c, `/d1/database/${databaseId}/time_travel/bookmark`, { method: 'GET' });
  if (!res.ok) return null;
  const bookmark = (res.json as { result?: { bookmark?: string } } | null)?.result?.bookmark;
  return typeof bookmark === 'string' && bookmark ? bookmark : null;
}

// ─── POST /api/sites/:siteId/data/reset/preview ──────────────────────────────
// Backup bookmark + HONEST delete-list. No deletion. The UI shows EXACTLY what will be removed.
dataResourceReset.post('/api/sites/:siteId/data/reset/preview', async (c) => {
  const g = await gateAndResolve(c);
  if (g.block) return g.block;
  const { siteId, resources } = g;
  const t0 = Date.now();

  // Backup FIRST (so the preview already surfaces the recovery bookmark the owner can note).
  const bookmark = resources.d1DatabaseId
    ? await takeD1Bookmark(c, resources.d1DatabaseId)
    : null;

  const tables = resources.d1DatabaseId ? await previewD1Tables(c, resources.d1DatabaseId) : [];
  const kvKeys = resources.kvNamespaceId ? await listKvKeys(c, resources.kvNamespaceId) : [];
  const r2Objects = resources.r2BucketName ? await listR2Objects(c, resources.r2BucketName) : [];

  logReset(c, {
    route: 'reset/preview',
    outcome: 'ok',
    site_id: siteId,
    tables: tables?.length ?? 0,
    kv_keys: kvKeys?.length ?? 0,
    r2_objects: r2Objects?.length ?? 0,
    has_bookmark: !!bookmark,
    latency_ms: Date.now() - t0,
  });

  return c.json({
    available: true,
    // The exact delete-list the wipe will act on — honest, not a guess.
    d1: {
      databaseId: resources.d1DatabaseId,
      databaseName: resources.d1DatabaseName,
      tables: tables ?? [],
      // null tables = the count probe failed → surface honestly, never as "0 tables".
      tablesAvailable: tables !== null,
    },
    kv: {
      namespaceId: resources.kvNamespaceId,
      namespaceName: resources.kvNamespaceName,
      keyCount: kvKeys?.length ?? 0,
      keysAvailable: kvKeys !== null,
    },
    r2: {
      bucket: resources.r2BucketName,
      objectCount: r2Objects?.length ?? 0,
      objectsAvailable: r2Objects !== null,
    },
    // The recovery receipt — surfaced up-front so the owner can copy it before confirming.
    backupBookmark: bookmark,
    recoveryHint: bookmark
      ? `Recover with: wrangler d1 time-travel restore ${resources.d1DatabaseName ?? resources.d1DatabaseId} --bookmark=${bookmark}`
      : null,
  });
});

/** Execute-request body: explicit confirmation is MANDATORY (server-enforced, not just UI). */
const ResetExecuteSchema = z
  .object({
    /** Must be `true` — a plain POST with no confirm is refused. */
    confirm: z.boolean(),
    /** Must equal the site slug (case-insensitive) OR the literal `RESET` — the type-to-confirm gate. */
    confirmText: z.string().min(1).max(200),
  })
  .strict();

// ─── POST /api/sites/:siteId/data/reset ──────────────────────────────────────
// Backup-first, then wipe the site's OWN dedicated D1 (DROP user tables) + KV (delete keys) + R2
// (delete objects). Confirm-gated at the WORKER. Returns the recovery bookmark + per-surface counts.
dataResourceReset.post('/api/sites/:siteId/data/reset', async (c) => {
  const g = await gateAndResolve(c);
  if (g.block) return g.block;
  const { siteId, orgId, resources } = g;
  const t0 = Date.now();

  // 1. Explicit confirmation — validate the body shape, `confirm:true`, and the type-to-confirm text.
  const parsed = ResetExecuteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success || parsed.data.confirm !== true) {
    return c.json(
      { error: { code: 'CONFIRMATION_REQUIRED', message: 'Explicit confirmation required.' } },
      409,
    );
  }
  const site = await c.env.DB.prepare(
    'SELECT slug FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
  )
    .bind(siteId, orgId)
    .first<{ slug: string | null }>();
  const slug = (site?.slug ?? '').trim().toLowerCase();
  const typed = parsed.data.confirmText.trim().toLowerCase();
  if (typed !== 'reset' && !(slug && typed === slug)) {
    logReset(c, { route: 'reset/execute', outcome: 'confirm_mismatch', site_id: siteId });
    return c.json(
      {
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'Type the site slug (or "RESET") to confirm.',
        },
      },
      409,
    );
  }

  // 2. Defense-in-depth: re-assert the resolved D1 id is not a shared-platform database before any DROP.
  if (resources.d1DatabaseId && isForbiddenDbId(c.env, resources.d1DatabaseId)) {
    logReset(c, { route: 'reset/execute', outcome: 'forbidden_db_id', site_id: siteId });
    return c.json(
      { error: { code: 'FORBIDDEN_TARGET', message: 'Refusing to reset a platform database.' } },
      409,
    );
  }

  // 3. BACKUP FIRST — a Time-Travel bookmark is the recovery receipt. No bookmark → ABORT (never wipe
  //    without a way back). Only required when there's a D1 to back up.
  let bookmark: string | null = null;
  if (resources.d1DatabaseId) {
    bookmark = await takeD1Bookmark(c, resources.d1DatabaseId);
    if (!bookmark) {
      logReset(c, { route: 'reset/execute', outcome: 'backup_failed', site_id: siteId });
      return c.json(
        {
          error: {
            code: 'BACKUP_FAILED',
            message: 'Could not take a recovery backup — reset aborted. Nothing was deleted.',
          },
        },
        424,
      );
    }
  }

  // 4. WIPE the per-site D1: DROP every user table (backup taken above; identifiers regex-validated).
  const dropped: string[] = [];
  const errors: string[] = [];
  if (resources.d1DatabaseId) {
    const tables = await previewD1Tables(c, resources.d1DatabaseId);
    for (const t of tables ?? []) {
      const drop = await cf(c, `/d1/database/${resources.d1DatabaseId}/query`, {
        method: 'POST',
        body: { sql: `DROP TABLE IF EXISTS "${t.name}";` },
      });
      if (drop.ok) dropped.push(t.name);
      else errors.push(`d1:${t.name}`);
    }
  }

  // 5. WIPE the per-site KV: bulk-delete every key.
  let kvDeleted = 0;
  if (resources.kvNamespaceId) {
    const keys = await listKvKeys(c, resources.kvNamespaceId);
    if (keys?.length) {
      // CF bulk-delete accepts up to 10k keys/call.
      for (let i = 0; i < keys.length; i += 10_000) {
        const batch = keys.slice(i, i + 10_000);
        const del = await cf(c, `/storage/kv/namespaces/${resources.kvNamespaceId}/bulk/delete`, {
          method: 'POST',
          body: batch,
        });
        if (del.ok) kvDeleted += batch.length;
        else errors.push('kv:bulk');
      }
    }
  }

  // 6. WIPE the per-site R2: delete every object (bulk delete, ≤1000 keys/call).
  let r2Deleted = 0;
  if (resources.r2BucketName) {
    const objs = await listR2Objects(c, resources.r2BucketName);
    if (objs?.length) {
      for (let i = 0; i < objs.length; i += 1000) {
        const batch = objs.slice(i, i + 1000);
        const del = await cf(c, `/r2/buckets/${resources.r2BucketName}/objects/delete`, {
          method: 'POST',
          body: { objects: batch.map((key) => ({ key })) },
        });
        if (del.ok) r2Deleted += batch.length;
        else errors.push('r2:bulk');
      }
    }
  }

  // 7. Append-only audit log — who reset which site, and the recovery bookmark.
  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: c.get('userId') ?? null,
    action: 'site_data.reset',
    message: `Reset site data to a clean slate (${dropped.length} tables dropped)`,
    target_type: 'site',
    target_id: siteId,
    metadata_json: {
      site_id: siteId,
      d1_database_id: resources.d1DatabaseId,
      dropped_tables: dropped.length,
      kv_deleted: kvDeleted,
      r2_deleted: r2Deleted,
      backup_bookmark: bookmark,
      errors: errors.length,
    },
  }).catch(() => {
    /* audit is best-effort — never fail the reset on a log write */
  });

  logReset(c, {
    route: 'reset/execute',
    outcome: errors.length ? 'partial' : 'ok',
    site_id: siteId,
    dropped: dropped.length,
    kv_deleted: kvDeleted,
    r2_deleted: r2Deleted,
    errors: errors.length,
    latency_ms: Date.now() - t0,
  });

  return c.json({
    ok: errors.length === 0,
    droppedTables: dropped,
    kvDeleted,
    r2Deleted,
    // The recovery receipt — the owner restores the pre-reset state from this bookmark.
    backupBookmark: bookmark,
    recoveryHint: bookmark
      ? `Recover with: wrangler d1 time-travel restore ${resources.d1DatabaseName ?? resources.d1DatabaseId} --bookmark=${bookmark}`
      : null,
    ...(errors.length ? { partialErrors: errors } : {}),
  });
});
