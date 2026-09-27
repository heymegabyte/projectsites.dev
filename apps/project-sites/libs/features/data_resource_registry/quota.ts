/**
 * @module libs/features/data_resource_registry/quota
 * @description Real Cloudflare account-quota / capacity checks for per-site resource PROVISIONING
 * (Data & Resource Platform — the provisioning wire-up).
 *
 * Provisioning a per-site D1 / KV / R2 creates REAL, BILLABLE Cloudflare infrastructure that counts
 * against ACCOUNT-WIDE limits. A per-site WfP dispatch namespace is a CONTAINER/partition — it does
 * **NOT** raise the account's D1/KV/R2 quotas (CAPABILITY-MATRIX.md HARD FACT #4). Therefore, BEFORE
 * creating a new account_resource, we MUST count what already exists on the account and refuse an
 * honest error when it is at cap — NEVER silently substitute a shared binding for a dedicated resource
 * (SECURITY-INVARIANTS — "never silently substitute a shared binding for a dedicated resource").
 *
 * Isolation + credential discipline (INV-1 / INV-6): the account is `env.CF_ACCOUNT_ID`, auth comes
 * from `resolveCfCredentials` — NEVER client-supplied and NEVER returned to the caller. This module
 * reads counts from the CF list APIs (`result_info.total_count` for D1 + KV; the buckets array length
 * for R2) and compares against a per-kind account cap.
 *
 * Fail-closed on an INDETERMINATE probe: if we can't read the count (auth/5xx/network), we return a
 * typed `quota_check_failed` (retryable) and the caller MUST NOT provision — an unknown count can
 * never be assumed "under cap", exactly as `entitlement-check-fail-closed-on-transient` mandates.
 *
 * @packageDocumentation
 */
import type { CfAuth } from '../../../src/services/cf_credentials.js';
import { cfAuthHeaders } from '../../../src/services/cf_credentials.js';

import type { ResourceKind } from './schemas.js';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Per-kind ACCOUNT resource caps used as the provisioning ceiling. These are conservative,
 * plan-agnostic ceilings for the number of per-site DEDICATED objects the platform will create on one
 * account before it must open another account (mirrors the neon-database-conservation "the scarce
 * unit is the account/project" doctrine for CF). They are intentionally LOWER than any hard CF plan
 * limit so the platform refuses honestly with headroom, rather than letting a CF `POST` fail opaquely.
 * Only the three kinds with a live provisioner have a cap; other kinds are not provisionable here.
 */
const ACCOUNT_RESOURCE_CAPS: Partial<Record<ResourceKind, number>> = {
  d1: 45_000, // CF Workers Paid allows up to 50k D1 databases/account; refuse with headroom.
  kv: 900, // CF allows ~1000 KV namespaces/account; refuse with headroom.
  r2: 900, // CF allows ~1000 R2 buckets/account; refuse with headroom.
};

/** The kinds this module can quota-check + (via the provisioners) provision. */
export type ProvisionableKind = 'd1' | 'kv' | 'r2';

/** True when `kind` is one of the three provisionable account_resource kinds. */
export function isProvisionableKind(kind: ResourceKind): kind is ProvisionableKind {
  return kind === 'd1' || kind === 'kv' || kind === 'r2';
}

/**
 * The result of an account-quota check. `ok:true` carries the current count + cap + whether the
 * account is AT cap (the caller refuses provisioning when `atCap` is true). `ok:false` is an
 * INDETERMINATE probe (auth/5xx/network) — retryable; the caller MUST fail closed (do not provision).
 */
export type QuotaCheckResult =
  | {
      readonly ok: true;
      /** How many of this kind currently exist on the account. */
      readonly count: number;
      /** The account cap the platform enforces for this kind. */
      readonly cap: number;
      /** True when `count >= cap` — provisioning must be refused with an honest error. */
      readonly atCap: boolean;
    }
  | {
      readonly ok: false;
      /** Typed reason the count could not be read — always transient/indeterminate. */
      readonly reason: 'quota_check_failed';
      readonly status?: number;
    };

/**
 * The CF list endpoint (path + how to read the count) for each provisionable kind. D1 + KV report a
 * `result_info.total_count`; R2 returns a `result.buckets[]` array whose length is the count.
 */
interface KindListSpec {
  readonly path: (account: string) => string;
  readonly readCount: (json: CfListJson) => number | undefined;
}

/** The shape the three CF list endpoints return (only the fields this module reads). */
interface CfListJson {
  readonly success?: boolean;
  readonly result?: unknown;
  readonly result_info?: { readonly total_count?: number; readonly count?: number };
}

const KIND_LIST_SPEC: Record<ProvisionableKind, KindListSpec> = {
  d1: {
    // A single-page list is enough — we only need result_info.total_count, not the rows.
    path: (a) => `${CF_API_BASE}/accounts/${a}/d1/database?per_page=1`,
    readCount: (j) => j.result_info?.total_count,
  },
  kv: {
    path: (a) => `${CF_API_BASE}/accounts/${a}/storage/kv/namespaces?per_page=1`,
    readCount: (j) => j.result_info?.total_count,
  },
  r2: {
    // R2 bucket list has no total_count; count the returned buckets array. R2 bucket counts are
    // small (per-site buckets), so a single list page is a faithful count on this account.
    path: (a) => `${CF_API_BASE}/accounts/${a}/r2/buckets`,
    readCount: (j) => {
      const result = j.result as { buckets?: unknown[] } | unknown[] | undefined;
      if (Array.isArray(result)) return result.length;
      if (result && Array.isArray((result as { buckets?: unknown[] }).buckets)) {
        return (result as { buckets: unknown[] }).buckets.length;
      }
      return undefined;
    },
  },
};

/**
 * Check whether the account has capacity to provision one more resource of `kind`.
 *
 * Counts what already exists on the account via the CF list API and compares against the per-kind
 * {@link ACCOUNT_RESOURCE_CAPS} ceiling. Returns `atCap:true` when the account is full (the caller
 * refuses with an honest error — NEVER a silent shared substitution). An indeterminate probe
 * (auth/5xx/network, or a count we cannot read) returns `ok:false` so the caller FAILS CLOSED.
 *
 * @param auth - server-side CF auth (from `resolveCfCredentials`; never client-supplied)
 * @param accountId - `env.CF_ACCOUNT_ID` (never client-supplied)
 * @param kind - the provisionable account_resource kind (`d1` | `kv` | `r2`)
 */
export async function checkAccountResourceQuota(
  auth: CfAuth,
  accountId: string,
  kind: ProvisionableKind,
): Promise<QuotaCheckResult> {
  const spec = KIND_LIST_SPEC[kind];
  const cap = ACCOUNT_RESOURCE_CAPS[kind] ?? 0;

  let res: Response;
  try {
    res = await fetch(spec.path(accountId), {
      headers: { ...cfAuthHeaders(auth), 'content-type': 'application/json' },
      method: 'GET',
    });
  } catch {
    // Network failure — indeterminate. Fail closed (retryable).
    return { ok: false, reason: 'quota_check_failed' };
  }

  const json = (await res.json().catch(() => null)) as CfListJson | null;
  if (!res.ok || !json?.success) {
    return { ok: false, reason: 'quota_check_failed', status: res.status };
  }

  const count = spec.readCount(json);
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    // The list succeeded but we couldn't read a count — indeterminate, fail closed. Never assume 0.
    return { ok: false, reason: 'quota_check_failed', status: res.status };
  }

  return { atCap: count >= cap, cap, count, ok: true };
}
