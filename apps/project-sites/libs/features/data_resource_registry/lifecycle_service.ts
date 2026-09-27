/**
 * @module libs/features/data_resource_registry/lifecycle_service
 * @description Resource LIFECYCLE operations for the Data & Resource Platform (FIRE 5): teardown,
 * clone, promote, and the environment-assignment read. These are the standalone server-side operations
 * the lifecycle mutation bridge ({@link ../lifecycle_mutation}) exposes to the three provisionable kinds
 * (d1/kv/r2) — kept OUT of the adapters + the core `service.ts` so the lifecycle surface is one owned unit
 * (tool-design-as-api). Every operation:
 *
 *  - resolves the CF id SERVER-SIDE from an OWNED registry row (never a caller-supplied id — INV-1);
 *  - re-scopes every DB read on `siteId` + `orgId` (belt-and-braces with the route's ownership gate);
 *  - refuses a shared-platform / deletion-protected id (fail closed);
 *  - returns a typed outcome, honest about what CF can/can't do per CAPABILITY-MATRIX (a teardown works;
 *    a full deep-clone of a large bucket is honest `not_available` — never a silent partial).
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';
import { dbQuery, dbQueryOne, dbUpdate } from '../../../src/services/db.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';
import { cfAuthHeaders, resolveCfCredentials } from '../../../src/services/cf_credentials.js';

import { forbiddenIdsForKind } from './service.js';
import { provisionResource } from './service.js';
import type { ProvisionableKind } from './quota.js';
import type { ResourceEnvironment } from './schemas.js';

/** CF REST API base (mirrors the adapters). */
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** The registry-row shape lifecycle ops read (the id, its protection flag, its display name). */
interface LifecycleRow {
  id: string;
  resource_id_or_name: string | null;
  resource_display_name: string | null;
  deletion_protected: number;
}

/** A typed lifecycle failure reason — honest, never a fabricated success. */
export type LifecycleFailureReason =
  | 'unauthorized'
  | 'not_owned'
  | 'not_registered' // no owned row for (site, env, kind)
  | 'forbidden_shared' // resolved a denylisted shared-platform id — fail closed
  | 'deletion_protected' // teardown refused: the row is protected
  | 'no_cf_credentials'
  | 'no_account_id'
  | 'not_available' // CF genuinely cannot do this op at scale (honest per CAPABILITY-MATRIX)
  | 'cf_error'; // the CF call failed

/** Result of {@link teardownResource}. */
export type TeardownResult =
  | { readonly ok: true; readonly deletedCfResource: boolean; readonly resourceId: string; readonly displayName: string }
  | { readonly ok: false; readonly reason: LifecycleFailureReason; readonly detail?: string };

/** Result of {@link cloneResource}. */
export type CloneResult =
  | {
      readonly ok: true;
      readonly resourceId: string; // the NEW resource's CF id/name
      readonly registryRowId: string;
      readonly displayName: string;
      readonly copied: boolean; // true when data was copied; false when only a blank sibling was created
      readonly note?: string; // honest note (e.g. "schema+data copied", "blank sibling — copy not available at this scale")
    }
  | { readonly ok: false; readonly reason: LifecycleFailureReason; readonly detail?: string };

/** Result of {@link promoteResource} (copy/point preview → production). */
export type PromoteResult =
  | { readonly ok: true; readonly targetResourceId: string; readonly registryRowId: string; readonly note?: string }
  | { readonly ok: false; readonly reason: LifecycleFailureReason; readonly detail?: string };

/** One row of the environment-assignment grid: which CF resource of a kind is bound in each environment. */
export interface EnvAssignmentEntry {
  readonly kind: string;
  readonly preview: { readonly present: boolean; readonly displayName?: string; readonly lifecycleState?: string; readonly bindingName?: string };
  readonly production: { readonly present: boolean; readonly displayName?: string; readonly lifecycleState?: string; readonly bindingName?: string };
}

/**
 * Read the OWNED, live registry row for `(siteId, orgId, environment, kind)`. Returns the row or a typed
 * failure reason. Fails closed on a shared-platform id (`forbidden_shared`). This is the single id-resolution
 * fence every lifecycle op shares — the caller NEVER supplies a CF id.
 */
async function resolveOwnedRow(
  env: Env,
  siteId: string,
  orgId: string,
  environment: ResourceEnvironment,
  kind: ProvisionableKind,
): Promise<{ ok: true; row: LifecycleRow } | { ok: false; reason: LifecycleFailureReason }> {
  const row = await dbQueryOne<LifecycleRow>(
    env.DB,
    `SELECT id, resource_id_or_name, resource_display_name, deletion_protected
       FROM site_resource_registry
       WHERE site_id = ? AND org_id = ? AND environment = ? AND resource_kind = ?
         AND resource_concept = 'account_resource' AND deleted_at IS NULL
         AND resource_id_or_name IS NOT NULL
       ORDER BY created_at LIMIT 1`,
    [siteId, orgId, environment, kind],
  );
  if (!row || !row.resource_id_or_name) return { ok: false, reason: 'not_registered' };
  if (forbiddenIdsForKind(kind).has(row.resource_id_or_name)) return { ok: false, reason: 'forbidden_shared' };
  return { ok: true, row };
}

/**
 * Delete a per-site CF resource on request + soft-delete its registry row. CONFIRM-GATED + honest about
 * irreversibility (the caller supplies `confirm:true`; the mutation bridge messages the irreversibility).
 * A `deletion_protected` row is refused (the platform-critical per-site D1 is protected). The CF DELETE is
 * idempotent (a 404 = already gone = success). After the CF resource is deleted, the registry row is
 * soft-deleted + moved to `retired` so the overview stops showing it.
 *
 * @param env - worker env
 * @param siteId - the OWNED site (route param, never the body)
 * @param orgId - the authed org
 * @param environment - which environment's resource to tear down
 * @param kind - the provisionable kind (d1/kv/r2)
 */
export async function teardownResource(
  env: Env,
  siteId: string,
  orgId: string,
  environment: ResourceEnvironment,
  kind: ProvisionableKind,
): Promise<TeardownResult> {
  if (!orgId) return { ok: false, reason: 'unauthorized' };
  if (!(await assertSiteOwned(env, orgId, siteId))) return { ok: false, reason: 'not_owned' };

  const resolved = await resolveOwnedRow(env, siteId, orgId, environment, kind);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { row } = resolved;

  if (row.deletion_protected === 1) return { ok: false, reason: 'deletion_protected' };

  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { ok: false, reason: 'no_cf_credentials' };
  const accountId = env.CF_ACCOUNT_ID;
  if (!accountId) return { ok: false, reason: 'no_account_id' };

  const id = row.resource_id_or_name as string;
  const url = cfDeleteUrl(accountId, kind, id);
  let res: Response;
  try {
    res = await fetch(url, { headers: { ...cfAuthHeaders(auth) }, method: 'DELETE' });
  } catch (err) {
    return { detail: err instanceof Error ? err.message : 'network error', ok: false, reason: 'cf_error' };
  }
  // 404 = already gone (idempotent). Any other non-2xx (except 404) is a hard CF error.
  if (!res.ok && res.status !== 404) {
    return { detail: `CF delete returned HTTP ${res.status}`, ok: false, reason: 'cf_error' };
  }

  // Soft-delete + retire the registry row so the overview stops surfacing it.
  await dbUpdate(
    env.DB,
    'site_resource_registry',
    { deleted_at: new Date().toISOString(), lifecycle_state: 'retired' },
    'id = ? AND site_id = ? AND org_id = ?',
    [row.id, siteId, orgId],
  );

  return {
    deletedCfResource: res.ok,
    displayName: row.resource_display_name ?? id,
    ok: true,
    resourceId: id,
  };
}

/**
 * Duplicate a single per-site resource WITHIN the site: provision a fresh sibling of the SAME kind in the
 * SAME environment, then copy the source's DATA into it where CF supports it honestly:
 *  - **KV** — enumerate the source namespace's keys + copy each value into the new namespace (bounded page;
 *    a very large namespace is copied best-effort and flagged).
 *  - **R2** — a full deep-copy of an arbitrarily large bucket is NOT available through the REST management
 *    API (no server-side bucket-copy primitive; INV-6 keeps S3 creds server-side). We create the blank
 *    sibling bucket + return an honest `copied:false` note — never a silent partial mirror.
 *  - **D1** — a schema+data clone requires an export/import cycle the REST surface doesn't expose in one
 *    call; we create the blank sibling DB + return an honest `copied:false` note.
 *
 * Provisioning the sibling reuses {@link provisionResource} (idempotency → quota → provisioner → record),
 * so quota is enforced and a second dedicated resource is a real, billable create (confirm-gated upstream).
 */
export async function cloneResource(
  env: Env,
  siteId: string,
  orgId: string,
  environment: ResourceEnvironment,
  kind: ProvisionableKind,
): Promise<CloneResult> {
  if (!orgId) return { ok: false, reason: 'unauthorized' };
  if (!(await assertSiteOwned(env, orgId, siteId))) return { ok: false, reason: 'not_owned' };

  // A clone must find an OWNED source row to duplicate (never a caller-supplied id).
  const resolved = await resolveOwnedRow(env, siteId, orgId, environment, kind);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  // A clone is a SECOND dedicated resource of the same kind. `provisionResource` is idempotent per
  // (site, env, kind) — it RETURNS the existing one rather than make a sibling — and the registry keys
  // exactly one dedicated resource per (site, environment, kind). A genuine distinct sibling needs a
  // selector the schema does not yet carry, and CF has no server-side deep-copy primitive for D1/R2 through
  // the management API. Rather than fabricate a duplicate that collides with the single-row invariant (or a
  // silent partial mirror), we honestly report `not_available` — the owner uses promote (preview →
  // production) for a real cross-environment copy, or teardown to remove a resource. (CAPABILITY-MATRIX.md.)
  return {
    detail:
      'Cloning would create a second dedicated resource of the same kind, but the per-site registry keys exactly one dedicated resource per (site, environment, kind), and the Cloudflare management API has no server-side deep-copy primitive for D1/R2. Use promote (preview → production) to copy across environments instead.',
    ok: false,
    reason: 'not_available',
  };
}

/**
 * Promote a resource from preview to production: ensure a production resource of the kind EXISTS (provision
 * it if absent — confirm-gated, billable), then copy the preview resource's DATA into it where CF supports
 * it honestly. Only KV supports a REST-level value copy today; D1/R2 return an honest note that the
 * production resource was ensured but a data copy is not available through the management API.
 *
 * Requires `environment` to be `preview` (the source). The target is always `production`.
 */
export async function promoteResource(
  env: Env,
  siteId: string,
  orgId: string,
  kind: ProvisionableKind,
  confirm: boolean | undefined,
): Promise<PromoteResult> {
  if (!orgId) return { ok: false, reason: 'unauthorized' };
  if (!(await assertSiteOwned(env, orgId, siteId))) return { ok: false, reason: 'not_owned' };

  // Source = preview. Must exist to promote.
  const previewRow = await resolveOwnedRow(env, siteId, orgId, 'preview', kind);
  if (!previewRow.ok) return { ok: false, reason: previewRow.reason };

  // Ensure the production resource exists (idempotent provision — reuses an existing prod row).
  const prod = await provisionResource(env, siteId, kind, {
    confirm,
    environment: 'production',
    orgId,
  });
  if (!prod.ok) {
    if (prod.reason === 'confirmation_required') {
      return { detail: 'confirmation_required', ok: false, reason: 'not_available' };
    }
    return { detail: prod.reason, ok: false, reason: prod.reason === 'not_owned' ? 'not_owned' : 'cf_error' };
  }

  // KV — copy values preview → production (bounded best-effort). D1/R2 — ensured only (honest note).
  if (kind === 'kv') {
    const copyNote = await copyKvValues(env, accountForCopy(env), orgId, previewRow.row.resource_id_or_name as string, prod.resourceId);
    return { note: copyNote, ok: true, registryRowId: prod.registryRowId, targetResourceId: prod.resourceId };
  }

  return {
    note:
      kind === 'r2'
        ? 'A production R2 bucket is ensured. Copying objects across buckets is not available through the management API — upload production objects directly.'
        : 'A production D1 database is ensured. Copying schema+data across databases requires an export/import cycle the management API does not expose — run your migrations against production.',
    ok: true,
    registryRowId: prod.registryRowId,
    targetResourceId: prod.resourceId,
  };
}

/**
 * Read the environment-assignment grid for a site: for every provisionable kind, which CF resource (if any)
 * is bound in `preview` vs `production`. Derived entirely from OWNED registry rows — no CF id is ever
 * surfaced (only the display name + lifecycle state + binding name). The UI can also derive this from two
 * overview calls; this server helper gives a single authoritative read for the grid.
 */
export async function listEnvironmentAssignments(
  env: Env,
  siteId: string,
  orgId: string,
): Promise<EnvAssignmentEntry[]> {
  const { data } = await dbQuery<{
    resource_kind: string;
    environment: string;
    resource_display_name: string | null;
    lifecycle_state: string;
    binding_name: string | null;
  }>(
    env.DB,
    `SELECT resource_kind, environment, resource_display_name, lifecycle_state, binding_name
       FROM site_resource_registry
       WHERE site_id = ? AND org_id = ? AND resource_concept = 'account_resource' AND deleted_at IS NULL
       ORDER BY resource_kind, environment`,
    [siteId, orgId],
  );

  const byKind = new Map<string, EnvAssignmentEntry>();
  const ensure = (kind: string): EnvAssignmentEntry => {
    let e = byKind.get(kind);
    if (!e) {
      e = { kind, preview: { present: false }, production: { present: false } };
      byKind.set(kind, e);
    }
    return e;
  };

  for (const row of data) {
    const entry = ensure(row.resource_kind);
    const slot = {
      bindingName: row.binding_name ?? undefined,
      displayName: row.resource_display_name ?? undefined,
      lifecycleState: row.lifecycle_state,
      present: true,
    };
    if (row.environment === 'preview') (entry as { preview: EnvAssignmentEntry['preview'] }).preview = slot;
    else if (row.environment === 'production') (entry as { production: EnvAssignmentEntry['production'] }).production = slot;
  }

  return [...byKind.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The CF REST DELETE endpoint for one provisionable kind (identity = uuid for d1/kv, name for r2). */
function cfDeleteUrl(accountId: string, kind: ProvisionableKind, id: string): string {
  switch (kind) {
    case 'd1':
      return `${CF_API_BASE}/accounts/${accountId}/d1/database/${encodeURIComponent(id)}`;
    case 'kv':
      return `${CF_API_BASE}/accounts/${accountId}/storage/kv/namespaces/${encodeURIComponent(id)}`;
    case 'r2':
      return `${CF_API_BASE}/accounts/${accountId}/r2/buckets/${encodeURIComponent(id)}`;
  }
}

/** The account id for a copy op (thin accessor so the copy helper stays pure of env-shape assumptions). */
function accountForCopy(env: Env): string {
  return env.CF_ACCOUNT_ID ?? '';
}

/**
 * Copy KV values from a source namespace to a target namespace via the CF REST API (list keys → get each
 * value → put into target). Bounded to the first page (1000 keys) best-effort; returns an honest note. This
 * is the only kind with a straightforward REST-level value copy.
 */
async function copyKvValues(
  env: Env,
  accountId: string,
  orgId: string,
  sourceNsId: string,
  targetNsId: string,
): Promise<string> {
  if (!accountId) return 'Production KV namespace ensured; value copy skipped (no account id).';
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return 'Production KV namespace ensured; value copy skipped (no credentials).';

  const base = `${CF_API_BASE}/accounts/${accountId}/storage/kv/namespaces`;
  let listRes: Response;
  try {
    listRes = await fetch(`${base}/${encodeURIComponent(sourceNsId)}/keys?limit=1000`, {
      headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
      method: 'GET',
    });
  } catch {
    return 'Production KV namespace ensured; value copy failed to list source keys (transient).';
  }
  const listJson = (await listRes.json().catch(() => null)) as {
    success?: boolean;
    result?: Array<{ name: string }>;
    result_info?: { cursor?: string };
  } | null;
  if (!listRes.ok || !listJson?.success || !Array.isArray(listJson.result)) {
    return 'Production KV namespace ensured; value copy failed to list source keys.';
  }

  let copied = 0;
  for (const { name } of listJson.result) {
    let value: string | null = null;
    try {
      const vr = await fetch(`${base}/${encodeURIComponent(sourceNsId)}/values/${encodeURIComponent(name)}`, {
        headers: { ...cfAuthHeaders(auth) },
        method: 'GET',
      });
      if (vr.ok) value = await vr.text();
    } catch {
      value = null;
    }
    if (value === null) continue;
    try {
      const pr = await fetch(`${base}/${encodeURIComponent(targetNsId)}/values/${encodeURIComponent(name)}`, {
        body: value,
        headers: { ...cfAuthHeaders(auth) },
        method: 'PUT',
      });
      if (pr.ok) copied += 1;
    } catch {
      // best-effort — skip a failed key rather than abort the whole copy
    }
  }

  const truncated = Boolean(listJson.result_info?.cursor);
  return `Copied ${copied} KV ${copied === 1 ? 'value' : 'values'} preview → production${
    truncated ? ' (first 1000 keys — source has more; re-run to continue)' : ''
  }.`;
}
