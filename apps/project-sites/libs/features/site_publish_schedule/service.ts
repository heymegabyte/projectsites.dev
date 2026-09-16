import type { Env } from '../../../src/types/env.js';
import { dbQuery, dbInsert, dbExecute, dbUpdate } from '../../../src/services/db.js';
import type { PublishSchedule } from './schemas.js';

export const FLAG_KEY = 'scheduled_publish';

/**
 * PURE, zero-I/O core: given candidate schedule rows and `nowMs`, return the PENDING rows whose
 * `publish_at` has arrived (`<= now`) — the set the cron should fire. Same inputs → same output
 * (unit-tested); the clock is injected, never read here.
 *
 * @param schedules - Candidate rows (any status; filtered to pending-and-due here).
 * @param nowMs - Current time in epoch ms.
 * @returns The due pending schedules (order preserved).
 */
export function resolveDueSchedules(
  schedules: readonly PublishSchedule[],
  nowMs: number,
): PublishSchedule[] {
  return schedules.filter((s) => {
    if (s.status !== 'pending') return false;
    const at = Date.parse(s.publish_at);
    return !Number.isNaN(at) && at <= nowMs;
  });
}

/** Row → validated domain shape (D1 returns unknown-typed rows). */
function toSchedule(row: Record<string, unknown>): PublishSchedule {
  const status = String(row.status ?? 'pending');
  return {
    id: String(row.id),
    org_id: String(row.org_id),
    site_id: String(row.site_id),
    publish_at: String(row.publish_at),
    status: (['pending', 'fired', 'canceled', 'skipped'].includes(status) ? status : 'pending') as PublishSchedule['status'],
    label: row.label == null ? null : String(row.label),
    created_at: String(row.created_at),
    fired_at: row.fired_at == null ? null : String(row.fired_at),
  };
}

/** Eligibility: a site is schedulable ONLY once it's BUILT (has assets) — else a scheduled go-live serves a blank page. Org-scoped (IDOR-safe). */
async function siteEligibility(
  env: Env,
  orgId: string,
  siteId: string,
): Promise<{ found: boolean; built: boolean }> {
  const { data } = await dbQuery<Record<string, unknown>>(
    env.DB,
    `SELECT id, current_build_version, status FROM sites WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  const row = data?.[0];
  if (!row) return { found: false, built: false };
  const built = row.current_build_version != null && String(row.current_build_version).length > 0;
  return { found: true, built };
}

export type ScheduleResult =
  | { ok: true; schedule: PublishSchedule }
  | { ok: false; reason: 'not_found' | 'not_built' };

/**
 * Schedule (or RESCHEDULE) a site's go-live. Supersedes any prior PENDING schedule for the site
 * (one pending schedule per site — "this site goes live at X"). Rejects a site that isn't the
 * caller's org's or isn't built yet.
 */
export async function scheduleForSite(
  env: Env,
  orgId: string,
  siteId: string,
  publishAt: string,
  label: string | null,
): Promise<ScheduleResult> {
  const { found, built } = await siteEligibility(env, orgId, siteId);
  if (!found) return { ok: false, reason: 'not_found' };
  if (!built) return { ok: false, reason: 'not_built' };
  // Supersede any existing pending schedule for this site (reschedule = one pending window).
  await dbExecute(
    env.DB,
    `UPDATE site_publish_schedules SET status = 'canceled', fired_at = ?
       WHERE site_id = ? AND org_id = ? AND status = 'pending' AND deleted_at IS NULL`,
    [new Date().toISOString(), siteId, orgId],
  );
  const record = {
    id: crypto.randomUUID(),
    org_id: orgId,
    site_id: siteId,
    publish_at: publishAt,
    status: 'pending' as const,
    label: label ?? null,
    created_at: new Date().toISOString(),
    fired_at: null,
  };
  await dbInsert(env.DB, 'site_publish_schedules', record);
  return { ok: true, schedule: toSchedule(record) };
}

/** List a site's schedules (newest first), org-scoped. */
export async function getSchedulesForSite(
  env: Env,
  orgId: string,
  siteId: string,
): Promise<PublishSchedule[]> {
  const { data } = await dbQuery<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM site_publish_schedules
       WHERE site_id = ? AND org_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 50`,
    [siteId, orgId],
  );
  return (data ?? []).map(toSchedule);
}

/** Cancel the PENDING schedule for a site (org-scoped, IDOR-safe). Returns true if one was canceled. */
export async function cancelForSite(env: Env, orgId: string, siteId: string): Promise<boolean> {
  const { data } = await dbQuery<Record<string, unknown>>(
    env.DB,
    `SELECT id FROM site_publish_schedules WHERE site_id = ? AND org_id = ? AND status = 'pending' AND deleted_at IS NULL`,
    [siteId, orgId],
  );
  if (!data || data.length === 0) return false;
  await dbExecute(
    env.DB,
    `UPDATE site_publish_schedules SET status = 'canceled', fired_at = ?
       WHERE site_id = ? AND org_id = ? AND status = 'pending'`,
    [new Date().toISOString(), siteId, orgId],
  );
  return true;
}

/**
 * The CRON consumer (scheduled() handler, Stage 6.2): flip every DUE pending schedule's site live.
 * Per-schedule fail-soft — one bad row never blocks the others; NEVER throws out of the caller.
 * A site that lost its build (current_build_version IS NULL) is marked 'skipped', not published
 * (publishing a blank page would be worse than waiting). Returns counts for the cron log.
 *
 * @param env - Worker bindings (D1).
 * @param nowMs - Current time in epoch ms (injected).
 */
export async function fireDuePublishSchedules(
  env: Env,
  nowMs: number,
): Promise<{ fired: number; skipped: number }> {
  const nowIso = new Date(nowMs).toISOString();
  const { data } = await dbQuery<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM site_publish_schedules
       WHERE status = 'pending' AND publish_at <= ? AND deleted_at IS NULL
       ORDER BY publish_at ASC LIMIT 100`,
    [nowIso],
  );
  const due = resolveDueSchedules((data ?? []).map(toSchedule), nowMs);
  let fired = 0;
  let skipped = 0;
  for (const s of due) {
    try {
      const { built } = await siteEligibility(env, s.org_id, s.site_id);
      if (!built) {
        await dbExecute(
          env.DB,
          `UPDATE site_publish_schedules SET status = 'skipped', fired_at = ? WHERE id = ?`,
          [nowIso, s.id],
        );
        skipped++;
        continue;
      }
      await dbUpdate(env.DB, 'sites', { status: 'published' }, 'id = ? AND org_id = ?', [
        s.site_id,
        s.org_id,
      ]);
      await dbExecute(
        env.DB,
        `UPDATE site_publish_schedules SET status = 'fired', fired_at = ? WHERE id = ?`,
        [nowIso, s.id],
      );
      fired++;
    } catch {
      /* per-schedule fail-soft — one bad row never blocks the sweep */
    }
  }
  return { fired, skipped };
}
