/**
 * @module libs/features/site_automations/handlers
 * @description Hono sub-application for the Automations panel (RES-AUTO slice 1).
 *
 * @remarks Mount in src/index.ts as:
 *   ```ts
 *   import { siteAutomations } from '../libs/features/site_automations/handlers.js';
 *   app.route('/', siteAutomations);
 *   ```
 *
 * Routes exposed:
 *   GET /api/sites/:siteId/automations
 *     Flag: site_automations — 404 if off (never 403 — existence never leaked)
 *     Auth: orgId from c.get('orgId') — 401 if missing
 *     Owner: assertSiteOwned — 404 if cross-org / missing (IDOR guard)
 *     Returns: { data: Automation[] } — the site's workflow_jobs rows, UI-shaped
 *
 *   POST /api/sites/:siteId/automations/:id/retry   (RES-AUTO slice 3 — the RETRY mutation)
 *     Flag: site_automations — 404 if off (gated identically to the GET)
 *     Auth: orgId from c.get('orgId') — 401 if missing
 *     Owner: assertSiteOwned — 404 if cross-org / missing (IDOR guard)
 *     Re-dispatches the site's SITE_WORKFLOW the SAME way POST /api/sites/:id/reset does
 *     (reDispatchSiteWorkflow). Refuses with 409 when a build is already in flight.
 *     Returns: { ok:true, status:'building' }
 *
 *   POST /api/sites/:siteId/automations/:id/cancel  (RES-AUTO slice 4 — the CANCEL mutation)
 *     Flag: site_automations — 404 if off (gated identically to the GET/retry)
 *     Auth: orgId from c.get('orgId') — 401 if missing
 *     Owner: assertSiteOwned — 404 if cross-org / missing (IDOR guard)
 *     Loads the owned `workflow_jobs` row; only a running/queued (in-flight) job is cancellable
 *     (409 otherwise). Flips the row to status='cancelled' + cancel_requested=1 and best-effort
 *     terminates the CF Workflow instance (cancelSiteWorkflow). Never fakes success.
 *     Returns: { ok:true, status:'cancelled' }
 */
import { Hono } from 'hono';
import { conflict } from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';
import { dbQueryOne } from '../../../src/services/db.js';
import {
  cancelSiteWorkflow,
  isCancellableJobStatus,
  listSiteAutomations,
  reDispatchSiteWorkflow,
  type CancellableJob,
  type RetryableSite,
} from './service.js';
import { CancelAutomationParams, RetryAutomationParams } from './schemas.js';

const FLAG_KEY = 'site_automations';

type AppContext = { Bindings: Env; Variables: Variables };

export const siteAutomations = new Hono<AppContext>();

/** GET /api/sites/:siteId/automations — list a site's automation/workflow instances. */
siteAutomations.get('/api/sites/:siteId/automations', async (c) => {
  // ── Feature flag gate ────────────────────────────────────────────────────
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
  }

  // ── Ownership check (IDOR guard) ─────────────────────────────────────────
  const { siteId } = c.req.param();
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // ── Read the store + respond ─────────────────────────────────────────────
  const data = await listSiteAutomations(c.env, siteId);
  return c.json({ data }, 200);
});

/**
 * POST /api/sites/:siteId/automations/:id/retry — re-run a (typically FAILED) automation
 * by re-dispatching the site's generation workflow, exactly as `POST /api/sites/:id/reset`
 * does. Gated by the SAME flag as the GET (404 when off); IDOR-guarded via assertSiteOwned;
 * refuses (409) when a build is already in flight so a double-click can't spawn two builds.
 */
siteAutomations.post('/api/sites/:siteId/automations/:id/retry', async (c) => {
  // ── Feature flag gate (identical to the GET — never leaks existence) ──────
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
  }

  // ── Validate params (Zod boundary) ───────────────────────────────────────
  const parsed = RetryAutomationParams.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ error: { code: 'BAD_REQUEST' } }, 400);
  }
  const { siteId, id: automationId } = parsed.data;

  // ── Ownership check (IDOR guard) ─────────────────────────────────────────
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // Load the owned site's fields the re-dispatch re-threads into the workflow.
  const site = await dbQueryOne<RetryableSite>(
    c.env.DB,
    `SELECT id, slug, business_name, business_address, business_category,
            business_phone, business_email, business_hours, google_place_id,
            budget_tier, status
       FROM sites
      WHERE id = ? AND deleted_at IS NULL`,
    [siteId],
  );
  if (!site) {
    // Owned per assertSiteOwned but no live row (soft-deleted / race) → 404.
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // In-flight build guard (mirrors reset) — refuse a second concurrent $-costly build.
  if (site.status === 'building' || site.status === 'generating') {
    throw conflict(
      'A build is already in progress for this site. Wait for it to finish before re-running.',
    );
  }

  // ── Re-dispatch the workflow (same mechanism as reset) ───────────────────
  const result = await reDispatchSiteWorkflow(c.env, site, {
    orgId,
    actorId: c.get('userId') ?? null,
    requestId: c.get('requestId') ?? null,
    automationId,
  });

  return c.json({ ok: true, status: result.status }, 200);
});

/**
 * POST /api/sites/:siteId/automations/:id/cancel — cancel a RUNNING/QUEUED automation. The MIRROR
 * of the retry route (same gate order): flip the owned `workflow_jobs` row to the terminal
 * `cancelled` state + raise `cancel_requested`, then best-effort terminate the CF Workflow instance
 * (cancelSiteWorkflow). Gated by the SAME flag as the GET/retry (404 when off); IDOR-guarded via
 * assertSiteOwned; refuses (409) when the job is already terminal (success/failed/cancelled) so a
 * stale click can't "cancel" a finished job. Never fakes success — the row flip is authoritative.
 */
siteAutomations.post('/api/sites/:siteId/automations/:id/cancel', async (c) => {
  // ── Feature flag gate (identical to the GET/retry — never leaks existence) ──
  if (!(await isFlagOn(c.env, FLAG_KEY, {}))) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  const orgId = c.get('orgId');
  if (!orgId) {
    return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
  }

  // ── Validate params (Zod boundary) ───────────────────────────────────────
  const parsed = CancelAutomationParams.safeParse(c.req.param());
  if (!parsed.success) {
    return c.json({ error: { code: 'BAD_REQUEST' } }, 400);
  }
  const { siteId, id: automationId } = parsed.data;

  // ── Ownership check (IDOR guard) ─────────────────────────────────────────
  if (!(await assertSiteOwned(c.env, orgId, siteId))) {
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // Load the targeted job, hard-scoped to the OWNED site so another site's job can't be cancelled.
  const job = await dbQueryOne<CancellableJob>(
    c.env.DB,
    `SELECT id, site_id, status
       FROM workflow_jobs
      WHERE id = ? AND site_id = ? AND deleted_at IS NULL`,
    [automationId, siteId],
  );
  if (!job) {
    // Owned site per assertSiteOwned, but no such job row for it → 404 (not a cross-tenant leak).
    return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  }

  // Only an in-flight job is cancellable — a terminal row can't be "cancelled" (mirrors retry's 409).
  if (!isCancellableJobStatus(job.status)) {
    throw conflict(
      `This automation is already ${job.status} — only a running or queued automation can be cancelled.`,
    );
  }

  // Resolve the slug for a human audit message (best-effort; never blocks the cancel).
  const site = await dbQueryOne<{ slug: string | null }>(
    c.env.DB,
    'SELECT slug FROM sites WHERE id = ? LIMIT 1',
    [siteId],
  );

  const result = await cancelSiteWorkflow(c.env, siteId, job, {
    orgId,
    actorId: c.get('userId') ?? null,
    requestId: c.get('requestId') ?? null,
    slug: site?.slug ?? null,
  });

  return c.json({ ok: true, status: result.status }, 200);
});
