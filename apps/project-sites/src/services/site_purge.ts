/**
 * @file Full-teardown site purge — gp-09 destructive-recreate capability.
 *
 * `purgeSiteResources` removes a soft-deleted site's ENTIRE dedicated footprint so the
 * platform can prove delivery end-to-end (delete → re-create) without orphaning anything:
 *
 *  1. Shared-bucket R2 version-tree — every object under `sites/{slug}/` in `SITES_BUCKET`
 *     (all build versions + `_manifest.json`), deleted via the binding in ≤1000-key batches.
 *  2. Dedicated D1 database — CF REST DELETE, guarded by {@link FORBIDDEN_DB_IDS} AND a
 *     CF-side name check (`ps-site-` prefix) so a mis-rowed platform id is NEVER deletable.
 *  3. Dedicated KV namespace — CF REST DELETE with the same CF-side `ps-site-` title check.
 *  4. Dedicated R2 buckets — every active `site_r2_allocations` row via the existing
 *     {@link deleteSiteR2} (S3 empty + REST delete + FORBIDDEN_BUCKET_NAMES guard).
 *  5. WfP footprint — {@link teardownSiteWfp} (both dispatch slots + registry rows).
 *  6. Registry + allocation + hostname rows — marked `retired`/`deleted` so the owner
 *     resources surface tells the truth post-delete (no ghost "active" rows).
 *  7. Host KV key + slug freeing — the archived row is renamed `<slug>--purged-<ts36>`
 *     so `ensureUniqueSlug` can give the ORIGINAL slug to a re-created site.
 *
 * Safety:
 *  - **Post-archive only** — refuses (`attempted:false`) unless `sites.deleted_at` is set.
 *    The DELETE handler soft-deletes first; purge can never destroy a live site.
 *  - **Explicit opt-in** — only runs when the owner sends `purge_resources: true` on
 *    DELETE /api/sites/:id (same body-opt-in tier as `cancel_subscription`).
 *  - **Fail-soft per step** — each step is independently guarded; the function NEVER throws.
 *  - Credentials are server-side ({@link resolveCfCredentials}); account is `env.CF_ACCOUNT_ID`.
 */
import type { Env } from '../types/env.js';

import { cfAuthHeaders, resolveCfCredentials, type CfAuth } from './cf_credentials.js';
import { dbExecute, dbQueryOne } from './db.js';
import { FORBIDDEN_DB_IDS } from './site_data_db.js';
import { deleteSiteR2, listSiteR2Allocations } from './site_r2.js';
import { teardownSiteWfp } from './wfp_site_hosting.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Only CF resources whose CF-side name carries this prefix are purge-deletable. */
const DEDICATED_NAME_PREFIX = 'ps-site-';

/** The site identity the handler resolved via `requireOwnedSite` (never client-trusted). */
export interface PurgeSiteInput {
  readonly siteId: string;
  readonly slug: string;
  readonly orgId: string;
}

/** Per-step honest verdict for a dedicated CF resource. */
export type DedicatedResourceVerdict = 'deleted' | 'skipped_absent' | 'skipped_forbidden' | 'error';

/** The honest, per-step summary a purge returns (and the DELETE response surfaces). */
export interface PurgeSiteSummary {
  attempted: boolean;
  refusedReason?: 'not_deleted' | 'site_missing';
  r2VersionObjectsDeleted: number;
  dedicatedD1: DedicatedResourceVerdict;
  dedicatedKv: DedicatedResourceVerdict;
  dedicatedBuckets: Array<{ bucket: string; ok: boolean; reason?: string }>;
  wfp: { attempted: boolean; slotsDeleted: number; registryCleared: number };
  allocationRetired: boolean;
  registryRetired: number;
  hostnamesRetired: number;
  hostKeyCleared: boolean;
  slugFreed: string | null;
}

function emptySummary(): PurgeSiteSummary {
  return {
    attempted: false,
    r2VersionObjectsDeleted: 0,
    dedicatedD1: 'skipped_absent',
    dedicatedKv: 'skipped_absent',
    dedicatedBuckets: [],
    wfp: { attempted: false, slotsDeleted: 0, registryCleared: 0 },
    allocationRetired: false,
    registryRetired: 0,
    hostnamesRetired: 0,
    hostKeyCleared: false,
    slugFreed: null,
  };
}

/** Delete every object under `sites/{slug}/` in the shared bucket. Returns objects deleted. */
async function purgeSharedR2Tree(env: Env, slug: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  // Hard page bound (100 pages × 1000 keys) so a pathological listing can never spin forever.
  for (let page = 0; page < 100; page++) {
    const listing = await env.SITES_BUCKET.list({
      cursor,
      limit: 1000,
      prefix: `sites/${slug}/`,
    });
    const keys = listing.objects.map((o) => o.key);
    if (keys.length > 0) {
      await env.SITES_BUCKET.delete(keys);
      deleted += keys.length;
    }
    if (!listing.truncated) break;
    cursor = (listing as { cursor?: string }).cursor;
    if (!cursor) break;
  }
  return deleted;
}

/**
 * Verify a CF resource's CF-side name carries the dedicated prefix, then DELETE it.
 * The GET-before-DELETE makes the guard CF-authoritative (row data alone is not trusted).
 */
async function verifyThenDeleteCfResource(
  auth: CfAuth,
  account: string,
  opts: { kind: 'd1' | 'kv'; resourceId: string },
): Promise<DedicatedResourceVerdict> {
  const path =
    opts.kind === 'd1'
      ? `/accounts/${account}/d1/database/${opts.resourceId}`
      : `/accounts/${account}/storage/kv/namespaces/${opts.resourceId}`;
  try {
    const got = await fetch(`${CF_API_BASE}${path}`, { headers: cfAuthHeaders(auth) });
    const json = (await got.json().catch(() => null)) as {
      success?: boolean;
      result?: { name?: string; title?: string };
    } | null;
    if (got.status === 404) return 'skipped_absent';
    const cfName = json?.result?.name ?? json?.result?.title ?? '';
    if (!json?.success || !cfName.startsWith(DEDICATED_NAME_PREFIX)) return 'skipped_forbidden';

    const del = await fetch(`${CF_API_BASE}${path}`, {
      headers: cfAuthHeaders(auth),
      method: 'DELETE',
    });
    const delJson = (await del.json().catch(() => null)) as { success?: boolean } | null;
    return del.ok && delJson?.success !== false ? 'deleted' : 'error';
  } catch {
    return 'error';
  }
}

/**
 * Purge a soft-deleted site's entire dedicated footprint. Never throws; every step is
 * independently fail-soft and the summary reports each step's honest outcome.
 */
export async function purgeSiteResources(
  env: Env,
  input: PurgeSiteInput,
): Promise<PurgeSiteSummary> {
  const summary = emptySummary();
  try {
    const { orgId, siteId, slug } = input;

    // Post-archive gate — purge NEVER runs against a live row.
    const row = await dbQueryOne<{ deleted_at: string | null; id: string; slug: string }>(
      env.DB,
      'SELECT id, slug, deleted_at FROM sites WHERE id = ?',
      [siteId],
    );
    if (!row) {
      summary.refusedReason = 'site_missing';
      return summary;
    }
    if (!row.deleted_at) {
      summary.refusedReason = 'not_deleted';
      return summary;
    }
    summary.attempted = true;

    // 1. Shared-bucket version tree (all builds + manifest) — frees the R2 half of slug reuse.
    try {
      summary.r2VersionObjectsDeleted = await purgeSharedR2Tree(env, slug);
    } catch {
      /* fail-soft */
    }

    // 2+3. Dedicated D1 + KV via CF REST (guarded: denylist + CF-side name prefix).
    const alloc = await dbQueryOne<{
      d1_database_id: string | null;
      d1_database_name: string | null;
      kv_namespace_id: string | null;
      kv_namespace_name: string | null;
    }>(
      env.DB,
      `SELECT d1_database_id, d1_database_name, kv_namespace_id, kv_namespace_name
         FROM site_database_allocations WHERE site_id = ?`,
      [siteId],
    ).catch(() => null);

    const cf = await resolveCfCredentials(env, orgId).catch(() => null);
    const account = env.CF_ACCOUNT_ID;
    if (cf && account) {
      if (alloc?.d1_database_id) {
        summary.dedicatedD1 = FORBIDDEN_DB_IDS.has(alloc.d1_database_id)
          ? 'skipped_forbidden'
          : await verifyThenDeleteCfResource(cf, account, {
              kind: 'd1',
              resourceId: alloc.d1_database_id,
            });
      }
      if (alloc?.kv_namespace_id) {
        summary.dedicatedKv = await verifyThenDeleteCfResource(cf, account, {
          kind: 'kv',
          resourceId: alloc.kv_namespace_id,
        });
      }
    } else if (alloc?.d1_database_id || alloc?.kv_namespace_id) {
      summary.dedicatedD1 = alloc?.d1_database_id ? 'error' : summary.dedicatedD1;
      summary.dedicatedKv = alloc?.kv_namespace_id ? 'error' : summary.dedicatedKv;
    }

    // 4. Dedicated R2 buckets — reuse the guarded deleter (S3 empty + REST + denylist).
    try {
      const allocations = await listSiteR2Allocations(env, siteId);
      for (const allocation of allocations) {
        const res = await deleteSiteR2(env, siteId, allocation, orgId).catch(() => ({
          ok: false as const,
          reason: 'cf_error',
        }));
        summary.dedicatedBuckets.push(
          res.ok
            ? { bucket: allocation.bucketName, ok: true }
            : { bucket: allocation.bucketName, ok: false, reason: String(res.reason) },
        );
      }
    } catch {
      /* fail-soft */
    }

    // 5. WfP slots + registry (flag-gated inside; idempotent with the handler's own call).
    try {
      summary.wfp = await teardownSiteWfp(env, siteId, { orgId });
    } catch {
      /* fail-soft */
    }

    // 6. Retire bookkeeping rows so the resources surface stays truthful.
    try {
      const allocRes = await dbExecute(
        env.DB,
        `UPDATE site_database_allocations
            SET status = 'retired', deletion_protected = 0, updated_at = datetime('now')
          WHERE site_id = ?`,
        [siteId],
      );
      summary.allocationRetired = !allocRes.error;
    } catch {
      /* fail-soft */
    }
    try {
      const regRes = await dbExecute(
        env.DB,
        `UPDATE site_resource_registry SET lifecycle_state = 'retired', updated_at = datetime('now')
          WHERE site_id = ? AND lifecycle_state != 'retired'`,
        [siteId],
      );
      summary.registryRetired = regRes.error ? 0 : (regRes.changes ?? 0);
    } catch {
      /* fail-soft */
    }
    try {
      const hostRes = await dbExecute(
        env.DB,
        `UPDATE hostnames SET status = 'deleted', deleted_at = datetime('now'), updated_at = datetime('now')
          WHERE site_id = ? AND deleted_at IS NULL`,
        [siteId],
      );
      summary.hostnamesRetired = hostRes.error ? 0 : (hostRes.changes ?? 0);
    } catch {
      /* fail-soft */
    }

    // 7. Host KV key (idempotent with the handler's own delete) + slug freeing.
    try {
      await env.CACHE_KV.delete(`host:${slug}.projectsites.dev`);
      summary.hostKeyCleared = true;
    } catch {
      /* fail-soft */
    }
    try {
      const suffix = `--purged-${Date.now().toString(36)}`;
      const freed = `${slug.slice(0, 63 - suffix.length)}${suffix}`;
      const slugRes = await dbExecute(
        env.DB,
        `UPDATE sites SET slug = ?, updated_at = datetime('now')
          WHERE id = ? AND deleted_at IS NOT NULL`,
        [freed, siteId],
      );
      if (!slugRes.error) summary.slugFreed = freed;
    } catch {
      /* fail-soft */
    }

    return summary;
  } catch {
    // Absolute fail-soft: purge must never break the delete path.
    return summary;
  }
}
