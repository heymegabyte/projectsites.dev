/**
 * @file Per-site R2 bucket provisioning — Data Platform re-architecture, **Phase 0c**
 * (`docs/data-platform-scope.md`).
 *
 * Creates a DEDICATED Cloudflare R2 bucket for a site via the CF REST API and records it in
 * `site_database_allocations`. The new architecture gives every (paid) site its OWN R2 bucket
 * instead of storing files under a shared `sites/{slug}/…` prefix in the platform bucket. Mirrors
 * the `d1_provisioner.ts` pattern.
 *
 * Safety:
 * - Credentials stay **server-side** (`resolveCfCredentials`); the account is `env.CF_ACCOUNT_ID`,
 *   never client-supplied.
 * - **Idempotent** — a second call for a site with an existing recorded bucket reuses it (never a
 *   duplicate bucket on retry). R2 bucket identity is the name, not a uuid.
 * - Honest failure — returns a typed `{ ok: false, reason }` (no credentials / no account / CF
 *   error) and records NOTHING when the create fails; never fabricates a bucket name.
 *
 * INERT until wired into the site-create pipeline behind the `per_site_r2` flag (a future
 * Phase 0c increment) — nothing calls it yet, so building it creates zero real resources.
 */
import type { Env } from '../types/env.js';

import { cfAuthHeaders, resolveCfCredentials } from './cf_credentials.js';
import { dbExecute, dbQueryOne } from './db.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Inputs for {@link provisionSiteR2} — the site + its tenant, resolved server-side by the caller. */
export interface ProvisionR2Input {
  readonly siteId: string;
  readonly tenantId: string;
  /** Org whose stored CF creds to prefer; falls back to the worker-bundled global key. */
  readonly orgId?: string | null;
}

/** Result of a provisioning attempt — a bucket name on success, a typed reason on failure. */
export type ProvisionR2Result =
  | {
      readonly ok: true;
      readonly bucketName: string;
      /** true when an existing allocation was reused (idempotent no-op), false on a fresh create. */
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly reason: string; readonly status?: number };

/**
 * The deterministic R2 bucket name for a site. R2 bucket names must be lowercase, 3-63 chars,
 * `[a-z0-9-]`. A site id (uuid/slug) is lowercased + sanitized + prefixed so the name maps 1:1 to
 * the site (stable → idempotent create + auditable).
 *
 * @example r2BucketName('abc-123')        // 'ps-site-abc-123'
 * @example r2BucketName('A/B C!')         // 'ps-site-a-b-c-'
 * @example r2BucketName('x'.repeat(80))   // total length ≤ 63
 */
export function r2BucketName(siteId: string): string {
  const safe = String(siteId ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 54); // 'ps-site-' is 8 chars; 8 + 54 = 62 ≤ 63
  return `ps-site-${safe}`;
}

/**
 * Provision (or reuse) a dedicated R2 bucket for a site.
 *
 * @param env   - worker env (DB + CF_ACCOUNT_ID + creds source)
 * @param input - the site + tenant (+ optional org for stored creds)
 * @returns the bucket name (reused or freshly created), or a typed failure reason
 */
export async function provisionSiteR2(
  env: Env,
  input: ProvisionR2Input,
): Promise<ProvisionR2Result> {
  const { orgId = null, siteId, tenantId } = input;

  // 1. Idempotency — reuse an existing recorded R2 allocation (never a duplicate on retry).
  const existing = await dbQueryOne<{ r2_bucket_name: string | null }>(
    env.DB,
    `SELECT r2_bucket_name FROM site_database_allocations WHERE site_id = ? AND r2_bucket_name IS NOT NULL`,
    [siteId],
  );
  if (existing?.r2_bucket_name) {
    return { bucketName: existing.r2_bucket_name, ok: true, reused: true };
  }

  // 2. Server-side credentials + account — never client-supplied.
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) {
    return { ok: false, reason: 'no_cf_credentials' };
  }
  const account = env.CF_ACCOUNT_ID;
  if (!account) {
    return { ok: false, reason: 'no_account_id' };
  }

  // 3. Create the R2 bucket via CF REST.
  const bucketName = r2BucketName(siteId);
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}/accounts/${account}/r2/buckets`, {
      body: JSON.stringify({ name: bucketName }),
      headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
      method: 'POST',
    });
  } catch {
    return { ok: false, reason: 'cf_request_failed' };
  }
  const json = (await res.json().catch(() => null)) as { success?: boolean } | null;
  if (!res.ok || !json?.success) {
    return { ok: false, reason: 'cf_create_failed', status: res.status };
  }

  // 4. Record the allocation (upsert on the site_id PK — idempotent even under a race/retry).
  await dbExecute(
    env.DB,
    `INSERT INTO site_database_allocations
       (tenant_id, site_id, db_plan, region, status, r2_bucket_name, created_at, updated_at)
     VALUES (?, ?, 'd1_tenant_db', 'auto', 'active', ?, datetime('now'), datetime('now'))
     ON CONFLICT(site_id) DO UPDATE SET
       r2_bucket_name = excluded.r2_bucket_name,
       updated_at = datetime('now')`,
    [tenantId, siteId, bucketName],
  );

  return { bucketName, ok: true, reused: false };
}
