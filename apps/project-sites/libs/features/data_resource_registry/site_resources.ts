/**
 * @file Per-site dedicated-resource resolver + platform-safety guard (Data Platform, FIRE 8).
 *
 * The greenfield-reset feature must operate ONLY on a site's OWN dedicated Cloudflare D1 / KV / R2
 * (provisioned by `d1_provisioner.ts` / `kv_provisioner.ts` / `r2_provisioner.ts` into
 * `site_database_allocations`) — NEVER the shared platform D1 (`env.DB`), never another site's
 * resources. This module is the single, server-side resolution + denylist boundary those handlers
 * go through, so the "per-site scope only" invariant lives in ONE place (and its tests do too).
 *
 * Safety invariants (all enforced here, none trusted from the client):
 * - The site is resolved from `site_database_allocations` by the SERVER-verified `siteId` (the caller
 *   has already run `assertSiteOwned`) — the client never supplies a database/namespace/bucket id.
 * - The resolved D1 id is checked against {@link FORBIDDEN_DB_IDS} (the shared master + dev platform
 *   D1s, plus the live `env.DB` binding id) — a match is a hard refusal, so a mis-provisioned or
 *   tampered allocation can never point the wipe at the platform database.
 * - When a site has no dedicated allocation, the resolver returns `{ ok: false, reason:
 *   'no_dedicated_resources' }` — the caller renders an honest "nothing to reset / not available",
 *   never falls back to the shared DB.
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';

import { dbQueryOne } from '../../../src/services/db.js';

/**
 * D1 database ids that MUST NEVER be the target of a per-site destructive op. These are the SHARED
 * platform databases — wiping any of them would destroy every tenant's data.
 *
 * - `ea3e839a-…` — `project-sites-db-production` (the master system-of-record, wrangler.toml).
 * - `f5b59818-…` — the default/dev `DB` binding id (wrangler.toml top-level).
 *
 * The live `env.DB` binding id is ADDED to this set at runtime by {@link isForbiddenDbId} when the
 * platform ever exposes it, so this constant is a floor, not the whole guard.
 */
export const FORBIDDEN_DB_IDS: ReadonlySet<string> = new Set([
  'ea3e839a-c641-4861-ae30-dfc63bff8032',
  'f5b59818-c785-4807-8aca-282c9037c58c',
]);

/**
 * True when `databaseId` is a shared-platform D1 that must never be wiped per-site. Checks the static
 * {@link FORBIDDEN_DB_IDS} floor plus any id exposed by the running worker's env (defensive — if a
 * deploy ever surfaces the bound DB id, it's covered without a code change).
 *
 * @param env - Worker env (may carry a `DB_ID` / `D1_DATABASE_ID` var on some deploys).
 * @param databaseId - The per-site D1 id resolved from the allocation.
 */
export function isForbiddenDbId(env: Env, databaseId: string): boolean {
  if (!databaseId) return true; // empty id → refuse (never "wipe nothing" silently as success)
  if (FORBIDDEN_DB_IDS.has(databaseId)) return true;
  const envAny = env as unknown as Record<string, unknown>;
  for (const key of ['DB_ID', 'D1_DATABASE_ID', 'PLATFORM_DB_ID'] as const) {
    const v = envAny[key];
    if (typeof v === 'string' && v && v === databaseId) return true;
  }
  return false;
}

/** A site's dedicated per-site resources, as recorded in `site_database_allocations`. */
export interface SiteResources {
  readonly d1DatabaseId: string | null;
  readonly d1DatabaseName: string | null;
  readonly kvNamespaceId: string | null;
  readonly kvNamespaceName: string | null;
  readonly r2BucketName: string | null;
}

/** Result of {@link resolveSiteResources} — the dedicated resources, or a typed "none" reason. */
export type ResolveSiteResourcesResult =
  | { readonly ok: true; readonly resources: SiteResources }
  | { readonly ok: false; readonly reason: 'no_dedicated_resources' | 'forbidden_db_id' };

/**
 * Resolve a site's DEDICATED per-site resources from `site_database_allocations`, refusing if the
 * recorded D1 id is a shared-platform database. The caller MUST have already verified the site
 * belongs to the requester (`assertSiteOwned`) — this function does NOT re-check ownership; it only
 * loads the allocation and applies the platform-safety denylist.
 *
 * @param env - Worker env (uses `env.DB` to READ the allocation row — never as a wipe target).
 * @param siteId - The server-verified owned site id.
 * @returns The dedicated resources, or `{ ok:false, reason }` when the site has no dedicated
 *   allocation, or the recorded D1 id is forbidden (mis-provisioned / tampered → refuse).
 */
export async function resolveSiteResources(
  env: Env,
  siteId: string,
): Promise<ResolveSiteResourcesResult> {
  const row = await dbQueryOne<{
    d1_database_id: string | null;
    d1_database_name: string | null;
    kv_namespace_id: string | null;
    kv_namespace_name: string | null;
    r2_bucket_name: string | null;
  }>(
    env.DB,
    `SELECT d1_database_id, d1_database_name, kv_namespace_id, kv_namespace_name, r2_bucket_name
       FROM site_database_allocations
      WHERE site_id = ? AND status = 'active'`,
    [siteId],
  );

  // No allocation at all, or an allocation with zero dedicated resources → honest "nothing to reset".
  if (
    !row ||
    (!row.d1_database_id && !row.kv_namespace_id && !row.r2_bucket_name)
  ) {
    return { ok: false, reason: 'no_dedicated_resources' };
  }

  // A recorded per-site D1 that is actually a shared-platform id is a hard refusal — never wipe it.
  if (row.d1_database_id && isForbiddenDbId(env, row.d1_database_id)) {
    return { ok: false, reason: 'forbidden_db_id' };
  }

  return {
    ok: true,
    resources: {
      d1DatabaseId: row.d1_database_id,
      d1DatabaseName: row.d1_database_name,
      kvNamespaceId: row.kv_namespace_id,
      kvNamespaceName: row.kv_namespace_name,
      r2BucketName: row.r2_bucket_name,
    },
  };
}
