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
 * INERT until wired into the site-create pipeline behind the `per_site_d1` flag (the next Phase 0c
 * increment) — nothing calls it yet, so building it creates zero real resources.
 */
import type { Env } from '../types/env.js';

import { cfAuthHeaders, resolveCfCredentials } from './cf_credentials.js';
import { dbExecute, dbQueryOne } from './db.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

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

  // 1. Idempotency — reuse an existing ACTIVE per-site D1 allocation (never a duplicate on retry).
  const existing = await dbQueryOne<{
    d1_database_id: string | null;
    d1_database_name: string | null;
  }>(
    env.DB,
    `SELECT d1_database_id, d1_database_name FROM site_database_allocations
       WHERE site_id = ? AND db_plan = 'd1_tenant_db' AND status = 'active' AND d1_database_id IS NOT NULL`,
    [siteId],
  );
  if (existing?.d1_database_id) {
    return {
      databaseId: existing.d1_database_id,
      databaseName: existing.d1_database_name ?? siteD1Name(siteId),
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

  // 3. Create the D1 via CF REST.
  const databaseName = siteD1Name(siteId);
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
  } | null;
  const databaseId = json?.result?.uuid;
  if (!res.ok || !json?.success || !databaseId) {
    return { ok: false, reason: 'cf_create_failed', status: res.status };
  }

  // 4. Record the allocation (upsert on the site_id PK — idempotent even under a race/retry).
  await dbExecute(
    env.DB,
    `INSERT INTO site_database_allocations
       (tenant_id, site_id, db_plan, region, status, d1_database_id, d1_database_name, created_at, updated_at)
     VALUES (?, ?, 'd1_tenant_db', 'auto', 'active', ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(site_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       db_plan = 'd1_tenant_db',
       status = 'active',
       d1_database_id = excluded.d1_database_id,
       d1_database_name = excluded.d1_database_name,
       updated_at = datetime('now')`,
    [tenantId, siteId, databaseId, databaseName],
  );

  return { databaseId, databaseName, ok: true, reused: false };
}
