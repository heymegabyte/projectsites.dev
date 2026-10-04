/**
 * @module libs/features/site_automations/service
 * @description Read-only data layer for the Automations panel — lists a site's
 * workflow/automation instances from the `workflow_jobs` D1 table (the system
 * of record for every dispatched job). Display reconciles with the store: real
 * rows map 1:1 to list items; an honest-empty store yields `[]`
 * (per [[verify-against-source-of-truth]]).
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';
import { dbQuery } from '../../../src/services/db.js';
import { writeAuditLog } from '../../../src/services/audit.js';
import type { Automation } from './schemas.js';

/** Raw `workflow_jobs` row columns this feature reads. */
interface WorkflowJobRow {
  id: string;
  job_name: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

/** Max rows returned — the panel is a recent-activity list, not a full export. */
const LIMIT = 200;

/**
 * List a site's automation/workflow instances, newest first, shaped for the UI.
 *
 * Ownership is the CALLER's responsibility (`assertSiteOwned` in the handler);
 * this query is still hard-scoped to `site_id = ?` so a bug upstream can't widen
 * the result set beyond the one site.
 *
 * @param env - Worker env (uses `env.DB`).
 * @param siteId - The owned site id from the route param.
 * @returns Automation list items; `[]` when the store has none (honest-empty).
 */
export async function listSiteAutomations(env: Env, siteId: string): Promise<Automation[]> {
  const { data } = await dbQuery<WorkflowJobRow>(
    env.DB,
    `SELECT id, job_name, status, created_at, completed_at
       FROM workflow_jobs
      WHERE site_id = ?
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${LIMIT}`,
    [siteId],
  );

  return data.map((row) => ({
    id: row.id,
    type: row.job_name,
    status: row.status,
    created_at: row.created_at,
    finished_at: row.completed_at,
  }));
}

/** The owned site fields the retry re-dispatch needs to re-thread into the workflow. */
export interface RetryableSite {
  id: string;
  slug: string;
  business_name: string | null;
  business_address: string | null;
  business_category: string | null;
  business_phone: string | null;
  business_email: string | null;
  business_hours: string | null;
  google_place_id: string | null;
  budget_tier: string | null;
  status: string | null;
}

/** Outcome of a retry re-dispatch (surfaced to the caller + the UI). */
export interface ReDispatchResult {
  /** The new status the site row was flipped to. */
  status: 'building';
  /** The dispatched workflow instance id, or `null` when the binding is absent (graceful). */
  workflowInstanceId: string | null;
}

/**
 * Re-dispatch a site's generation workflow — the RETRY action behind the Automations
 * panel. Mirrors `POST /api/sites/:id/reset`'s re-dispatch: flip the site row to
 * `status='building'`, create a `SITE_WORKFLOW` instance keyed on the site id (falling
 * back to a unique `-retry-<ts>` id when one is already in flight), re-threading the
 * persisted NAP + category + budget so the rebuild keeps the brand, and write the audit
 * trail. Graceful when `env.SITE_WORKFLOW` is unbound (status still flips; `null` id).
 *
 * Ownership + flag gating + the in-flight guard are the CALLER's responsibility
 * (`assertSiteOwned` + `isFlagOn` + the `building/generating` check in the handler) — this
 * service assumes the site is owned and buildable.
 *
 * @param env - Worker env (uses `env.DB` + optional `env.SITE_WORKFLOW`).
 * @param site - The owned site row (from `assertSiteOwned` + a `sites` SELECT).
 * @param ctx - The requesting actor + the failed automation/job id (for the audit record).
 * @returns `{ status, workflowInstanceId }`.
 */
export async function reDispatchSiteWorkflow(
  env: Env,
  site: RetryableSite,
  ctx: { orgId: string; actorId: string | null; requestId: string | null; automationId: string },
): Promise<ReDispatchResult> {
  // Flip to building first so the UI + the in-flight guard see the state immediately.
  await env.DB.prepare("UPDATE sites SET status = 'building', updated_at = datetime('now') WHERE id = ?")
    .bind(site.id)
    .run();

  let workflowInstanceId: string | null = null;

  if (env.SITE_WORKFLOW) {
    // Same params the reset re-dispatch threads (NAP + category + budget survive the rebuild).
    const params = {
      siteId: site.id,
      orgId: ctx.orgId,
      slug: site.slug,
      businessName: site.business_name || '',
      businessAddress: site.business_address || '',
      businessCategory: site.business_category || '',
      businessPhone: site.business_phone || '',
      businessEmail: site.business_email || '',
      businessHours: site.business_hours || '',
      googlePlaceId: site.google_place_id || '',
      isReset: true,
      budgetTier: site.budget_tier || 'free',
    };

    try {
      const instance = await env.SITE_WORKFLOW.create({ id: site.id, params });
      workflowInstanceId = instance.id;
    } catch {
      // An instance with the bare site id already exists → retry with a unique suffix
      // (mirrors reset's `{siteId}-reset-{ts}` fallback).
      try {
        const retryId = `${site.id}-retry-${Date.now()}`;
        const instance = await env.SITE_WORKFLOW.create({ id: retryId, params });
        workflowInstanceId = instance.id;
      } catch {
        // Workflow genuinely unavailable — the status flip + audit still stand (graceful).
        workflowInstanceId = null;
      }
    }

    // Authoritative instance pointer so the status endpoint reports the LATEST build.
    if (workflowInstanceId) {
      await env.DB.prepare('UPDATE sites SET latest_workflow_instance = ? WHERE id = ?')
        .bind(workflowInstanceId, site.id)
        .run()
        .catch(() => {});
    }
  }

  await writeAuditLog(env.DB, {
    org_id: ctx.orgId,
    actor_id: ctx.actorId,
    action: 'automation.retry',
    message: workflowInstanceId
      ? `Automation '${ctx.automationId}' re-run for '${site.slug}' — rebuild pipeline re-dispatched`
      : `Automation '${ctx.automationId}' retry requested for '${site.slug}' — workflow binding unavailable, status set to building`,
    target_type: 'site',
    target_id: site.id,
    metadata_json: {
      site_id: site.id,
      slug: site.slug,
      automation_id: ctx.automationId,
      workflow_instance_id: workflowInstanceId ?? 'not_available',
    },
    request_id: ctx.requestId ?? undefined,
  });

  return { status: 'building', workflowInstanceId };
}
