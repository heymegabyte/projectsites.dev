/**
 * @module libs/features/site_functions/service
 * @description Read-only data layer for the Functions panel — lists a site's
 * code-defined Functions (Workers-for-Platforms) from AUTHORITATIVE PERSISTED
 * SIGNALS, never a fabricated list:
 *
 *   1. `sites.functions_deployed_at` (D1) — whether a live `functions/` worker is
 *      deployed on WfP (written by `recordFunctionsDeploy` on publish; read by
 *      `siteHasDeployedFunctions`). This is the HTTP-function surface.
 *   2. The last-good bundle in R2 (`readFunctionsBundle`) — the REAL deployed code;
 *      its byte size proves the worker exists + sizes the deployment.
 *   3. `site_functions_schedules` (D1) — one real row per cron the site declared in
 *      `functions/_scheduled.*` (WfP has no native cron → the platform cron
 *      dispatcher fires them). Each is a scheduled function.
 *
 * Display reconciles with the store: a site with a deployed worker + crons maps
 * 1:1 to list items; a site with NO deployed functions AND no schedules yields an
 * honest-empty `[]` (per [[verify-against-source-of-truth]]). We deliberately do
 * NOT parse per-route patterns out of the bundle — that manifest isn't persisted
 * server-side and a minified bundle would make it a guess; mirrors the honest
 * `backend_inventory` stance (never invent data we can't truthfully source).
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';
import { dbQuery, dbQueryOne } from '../../../src/services/db.js';
import {
  isWfpConfigured,
  siteFunctionsScriptName,
} from '../../../src/services/wfp_dispatch.js';
import { readFunctionsBundle } from '../../../src/services/functions_deploy.js';
import type { ListFunctionsResponse, SiteFunction } from './schemas.js';

/** Max schedule rows surfaced — a recent-activity list, not a full export (mirrors automations). */
const SCHEDULE_LIMIT = 100;

/** The one `sites` column this reader needs (the authoritative deploy signal). */
interface SiteDeployRow {
  functions_deployed_at: string | null;
}

/** Raw `site_functions_schedules` row (only the columns we surface). */
interface ScheduleRow {
  cron: string;
}

/**
 * List a site's code-defined Functions, shaped for the UI, from the real
 * persisted signals above.
 *
 * Ownership is the CALLER's responsibility (`assertSiteOwned` in the handler);
 * every query here is still hard-scoped to `site_id = ?` so a bug upstream can't
 * widen the result beyond the one site.
 *
 * @param env - Worker env (uses `env.DB` + `env.SITES_BUCKET` + WfP config).
 * @param siteId - The owned site id from the route param.
 * @returns `{ data, functionsDeployed, wfpConfigured }` — honest-empty `data: []`
 *   when the site has no deployed functions worker and no cron schedules.
 */
export async function listSiteFunctions(
  env: Env,
  siteId: string,
): Promise<ListFunctionsResponse> {
  const wfpConfigured = isWfpConfigured(env);

  // 1. Authoritative deploy signal — is a live `functions/` worker deployed for this site?
  const site = await dbQueryOne<SiteDeployRow>(
    env.DB,
    'SELECT functions_deployed_at FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  const deployedAt = site?.functions_deployed_at ?? null;
  const functionsDeployed = !!deployedAt;

  const data: SiteFunction[] = [];

  // 2. The HTTP functions worker — surfaced ONLY when a live deploy signal exists
  //    (an honest site with no functions shows nothing, never a phantom worker).
  //    Its byte size comes from the REAL last-good bundle in R2 (proof the code exists).
  if (functionsDeployed) {
    let bundleBytes: number | null = null;
    try {
      const bundle = await readFunctionsBundle(env, siteId);
      bundleBytes = bundle != null ? byteLength(bundle) : null;
    } catch {
      // A bundle-read fault must not fail the list — report unknown size, keep the deploy row.
      bundleBytes = null;
    }

    data.push({
      id: siteFunctionsScriptName(siteId),
      kind: 'http',
      name: siteFunctionsScriptName(siteId),
      status: 'deployed',
      cron: null,
      bundleBytes,
      deployed_at: deployedAt,
    });
  }

  // 3. Scheduled functions — one entry per real cron the site declared in `functions/_scheduled.*`.
  const { data: scheduleRows } = await dbQuery<ScheduleRow>(
    env.DB,
    `SELECT cron
       FROM site_functions_schedules
      WHERE site_id = ?
      ORDER BY cron
      LIMIT ${SCHEDULE_LIMIT}`,
    [siteId],
  );
  for (const row of scheduleRows) {
    data.push({
      id: `cron:${row.cron}`,
      kind: 'scheduled',
      name: row.cron,
      // A schedule only fires when a functions worker is live (the platform cron JOINs
      // on functions_deployed_at); reflect that honest status rather than a flat 'deployed'.
      status: functionsDeployed ? 'deployed' : 'not_deployed',
      cron: row.cron,
      bundleBytes: null,
      deployed_at: deployedAt,
    });
  }

  return { data, functionsDeployed, wfpConfigured };
}

/**
 * Byte length of a UTF-8 string (the deployed bundle size). Uses `TextEncoder`
 * when available (Workers always has it) and falls back to `Blob` — never throws.
 */
function byteLength(s: string): number {
  try {
    return new TextEncoder().encode(s).length;
  } catch {
    try {
      return new Blob([s]).size;
    } catch {
      return s.length;
    }
  }
}
