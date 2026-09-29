/**
 * Functions publish orchestration (Stage 2.2c, ADR-0035 §5).
 *
 * Called on Publish AFTER the container bundles the site's `functions/` folder
 * (esbuild → one ESM Worker via `scripts/functions-build`). It gates the deploy
 * on WfP config + the `customEndpoints` entitlement, then routes the build
 * result to the WfP upload/delete helpers:
 *
 *   bad build  → keep the last-good functions live (never touch WfP), surface it
 *   empty      → remove any stale `site-<siteId>` script
 *   good build → upload `site-<siteId>`
 *
 * NEVER throws — a functions failure must not take down a content publish
 * ("publish the static site, keep last-good functions live" per the ADR).
 */
import type { Env } from '../types/env.js';
import { getOrgEntitlements } from './billing.js';
import { resolveEnvVarsForFunctions } from './ai_env_vars.js';
import { signFunctionToken } from './functions/internal.js';
import { dbUpdate, dbQueryOne, dbQuery } from './db.js';
import {
  isWfpConfigured,
  uploadSiteFunctionsWorker,
  deleteSiteFunctionsWorker,
} from './wfp_dispatch.js';

/** The container bundle outcome for a site's `functions/` folder. */
export type FunctionsBuildResult =
  | { ok: true; script: string; crons?: string[] } // one esbuild ESM Worker bundle (+ Stage 6.1 cron(s) from `_scheduled`)
  | { ok: true; empty: true } // no `functions/` folder, or it declares no routes
  | { ok: false; error: string }; // reserved-path collision / npm / esbuild failure

/** Outcome of the publish-time functions deploy (all non-fatal to the static publish). */
export type DeploySiteFunctionsResult =
  | { status: 'deployed'; scriptName: string }
  | { status: 'removed' }
  | { status: 'skipped_not_entitled' }
  | { status: 'wfp_unconfigured' }
  | { status: 'build_failed'; error: string }
  | { status: 'upload_failed'; error: string; httpStatus?: number };

/** The tenant-scoping bindings injected into a site's functions-worker upload. */
interface FunctionsUploadBindings {
  secretsJson?: string;
  kvNamespaceId?: string;
  r2BucketName?: string;
  fnToken?: string;
  fnService?: string;
}

/**
 * Resolve the tenant-scoping bindings a site's functions worker is uploaded with
 * (Stage 4.1): the `env.SECRETS` blob + the KV/R2 shim ids + the signed env.AI/DATA
 * token & service binding. Shared by the publish deploy AND the Stage 5.1 snapshot
 * restore so a restored worker keeps identical bindings. Every field is fail-soft:
 * a resolve/sign failure yields no binding (never blocks the publish/restore). The
 * `FUNCTIONS_*` config is read via a narrow cast — `env.ts` is owned by a concurrent
 * session, so this must not depend on the `Env` type carrying those keys.
 *
 * @remarks Impure — reads D1 (env-vars) + Web Crypto (token sign).
 * @example const b = await resolveFunctionsUploadBindings(env, siteId, orgId)
 */
async function resolveFunctionsUploadBindings(
  env: Env,
  siteId: string,
  orgId: string,
): Promise<FunctionsUploadBindings> {
  let secretsJson: string | undefined;
  try {
    const secrets = await resolveEnvVarsForFunctions(env, orgId, siteId);
    if (Object.keys(secrets).length > 0) secretsJson = JSON.stringify(secrets);
  } catch {
    /* fail-soft — deploy without secrets rather than block */
  }
  const kvNamespaceId = (env as unknown as { FUNCTIONS_KV_ID?: string }).FUNCTIONS_KV_ID;
  const r2BucketName = (env as unknown as { FUNCTIONS_R2_BUCKET?: string }).FUNCTIONS_R2_BUCKET;
  const fnService = (env as unknown as { FUNCTIONS_INTERNAL_SERVICE?: string })
    .FUNCTIONS_INTERNAL_SERVICE;
  const fnSecret = (env as unknown as { FUNCTIONS_INTERNAL_SECRET?: string })
    .FUNCTIONS_INTERNAL_SECRET;
  let fnToken: string | undefined;
  if (fnSecret && fnService) {
    try {
      fnToken = await signFunctionToken(fnSecret, siteId);
    } catch {
      /* fail-soft — deploy without env.AI rather than block */
    }
  }
  return { secretsJson, kvNamespaceId, r2BucketName, fnToken, fnService };
}

/**
 * Deploy (or remove) a site's bundled `functions/` worker on Publish.
 *
 * @param opts.build - the container's bundle result (see {@link FunctionsBuildResult})
 * @returns a typed, non-throwing outcome
 * @example await deploySiteFunctions(env, { siteId, orgId, build: { ok: true, script } })
 */
export async function deploySiteFunctions(
  env: Env,
  opts: { siteId: string; orgId: string; build: FunctionsBuildResult; preview?: boolean },
): Promise<DeploySiteFunctionsResult> {
  if (!isWfpConfigured(env)) return { status: 'wfp_unconfigured' };

  // Entitlement gate. A lookup failure degrades to "skip" (never block publish).
  let entitled = false;
  try {
    entitled = (await getOrgEntitlements(env.DB, opts.orgId)).customEndpoints;
  } catch {
    return { status: 'skipped_not_entitled' };
  }
  if (!entitled) return { status: 'skipped_not_entitled' };

  const { build, preview } = opts;

  // Bad build → keep the last-good script live; do NOT touch WfP.
  if (!build.ok) return { status: 'build_failed', error: build.error };

  // Empty functions/ → remove any stale script so a deleted folder stops serving,
  // and CLEAR the deploy signal so Stage 3.1 dispatch stops routing to it. In
  // preview mode this only clears the `-preview` slot (never the live signal).
  if (!('script' in build)) {
    await deleteSiteFunctionsWorker(env, opts.siteId, { preview });
    if (!preview) {
      await recordFunctionsDeploy(env.DB, opts.siteId, false).catch(() => {});
      // Stage 6.1 — a removed functions worker has no scheduled handler; clear the
      // site's cron schedules so the platform cron stops dispatching to a dead script.
      await recordFunctionsSchedules(env.DB, opts.siteId, []).catch(() => {});
    }
    return { status: 'removed' };
  }

  // Stage 4.1 — resolve the tenant-scoping bindings (env.SECRETS blob + KV/R2/AI
  // shim config) injected into the upload. Shared with the Stage 5.1 snapshot
  // restore ({@link restoreSnapshotFunctions}) so both inject identical bindings.
  const bindings = await resolveFunctionsUploadBindings(env, opts.siteId, opts.orgId);

  // Good build → upload. An upload failure leaves the previous script in place
  // (the PUT never overwrote), so last-good is preserved either way. Preview
  // uploads to `site-<id>-preview` and NEVER touches the live deploy signal or the
  // persisted last-good bundle (Stage 2.3 — the owner tests it before promoting).
  const res = await uploadSiteFunctionsWorker(env, opts.siteId, build.script, {
    preview,
    ...bindings,
  });
  if (res.ok) {
    if (!preview) {
      // Record the deploy so Stage 3.1 dispatch knows a script is live. Fail-soft:
      // a signal-write failure must not fail the publish — dispatch just won't
      // route to the new script until the next successful publish.
      await recordFunctionsDeploy(env.DB, opts.siteId, true).catch(() => {});
      // Persist the last-good bundle to R2 so the Stage 2.3 preview slot
      // (`/api/test-publish`) can redeploy it WITHOUT a fresh container build.
      // Fail-soft: a persist failure only means test-publish lacks a bundle.
      await persistFunctionsBundle(env, opts.siteId, build.script).catch(() => {});
      // Stage 6.1 — replace the site's cron schedules with the ones declared in
      // `functions/_scheduled.*` (empty when none → the site has no crons). The
      // platform cron (index.ts `scheduled()`) reads these + dispatches when due.
      await recordFunctionsSchedules(env.DB, opts.siteId, build.crons ?? []).catch(() => {});
    }
    return { status: 'deployed', scriptName: res.scriptName };
  }
  return { status: 'upload_failed', error: res.error, httpStatus: res.status };
}

/** R2 key for a site's last-good functions bundle (the preview slot's source). */
export function functionsBundleKey(siteId: string): string {
  return `functions-bundles/${siteId}.js`;
}

/**
 * Persist a site's last-good functions bundle to R2 so the Stage 2.3 preview slot
 * can redeploy it without a container rebuild. Impure — writes R2.
 * @example await persistFunctionsBundle(env, siteId, script)
 */
export async function persistFunctionsBundle(
  env: Env,
  siteId: string,
  script: string,
): Promise<void> {
  await env.SITES_BUCKET.put(functionsBundleKey(siteId), script, {
    httpMetadata: { contentType: 'application/javascript' },
  });
}

/**
 * Read a site's last-good functions bundle from R2 (null if it never built one).
 * The Stage 2.3 `/api/test-publish` handler reuses it for the preview deploy.
 * @returns the bundle text, or null when absent
 * @example const script = await readFunctionsBundle(env, siteId)
 */
export async function readFunctionsBundle(env: Env, siteId: string): Promise<string | null> {
  const obj = await env.SITES_BUCKET.get(functionsBundleKey(siteId));
  return obj ? await obj.text() : null;
}

/**
 * Persist whether a site currently has a live `functions/` worker on WfP.
 * Writes `sites.functions_deployed_at` — an ISO timestamp on deploy, NULL on
 * remove — so the Stage 3.1 dispatch guard can decide (via
 * {@link siteHasDeployedFunctions}) whether to route `/api/*` to the site's
 * worker WITHOUT probing WfP on the hot path. Best-effort: callers wrap it so a
 * D1 failure never fails the publish (fail-soft).
 *
 * @remarks Impure — writes D1.
 * @example await recordFunctionsDeploy(env.DB, siteId, true) // marks a live deploy
 */
export async function recordFunctionsDeploy(
  db: D1Database,
  siteId: string,
  deployed: boolean,
): Promise<void> {
  await dbUpdate(
    db,
    'sites',
    { functions_deployed_at: deployed ? new Date().toISOString() : null },
    'id = ?',
    [siteId],
  );
}

/**
 * Whether a site has a live `functions/` worker deployed (the Stage 3.1 dispatch
 * precondition). Reads the `functions_deployed_at` signal written by
 * {@link recordFunctionsDeploy}; soft-deleted sites never qualify.
 *
 * @returns true iff `sites.functions_deployed_at` is a non-null value
 * @example if (await siteHasDeployedFunctions(env.DB, siteId)) { ...dispatch... }
 */
export async function siteHasDeployedFunctions(db: D1Database, siteId: string): Promise<boolean> {
  const row = await dbQueryOne<{ functions_deployed_at: string | null }>(
    db,
    'SELECT functions_deployed_at FROM sites WHERE id = ? AND deleted_at IS NULL',
    [siteId],
  );
  return !!row?.functions_deployed_at;
}

// ─── Stage 5.1 — snapshot functions versioning (freeze at capture + restore) ───

/**
 * R2 key for a site's functions bundle FROZEN at a specific build `version` — the
 * snapshot's restorable copy. Distinct from the single live {@link functionsBundleKey}
 * (overwritten every publish); the per-version copies let a restore re-deploy the
 * exact functions that were live for THAT build.
 *
 * @example functionsBundleVersionKey('abc', 'v-123') // 'functions-bundles/abc/v/v-123.js'
 */
export function functionsBundleVersionKey(siteId: string, version: string): string {
  return `functions-bundles/${siteId}/v/${version}.js`;
}

/**
 * Freeze the site's CURRENT live functions bundle under its build `version` so a
 * future snapshot restore can re-deploy exactly these functions (Stage 5.1
 * capture). Copies the live {@link functionsBundleKey} → {@link functionsBundleVersionKey};
 * a site with no live functions bundle → no-op (that build has no functions).
 * Called at snapshot creation (AI-edit publish + the initial workflow snapshot).
 *
 * @remarks Impure — reads+writes R2. NON-throwing: a freeze failure must never
 * fail the publish or block snapshot creation.
 * @example await freezeFunctionsBundleForSnapshot(env, siteId, version)
 */
export async function freezeFunctionsBundleForSnapshot(
  env: Env,
  siteId: string,
  version: string,
): Promise<void> {
  try {
    const live = await env.SITES_BUCKET.get(functionsBundleKey(siteId));
    if (!live) return; // no functions to freeze for this build
    const script = await live.text();
    await env.SITES_BUCKET.put(functionsBundleVersionKey(siteId, version), script, {
      httpMetadata: { contentType: 'application/javascript' },
    });
  } catch {
    /* fail-soft — a freeze failure never blocks the publish/snapshot */
  }
}

/** Outcome of a snapshot's functions rollback (all non-fatal to the content restore). */
export type RestoreSnapshotFunctionsResult =
  | { status: 'redeployed'; scriptName: string } // frozen bundle re-uploaded live
  | { status: 'removed' } // snapshot had no functions → live worker removed
  | { status: 'noop' } // snapshot had no functions AND none live → nothing to do
  | { status: 'skipped_not_entitled' }
  | { status: 'wfp_unconfigured' }
  | { status: 'upload_failed'; error: string; httpStatus?: number };

/**
 * Roll a site's WfP functions worker back to the copy frozen at snapshot build
 * `version` (Stage 5.1 restore) so the front (R2 content) and back (functions)
 * revert together. Reads {@link functionsBundleVersionKey}:
 *
 *  - **present** → re-upload `site-<siteId>` to the LIVE slot with the same
 *    tenant-scoped bindings a normal deploy injects, refresh the live last-good
 *    bundle (so preview/test-publish also reflects the restored version), and set
 *    the deploy signal.
 *  - **absent** → the snapshot's build had NO functions. If the site currently has
 *    a live worker, remove it + clear the signal (front+back roll back together);
 *    otherwise no-op.
 *
 * Entitlement-gated (a not-entitled/unconfigured caller leaves functions untouched
 * and the content restore still succeeds). NEVER throws — a functions rollback
 * failure must not fail the content restore ({@link restoreSnapshot} wraps it).
 *
 * @remarks Impure — R2 + D1 + WfP upload/delete.
 * @example await restoreSnapshotFunctions(env, { siteId, orgId, version })
 */
export async function restoreSnapshotFunctions(
  env: Env,
  opts: { siteId: string; orgId: string; version: string },
): Promise<RestoreSnapshotFunctionsResult> {
  if (!isWfpConfigured(env)) return { status: 'wfp_unconfigured' };

  // Entitlement gate. A lookup failure degrades to "skip" (never touch WfP).
  let entitled = false;
  try {
    entitled = (await getOrgEntitlements(env.DB, opts.orgId)).customEndpoints;
  } catch {
    return { status: 'skipped_not_entitled' };
  }
  if (!entitled) return { status: 'skipped_not_entitled' };

  // The bundle frozen at this snapshot's build version (null → that build had none).
  let frozen: string | null = null;
  try {
    const obj = await env.SITES_BUCKET.get(functionsBundleVersionKey(opts.siteId, opts.version));
    frozen = obj ? await obj.text() : null;
  } catch {
    frozen = null;
  }

  // No frozen functions → the snapshot predates functions (or had none). Remove any
  // live worker + clear the signal so front+back match; skip the WfP call entirely
  // when the site has no live worker (the common no-functions restore).
  if (!frozen) {
    const hasLive = await siteHasDeployedFunctions(env.DB, opts.siteId).catch(() => false);
    if (!hasLive) return { status: 'noop' };
    await deleteSiteFunctionsWorker(env, opts.siteId).catch(() => {});
    await recordFunctionsDeploy(env.DB, opts.siteId, false).catch(() => {});
    return { status: 'removed' };
  }

  // Re-upload the frozen bundle to the LIVE slot with the same bindings a normal
  // deploy injects. An upload failure leaves the current script in place (the PUT
  // never overwrote) → last-good preserved either way.
  const bindings = await resolveFunctionsUploadBindings(env, opts.siteId, opts.orgId);
  const res = await uploadSiteFunctionsWorker(env, opts.siteId, frozen, bindings);
  if (!res.ok) return { status: 'upload_failed', error: res.error, httpStatus: res.status };
  // Refresh the live last-good bundle to the restored version + set the signal.
  await persistFunctionsBundle(env, opts.siteId, frozen).catch(() => {});
  await recordFunctionsDeploy(env.DB, opts.siteId, true).catch(() => {});
  return { status: 'redeployed', scriptName: res.scriptName };
}

// ─── Stage 6.1 — scheduled/cron: per-site schedule store (platform-dispatcher) ───

/** A site's registered cron schedule (one row per cron expression). */
export interface SiteSchedule {
  siteId: string;
  cron: string;
}

/**
 * Replace a site's cron schedule set with `crons` (Stage 6.1). Deduped + trimmed;
 * an empty list leaves the site with ZERO schedules (deploy-with-no-`_scheduled`
 * or a functions removal both clear it). The platform cron (`index.ts scheduled()`)
 * reads these via {@link listActiveFunctionsSchedules} + dispatches when due. A
 * single D1 `batch` (delete-then-insert) keeps it atomic.
 *
 * @remarks Impure — writes D1. Callers wrap in `.catch()` (fail-soft; a schedule
 * write must never fail the publish).
 * @example await recordFunctionsSchedules(env.DB, siteId, ['0 * * * *'])
 */
export async function recordFunctionsSchedules(
  db: D1Database,
  siteId: string,
  crons: string[],
): Promise<void> {
  const clean = [...new Set(crons.map((c) => c.trim()).filter(Boolean))].slice(0, 20);
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM site_functions_schedules WHERE site_id = ?').bind(siteId),
  ];
  for (const cron of clean) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO site_functions_schedules (id, site_id, cron, created_at) VALUES (?, ?, ?, datetime('now'))",
        )
        .bind(crypto.randomUUID(), siteId, cron),
    );
  }
  await db.batch(stmts);
}

/**
 * List every ACTIVE site cron schedule — joined to `sites` so only live
 * (`deleted_at IS NULL`) sites with a deployed functions worker
 * (`functions_deployed_at IS NOT NULL`) are returned (a removed worker's schedules
 * were cleared, but the JOIN is belt-and-suspenders). The platform cron reads this
 * each minute + cron-matches (`cron_match.ts`) to decide which to dispatch.
 *
 * @returns `{ siteId, cron }[]`
 * @example const due = (await listActiveFunctionsSchedules(env.DB)).filter(s => cronMatches(s.cron, now))
 */
export async function listActiveFunctionsSchedules(db: D1Database): Promise<SiteSchedule[]> {
  const { data } = await dbQuery<{ site_id: string; cron: string }>(
    db,
    `SELECT sfs.site_id AS site_id, sfs.cron AS cron
       FROM site_functions_schedules sfs
       JOIN sites st ON st.id = sfs.site_id
      WHERE st.deleted_at IS NULL AND st.functions_deployed_at IS NOT NULL`,
  );
  return (data ?? []).map((r) => ({ siteId: r.site_id, cron: r.cron }));
}
