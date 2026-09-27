/**
 * @module libs/features/data_resource_registry/service
 * @description The Authoritative Resource Registry service (Data & Resource Platform §1 + §4).
 *
 * Records, lists, and gets registry rows for a `(site, environment)`, and — CRITICALLY —
 * {@link resolveResourceRef} resolves a CF identifier SERVER-SIDE from the registry + the authed
 * `site+env` context, REJECTING any id not owned by that site+env.
 *
 * The single most important invariant (DESIGN.md §4): **no CF identifier is ever accepted from the
 * client.** The caller supplies only `{ kind, environment }` plus a non-identifier selector; this
 * service maps that to the real CF id from a row the caller already proved they own. It reuses the
 * canonical `assertSiteOwned`/`ownsSiteData` guard (404-on-foreign) and the `FORBIDDEN_DB_IDS`
 * denylist so a resolve can never land on a shared-platform id.
 *
 * All D1 access goes through the repo `dbQuery`/`dbInsert`/`dbUpdate` helpers — never raw
 * `db.prepare` here.
 *
 * @packageDocumentation
 */
import type { Env } from '../../../src/types/env.js';
import { dbInsert, dbQuery, dbQueryOne } from '../../../src/services/db.js';
import { assertSiteOwned } from '../../../src/services/site_ownership.js';
import { FORBIDDEN_DB_IDS } from '../../../src/services/site_data_db.js';
import { uuidv7 } from '../../../src/lib/uuid.js';

import {
  type RecordResourceInput,
  RecordResourceInputSchema,
  type ResourceRecord,
  ResourceRecordSchema,
  type ResourceRef,
  ResourceRefSchema,
  type ResolvedResourceRef,
} from './schemas.js';

/**
 * The isolation guard the service depends on. Defaults to the canonical
 * {@link assertSiteOwned} (`sites.org_id === orgId`, 404-on-foreign) but is injectable so unit
 * tests can drive the site-isolation branch without a live D1, and so a caller that already
 * resolved ownership via `ownsSiteData` can pass an equivalent probe. Both check the SAME
 * invariant: row exists, not soft-deleted, `org_id` == caller's authed org.
 */
export type OwnershipGuard = (
  env: Env,
  orgId: string | undefined,
  siteId: string,
) => Promise<boolean>;

/** Kinds that are genuinely `not_supported` on this deployment (CAPABILITY-MATRIX.md). */
const UNSUPPORTED_KINDS: ReadonlySet<ResourceRef['kind']> = new Set(['queue']);

/**
 * The shared-platform ids the registry must NEVER resolve to a customer surface, keyed by kind.
 * D1 reuses the live {@link FORBIDDEN_DB_IDS} denylist (the master + non-prod platform DBs). Other
 * kinds have no shared-id denylist YET (their shared shims are prefix-scoped, not id-collisions) —
 * an empty set means "nothing denied for this kind". Kept here so the fence is one lookup.
 */
function forbiddenIdsForKind(kind: ResourceRef['kind']): ReadonlySet<string> {
  if (kind === 'd1') return FORBIDDEN_DB_IDS;
  return EMPTY_DENYLIST;
}
const EMPTY_DENYLIST: ReadonlySet<string> = new Set();

// ─────────────────────────────────────────────────────────────────────────────
// Row mapping (D1 snake_case → typed camelCase ResourceRecord)
// ─────────────────────────────────────────────────────────────────────────────

/** Raw `site_resource_registry` row shape as D1 returns it (snake_case, INTEGER booleans). */
interface RegistryRow {
  id: string;
  org_id: string;
  site_id: string;
  owner_user_id: string | null;
  environment: string;
  resource_concept: string;
  resource_kind: string;
  tenancy: string;
  cf_account_id: string;
  wfp_dispatch_namespace: string | null;
  user_worker_script: string | null;
  resource_id_or_name: string | null;
  resource_display_name: string | null;
  binding_name: string | null;
  vectorize_namespace: string | null;
  lifecycle_state: string;
  provisioning_method: string;
  access_policy: string;
  deletion_protected: number;
  deploy_id: string | null;
  deployed_version: string | null;
  last_sync_at: string | null;
  drift_code: string | null;
  drift_detail: string | null;
  last_error_code: string | null;
  last_error_detail: string | null;
  usage_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Parse a raw D1 row into a validated {@link ResourceRecord} (Zod at the read boundary). */
function toResourceRecord(row: RegistryRow): ResourceRecord {
  return ResourceRecordSchema.parse({
    id: row.id,
    orgId: row.org_id,
    siteId: row.site_id,
    ownerUserId: row.owner_user_id,
    environment: row.environment,
    resourceConcept: row.resource_concept,
    resourceKind: row.resource_kind,
    tenancy: row.tenancy,
    cfAccountId: row.cf_account_id,
    wfpDispatchNamespace: row.wfp_dispatch_namespace,
    userWorkerScript: row.user_worker_script,
    resourceIdOrName: row.resource_id_or_name,
    resourceDisplayName: row.resource_display_name,
    bindingName: row.binding_name,
    vectorizeNamespace: row.vectorize_namespace,
    lifecycleState: row.lifecycle_state,
    provisioningMethod: row.provisioning_method,
    accessPolicy: row.access_policy,
    deletionProtected: row.deletion_protected === 0 ? 0 : 1,
    deployId: row.deploy_id,
    deployedVersion: row.deployed_version,
    lastSyncAt: row.last_sync_at,
    driftCode: row.drift_code,
    driftDetail: row.drift_detail,
    lastErrorCode: row.last_error_code,
    lastErrorDetail: row.last_error_detail,
    usageJson: row.usage_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

const SELECT_COLUMNS =
  'id, org_id, site_id, owner_user_id, environment, resource_concept, resource_kind, tenancy, ' +
  'cf_account_id, wfp_dispatch_namespace, user_worker_script, resource_id_or_name, ' +
  'resource_display_name, binding_name, vectorize_namespace, lifecycle_state, ' +
  'provisioning_method, access_policy, deletion_protected, deploy_id, deployed_version, ' +
  'last_sync_at, drift_code, drift_detail, last_error_code, last_error_detail, usage_json, ' +
  'created_at, updated_at, deleted_at';

// ─────────────────────────────────────────────────────────────────────────────
// record / list / get
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record (insert) a resource row in the registry. The service supplies `id` (UUIDv7),
 * `cf_account_id` (`env.CF_ACCOUNT_ID` — NEVER the client), and timestamps. `orgId`/`siteId` in
 * the input come from the authed context in the route, not the client body.
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID)
 * @param input - validated {@link RecordResourceInput}
 * @returns the new row id on success, or a typed error string
 */
export async function recordResource(
  env: Env,
  input: RecordResourceInput,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const parsed = RecordResourceInputSchema.parse(input);
  const account = env.CF_ACCOUNT_ID;
  if (!account) return { error: 'no_account_id', ok: false };

  const id = uuidv7();
  const { error } = await dbInsert(env.DB, 'site_resource_registry', {
    id,
    org_id: parsed.orgId,
    site_id: parsed.siteId,
    owner_user_id: parsed.ownerUserId ?? null,
    environment: parsed.environment,
    resource_concept: parsed.resourceConcept,
    resource_kind: parsed.resourceKind,
    tenancy: parsed.tenancy,
    cf_account_id: account,
    wfp_dispatch_namespace: parsed.wfpDispatchNamespace ?? null,
    user_worker_script: parsed.userWorkerScript ?? null,
    resource_id_or_name: parsed.resourceIdOrName ?? null,
    resource_display_name: parsed.resourceDisplayName ?? null,
    binding_name: parsed.bindingName ?? null,
    vectorize_namespace: parsed.vectorizeNamespace ?? null,
    lifecycle_state: parsed.lifecycleState,
    provisioning_method: parsed.provisioningMethod,
    access_policy: parsed.accessPolicy,
    deletion_protected: parsed.deletionProtected ? 1 : 0,
    deploy_id: parsed.deployId ?? null,
    deployed_version: parsed.deployedVersion ?? null,
    usage_json: parsed.usageJson ?? null,
  });
  if (error) return { error, ok: false };
  return { id, ok: true };
}

/**
 * List a site's registry rows for one environment (soft-deleted rows excluded).
 *
 * The caller MUST have already proven org ownership of `siteId` in the route (the same discipline
 * as the D1 Tables surface) — this function is the DB read; the route runs the ownership gate.
 *
 * @param env - worker env (DB)
 * @param siteId - the OWNED site (server-side, from the route param)
 * @param environment - 'preview' | 'production'
 * @returns validated {@link ResourceRecord}[]
 */
export async function listResources(
  env: Env,
  siteId: string,
  environment: ResourceRef['environment'],
): Promise<ResourceRecord[]> {
  const { data } = await dbQuery<RegistryRow>(
    env.DB,
    `SELECT ${SELECT_COLUMNS} FROM site_resource_registry
       WHERE site_id = ? AND environment = ? AND deleted_at IS NULL
       ORDER BY resource_kind, resource_concept, created_at`,
    [siteId, environment],
  );
  return data.map(toResourceRecord);
}

/**
 * Get ONE registry row by its id, scoped to the owning site (defense-in-depth: the id AND the
 * site must match, so a row id from another site is a miss). Returns `null` when not found.
 *
 * @param env - worker env (DB)
 * @param siteId - the OWNED site the row must belong to
 * @param rowId - the `site_resource_registry.id`
 */
export async function getResource(
  env: Env,
  siteId: string,
  rowId: string,
): Promise<ResourceRecord | null> {
  const row = await dbQueryOne<RegistryRow>(
    env.DB,
    `SELECT ${SELECT_COLUMNS} FROM site_resource_registry
       WHERE id = ? AND site_id = ? AND deleted_at IS NULL`,
    [rowId, siteId],
  );
  return row ? toResourceRecord(row) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveResourceRef — the server-side identifier-resolution keystone (§4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a client-supplied {@link ResourceRef} to a real CF identifier, SERVER-SIDE, rejecting
 * any id not owned by the authed `(org, site, env)`. This is the generalisation of
 * `resolveSiteDataDb` for every resource kind, and it is the security keystone: the caller never
 * names a CF id — it names `{ kind, environment[, selector] }`, and this maps to a row it owns.
 *
 * Resolution algorithm (DESIGN.md §4, mirrors the canonical site-scoped route order):
 *   1. AUTH       — `orgId` from the authed context (401 if absent). NEVER from the ref/body.
 *   2. SUPPORT    — reject a `not_supported` kind (e.g. queue) with `unsupported_kind`.
 *   3. OWNERSHIP  — `ownsSite(env, orgId, siteId)` (default {@link assertSiteOwned}) else
 *                   `not_owned` → the route renders 404 (never 403 — never leak existence).
 *   4. LOOKUP     — read the CF id from the REGISTRY row for `(siteId, env, kind[, selector])`.
 *                   A ref that names a kind/selector with NO owned row → `not_registered`.
 *   5. DENYLIST   — if the resolved id ∈ the kind's shared-platform denylist → `forbidden_shared`
 *                   (fail closed; the caller logs, never confirms).
 *   6. ACCOUNT    — `env.CF_ACCOUNT_ID` (never client) else `no_account_id`.
 *
 * The returned identifier came from a row keyed on the OWNED `siteId` + the requested `environment`
 * — a preview ref resolves the preview row (a DIFFERENT CF id than production), so a preview op can
 * never touch a production id because it never resolves one. A ref for another site/env has no
 * matching owned row and is rejected at step 3 (foreign site) or step 4 (no row).
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID)
 * @param siteId - the site from the route param (server-side, NEVER from the ref/body)
 * @param ref - the non-identifier `{ kind, environment[, selector] }` from the caller
 * @param opts.orgId - the caller's authed org (`c.get('orgId')`); `undefined` → `unauthorized`
 * @param opts.ownsSite - injectable ownership guard (default {@link assertSiteOwned})
 * @returns a {@link ResolvedResourceRef} — the resolved CF id on success, else a typed reason
 */
export async function resolveResourceRef(
  env: Env,
  siteId: string,
  ref: ResourceRef,
  opts: { orgId?: string | undefined; ownsSite?: OwnershipGuard },
): Promise<ResolvedResourceRef> {
  const parsedRef = ResourceRefSchema.parse(ref);
  const orgId = opts.orgId;
  const ownsSite = opts.ownsSite ?? assertSiteOwned;

  // 1. AUTH — org comes ONLY from the authed context.
  if (!orgId) return { ok: false, reason: 'unauthorized' };

  // 2. SUPPORT — honest refusal for a kind the CF API can't back on this deployment.
  if (UNSUPPORTED_KINDS.has(parsedRef.kind)) {
    return { ok: false, reason: 'unsupported_kind' };
  }

  // 3. OWNERSHIP — the site+env must belong to the caller's org (404-on-foreign in the route).
  if (!(await ownsSite(env, orgId, siteId))) {
    return { ok: false, reason: 'not_owned' };
  }

  // 4. LOOKUP — the CF id lives ONLY in a registry row for the OWNED site + requested env + kind.
  //    The org_id is ALSO matched (belt-and-braces with the ownership gate) so a row that somehow
  //    carries a foreign org can never resolve. Optional selector disambiguates WHICH row.
  const clauses = [
    'site_id = ?',
    'org_id = ?',
    'environment = ?',
    'resource_kind = ?',
    'deleted_at IS NULL',
  ];
  const params: unknown[] = [siteId, orgId, parsedRef.environment, parsedRef.kind];
  if (parsedRef.concept) {
    clauses.push('resource_concept = ?');
    params.push(parsedRef.concept);
  }
  if (parsedRef.bindingName) {
    clauses.push('binding_name = ?');
    params.push(parsedRef.bindingName);
  }
  if (parsedRef.vectorizeNamespace) {
    clauses.push('vectorize_namespace = ?');
    params.push(parsedRef.vectorizeNamespace);
  }
  const row = await dbQueryOne<
    Pick<RegistryRow, 'id' | 'resource_id_or_name' | 'access_policy'>
  >(
    env.DB,
    `SELECT id, resource_id_or_name, access_policy FROM site_resource_registry
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at LIMIT 1`,
    params,
  );
  if (!row || !row.resource_id_or_name) {
    return { ok: false, reason: 'not_registered' };
  }

  // 5. DENYLIST — a resolved id that is a shared-platform id fails closed (never surfaced).
  if (forbiddenIdsForKind(parsedRef.kind).has(row.resource_id_or_name)) {
    return { ok: false, reason: 'forbidden_shared' };
  }

  // 6. ACCOUNT — always the server account, never the client.
  const account = env.CF_ACCOUNT_ID;
  if (!account) return { ok: false, reason: 'no_account_id' };

  const accessPolicy = ResourceRecordSchema.shape.accessPolicy.parse(row.access_policy);
  return {
    accessPolicy,
    accountId: account,
    environment: parsedRef.environment,
    ok: true,
    registryRowId: row.id,
    resourceId: row.resource_id_or_name,
    resourceKind: parsedRef.kind,
  };
}
