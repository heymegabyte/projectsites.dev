/**
 * Usage Gauges service — per-org usage metrics from D1.
 *
 * Computes site count, build count, and media storage against the org's REAL
 * plan limits (sourced from the `plan_entitlement` SSOT matrix — NOT hardcoded),
 * to feed the Billing "Plan & usage" gauges.
 *
 * @module libs/features/usage_gauges/service
 */
import type { Env } from '../../../src/types/env.js';
import { dbQueryOne } from '../../../src/services/db.js';
import { resolveActiveOrgPlan } from '../../../src/services/build_limits.js';
import { getLimit, type PlanTier } from '../../../src/services/plan_entitlement.js';
import type { UsageGauge } from './schemas.js';

interface CountRow {
  cnt: number;
}

interface SizeRow {
  total_mb: number;
}

/**
 * Compute usage gauges for an org. Queries D1 for live counts and compares them
 * against the org's ACTUAL plan limits from the `plan_entitlement` SSOT matrix.
 *
 * Was a hardcoded `FREE_LIMITS = { sites: 3, builds: 10, media_gb: 1, bandwidth_gb: 5 }`
 * that (a) matched NO real plan tier (free is 1 site / 5 builds / 10 MB per the SSOT) and
 * (b) ignored the org's plan entirely — so every free owner saw fabricated headroom and
 * the "/ 3 sites" meter contradicted the "1 project" plan card (AL-326 lying-UI cap). Now
 * the limits are plan-aware from `getLimit()`: an active|trialing `paid` sub resolves to
 * the sold `pro` tier (unlimited sites → "∞", matching the Pro plan card), everything else
 * to `free`. The fabricated `bandwidth_gb` gauge (no SSOT limit, never measured) is dropped
 * so the meter only shows gauges backed by a real count AND a real enforced limit.
 *
 * @param env - Worker env (needs `DB`).
 * @param orgId - Organisation UUID.
 * @returns Sites / Builds / Media gauges — each `{used, limit, pct}` where `limit === -1`
 *   means unlimited (the client renders "∞" and holds `pct` at 0).
 */
export async function computeUsageGauges(env: Env, orgId: string): Promise<UsageGauge[]> {
  const tier: PlanTier = (await resolveActiveOrgPlan(env.DB, orgId)) === 'paid' ? 'pro' : 'free';

  const siteRow = await dbQueryOne<CountRow>(
    env.DB,
    `SELECT COUNT(*) as cnt FROM sites WHERE org_id = ? AND deleted_at IS NULL`,
    [orgId],
  );

  const buildRow = await dbQueryOne<CountRow>(
    env.DB,
    `SELECT COUNT(*) as cnt FROM workflow_jobs
     WHERE org_id = ? AND job_name = 'build' AND deleted_at IS NULL`,
    [orgId],
  );

  const mediaRow = await dbQueryOne<SizeRow>(
    env.DB,
    // Media storage lives in `media_assets.size_bytes` (per-org), NOT on `sites` —
    // the old `SUM(media_size_bytes) FROM sites` referenced a column that doesn't
    // exist, so the query threw (swallowed by dbQuery) and the Media gauge always
    // read 0 regardless of actual usage.
    `SELECT COALESCE(SUM(size_bytes), 0) / 1048576.0 as total_mb
     FROM media_assets WHERE org_id = ? AND deleted_at IS NULL`,
    [orgId],
  );

  const sites = Number(siteRow?.cnt ?? 0);
  const builds = Number(buildRow?.cnt ?? 0);
  // Media is reported in MB (the SSOT `media_storage_mb` unit) — free is 10 MB, so a GB
  // scale would render a misleading "0 / 0.01 GB". Round to whole MB.
  const mediaMb = Math.round(Number(mediaRow?.total_mb ?? 0));

  const sitesLimit = getLimit('sites', tier);
  const buildsLimit = getLimit('builds_per_month', tier);
  const mediaLimit = getLimit('media_storage_mb', tier);

  /** Percent full; 0 for an unlimited (`-1`) or zero limit (the client shows "∞"). */
  const pct = (used: number, limit: number): number =>
    limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  return [
    { metric: 'sites', label: 'Sites', used: sites, limit: sitesLimit, unit: 'sites', pct: pct(sites, sitesLimit) },
    { metric: 'builds', label: 'Builds', used: builds, limit: buildsLimit, unit: 'builds', pct: pct(builds, buildsLimit) },
    { metric: 'media', label: 'Media', used: mediaMb, limit: mediaLimit, unit: 'MB', pct: pct(mediaMb, mediaLimit) },
  ];
}
