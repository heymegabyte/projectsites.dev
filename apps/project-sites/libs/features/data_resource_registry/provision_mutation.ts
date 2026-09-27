/**
 * @module libs/features/data_resource_registry/provision_mutation
 * @description Shared `mutate({action:'provision'})` bridge for the d1/kv/r2 adapters (the
 * PROVISIONING wire-up). Turns `service.provisionResource` (idempotency → quota → provisioner →
 * registry record → partial-recovery) into the uniform {@link AdapterResult} envelope every adapter
 * verb returns, so the three adapters share ONE provision implementation (tool-design-as-api — no
 * per-adapter copy of the confirm/quota/record logic).
 *
 * Unlike every read/write verb (which operates on an ALREADY-resolved `scope.resourceId`), provision
 * CREATES the resource, so it reads `scope.env` (server-attached) for the DB + creds the provisioner
 * needs. The ownership gate already ran upstream (the route/dispatcher's `WHERE id=? AND org_id=?`), so
 * this passes an always-true `ownsSite` — `provisionResource` still re-scopes every DB read on
 * `siteId` + `orgId`. `confirm:true` is REQUIRED (provisioning creates REAL billable infra); the
 * quota check refuses at cap (NEVER a silent shared substitution); a `record_failed` partial is
 * surfaced verbatim so it is RECOVERABLE.
 *
 * @packageDocumentation
 */
import type { AdapterResult, ResolvedScope } from './adapter.js';
import { provisionResource } from './service.js';
import type { ProvisionableKind } from './quota.js';

/** The `provision` mutation input shared by the d1/kv/r2 adapters — a NAMED variant, never a bare field. */
export interface ProvisionInput {
  readonly action: 'provision';
  /** Must be `true` — provisioning creates REAL billable CF infrastructure (approval-required). */
  readonly confirm?: boolean;
}

/** What a successful `provision` returns: the created (or reused) CF id + registry row + whether it was fresh. */
export interface ProvisionMutateResult {
  readonly action: 'provision';
  /** The site's dedicated CF id (D1 uuid / KV namespace id) or name (R2 bucket). */
  readonly resourceId: string;
  /** The `site_resource_registry.id` recorded for it. */
  readonly registryRowId: string;
  /** true when THIS call freshly created the resource; false when an existing allocation was reused (idempotent). */
  readonly created: boolean;
  /** Human display name of the provisioned resource. */
  readonly displayName: string;
}

/**
 * Run the `provision` mutation for one kind through {@link provisionResource}, mapping the typed result
 * into an {@link AdapterResult}. The correlation id is minted by the caller (so the whole adapter call
 * shares one id). A `record_failed` PARTIAL (the CF resource exists but the registry row didn't record)
 * is surfaced as a NON-retryable error whose message NAMES the created id — the partial state is
 * recoverable (re-running provision is idempotent + retries the record), never a silent half-provision.
 *
 * @param cid - the correlation id for this adapter call
 * @param scope - the resolved scope; provision reads `scope.env`/`scope.siteId`/`scope.orgId`/`scope.environment`
 * @param kind - the provisionable account_resource kind (`d1` | `kv` | `r2`)
 * @param input - the discriminated `{ action:'provision', confirm? }` mutation
 */
export async function runProvisionMutation(
  cid: string,
  scope: ResolvedScope,
  kind: ProvisionableKind,
  input: ProvisionInput,
): Promise<AdapterResult<ProvisionMutateResult>> {
  const env = scope.env;
  if (!env) {
    // A provision scope MUST carry the worker env (server-attached). Its absence is a programming
    // error in the caller, not a user error — fail closed, never attempt a create without the DB/creds.
    return {
      correlationId: cid,
      error: {
        code: 'provision_unavailable',
        message: 'Provisioning is not available in this context.',
        retryable: false,
      },
      ok: false,
    };
  }

  const result = await provisionResource(env, scope.siteId, kind, {
    confirm: input.confirm,
    environment: scope.environment,
    orgId: scope.orgId,
    ownsSite: async () => true, // ownership already proven upstream; provisionResource re-scopes by site+org
    tenantId: scope.tenantId,
  });

  if (result.ok) {
    return {
      correlationId: cid,
      data: {
        action: 'provision',
        created: result.created,
        displayName: result.displayName,
        registryRowId: result.registryRowId,
        resourceId: result.resourceId,
      },
      ok: true,
    };
  }

  // Map the typed provision failure to an adapter error envelope. quota_check_failed is transient
  // (retryable); everything else is a hard, user-safe refusal. record_failed NAMES the created id so
  // the caller can report the recoverable partial state.
  switch (result.reason) {
    case 'confirmation_required':
      return {
        correlationId: cid,
        error: {
          code: 'confirmation_required',
          message: `Provisioning a dedicated ${kind.toUpperCase()} resource creates real, billable Cloudflare infrastructure. Re-run with confirm:true to create it.`,
          retryable: false,
        },
        ok: false,
      };
    case 'quota_at_cap':
      return {
        correlationId: cid,
        error: {
          code: 'quota_at_cap',
          message: `The Cloudflare account ${kind.toUpperCase()} quota has been reached — cannot provision a new dedicated ${kind.toUpperCase()} resource. (A shared resource is never substituted silently.)`,
          retryable: false,
        },
        ok: false,
      };
    case 'quota_check_failed':
      return {
        correlationId: cid,
        error: {
          code: 'quota_check_failed',
          message: 'Could not verify Cloudflare account capacity; provisioning was not attempted. Try again shortly.',
          retryable: true,
        },
        ok: false,
      };
    case 'record_failed':
      return {
        correlationId: cid,
        error: {
          code: 'record_failed',
          message: `The ${kind.toUpperCase()} resource was CREATED (id/name: ${result.resourceId}) but recording it in the registry failed — this is a recoverable partial state; re-run provision to finish (it will reuse the existing resource). Detail: ${result.detail}`,
          retryable: true,
        },
        ok: false,
      };
    case 'not_owned':
      return {
        correlationId: cid,
        error: { code: 'not_found', message: 'Resource not found.', retryable: false },
        ok: false,
      };
    case 'no_cf_credentials':
    case 'no_account_id':
    case 'provision_failed':
      return {
        correlationId: cid,
        error: {
          code: result.reason,
          message: `Could not provision the dedicated ${kind.toUpperCase()} resource.`,
          retryable: result.reason === 'provision_failed',
        },
        ok: false,
      };
    default:
      return {
        correlationId: cid,
        error: { code: 'provision_failed', message: `Could not provision the ${kind.toUpperCase()} resource.`, retryable: false },
        ok: false,
      };
  }
}
