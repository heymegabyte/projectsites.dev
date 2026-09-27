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
import { resolveCfCredentials } from '../../../src/services/cf_credentials.js';
import { provisionSiteD1 } from '../../../src/services/d1_provisioner.js';
import { provisionSiteKv } from '../../../src/services/kv_provisioner.js';
import { provisionSiteR2 } from '../../../src/services/r2_provisioner.js';
import { uuidv7 } from '../../../src/lib/uuid.js';

import { checkAccountResourceQuota, type ProvisionableKind } from './quota.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// provisionResource — the PROVISIONING wire-up (not_registered → live dedicated)
// ─────────────────────────────────────────────────────────────────────────────

/** The per-kind display + access-policy metadata used when recording a freshly-provisioned row. */
const PROVISION_META: Record<
  ProvisionableKind,
  { readonly accessPolicy: ResourceRecord['accessPolicy']; readonly label: string }
> = {
  d1: { accessPolicy: 'no_direct', label: 'D1 database' }, // per-site D1 reached via REST/service binding (INV-8)
  kv: { accessPolicy: 'site_scoped', label: 'KV namespace' },
  r2: { accessPolicy: 'site_scoped', label: 'R2 bucket' },
};

/**
 * The typed outcome of {@link provisionResource}. Every non-success is an HONEST, typed reason — a
 * `record_failed` carries the created CF id so the PARTIAL state is recoverable (never a silent
 * half-provision). `quota_at_cap` names the kind so the caller can render an honest "account D1 quota
 * reached" — NEVER a silent shared substitution.
 */
export type ProvisionResourceResult =
  | {
      readonly ok: true;
      /** The site's dedicated CF id (D1 uuid / KV namespace id) or name (R2 bucket). */
      readonly resourceId: string;
      /** The registry `site_resource_registry.id` recorded for it. */
      readonly registryRowId: string;
      /** true when THIS call freshly created the resource; false when an existing allocation was reused. */
      readonly created: boolean;
      /** Human display name of the provisioned resource. */
      readonly displayName: string;
    }
  | {
      // The provisioner succeeded (a REAL CF resource + allocation exist) but the registry record
      // failed — a RECOVERABLE partial state: re-running provisionResource is idempotent (it reuses the
      // allocation) and will retry the record. The caller MUST surface this, never treat it as clean.
      readonly ok: false;
      readonly reason: 'record_failed';
      /** The created CF id/name — the resource EXISTS; only the registry row is missing. */
      readonly resourceId: string;
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | 'unsupported_kind' // a kind with no live provisioner (only d1/kv/r2 provision here)
        | 'unauthorized' // no authed org
        | 'not_owned' // site+env not owned by the caller's org (404-on-foreign in the route)
        | 'confirmation_required' // confirm:true is REQUIRED — provisioning creates billable infra
        | 'quota_at_cap' // account is at cap for this kind — refuse, NEVER silently share
        | 'quota_check_failed' // could not read the account count — fail closed, do not provision
        | 'no_cf_credentials'
        | 'no_account_id'
        | 'provision_failed'; // the CF create itself failed (records nothing)
      readonly status?: number;
    };

/** Invoke the right provisioner for a kind — each is idempotent (reuses an existing allocation). */
async function runProvisioner(
  env: Env,
  kind: ProvisionableKind,
  args: { siteId: string; tenantId: string; orgId: string | null },
): Promise<
  | { ok: true; resourceId: string; displayName: string; reused: boolean }
  | { ok: false; reason: string; status?: number }
> {
  if (kind === 'd1') {
    const r = await provisionSiteD1(env, args);
    return r.ok
      ? { displayName: r.databaseName, ok: true, resourceId: r.databaseId, reused: r.reused }
      : { ok: false, reason: r.reason, status: r.status };
  }
  if (kind === 'kv') {
    const r = await provisionSiteKv(env, args);
    return r.ok
      ? { displayName: r.namespaceName, ok: true, resourceId: r.namespaceId, reused: r.reused }
      : { ok: false, reason: r.reason, status: r.status };
  }
  const r = await provisionSiteR2(env, args);
  return r.ok
    ? { displayName: r.bucketName, ok: true, resourceId: r.bucketName, reused: r.reused }
    : { ok: false, reason: r.reason, status: r.status };
}

/**
 * PROVISION a per-site DEDICATED resource — the wire-up that turns `not_registered` into a live,
 * registry-recorded, tenancy=`dedicated` allocation by calling the (previously inert) provisioner.
 *
 * The flow (SECURITY-INVARIANTS + the directive):
 *   1. AUTH        — `orgId` from the authed context (never the client). `confirm:true` REQUIRED
 *                    (provisioning creates REAL billable CF infra — approval-required, INV-11).
 *   2. SUPPORT     — only `d1`/`kv`/`r2` have a live provisioner; anything else → `unsupported_kind`.
 *   3. OWNERSHIP   — `ownsSite(env, orgId, siteId)` (default {@link assertSiteOwned}) else `not_owned`
 *                    (the route renders 404 — never leak existence).
 *   4. IDEMPOTENT  — if the site ALREADY has this resource (a live registry row for the kind), return
 *                    it and CREATE NOTHING (no duplicate CF resource, no duplicate row).
 *   5. QUOTA       — BEFORE creating, check the REAL account count via the CF API. At cap → honest
 *                    `quota_at_cap` (NEVER a silent shared substitution). Indeterminate → fail closed.
 *   6. CREATE      — call the idempotent provisioner (creates the CF resource + the allocation row).
 *   7. RECORD      — `recordResource` a tenancy=`dedicated` registry row. If the provisioner succeeded
 *                    but the record fails → return `record_failed` WITH the created id so the partial
 *                    state is RECOVERABLE (re-run is idempotent), never a silent half-provision.
 *
 * The caller MUST have proven org ownership upstream when passing an always-true `ownsSite` (the MCP
 * dispatcher does its own `WHERE id=? AND org_id=?`); otherwise the default guard enforces it.
 *
 * @param env - worker env (DB + CF_ACCOUNT_ID + creds source)
 * @param siteId - the OWNED site (server-side; NEVER a client-supplied CF id)
 * @param kind - the provisionable account_resource kind (`d1` | `kv` | `r2`)
 * @param opts.environment - 'preview' | 'production' (the registry row's environment)
 * @param opts.orgId - the caller's authed org (`c.get('orgId')`); `undefined` → `unauthorized`
 * @param opts.confirm - MUST be `true` — provisioning creates billable infra
 * @param opts.tenantId - the allocation's tenant (defaults to `orgId ?? siteId`)
 * @param opts.ownsSite - injectable ownership guard (default {@link assertSiteOwned})
 * @returns a typed {@link ProvisionResourceResult}
 */
export async function provisionResource(
  env: Env,
  siteId: string,
  kind: ProvisionableKind,
  opts: {
    environment: ResourceRef['environment'];
    orgId?: string | undefined;
    confirm?: boolean;
    tenantId?: string | null;
    ownsSite?: OwnershipGuard;
  },
): Promise<ProvisionResourceResult> {
  const orgId = opts.orgId;
  const environment = opts.environment;
  const ownsSite = opts.ownsSite ?? assertSiteOwned;

  // 1. AUTH + confirm gate — provisioning creates REAL billable infra (INV-11 approval-required).
  if (!orgId) return { ok: false, reason: 'unauthorized' };
  if (opts.confirm !== true) return { ok: false, reason: 'confirmation_required' };

  // 2. SUPPORT — only the three kinds with a live provisioner.
  const meta = PROVISION_META[kind];
  if (!meta) return { ok: false, reason: 'unsupported_kind' };

  // 3. OWNERSHIP — the site must belong to the caller's org (404-on-foreign in the route).
  if (!(await ownsSite(env, orgId, siteId))) {
    return { ok: false, reason: 'not_owned' };
  }

  // 4. IDEMPOTENT — an existing live registry row for this kind means it's already provisioned. Return
  //    it and CREATE NOTHING (no double-provision). Belt-and-braces with the provisioner's own reuse.
  const existing = await dbQueryOne<{ id: string; resource_id_or_name: string | null; resource_display_name: string | null }>(
    env.DB,
    `SELECT id, resource_id_or_name, resource_display_name FROM site_resource_registry
       WHERE site_id = ? AND org_id = ? AND environment = ? AND resource_kind = ?
         AND resource_concept = 'account_resource' AND deleted_at IS NULL
         AND resource_id_or_name IS NOT NULL
       ORDER BY created_at LIMIT 1`,
    [siteId, orgId, environment, kind],
  );
  if (existing?.resource_id_or_name) {
    return {
      created: false,
      displayName: existing.resource_display_name ?? existing.resource_id_or_name,
      ok: true,
      registryRowId: existing.id,
      resourceId: existing.resource_id_or_name,
    };
  }

  // 5. QUOTA — count the REAL account resources BEFORE creating. A per-site WfP namespace does NOT
  //    raise account-wide D1/KV/R2 limits, so this is the only honest capacity signal. At cap → refuse
  //    with a typed error (NEVER a silent shared binding). Indeterminate probe → fail closed.
  const auth = await resolveCfCredentials(env, orgId);
  if (!auth) return { ok: false, reason: 'no_cf_credentials' };
  const account = env.CF_ACCOUNT_ID;
  if (!account) return { ok: false, reason: 'no_account_id' };

  const quota = await checkAccountResourceQuota(auth, account, kind);
  if (!quota.ok) return { ok: false, reason: 'quota_check_failed', status: quota.status };
  if (quota.atCap) return { ok: false, reason: 'quota_at_cap' };

  // 6. CREATE — the idempotent provisioner creates the CF resource + records the allocation row.
  const tenantId = opts.tenantId ?? orgId ?? siteId;
  const prov = await runProvisioner(env, kind, { orgId, siteId, tenantId });
  if (!prov.ok) {
    return {
      ok: false,
      reason: prov.reason === 'no_account_id' ? 'no_account_id' : 'provision_failed',
      status: prov.status,
    };
  }

  // 7. RECORD — a tenancy=dedicated registry row. If THIS fails after the CF resource exists, report a
  //    RECOVERABLE partial state (the id is live; re-running provisionResource reuses it + retries the
  //    record) — never a silent half-provision (the directive's "keep provision + record recoverable").
  const recorded = await recordResource(env, {
    accessPolicy: meta.accessPolicy,
    deletionProtected: true,
    environment,
    lifecycleState: 'active',
    orgId,
    provisioningMethod: 'eager',
    resourceConcept: 'account_resource',
    resourceDisplayName: prov.displayName,
    resourceIdOrName: prov.resourceId,
    resourceKind: kind,
    siteId,
    tenancy: 'dedicated',
  });
  if (!recorded.ok) {
    return { detail: recorded.error, ok: false, reason: 'record_failed', resourceId: prov.resourceId };
  }

  return {
    created: !prov.reused,
    displayName: prov.displayName,
    ok: true,
    registryRowId: recorded.id,
    resourceId: prov.resourceId,
  };
}
