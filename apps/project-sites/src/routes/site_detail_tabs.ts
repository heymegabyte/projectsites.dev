/**
 * Per-project tab endpoints for `/admin/sites/:id`.
 *
 * Closes TEST-PLAN.md TAB-01..TAB-13 by exposing:
 *
 *   GET    /api/sites/:siteId/logs/tail                  — polled live tail
 *   POST   /api/sites/:siteId/snapshots/:snapId/rollback — promote snapshot to current
 *   POST   /api/sites/:siteId/sql/exec                   — read-only D1 console
 *   GET    /api/sites/:siteId/integration-providers      — per-site MCP providers
 *   DELETE /api/sites/:siteId/integration-providers/:key — disconnect MCP provider
 *
 * Auth-required, org-scoped via the existing `authMiddleware` on `/api/*`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, Variables } from '../types/env.js';
import { internalError } from '@project-sites/shared';
import { dbQuery, dbQueryOne, dbExecute } from '../services/db.js';
import { writeAuditLog } from '../services/audit.js';
import { isSuperAdmin } from '../services/sysadmin.js';

const tabs = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sites/:siteId/logs/tail
// Returns the latest 200 log rows for the site (audit + workflow_jobs union).
// Angular client polls every 3s; native WS upgrade is a future step.
// ─────────────────────────────────────────────────────────────────────────────
tabs.get('/api/sites/:siteId/logs/tail', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  const rows = await dbQuery<{
    created_at: string;
    actor_id: string | null;
    action: string;
    target_id: string | null;
    message: string | null;
    metadata_json: string | null;
  }>(
    c.env.DB,
    `SELECT created_at, actor_id, action, target_id, message, metadata_json
       FROM audit_logs
      WHERE org_id = ?1 AND target_id = ?2
      ORDER BY created_at DESC
      LIMIT 200`,
    [orgId, siteId],
  );

  const logs = (rows.data ?? []).map((r) => ({
    ts: r.created_at,
    level: r.action.includes('error') ? 'error' : r.action.includes('warn') ? 'warn' : 'info',
    source: r.actor_id ?? 'system',
    message: r.message ?? r.action,
  }));

  return c.json({ logs });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sites/:siteId/snapshots/:snapshotId/rollback
// Promote the named snapshot to the live serving slot + write audit row.
// ─────────────────────────────────────────────────────────────────────────────
tabs.post('/api/sites/:siteId/snapshots/:snapshotId/rollback', async (c) => {
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }

  const snap = await dbQueryOne<{ id: string; snapshot_name: string }>(
    c.env.DB,
    `SELECT id, snapshot_name
       FROM site_snapshots
      WHERE id = ?1 AND site_id = ?2 AND deleted_at IS NULL`,
    [snapshotId, siteId],
  );
  if (!snap) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
  }

  // The actual R2 path copy + KV invalidation happens in the deploy worker
  // (see site_serving.ts). Here we record the intent + bump the site's
  // updated_at so polling clients see the change.
  const { error: rollbackErr } = await dbExecute(
    c.env.DB,
    `UPDATE sites SET updated_at = datetime('now') WHERE id = ?1 AND org_id = ?2`,
    [siteId, orgId],
  );
  // Pre-guarded (snapshot loaded + org-scoped WHERE) — surface a DB failure instead
  // of a lying "rollback recorded" that polling clients would act on.
  if (rollbackErr) throw internalError(`Failed to record rollback: ${rollbackErr}`);

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'site.snapshot.rollback',
    target_type: 'site',
    target_id: siteId,
    message: `Rolled back to ${snap.snapshot_name}`,
    metadata_json: { snapshot_id: snap.id, snapshot_name: snap.snapshot_name },
  });

  return c.json({ ok: true, snapshot_name: snap.snapshot_name });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/sites/:siteId/snapshots/:snapshotId
// Rename a snapshot and/or set its description. `snapshots.component.ts`'s create
// dialog dropped the user-facing description field (auto-generated) and DOCUMENTS
// this endpoint as the operator escape-hatch ("Operators who need a custom note can
// still PATCH the row via the API `PATCH /sites/:id/snapshots/:snapId`") — but the
// route did not exist and returned 404, a documented-but-dead capability. This makes
// it real. Org-scoped (IDOR guard on the site); UNIQUE(site_id, snapshot_name)
// collision → clean 409 (never a swallowed 500); at least one field required.
// ─────────────────────────────────────────────────────────────────────────────
const PatchSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(240).optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined, {
    message: 'name or description required',
  });

tabs.patch('/api/sites/:siteId/snapshots/:snapshotId', async (c) => {
  const siteId = c.req.param('siteId');
  const snapshotId = c.req.param('snapshotId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }

  const parsed = PatchSnapshotSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'name or description required' } }, 400);
  }
  const { name, description } = parsed.data;

  // IDOR guard: the site must belong to the caller's org before we touch its rows.
  const site = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!site) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
  }

  const snap = await dbQueryOne<{ id: string; snapshot_name: string }>(
    c.env.DB,
    `SELECT id, snapshot_name FROM site_snapshots
      WHERE id = ?1 AND site_id = ?2 AND deleted_at IS NULL`,
    [snapshotId, siteId],
  );
  if (!snap) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot not found' } }, 404);
  }

  // Pre-check UNIQUE(site_id, snapshot_name) so a rename collision is a clean 409,
  // not a swallowed SQL error surfaced as a generic 500.
  if (name && name !== snap.snapshot_name) {
    const clash = await dbQueryOne<{ id: string }>(
      c.env.DB,
      `SELECT id FROM site_snapshots
        WHERE site_id = ?1 AND snapshot_name = ?2 AND id != ?3 AND deleted_at IS NULL`,
      [siteId, name, snapshotId],
    );
    if (clash) {
      return c.json(
        { error: { code: 'CONFLICT', message: `A snapshot named "${name}" already exists` } },
        409,
      );
    }
  }

  const { error: updErr } = await dbExecute(
    c.env.DB,
    `UPDATE site_snapshots
        SET snapshot_name = COALESCE(?1, snapshot_name),
            description   = COALESCE(?2, description),
            updated_at    = datetime('now')
      WHERE id = ?3 AND site_id = ?4`,
    [name ?? null, description ?? null, snapshotId, siteId],
  );
  if (updErr) throw internalError(`Failed to update snapshot: ${updErr}`);

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'site.snapshot.updated',
    target_type: 'site',
    target_id: siteId,
    message: `Snapshot '${snap.snapshot_name}' updated${name && name !== snap.snapshot_name ? ` → '${name}'` : ''}`,
    metadata_json: {
      snapshot_id: snapshotId,
      renamed: !!(name && name !== snap.snapshot_name),
      described: description !== undefined,
    },
  });

  // Re-read so the response reflects exactly what persisted (never a lying echo).
  const updated = await dbQueryOne<{
    id: string;
    snapshot_name: string;
    description: string | null;
  }>(
    c.env.DB,
    `SELECT id, snapshot_name, description FROM site_snapshots WHERE id = ?1 AND site_id = ?2`,
    [snapshotId, siteId],
  );
  return c.json({ data: updated });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/sites/:siteId/sql/exec
// Read-only D1 console. Rejects DDL/DML; allowlist: SELECT, EXPLAIN, WITH, PRAGMA.
// ─────────────────────────────────────────────────────────────────────────────
const SqlExecSchema = z.object({
  query: z.string().min(1).max(8_000),
});

const READONLY_PREFIX = /^\s*(SELECT|EXPLAIN|WITH|PRAGMA)\b/i;
const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|REINDEX|VACUUM|REPLACE|TRUNCATE)\b/i;

tabs.post('/api/sites/:siteId/sql/exec', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }

  // The raw D1 console reads the SHARED multi-tenant database — restrict it to platform
  // administrators (a site owner must never be able to `SELECT * FROM users`). AL-792.
  if (!(await isSuperAdmin(c.env, userId))) {
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'The SQL console is restricted to platform administrators.',
        },
      },
      403,
    );
  }

  let body: { query: string };
  try {
    body = SqlExecSchema.parse(await c.req.json().catch(() => ({})));
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'invalid body' }, 400);
  }

  const q = body.query.trim();
  if (!READONLY_PREFIX.test(q)) {
    return c.json(
      { ok: false, error: 'read-only: only SELECT / EXPLAIN / WITH / PRAGMA allowed' },
      400,
    );
  }
  if (FORBIDDEN_KEYWORDS.test(q)) {
    return c.json({ ok: false, error: 'DDL not allowed' }, 400);
  }

  // Org-scope check: site must belong to the caller's org.
  const site = await dbQueryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!site) {
    return c.json({ ok: false, error: 'site not found' }, 404);
  }

  const t0 = Date.now();
  try {
    const result = await c.env.DB.prepare(q).all();
    const rows = (result.results ?? []) as Array<Record<string, unknown>>;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    await writeAuditLog(c.env.DB, {
      org_id: orgId,
      actor_id: userId,
      action: 'site.sql.exec',
      target_type: 'site',
      target_id: siteId,
      message: 'SQL query executed',
      metadata_json: { query: q.slice(0, 200), rowcount: rows.length },
    });
    return c.json({
      ok: true,
      columns,
      rows,
      duration_ms: Date.now() - t0,
    });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : 'query failed' }, 400);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/sites/:siteId/integrations
// Lists MCP providers + their connection status for this site.
// ─────────────────────────────────────────────────────────────────────────────
const PROVIDERS: Array<{ key: string; name: string; oauth_supported: boolean }> = [
  { key: 'mailchimp', name: 'Mailchimp', oauth_supported: true },
  { key: 'stripe', name: 'Stripe', oauth_supported: true },
  { key: 'hubspot', name: 'HubSpot', oauth_supported: true },
  { key: 'github', name: 'GitHub', oauth_supported: true },
  { key: 'slack', name: 'Slack', oauth_supported: true },
  { key: 'notion', name: 'Notion', oauth_supported: true },
  { key: 'resend', name: 'Resend', oauth_supported: false },
];

tabs.get('/api/sites/:siteId/integration-providers', async (c) => {
  const siteId = c.req.param('siteId');
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  // Org-scope the site. This handler used to sit at `/integrations`, where the
  // newsletter-integrations route (forms.ts, registered first) SHADOWED it — so it
  // never ran and its missing ownership check was harmless. On its own
  // `/integration-providers` path it is reachable, so it MUST verify the site
  // belongs to the caller's org (else any authed user could read another org's
  // per-site provider status by guessing siteId).
  const owned = await dbQueryOne(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!owned) return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const conns = await dbQuery<{ provider: string }>(
    c.env.DB,
    `SELECT provider FROM mcp_connections
      WHERE site_id = ?1 AND deleted_at IS NULL`,
    [siteId],
  );
  const connected = new Set((conns.data ?? []).map((r) => r.provider));

  const providers = PROVIDERS.map((p) => ({
    ...p,
    status: connected.has(p.key) ? ('connected' as const) : ('disconnected' as const),
  }));

  return c.json({ providers });
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/sites/:siteId/integration-providers/:key
// Soft-delete the mcp_connections row for this site + provider.
// ─────────────────────────────────────────────────────────────────────────────
tabs.delete('/api/sites/:siteId/integration-providers/:key', async (c) => {
  const siteId = c.req.param('siteId');
  const provider = c.req.param('key');
  const orgId = c.get('orgId');
  const userId = c.get('userId');
  if (!orgId || !userId) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } }, 401);
  }
  const owned = await dbQueryOne(
    c.env.DB,
    `SELECT id FROM sites WHERE id = ?1 AND org_id = ?2 AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!owned) return c.json({ error: { code: 'NOT_FOUND', message: 'Site not found' } }, 404);

  const { error: disconnectErr } = await dbExecute(
    c.env.DB,
    `UPDATE mcp_connections
        SET deleted_at = datetime('now')
      WHERE site_id = ?1 AND provider = ?2 AND deleted_at IS NULL`,
    [siteId, provider],
  );
  // Site ownership is pre-guarded above. changes===0 is a VALID idempotent success
  // here (the provider was already disconnected) — NOT a 404. Only surface a real
  // DB error so a failed disconnect never reports success.
  if (disconnectErr) throw internalError(`Failed to disconnect integration: ${disconnectErr}`);

  await writeAuditLog(c.env.DB, {
    org_id: orgId,
    actor_id: userId,
    action: 'site.integrations.disconnect',
    target_type: 'site',
    target_id: siteId,
    message: `Disconnected ${provider}`,
    metadata_json: { provider },
  });

  return c.json({ ok: true });
});

export { tabs as siteDetailTabs };
