/**
 * @module libs/features/abuse_takedown/service
 * @description Abuse / takedown workflow service (flag: `abuse_takedown`).
 *
 * Public visitors report a published site; platform operators (super-admins)
 * review and either dismiss the report or uphold a takedown — which archives
 * the offending site. A hosting-platform necessity (DMCA + illegal content).
 *
 * @remarks Boundaries are Zod-validated by the handler; this layer assumes
 * validated input and performs the D1 reads/writes only.
 */

import type { Env } from '../../../src/types/env.js';
import { dbInsert, dbQuery, dbQueryOne, dbExecute } from '../../../src/services/db.js';
import { teardownSiteWfp } from '../../../src/services/wfp_site_hosting.js';
import type { AbuseReport, AbuseReportSubmit } from './schemas.js';

/** Registry flag key gating this feature. */
export const FLAG_KEY = 'abuse_takedown';

/** Resolve a reported site by slug OR id → its id + owning org (or null if unknown). */
export async function resolveReportedSite(
  env: Env,
  slugOrId: string,
): Promise<{ id: string; org_id: string | null } | null> {
  return dbQueryOne<{ id: string; org_id: string | null }>(
    env.DB,
    'SELECT id, org_id FROM sites WHERE (slug = ? OR id = ?) AND deleted_at IS NULL LIMIT 1',
    [slugOrId, slugOrId],
  );
}

/**
 * Persist a new abuse report in the `pending` state.
 * @returns the created report id.
 */
export async function createAbuseReport(
  env: Env,
  input: AbuseReportSubmit,
  site: { id: string; org_id: string | null },
): Promise<{ id: string; status: 'pending' }> {
  const id = crypto.randomUUID();
  await dbInsert(env.DB, 'abuse_reports', {
    id,
    site_id: site.id,
    org_id: site.org_id,
    reporter_email: input.reporter_email ?? null,
    category: input.category,
    reason: input.reason,
    evidence_url: input.evidence_url ?? null,
    status: 'pending',
  });
  return { id, status: 'pending' };
}

/** List reports for operator review, newest first, optionally filtered by status. */
export async function listAbuseReports(env: Env, status?: string): Promise<AbuseReport[]> {
  const where = status ? 'WHERE deleted_at IS NULL AND status = ?' : 'WHERE deleted_at IS NULL';
  const params = status ? [status] : [];
  const { data } = await dbQuery<AbuseReport>(
    env.DB,
    `SELECT id, site_id, org_id, reporter_email, category, reason, evidence_url, status,
            resolution_note, resolved_by, created_at, resolved_at
       FROM abuse_reports ${where} ORDER BY created_at DESC LIMIT 200`,
    params,
  );
  return data;
}

/**
 * Resolve a report. `takedown` archives the offending site (reversible via the
 * normal site lifecycle); `dismiss` just closes the report. Idempotent-safe:
 * an already-resolved report returns null (not found / nothing to do).
 *
 * @returns the resolved report, or null when the id is unknown.
 */
export async function resolveAbuseReport(
  env: Env,
  reportId: string,
  action: 'dismiss' | 'takedown',
  note: string | undefined,
  resolvedBy: string,
): Promise<AbuseReport | null> {
  const report = await dbQueryOne<{ id: string; site_id: string | null; org_id: string | null }>(
    env.DB,
    'SELECT id, site_id, org_id FROM abuse_reports WHERE id = ? AND deleted_at IS NULL AND status IN (?, ?) LIMIT 1',
    [reportId, 'pending', 'reviewing'],
  );
  if (!report) return null;

  // Order matters + BOTH writes are error-checked. dbExecute returns { error } and NEVER
  // throws, so a bare await would silently drop. Do the safety-critical site archive (the
  // actual takedown) FIRST and throw on failure BEFORE marking the report resolved: a
  // failed archive then leaves the report pending/reviewing (retryable) rather than
  // stranding a still-LIVE abusive site behind an already-'upheld_takedown' report that the
  // retry SELECT can no longer find. Re-archiving an already-archived site on retry is an
  // idempotent no-op (the `deleted_at IS NULL` guard + fixed target status).
  if (action === 'takedown' && report.site_id) {
    const { error: archiveError } = await dbExecute(
      env.DB,
      `UPDATE sites SET status = 'archived', updated_at = datetime('now')
        WHERE id = ? AND deleted_at IS NULL`,
      [report.site_id],
    );
    if (archiveError) {
      throw new Error(
        `abuse_takedown: failed to archive site ${report.site_id} for report ${reportId}: ${archiveError}`,
      );
    }

    // WfP Site Hosting Unit 5 — tear down the taken-down site's WfP footprint (both dispatch
    // slots + registry rows). Flag-gated + fail-soft internally; the extra `.catch` guarantees a
    // teardown miss NEVER fails the takedown (the archive above already succeeded). The report's
    // `org_id` (set from the resolved site at report time) is the correct flag scope.
    await teardownSiteWfp(env, report.site_id, { orgId: report.org_id ?? undefined }).catch(
      () => {},
    );
  }

  const newStatus = action === 'takedown' ? 'upheld_takedown' : 'dismissed';
  const { error: reportError } = await dbExecute(
    env.DB,
    `UPDATE abuse_reports
        SET status = ?, resolution_note = ?, resolved_by = ?,
            resolved_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`,
    [newStatus, note ?? null, resolvedBy, reportId],
  );
  if (reportError) {
    throw new Error(
      `abuse_takedown: failed to mark report ${reportId} ${newStatus}: ${reportError}`,
    );
  }

  return dbQueryOne<AbuseReport>(
    env.DB,
    `SELECT id, site_id, org_id, reporter_email, category, reason, evidence_url, status,
            resolution_note, resolved_by, created_at, resolved_at
       FROM abuse_reports WHERE id = ? LIMIT 1`,
    [reportId],
  );
}
