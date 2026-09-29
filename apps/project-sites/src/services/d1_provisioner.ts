/**
 * @file Per-site D1 provisioning — Data Platform re-architecture, **Phase 0c**
 * (`docs/data-platform-scope.md`).
 *
 * Creates a DEDICATED Cloudflare D1 database for a site via the CF REST API and records it in
 * `site_database_allocations`. The new architecture gives every (paid) site its OWN D1 instead of
 * the shared platform D1 with `site_id` scoping. Mirrors the `upstash_provisioner.ts` pattern.
 *
 * Safety:
 * - Credentials stay **server-side** (`resolveCfCredentials`); the account is `env.CF_ACCOUNT_ID`,
 *   never client-supplied.
 * - **Idempotent** — a second call for a site with an existing ACTIVE per-site D1 reuses it (never a
 *   duplicate database on retry).
 * - Honest failure — returns a typed `{ ok: false, reason }` (no credentials / no account / CF error)
 *   and records NOTHING when the create fails; never fabricates a database id.
 *
 * Callers (both gated behind the `per_site_data` flag, DARK by default → zero real resources until
 * enabled): `site_create.ts` provisions eagerly on site-create; `site_data_db.ts` provisions LAZILY
 * on first Data-tab access. Both are idempotent, so the two paths converge on one D1 per site.
 */
import type { Env } from '../types/env.js';

import { cfAuthHeaders, resolveCfCredentials } from './cf_credentials.js';
import { dbExecute, dbQueryOne } from './db.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Read the ACTIVE per-site D1 allocation for a site, or null. The single source of a per-site
 * database id — used for both the pre-create idempotency check and the post-conflict re-read.
 */
async function readAllocation(
  env: Env,
  siteId: string,
): Promise<{ d1_database_id: string; d1_database_name: string | null } | null> {
  const row = await dbQueryOne<{
    d1_database_id: string | null;
    d1_database_name: string | null;
  }>(
    env.DB,
    `SELECT d1_database_id, d1_database_name FROM site_database_allocations
       WHERE site_id = ? AND db_plan = 'd1_tenant_db' AND status = 'active' AND d1_database_id IS NOT NULL`,
    [siteId],
  );
  return row?.d1_database_id
    ? { d1_database_id: row.d1_database_id, d1_database_name: row.d1_database_name }
    : null;
}

/**
 * Does a CF D1-create error response mean "a database with that name already exists"? A name conflict
 * is NOT a failure — the database exists (a concurrent provisioner or a prior create made it), so the
 * caller re-reads the allocation and reuses the id. Matches CF's error code (7502) or the message
 * wording, defensively (CF has used both shapes).
 */
function isCfAlreadyExists(status: number, json: unknown): boolean {
  if (status !== 409 && status !== 400) return false;
  const errors = (json as { errors?: Array<{ code?: number; message?: string }> } | null)?.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) => e?.code === 7502 || /already exists/i.test(String(e?.message ?? '')),
  );
}

/** Inputs for {@link provisionSiteD1} — the site + its tenant, resolved server-side by the caller. */
export interface ProvisionD1Input {
  readonly siteId: string;
  readonly tenantId: string;
  /** Org whose stored CF creds to prefer; falls back to the worker-bundled global key. */
  readonly orgId?: string | null;
}

/** Result of a provisioning attempt — a database id on success, a typed reason on failure. */
export type ProvisionD1Result =
  | {
      readonly ok: true;
      readonly databaseId: string;
      readonly databaseName: string;
      /** true when an existing allocation was reused (idempotent no-op), false on a fresh create. */
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly reason: string; readonly status?: number };

/**
 * The deterministic D1 database name for a site's tenant database. CF D1 names allow
 * `[a-zA-Z0-9_-]`; a site id (uuid/slug) is sanitized + prefixed so the name maps 1:1 to the site
 * (stable → idempotent create + auditable).
 *
 * @example siteD1Name('abc-123')        // 'ps-site-abc-123'
 * @example siteD1Name('a/b c!')         // 'ps-site-a-b-c-'
 */
export function siteD1Name(siteId: string): string {
  const safe = String(siteId ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48);
  return `ps-site-${safe}`;
}

/**
 * Provision (or reuse) a dedicated D1 database for a site.
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID + creds source)
 * @param input - the site + tenant (+ optional org for stored creds)
 * @returns the database id/name (reused or freshly created), or a typed failure reason
 */
export async function provisionSiteD1(
  env: Env,
  input: ProvisionD1Input,
): Promise<ProvisionD1Result> {
  const { orgId = null, siteId, tenantId } = input;
  const databaseName = siteD1Name(siteId);

  // 1. Idempotency — reuse an existing ACTIVE per-site D1 allocation (never a duplicate on retry).
  const existing = await readAllocation(env, siteId);
  if (existing) {
    return {
      databaseId: existing.d1_database_id,
      databaseName: existing.d1_database_name ?? databaseName,
      ok: true,
      reused: true,
    };
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

  // 3. Create the D1 via CF REST. A concurrent provisioner (that also passed the step-1 read) may be
  //    creating in parallel; CF answers a second create for the same NAME with an "already exists"
  //    error, which we treat as success (the DB exists) and fall through to the collapse below.
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}/accounts/${account}/d1/database`, {
      body: JSON.stringify({ name: databaseName }),
      headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
      method: 'POST',
    });
  } catch {
    return { ok: false, reason: 'cf_request_failed' };
  }
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: { uuid?: string };
    errors?: unknown;
  } | null;
  const createdId = json?.result?.uuid;
  const created = res.ok && json?.success === true && !!createdId;

  if (!created) {
    // A name-conflict is NOT a failure — a sibling provisioner already created this DB. Re-read the
    // allocation (it may have just landed) and reuse it; any OTHER error is an honest create failure.
    if (isCfAlreadyExists(res.status, json)) {
      const afterConflict = await readAllocation(env, siteId);
      if (afterConflict) {
        return {
          databaseId: afterConflict.d1_database_id,
          databaseName: afterConflict.d1_database_name ?? databaseName,
          ok: true,
          reused: true,
        };
      }
      // The DB exists on CF but no allocation row is visible yet (rare replica lag). Report a typed
      // reason rather than fabricate an id — the caller retries and the row will resolve.
      return { ok: false, reason: 'cf_exists_no_allocation', status: res.status };
    }
    return { ok: false, reason: 'cf_create_failed', status: res.status };
  }

  // 4. Record the allocation. INSERT … ON CONFLICT(site_id) DO NOTHING is the RACE COLLAPSE: if a
  //    concurrent caller inserted first, our insert is a no-op (changes: 0). We then re-read the
  //    winning row and reuse ITS id — so both callers converge on ONE allocation and the loser's
  //    freshly-created CF DB is simply left unreferenced (never a second live allocation).
  const { changes } = await dbExecute(
    env.DB,
    `INSERT INTO site_database_allocations
       (tenant_id, site_id, db_plan, region, status, d1_database_id, d1_database_name, created_at, updated_at)
     VALUES (?, ?, 'd1_tenant_db', 'auto', 'active', ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(site_id) DO NOTHING`,
    [tenantId, siteId, createdId, databaseName],
  );

  if (changes === 0) {
    // Lost the insert race — an allocation already exists for this site. Reuse the winner's id.
    const winner = await readAllocation(env, siteId);
    if (winner) {
      return {
        databaseId: winner.d1_database_id,
        databaseName: winner.d1_database_name ?? databaseName,
        ok: true,
        reused: true,
      };
    }
  }

  return { databaseId: createdId, databaseName, ok: true, reused: false };
}
