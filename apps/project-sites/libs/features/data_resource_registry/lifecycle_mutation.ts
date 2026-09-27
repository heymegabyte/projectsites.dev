/**
 * @module libs/features/data_resource_registry/lifecycle_mutation
 * @description Shared LIFECYCLE + R2-presign `mutate` bridge for the d1/kv/r2 adapters (FIRE 5). Turns the
 * standalone {@link ./lifecycle_service} operations (teardown / clone / promote) and the scoped-URL minter
 * ({@link ./r2_presign}) into the uniform {@link AdapterResult} envelope every adapter verb returns, so the
 * three provisionable adapters share ONE lifecycle implementation (tool-design-as-api — no per-adapter copy
 * of the confirm / CF-DELETE / registry-update logic).
 *
 * Each op mirrors {@link ../provision_mutation}: the ownership gate has already run upstream (the route's
 * `ownsSiteData`), and each service op re-scopes every DB read on `siteId` + `orgId`; destructive/billable
 * ops require `confirm:true` (surfaced as `confirmation_required` until approved); an op CF genuinely can't
 * back returns an honest `not_available` (never a fabricated success).
 *
 * @packageDocumentation
 */
import type { AdapterResult, ResolvedScope } from './adapter.js';
import {
  cloneResource,
  promoteResource,
  teardownResource,
  type LifecycleFailureReason,
} from './lifecycle_service.js';
import type { ProvisionableKind } from './quota.js';
import { mintScopedR2Url, type R2PresignVerb } from './r2_presign.js';

/** The `teardown` mutation input — DESTRUCTIVE, requires `confirm:true`. */
export interface TeardownInput {
  readonly action: 'teardown';
  readonly confirm?: boolean;
}

/** The `clone` mutation input — duplicates a resource within the site (may be `not_available`). */
export interface CloneInput {
  readonly action: 'clone';
  readonly confirm?: boolean;
}

/** The `promote` mutation input — copy/point preview → production. Requires `confirm:true` (may provision prod). */
export interface PromoteInput {
  readonly action: 'promote';
  readonly confirm?: boolean;
}

/** The `preview_url` mutation input — mint a short-lived SCOPED download/upload URL for ONE R2 object. */
export interface PresignInput {
  readonly action: 'preview_url' | 'upload_url';
  readonly key: string;
  /** For `upload_url`: the content-type the client will send (signed into the URL). */
  readonly contentType?: string;
  /** Requested TTL in seconds (clamped `[60, 3600]`). */
  readonly ttlSeconds?: number;
}

/** What a successful `teardown` returns (shared by d1/kv/r2 — one shape, no per-adapter duplicate). */
export interface TeardownMutateResult {
  readonly action: 'teardown';
  readonly resourceId: string;
  readonly displayName: string;
  readonly deletedCfResource: boolean;
}

/** What a successful `clone` returns (shared by d1/kv/r2). Honest — clone is `not_available` today. */
export interface CloneMutateResult {
  readonly action: 'clone';
  readonly resourceId: string;
  readonly registryRowId: string;
  readonly displayName: string;
  readonly copied: boolean;
  readonly note?: string;
}

/** What a successful `promote` returns (shared by d1/kv/r2 — ensured prod resource + honest copy note). */
export interface PromoteMutateResult {
  readonly action: 'promote';
  readonly targetResourceId: string;
  readonly registryRowId: string;
  readonly note?: string;
}

/** What a successful `preview_url`/`upload_url` returns (R2 only — a short-lived SCOPED URL or honest miss). */
export interface PresignMutateResult {
  readonly action: 'preview_url' | 'upload_url';
  readonly key: string;
  readonly available: boolean;
  readonly url?: string;
  readonly expiresInSeconds?: number;
  readonly approach?: string;
}

/** Map a typed lifecycle failure reason → a user-safe adapter error envelope. */
function lifecycleError<T>(cid: string, reason: LifecycleFailureReason, detail?: string): AdapterResult<T> {
  const messages: Record<LifecycleFailureReason, { message: string; retryable: boolean }> = {
    cf_error: { message: 'Cloudflare could not complete this action. Try again shortly.', retryable: true },
    deletion_protected: {
      message: 'This resource is protected from deletion because the site depends on it. It cannot be torn down here.',
      retryable: false,
    },
    forbidden_shared: { message: 'This resource cannot be modified.', retryable: false },
    no_account_id: { message: 'Cloudflare account is not configured.', retryable: false },
    no_cf_credentials: { message: 'Cloudflare credentials are not configured.', retryable: false },
    not_available: {
      message: detail ?? 'This action is not available for this resource.',
      retryable: false,
    },
    not_owned: { message: 'Resource not found.', retryable: false },
    not_registered: { message: 'No resource of this kind is connected to this site yet.', retryable: false },
    unauthorized: { message: 'You must be signed in.', retryable: false },
  };
  const m = messages[reason];
  // A `confirmation_required` surfaced as not_available (from promote's provision gate) keeps the code the UI expects.
  const code = reason === 'not_available' && detail === 'confirmation_required' ? 'confirmation_required' : reason;
  return {
    correlationId: cid,
    error: {
      code,
      message: code === 'confirmation_required'
        ? 'Promoting to production may create a real, billable production resource. Re-run with confirm:true.'
        : m.message,
      retryable: m.retryable,
    },
    ok: false,
  };
}

/**
 * Run the `teardown` mutation: delete the per-site CF resource + soft-delete its registry row. DESTRUCTIVE —
 * requires `confirm:true`; without it, returns `confirmation_required` NAMING the irreversibility so the UI's
 * confirm dialog can carry an honest warning.
 */
export async function runTeardownMutation(
  cid: string,
  scope: ResolvedScope,
  kind: ProvisionableKind,
  input: TeardownInput,
): Promise<AdapterResult<TeardownMutateResult>> {
  const env = scope.env;
  if (!env) {
    return {
      correlationId: cid,
      error: { code: 'lifecycle_unavailable', message: 'Teardown is not available in this context.', retryable: false },
      ok: false,
    };
  }
  if (input.confirm !== true) {
    return {
      correlationId: cid,
      error: {
        code: 'confirmation_required',
        message: `Deleting this dedicated ${kind.toUpperCase()} resource is PERMANENT and IRREVERSIBLE — all data in it is destroyed and cannot be recovered. Re-run with confirm:true to delete it.`,
        retryable: false,
      },
      ok: false,
    };
  }

  const result = await teardownResource(env, scope.siteId, scope.orgId, scope.environment, kind);
  if (!result.ok) return lifecycleError(cid, result.reason, result.detail);
  return {
    correlationId: cid,
    data: {
      action: 'teardown',
      deletedCfResource: result.deletedCfResource,
      displayName: result.displayName,
      resourceId: result.resourceId,
    },
    ok: true,
  };
}

/** Run the `clone` mutation (honest `not_available` per CAPABILITY-MATRIX; kept so the verb resolves typed). */
export async function runCloneMutation(
  cid: string,
  scope: ResolvedScope,
  kind: ProvisionableKind,
  _input: CloneInput,
): Promise<AdapterResult<CloneMutateResult>> {
  const env = scope.env;
  if (!env) {
    return {
      correlationId: cid,
      error: { code: 'lifecycle_unavailable', message: 'Clone is not available in this context.', retryable: false },
      ok: false,
    };
  }
  const result = await cloneResource(env, scope.siteId, scope.orgId, scope.environment, kind);
  if (!result.ok) return lifecycleError(cid, result.reason, result.detail);
  return {
    correlationId: cid,
    data: {
      action: 'clone',
      copied: result.copied,
      displayName: result.displayName,
      note: result.note,
      registryRowId: result.registryRowId,
      resourceId: result.resourceId,
    },
    ok: true,
  };
}

/**
 * Run the `promote` mutation: ensure a production resource exists (idempotent, billable — confirm-gated) and
 * copy preview data into it where CF supports it (KV values; D1/R2 ensured-only with an honest note).
 */
export async function runPromoteMutation(
  cid: string,
  scope: ResolvedScope,
  kind: ProvisionableKind,
  input: PromoteInput,
): Promise<AdapterResult<PromoteMutateResult>> {
  const env = scope.env;
  if (!env) {
    return {
      correlationId: cid,
      error: { code: 'lifecycle_unavailable', message: 'Promote is not available in this context.', retryable: false },
      ok: false,
    };
  }
  const result = await promoteResource(env, scope.siteId, scope.orgId, kind, input.confirm);
  if (!result.ok) return lifecycleError(cid, result.reason, result.detail);
  return {
    correlationId: cid,
    data: {
      action: 'promote',
      note: result.note,
      registryRowId: result.registryRowId,
      targetResourceId: result.targetResourceId,
    },
    ok: true,
  };
}

/**
 * Run the R2 `preview_url` / `upload_url` mutation: mint a short-lived SCOPED download/upload URL for ONE
 * object and return ONLY the URL (never account credentials — INV-6). Honest `not_available` when scoped-URL
 * minting isn't possible on this deployment. Read-only for a download (no confirm); an upload URL grants
 * write to ONE object under a short TTL, so it is not itself destructive (an overwrite is the client's PUT).
 */
export async function runR2PresignMutation(
  cid: string,
  scope: ResolvedScope,
  input: PresignInput,
): Promise<AdapterResult<PresignMutateResult>> {
  const key = input?.key;
  if (typeof key !== 'string' || key.length === 0) {
    return {
      correlationId: cid,
      error: { code: 'invalid_key', message: 'Object key is missing or empty.', retryable: false },
      ok: false,
    };
  }
  const verb: R2PresignVerb = input.action === 'upload_url' ? 'upload' : 'download';
  const minted = await mintScopedR2Url(scope.auth, scope.accountId, {
    bucket: scope.resourceId,
    contentType: input.contentType,
    key,
    ttlSeconds: input.ttlSeconds,
    verb,
  });

  if (minted.available) {
    return {
      correlationId: cid,
      data: {
        action: input.action,
        available: true,
        expiresInSeconds: minted.expiresInSeconds,
        key,
        url: minted.url,
      },
      ok: true,
    };
  }

  // Honest "not wired" — never a fabricated URL. The surface shows the approach + falls back to a server proxy.
  return {
    correlationId: cid,
    data: { action: input.action, approach: minted.reason, available: false, key },
    ok: true,
  };
}
