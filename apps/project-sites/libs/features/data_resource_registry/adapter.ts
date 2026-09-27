/**
 * @module libs/features/data_resource_registry/adapter
 * @description The typed CF resource ADAPTER INTERFACE (Data & Resource Platform §5).
 *
 * One adapter per {@link ResourceKind}, each a narrow typed API (tool-design-as-api — no
 * `runAnything`). This file is the CONTRACT ONLY (interface + types) — concrete per-kind adapters
 * (d1, kv, r2, …) implement it against the CF REST API in later fires. The interface is uniform so
 * the UI + MCP + resolver treat every kind the same, while each implementation honestly reflects
 * what the CF API supports (CAPABILITY-MATRIX.md): a kind returns a `not_supported` typed error for
 * a verb the CF API genuinely can't back (e.g. Queue on this deployment, "browse all DO state").
 *
 * Every method:
 *  - takes a {@link ResolvedScope} whose `resourceId` was RESOLVED server-side from the registry —
 *    it NEVER carries a CF id from the caller (see `service.resolveResourceRef`);
 *  - returns a typed {@link AdapterResult} envelope, never raw stdout/JSON;
 *  - is Zod-validated in + out by its concrete implementation (this file declares the contract).
 *
 * The scope's executor can only address the id it was minted with (the `site_data_db.ts`
 * `SiteDataD1` pattern) — a structural guarantee, not just a check.
 *
 * @packageDocumentation
 */
import type { CfAuth } from '../../../src/services/cf_credentials.js';
import type {
  ResourceAccessPolicy,
  ResourceEnvironment,
  ResourceKind,
} from './schemas.js';

/**
 * Uniform result envelope for every adapter method (tool-design-as-api). Success carries `data`;
 * failure carries a typed `error` (code + user-safe message + retryable hint). Every result
 * carries a `correlationId` for log/trace correlation (structured-logging).
 */
export interface AdapterResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
  readonly correlationId: string;
}

/**
 * The scope every adapter method resolves against — NEVER carries a CF id from the caller.
 * `resourceId` is server-resolved from the registry (`service.resolveResourceRef`); `auth` comes
 * from `resolveCfCredentials`; `accountId` is `env.CF_ACCOUNT_ID`. An executor minted for this
 * scope can address ONLY `resourceId`.
 */
export interface ResolvedScope {
  readonly siteId: string;
  readonly orgId: string; // authed
  readonly environment: ResourceEnvironment;
  readonly auth: CfAuth; // from resolveCfCredentials
  readonly accountId: string; // env.CF_ACCOUNT_ID
  readonly resourceId: string; // resolved from the registry (the ONLY id, server-side)
  /** How the resolved resource may be reached (drives whether a mutate verb is even offered). */
  readonly accessPolicy: ResourceAccessPolicy;
}

/**
 * The four verbs every adapter declares support for. A kind returns a `not_supported` typed error
 * for any verb its CF API genuinely can't back.
 *
 * - `list`   → enumerate children (D1 tables, KV keys, R2 objects, Vectorize namespaces, workflow runs)
 * - `head`   → cheap existence/metadata probe of the resource itself (sync/drift primitive, no body)
 * - `get`    → read ONE child (a table page, one KV value, one R2 object, one workflow run)
 * - `mutate` → a NAMED, typed mutation (provision | destroy | put | delete | seed | trigger …)
 */
export type ResourceVerb = 'list' | 'head' | 'get' | 'mutate';

/** Declares which environments + verbs + named mutations an adapter serves (drives the UI/MCP). */
export interface ResourceAdapterSupport {
  readonly environments: readonly ResourceEnvironment[];
  readonly verbs: readonly ResourceVerb[];
  /** Named mutations this kind allows (`[]` = read-only). Each is a discriminated `mutate` variant. */
  readonly mutations: readonly string[];
}

/**
 * Typed contract per resource kind. Not all kinds implement all verbs — a kind returns a
 * `not_supported` typed error (in the {@link AdapterResult} envelope) for a verb the CF API
 * genuinely can't back. `mutate` is a discriminated union per kind
 * (`{ action: 'provision' } | { action: 'put'; key; value } | …`), each variant with its own Zod
 * schema — NEVER a generic `{ sql }`/`{ command }` field.
 *
 * @typeParam TList        - shape returned by `list` (e.g. table names, KV key page, R2 object list)
 * @typeParam THead        - shape returned by `head` (cheap metadata probe)
 * @typeParam TGet         - shape returned by `get` (one child)
 * @typeParam TMutateInput - the discriminated named-mutation input union
 * @typeParam TMutateResult- shape returned by a successful mutation
 */
export interface ResourceAdapter<
  TList,
  THead,
  TGet,
  TMutateInput,
  TMutateResult,
> {
  readonly kind: ResourceKind;
  /** Which environments + verbs + mutations this adapter serves (drives the UI). */
  readonly supports: ResourceAdapterSupport;

  /** Enumerate children of the resource. Optional `input` = pagination / filter (per-kind Zod). */
  list(scope: ResolvedScope, input?: unknown): Promise<AdapterResult<TList>>;

  /** Cheap existence/metadata probe of the resource itself — the sync/drift primitive. */
  head(scope: ResolvedScope): Promise<AdapterResult<THead>>;

  /** Read ONE child of the resource (a table page, one KV value, one R2 object, one run). */
  get(scope: ResolvedScope, input: unknown): Promise<AdapterResult<TGet>>;

  /** Run a NAMED, typed mutation. `input` is the kind's discriminated `{ action, … }` union. */
  mutate(scope: ResolvedScope, input: TMutateInput): Promise<AdapterResult<TMutateResult>>;
}

/**
 * A registry of adapters keyed by {@link ResourceKind}. Concrete adapters register here in a later
 * fire; the resolver + MCP dispatch look an adapter up by kind. Typed loose (`ResourceAdapter` with
 * `unknown` type args) because each kind's payloads differ — the concrete adapter narrows them.
 */
export type ResourceAdapterRegistry = Partial<
  Record<ResourceKind, ResourceAdapter<unknown, unknown, unknown, unknown, unknown>>
>;
