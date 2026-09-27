/**
 * @module libs/features/data_resource_registry/schemas
 * @description Zod schemas for the Authoritative Resource Registry (Data & Resource Platform §1).
 *
 * Single source of truth for the registry model + the distinct resource-concept types. Every
 * enum column in `site_resource_registry` (migration 0643) is validated here; TS types are
 * `z.infer` — NEVER hand-duplicated (zod-everywhere). These schemas guard the registry write
 * boundary and the parsed shape the resolver + adapters consume.
 *
 * The FIVE orthogonal concepts + the concrete kinds are deliberately distinct so the resolver,
 * the UI, and the MCP never conflate them (DESIGN.md §2): an account-resource is a standalone CF
 * object; a wfp-namespace is a dispatch container; a DO-namespace is a class binding on a script;
 * a vectorize-namespace is a metadata partition inside one index; a binding is a relationship
 * attached to one User Worker at deploy. `environment` splits every kind into preview|production.
 *
 * @packageDocumentation
 */
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Concept + kind + tenancy + environment enums (DESIGN.md §2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The FIVE orthogonal resource concepts. A registry row is
 * `(siteId, environment, resourceKind, concept-shape)`. See DESIGN.md §2 for why each is its own
 * type (the HARD CF facts each encodes — a dispatch namespace has no quota, a DO class has no
 * enumerate-state API, a vectorize namespace is a partition not an index, a binding is a
 * relationship created at deploy).
 */
export const ResourceConceptSchema = z.enum([
  'account_resource', // standalone CF object owned by the account (D1 db, KV ns, R2 bucket, Vectorize index, Queue, AE dataset)
  'wfp_namespace', // the Workers-for-Platforms DISPATCH namespace — holds user scripts; not a store, not a quota pool
  'do_namespace', // a Durable Object CLASS binding on a specific Worker; instances addressed at runtime, state NOT browsable
  'vectorize_namespace', // a metadata NAMESPACE (partition) inside ONE Vectorize index — a filter key, not a separate index
  'binding', // the ATTACHMENT of a resource to ONE User Worker at deploy (metadata.bindings[]) — a relationship, not a CF object
]);
export type ResourceConcept = z.infer<typeof ResourceConceptSchema>;

/** The concrete resource KINDS the platform surfaces (what a UI section / MCP tool targets). */
export const ResourceKindSchema = z.enum([
  'd1', // account_resource — per-site dedicated (site_database_allocations)
  'kv', // account_resource — per-site dedicated (allocation) OR shared shim
  'r2', // account_resource — per-site dedicated (allocation) OR shared shim
  'durable_object', // do_namespace — SITE_BUILDER only; instance ops opt-in, state NOT browsable
  'workflow', // account_resource (Workflow binding) — platform-level, run instances
  'queue', // account_resource — UNSUPPORTED on this deployment (no QUEUE binding)
  'vectorize', // account_resource (index) + vectorize_namespace (partition)
  'analytics_engine', // account_resource (dataset) — read-only observability
  'connection', // an MCP/OAuth connection to an EXTERNAL provider (mcp_connections) — observability only
]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

/** Every kind is split into two isolated environments. preview MUST NEVER read/write production. */
export const ResourceEnvironmentSchema = z.enum(['preview', 'production']);
export type ResourceEnvironment = z.infer<typeof ResourceEnvironmentSchema>;

/** Whether the site OWNS a dedicated CF object, or SHARES a platform object via a key/prefix shim. */
export const ResourceTenancySchema = z.enum([
  'dedicated', // a genuinely per-site CF object (its own id) — e.g. provisioned per-site D1
  'shared_shim', // a shared platform object reached with a site-scoped prefix (Functions __PS_KV `site:<id>:`)
  'shared_platform', // a platform-only object never customer-facing (master D1) — recorded ONLY to denylist it
]);
export type ResourceTenancy = z.infer<typeof ResourceTenancySchema>;

/** Lifecycle a registry row flows through. */
export const ResourceLifecycleStateSchema = z.enum([
  'requested',
  'provisioning',
  'active',
  'degraded',
  'retiring',
  'retired',
  'error',
]);
export type ResourceLifecycleState = z.infer<typeof ResourceLifecycleStateSchema>;

/** How a resource came to exist. `binding_only` = attached at deploy, no standalone object;
 * `external` = an mcp_connections/OAuth link (kind='connection'). */
export const ProvisioningMethodSchema = z.enum([
  'lazy',
  'eager',
  'imported',
  'binding_only',
  'external',
]);
export type ProvisioningMethod = z.infer<typeof ProvisioningMethodSchema>;

/** Who may reach a resource + how. `no_direct` = reachable only via a service binding (per-site D1). */
export const ResourceAccessPolicySchema = z.enum([
  'site_scoped',
  'read_only',
  'superadmin_only',
  'no_direct',
]);
export type ResourceAccessPolicy = z.infer<typeof ResourceAccessPolicySchema>;

/**
 * Typed drift codes (DESIGN.md §6). `forbidden_shared` is ALWAYS logged and NEVER surfaced to a
 * customer (a resolve landed on a denylisted shared-platform id).
 */
export const ResourceDriftCodeSchema = z.enum([
  'resource_missing_on_cf', // row says it exists, CF head 404s
  'id_mismatch', // registry id ≠ what a fresh list returns
  'binding_mismatch', // recorded binding ≠ last upload's metadata.bindings[]
  'orphan_on_cf', // CF object exists with our naming, no row
  'forbidden_shared', // resolved a denylisted shared-platform id — logged, never surfaced
]);
export type ResourceDriftCode = z.infer<typeof ResourceDriftCodeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The registry row (Table B — site_resource_registry, migration 0643)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single row of `site_resource_registry`, as it is stored + read. Booleans that are `INTEGER`
 * in SQLite are modelled as `0 | 1` here (D1 returns them numeric); the service coerces them.
 * Every field maps 1:1 to a column (DESIGN.md §3.2 column-to-directive table).
 */
export const ResourceRecordSchema = z.object({
  id: z.string().min(1), // UUIDv7
  orgId: z.string().min(1), // authz key
  siteId: z.string().min(1), // resolution key
  ownerUserId: z.string().nullable().optional(),

  environment: ResourceEnvironmentSchema,
  resourceConcept: ResourceConceptSchema,
  resourceKind: ResourceKindSchema,
  tenancy: ResourceTenancySchema,

  cfAccountId: z.string().min(1), // env.CF_ACCOUNT_ID at record time
  wfpDispatchNamespace: z.string().nullable().optional(),
  userWorkerScript: z.string().nullable().optional(),

  resourceIdOrName: z.string().nullable().optional(), // the CF id OR name
  resourceDisplayName: z.string().nullable().optional(),
  bindingName: z.string().nullable().optional(),
  vectorizeNamespace: z.string().nullable().optional(),

  lifecycleState: ResourceLifecycleStateSchema,
  provisioningMethod: ProvisioningMethodSchema,
  accessPolicy: ResourceAccessPolicySchema,

  deletionProtected: z.union([z.literal(0), z.literal(1)]),

  deployId: z.string().nullable().optional(),
  deployedVersion: z.string().nullable().optional(),

  lastSyncAt: z.string().nullable().optional(),
  driftCode: ResourceDriftCodeSchema.nullable().optional(),
  driftDetail: z.string().nullable().optional(),
  lastErrorCode: z.string().nullable().optional(),
  lastErrorDetail: z.string().nullable().optional(),
  usageJson: z.string().nullable().optional(),

  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().optional(),
});
export type ResourceRecord = z.infer<typeof ResourceRecordSchema>;

/**
 * Input to record (upsert) a resource. The service supplies `id`, `cfAccountId`, and timestamps
 * server-side — the caller NEVER names the CF account. `orgId`/`siteId` come from the authed
 * context in the route, not the client body (IDOR discipline). Unknown keys rejected.
 */
export const RecordResourceInputSchema = z
  .object({
    orgId: z.string().min(1),
    siteId: z.string().min(1),
    ownerUserId: z.string().min(1).optional(),

    environment: ResourceEnvironmentSchema.default('production'),
    resourceConcept: ResourceConceptSchema,
    resourceKind: ResourceKindSchema,
    tenancy: ResourceTenancySchema.default('dedicated'),

    wfpDispatchNamespace: z.string().min(1).optional(),
    userWorkerScript: z.string().min(1).optional(),

    resourceIdOrName: z.string().min(1).optional(),
    resourceDisplayName: z.string().min(1).optional(),
    bindingName: z.string().min(1).optional(),
    vectorizeNamespace: z.string().min(1).optional(),

    lifecycleState: ResourceLifecycleStateSchema.default('requested'),
    provisioningMethod: ProvisioningMethodSchema.default('lazy'),
    accessPolicy: ResourceAccessPolicySchema.default('site_scoped'),

    deletionProtected: z.boolean().default(true),

    deployId: z.string().min(1).optional(),
    deployedVersion: z.string().min(1).optional(),
    usageJson: z.string().optional(),
  })
  .strict();
export type RecordResourceInput = z.infer<typeof RecordResourceInputSchema>;

/**
 * A BindingRecord is a registry row narrowed to `resourceConcept = 'binding'` — the attachment of
 * an account_resource (or service/DO/AI) to ONE User Worker at deploy. A binding always carries a
 * `bindingName` (the in-worker symbol) and a `userWorkerScript` (the script it attaches to); it is
 * created at upload, not provisioned. Modelled as a refinement of the base record so it shares one
 * shape (no duplicate type).
 */
export const BindingRecordSchema = ResourceRecordSchema.extend({
  resourceConcept: z.literal('binding'),
  bindingName: z.string().min(1), // required for a binding — the in-worker symbol
  userWorkerScript: z.string().min(1), // the script the binding attaches to
});
export type BindingRecord = z.infer<typeof BindingRecordSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Reference — the non-identifier tuple a caller supplies to resolve a CF id
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ONLY thing a browser/MCP caller may name when addressing a resource:
 * `{ kind, environment }` plus an optional non-identifier `ref` selector (a binding name, a
 * vectorize namespace) that disambiguates WHICH row of that kind — NEVER a raw CF id. `siteId`
 * comes from the route param and `orgId` from the authed context; both are added server-side and
 * are NOT part of this schema (so a client can't smuggle them). `.strict()` rejects any attempt to
 * pass a `resourceId`/`databaseId`/`accountId`.
 */
export const ResourceRefSchema = z
  .object({
    kind: ResourceKindSchema,
    environment: ResourceEnvironmentSchema.default('production'),
    concept: ResourceConceptSchema.optional(),
    /** Non-identifier selector: a binding symbol OR a vectorize namespace. Never a CF id. */
    bindingName: z.string().min(1).max(128).optional(),
    vectorizeNamespace: z.string().min(1).max(128).optional(),
  })
  .strict();
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

/** Typed reason a ref could not be resolved to a CF id — honest, no fabrication. */
export const ResolveResourceRefFailureSchema = z.enum([
  'unauthorized', // no authed org
  'not_owned', // site+env not owned by the caller's org (404-on-foreign in the route)
  'not_registered', // no registry row for (site, env, kind[, selector])
  'forbidden_shared', // resolved id is a denylisted shared-platform id — fail closed
  'no_account_id', // env.CF_ACCOUNT_ID missing
  'unsupported_kind', // kind is not_supported on this deployment (e.g. queue)
]);
export type ResolveResourceRefFailure = z.infer<typeof ResolveResourceRefFailureSchema>;

/**
 * Result of resolving a ref: on success, the server-resolved CF identifier + the account + the
 * bound row id. The caller receives an identifier it can act on, but it never NAMED it — the
 * registry did. On failure, a typed reason (never a partial success, never a fabricated id).
 */
export const ResolvedResourceRefSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    /** The server-resolved CF id or name — the ONLY place ids live. */
    resourceId: z.string().min(1),
    resourceKind: ResourceKindSchema,
    environment: ResourceEnvironmentSchema,
    accountId: z.string().min(1),
    /** The `site_resource_registry.id` this resolved from (audit / drift). */
    registryRowId: z.string().min(1),
    accessPolicy: ResourceAccessPolicySchema,
  }),
  z.object({
    ok: z.literal(false),
    reason: ResolveResourceRefFailureSchema,
  }),
]);
export type ResolvedResourceRef = z.infer<typeof ResolvedResourceRefSchema>;
