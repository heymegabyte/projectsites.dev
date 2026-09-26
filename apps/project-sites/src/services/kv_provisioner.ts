/**
 * @file Per-site KV namespace provisioning — Data Platform re-architecture, **Phase 0c**
 * (`docs/data-platform-scope.md`).
 *
 * Creates a DEDICATED Cloudflare KV namespace for a site via the CF REST API and records it in
 * `site_database_allocations`. Mirrors the `d1_provisioner.ts` pattern — giving every (paid)
 * site its OWN KV namespace rather than key-prefix scoping inside the platform namespace.
 * Added columns (`kv_namespace_id`, `kv_namespace_name`) are introduced in migration 0634.
 *
 * Safety:
 * - Credentials stay **server-side** (`resolveCfCredentials`); the account is `env.CF_ACCOUNT_ID`,
 *   never client-supplied.
 * - **Idempotent** — a second call for a site with an existing KV namespace reuses it (never a
 *   duplicate namespace on retry).
 * - Honest failure — returns a typed `{ ok: false, reason }` (no credentials / no account / CF
 *   error) and records NOTHING when the create fails; never fabricates a namespace id.
 *
 * INERT until wired into the site-create pipeline behind the `per_site_kv` flag (the next Phase 0c
 * increment) — nothing calls it yet, so building it creates zero real resources.
 */
import type { Env } from '../types/env.js';

import { cfAuthHeaders, resolveCfCredentials } from './cf_credentials.js';
import { dbExecute, dbQueryOne } from './db.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** Inputs for {@link provisionSiteKv} — the site + its tenant, resolved server-side by the caller. */
export interface ProvisionKvInput {
  readonly siteId: string;
  readonly tenantId: string;
  /** Org whose stored CF creds to prefer; falls back to the worker-bundled global key. */
  readonly orgId?: string | null;
}

/** Result of a provisioning attempt — a namespace id on success, a typed reason on failure. */
export type ProvisionKvResult =
  | {
      readonly ok: true;
      readonly namespaceId: string;
      readonly namespaceName: string;
      /** true when an existing allocation was reused (idempotent no-op), false on a fresh create. */
      readonly reused: boolean;
    }
  | { readonly ok: false; readonly reason: string; readonly status?: number };

/**
 * The deterministic KV namespace name for a site. CF KV names allow `[a-zA-Z0-9_-]`; a site id
 * (uuid/slug) is sanitized + prefixed so the name maps 1:1 to the site (stable → idempotent
 * create + auditable).
 *
 * @example kvNamespaceName('abc-123')  // 'ps-site-abc-123-kv'
 * @example kvNamespaceName('a/b c!')   // 'ps-site-a-b-c--kv'
 */
export function kvNamespaceName(siteId: string): string {
  const safe = String(siteId ?? '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .slice(0, 48);
  return `ps-site-${safe}-kv`;
}

/**
 * Provision (or reuse) a dedicated KV namespace for a site.
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID + creds source)
 * @param input - the site + tenant (+ optional org for stored creds)
 * @returns the namespace id/name (reused or freshly created), or a typed failure reason
 */
export async function provisionSiteKv(
  env: Env,
  input: ProvisionKvInput,
): Promise<ProvisionKvResult> {
  const { orgId = null, siteId, tenantId } = input;

  // 1. Idempotency — reuse an existing KV allocation (never a duplicate on retry).
  const existing = await dbQueryOne<{
    kv_namespace_id: string | null;
    kv_namespace_name: string | null;
  }>(
    env.DB,
    `SELECT kv_namespace_id, kv_namespace_name FROM site_database_allocations
       WHERE site_id = ? AND kv_namespace_id IS NOT NULL`,
    [siteId],
  );
  if (existing?.kv_namespace_id) {
    return {
      namespaceId: existing.kv_namespace_id,
      namespaceName: existing.kv_namespace_name ?? kvNamespaceName(siteId),
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

  // 3. Create the KV namespace via CF REST.
  const namespaceName = kvNamespaceName(siteId);
  let res: Response;
  try {
    res = await fetch(`${CF_API_BASE}/accounts/${account}/storage/kv/namespaces`, {
      body: JSON.stringify({ title: namespaceName }),
      headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
      method: 'POST',
    });
  } catch {
    return { ok: false, reason: 'cf_request_failed' };
  }
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: { id?: string };
  } | null;
  const namespaceId = json?.result?.id;
  if (!res.ok || !json?.success || !namespaceId) {
    return { ok: false, reason: 'cf_create_failed', status: res.status };
  }

  // 4. Record the allocation (upsert on the site_id PK — idempotent even under a race/retry).
  await dbExecute(
    env.DB,
    `INSERT INTO site_database_allocations
       (tenant_id, site_id, db_plan, region, status, kv_namespace_id, kv_namespace_name, created_at, updated_at)
     VALUES (?, ?, 'd1_tenant_db', 'auto', 'active', ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(site_id) DO UPDATE SET
       kv_namespace_id = excluded.kv_namespace_id,
       kv_namespace_name = excluded.kv_namespace_name,
       updated_at = datetime('now')`,
    [tenantId, siteId, namespaceId, namespaceName],
  );

  return { namespaceId, namespaceName, ok: true, reused: false };
}
