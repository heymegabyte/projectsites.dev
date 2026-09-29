/**
 * @file R2 Bucket **Manager** — the authoritative, site-scoped catalog + view over ALL of a site's
 * R2 surfaces. The layer ON TOP of the per-site custom-bucket plane (`site_r2.ts` +
 * `site_r2_allocations`); it does NOT replace it — it UNIONS the site's own custom buckets with the
 * one **PROTECTED system bucket** (the isogit "Project code · Preview" surface) into a single
 * authoritative list the editor Resources → Buckets tab renders.
 *
 * Slice 1 (foundation) provides:
 * - {@link resolveSiteBuckets} — authoritative, site-scoped, `assertSiteOwned`-gated, cursor-paginated
 *   list that ALWAYS includes the protected system bucket as a distinct entry and NEVER another site's
 *   buckets (structural `WHERE site_id = ?`).
 * - {@link assertBucketMutable} — HARD-THROWS ({@link SystemBucketProtectedError}) on any
 *   config/reset/empty/delete targeting the system bucket. **SERVICE layer, not UI.**
 * - {@link assertBucketOwnedBySite} — HARD-THROWS ({@link BucketOwnershipError}) on a cross-site bucket
 *   (defense-in-depth beyond the SQL scoping).
 * - {@link isValidNewBucketName} — create-name validation (mirrors `site_r2.isValidBucketDisplayName`).
 *
 * ### The system bucket (isogit project code · preview)
 * The isogit adapter writes a site's project code + preview `dist/` under the SHARED `SITES_BUCKET`
 * binding at `sites/{slug}/…` (`git.ts` `gitPrefix`, `site_branches.ts`) — there is NO dedicated
 * per-site R2 bucket for it. So the "Project code · Preview" entry is a **synthesized** catalog row
 * (`is_system: true`) referencing the shared platform bucket. Mutating it is a hard, server-side
 * failure — the shared platform bucket names are already on {@link FORBIDDEN_BUCKET_NAMES}.
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';

import { assertSiteOwned } from './site_ownership.js';
import { dbQuery } from './db.js';
import { FORBIDDEN_BUCKET_NAMES } from './site_r2.js';

/** The stable id of the synthesized, protected isogit "Project code · Preview" system bucket. */
export const SYSTEM_BUCKET_ID = 'system:project-code-preview' as const;

/** Display label for the protected system bucket. */
export const SYSTEM_BUCKET_DISPLAY_NAME = 'Project code · Preview' as const;

/**
 * The real (shared) R2 bucket the system entry references. The isogit project code + preview live
 * under the platform `SITES_BUCKET` (per-site key prefix `sites/{slug}/`); this is the prod bucket
 * name and is on {@link FORBIDDEN_BUCKET_NAMES} so it can never be mutated from the per-site plane.
 */
const SYSTEM_BUCKET_REAL_NAME = 'project-sites-assets';

/** What kind of R2 surface a catalog entry represents. */
export type BucketKind = 'system' | 'custom';

/** Provisioning state of a Manager-catalog bucket (mirrors the `site_r2_buckets.provision_state`). */
export type BucketProvisionState = 'provisioning' | 'active' | 'deleting' | 'retired';

/** A single bucket the Manager surfaces (the system entry OR one of the site's own custom buckets). */
export interface SiteR2ManagerBucket {
  /** Stable id — {@link SYSTEM_BUCKET_ID} for the system entry, else the catalog row id. */
  readonly id: string;
  /** The owning site (every custom row is scoped to it; the system entry carries the requesting site). */
  readonly siteId: string;
  /** The REAL Cloudflare R2 bucket name (site-prefixed for custom; the shared bucket for the system entry). */
  readonly bucketName: string;
  /** The tenant-facing display name. */
  readonly displayName: string;
  /** True ONLY for the protected isogit "Project code · Preview" entry. */
  readonly isSystem: boolean;
  /** False for the system bucket; true for a custom bucket that may be configured/reset/deleted. */
  readonly mutable: boolean;
  /** `system` | `custom`. */
  readonly kind: BucketKind;
  /** Optional data-residency hint (eu | fedramp); null = default. */
  readonly jurisdiction: string | null;
  /** Provisioning state. */
  readonly provisionState: BucketProvisionState;
  /** The CF account id the bucket lives in (for the copyable S3 address); null when unknown. */
  readonly accountId: string | null;
}

/** Why {@link resolveSiteBuckets} could not resolve — honest, typed, never fabricated. */
export type ResolveSiteBucketsFailure = 'not_owned';

/** Result of {@link resolveSiteBuckets}: an authoritative page on success, a typed reason on failure. */
export type ResolveSiteBucketsResult =
  | {
      readonly ok: true;
      /** System bucket first, then the site's own custom buckets (oldest→newest). */
      readonly buckets: SiteR2ManagerBucket[];
      /** Opaque continuation cursor for the next page, or null when this is the last page. */
      readonly cursor: string | null;
    }
  | { readonly ok: false; readonly reason: ResolveSiteBucketsFailure };

/** Default + max page size for the authoritative list. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** A raw `site_r2_buckets` row (custom buckets only — the system entry is synthesized, never stored). */
interface CatalogRow {
  readonly id: string;
  readonly site_id: string;
  readonly bucket_name: string;
  readonly display_name: string;
  readonly kind: string;
  readonly is_system: number;
  readonly jurisdiction: string | null;
  readonly provision_state: string;
  readonly account_id: string | null;
}

/** Coerce a stored `provision_state` string to the typed union (defensive; defaults to `active`). */
function toProvisionState(raw: string): BucketProvisionState {
  return raw === 'provisioning' || raw === 'deleting' || raw === 'retired' ? raw : 'active';
}

/** Build the synthesized, protected system-bucket entry for a site (never read from the catalog). */
function systemBucketFor(siteId: string, accountId: string | null): SiteR2ManagerBucket {
  return {
    accountId,
    bucketName: SYSTEM_BUCKET_REAL_NAME,
    displayName: SYSTEM_BUCKET_DISPLAY_NAME,
    id: SYSTEM_BUCKET_ID,
    isSystem: true,
    jurisdiction: null,
    kind: 'system',
    // The system bucket is NEVER mutable from the per-site plane (defense-in-depth: its real name is
    // also on FORBIDDEN_BUCKET_NAMES).
    mutable: false,
    provisionState: 'active',
    siteId,
  };
}

/**
 * Resolve the authoritative, site-scoped list of R2 buckets for a site: the protected isogit system
 * bucket FIRST, then the site's OWN custom buckets from the `site_r2_buckets` catalog.
 *
 * The caller passes the requester's `orgId`; this function calls {@link assertSiteOwned} itself — a
 * foreign or missing site resolves to `{ ok: false, reason: 'not_owned' }` and NO buckets leak. The
 * custom-bucket query is structurally scoped (`WHERE site_id = ?`) so another site's rows can never
 * appear; the system entry is synthesized (not read from the catalog) so it is ALWAYS present.
 *
 * @param env - worker env (`DB` + `CF_ACCOUNT_ID`).
 * @param siteId - the site whose buckets to list (server-side; the ownership check binds it to `orgId`).
 * @param orgId - the requester's org id (from the auth context); undefined/foreign → `not_owned`.
 * @param opts.limit - page size for custom buckets (1..{@link MAX_LIMIT}, default {@link DEFAULT_LIMIT}).
 * @param opts.cursor - opaque continuation cursor from a prior page (the last row id seen).
 */
export async function resolveSiteBuckets(
  env: Env,
  siteId: string,
  orgId: string | undefined,
  opts: { limit?: number; cursor?: string } = {},
): Promise<ResolveSiteBucketsResult> {
  // 1. Ownership — never leak another org's buckets. 404-class failure at the route.
  if (!(await assertSiteOwned(env, orgId, siteId))) {
    return { ok: false, reason: 'not_owned' };
  }

  const accountId = env.CF_ACCOUNT_ID ?? null;
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const cursor = opts.cursor;

  // 2. The site's OWN custom buckets — structurally scoped + keyset-paginated by row id. Fetch one
  //    extra to know whether another page exists.
  const params: unknown[] = [siteId];
  let cursorClause = '';
  if (cursor) {
    cursorClause = ' AND id > ?';
    params.push(cursor);
  }
  params.push(limit + 1);
  const { data } = await dbQuery<CatalogRow>(
    env.DB,
    `SELECT id, site_id, bucket_name, display_name, kind, is_system, jurisdiction, provision_state, account_id
       FROM site_r2_buckets
      WHERE site_id = ? AND is_system = 0 AND provision_state != 'retired' AND deleted_at IS NULL${cursorClause}
      ORDER BY id ASC
      LIMIT ?`,
    params,
  );

  const hasMore = data.length > limit;
  const pageRows = hasMore ? data.slice(0, limit) : data;
  const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null;

  const custom: SiteR2ManagerBucket[] = pageRows
    // Defense-in-depth: never surface a shared platform bucket even if a row somehow named one.
    .filter((r) => !FORBIDDEN_BUCKET_NAMES.has(r.bucket_name))
    .map((r) => ({
      accountId: r.account_id ?? accountId,
      bucketName: r.bucket_name,
      displayName: r.display_name,
      id: r.id,
      isSystem: false,
      jurisdiction: r.jurisdiction,
      kind: 'custom',
      mutable: true,
      provisionState: toProvisionState(r.provision_state),
      siteId: r.site_id,
    }));

  // 3. System bucket ALWAYS first (only on the first page — it is not part of the cursor set).
  const buckets = cursor ? custom : [systemBucketFor(siteId, accountId), ...custom];

  return { buckets, cursor: nextCursor, ok: true };
}

/** Thrown when a mutating op targets the protected system bucket. Route maps it to a hard failure. */
export class SystemBucketProtectedError extends Error {
  constructor(readonly operation: string) {
    super(
      `The "${SYSTEM_BUCKET_DISPLAY_NAME}" bucket is managed by the platform and cannot be ${operation}d.`,
    );
    this.name = 'SystemBucketProtectedError';
  }
}

/** Thrown when a bucket does not belong to the site acting on it (cross-site guard). */
export class BucketOwnershipError extends Error {
  constructor(
    readonly bucketId: string,
    readonly siteId: string,
  ) {
    super('Bucket not found for this site');
    this.name = 'BucketOwnershipError';
  }
}

/** A mutating operation the system bucket must refuse. */
export type BucketMutation = 'config' | 'reset' | 'empty' | 'delete';

/**
 * SERVICE-LAYER guard: HARD-THROW {@link SystemBucketProtectedError} when a config/reset/empty/delete
 * targets the protected system bucket. This is the authoritative protection — it lives in the service
 * so EVERY caller (route, workflow, cron, script) is guarded, never only the UI. Non-system buckets
 * pass through untouched.
 *
 * @param bucket - the resolved bucket the mutation targets.
 * @param operation - the mutation being attempted.
 * @throws {SystemBucketProtectedError} when `bucket.isSystem` (or `bucket.mutable === false`).
 */
export function assertBucketMutable(bucket: SiteR2ManagerBucket, operation: BucketMutation): void {
  if (bucket.isSystem || bucket.mutable === false) {
    throw new SystemBucketProtectedError(operation);
  }
}

/**
 * SERVICE-LAYER cross-site guard: HARD-THROW {@link BucketOwnershipError} when a resolved bucket does
 * not belong to `siteId`. Defense-in-depth beyond the `WHERE site_id = ?` scoping in
 * {@link resolveSiteBuckets} — any path that resolves a bucket by id then acts on it re-asserts here.
 *
 * @param bucket - the resolved bucket.
 * @param siteId - the site the caller proved they own.
 * @throws {BucketOwnershipError} when `bucket.siteId !== siteId`.
 */
export function assertBucketOwnedBySite(bucket: SiteR2ManagerBucket, siteId: string): void {
  if (bucket.siteId !== siteId) {
    throw new BucketOwnershipError(bucket.id, siteId);
  }
}

/**
 * True when a client-supplied NEW bucket display name is a legal short name (validated at the
 * boundary before it reaches provisioning). Mirrors `site_r2.isValidBucketDisplayName`: must start
 * with an alphanumeric, then letters/numbers/spaces/dashes/underscores, ≤30 chars total.
 *
 * @example isValidNewBucketName('uploads')       // true
 * @example isValidNewBucketName(' leadingspace')  // false
 */
export function isValidNewBucketName(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,29}$/.test(name.trim());
}
