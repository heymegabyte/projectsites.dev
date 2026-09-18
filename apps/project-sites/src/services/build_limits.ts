/**
 * @module services/build_limits
 *
 * @description
 * Per-org site allowance — free accounts get exactly 1 site AT A TIME; paid
 * plans are billed at $50/month per site (PAID_LIMIT is the runaway-cost sanity
 * ceiling, not an "all you can eat" allotment). Owners of unlimited orgs get
 * `Infinity`. Tracked by counting LIVE (non-deleted) rows in the `sites` table
 * (`deleted_at IS NULL`) — a soft-delete FREES the slot, so a user can delete a
 * site and create another (the legit fix-a-mistake flow). Churn abuse
 * (delete→recreate to trigger repeated expensive builds) is bounded NOT by this
 * site count but by the monthly AI-spend cap in `build_budget` (free tier
 * $5/mo), which gates the create→build path — the two limits compose.
 *
 * @remarks
 * - The `UNLIMITED_ORGS` set is request-cached, populated lazily when the
 *   owner's email matches a known whitelist (e.g. `brian@megabyte.space`).
 *   This keeps the membership query off the hot path for repeat callers in
 *   the same worker isolate.
 * - Callers MUST pass the org's billing plan (`'paid' | 'free' | null`) —
 *   the caller is the source of truth (read from `subscriptions` table or
 *   entitlements) and we don't re-resolve here to keep the function pure.
 */
import { dbQuery, dbQueryOne } from './db.js';

/** Free-tier site quota — free accounts get exactly ONE site. */
const FREE_LIMIT = 1;
/** Paid-tier runaway-cost ceiling. Billing is $50/mo PER site (PRICING.MONTHLY_CENTS). */
const PAID_LIMIT = 50;

/** Per-isolate cache of orgs known to have unlimited builds (populated lazily). */
const UNLIMITED_ORGS = new Set<string>();

/**
 * Whether the org's OWNER is on the unlimited whitelist (platform-operator
 * dogfooding orgs get unlimited builds + AI budget). Currently
 * `brian@megabyte.space` only. Shared by build_limits + build_budget so the
 * whitelist lives in ONE place (was duplicated + hardcoded in both).
 *
 * @remarks Broadening this to the full super-admin set (`SYS_ADMIN_EMAILS`,
 * which adds `hey@megabyte.space`) is a COST/business decision — it grants free
 * unlimited compute — so it stays brian-only until Brian decides. Fail-closed:
 * a DB error denies (returns false).
 */
export async function isUnlimitedOrgOwner(db: D1Database, orgId: string): Promise<boolean> {
  // Unlimited-build owners: the platform operator + the e2e/loop dogfooding org.
  // e2e@megabyte.space added 2026-08-25 (Brian directive) so the self-improving
  // loop can accumulate as MANY sample sites as it likes without the 1-site free
  // limit forcing a delete-before-create (which was 404-ing prior loop builds).
  const UNLIMITED_OWNER_EMAILS = new Set(['brian@megabyte.space', 'e2e@megabyte.space']);
  // A TRANSIENT D1 error on the owner lookup must NOT strand an unlimited org at the
  // free limit — a swallowed throw (the old `.catch(() => null)`) surfaced as a false
  // `BUILD_LIMIT_REACHED` ("68 of 1 site") on a healthy read-replica blip, violating
  // the UNLIMITED contract. Retry once on THROW before failing closed; a genuine
  // "no owner row" still returns null (correctly not-unlimited — never fail OPEN).
  let owner: { email: string } | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      owner = await dbQueryOne<{ email: string }>(
        db,
        `SELECT u.email FROM users u JOIN memberships m ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'owner' AND m.deleted_at IS NULL AND u.deleted_at IS NULL LIMIT 1`,
        [orgId],
      );
      break;
    } catch {
      owner = null; // give up after the retry → fail closed (safe: never grant unlimited on an unconfirmed owner)
    }
  }
  return UNLIMITED_OWNER_EMAILS.has(owner?.email ?? '');
}

/**
 * Resolve an org's ACTIVE billing plan for quota / entitlement decisions.
 *
 * The single source of truth for "what plan is this org entitled to right now".
 * Gates on `status IN ('active', 'trialing')` — a TRIAL grants full paid access,
 * matching `subscriptionEventType` (which emits `subscription.active` for trialing
 * and provisions paid capabilities) and the AI-spend-cap resolver. Four call sites
 * used to hand-roll `SELECT plan … WHERE status = 'active'`, which silently EXCLUDED
 * `trialing` → a trialing subscriber was dropped to the free 1-site quota despite
 * being provisioned paid capabilities everywhere else. Routing them all through here
 * fixes that inconsistency + stops the four copies from drifting again.
 *
 * @param db    - D1Database binding.
 * @param orgId - Organization to resolve.
 * @returns The plan string (e.g. `'paid'`), or `null` when no active/trialing sub exists.
 *
 * @example
 * const plan = await resolveActiveOrgPlan(env.DB, orgId); // 'paid' | 'free' | null
 * const quota = await checkBuildLimit(env.DB, orgId, plan);
 */
export async function resolveActiveOrgPlan(db: D1Database, orgId: string): Promise<string | null> {
  const sub = await dbQueryOne<{ plan: string }>(
    db,
    "SELECT plan FROM subscriptions WHERE org_id = ? AND status IN ('active', 'trialing')",
    [orgId],
  );
  return sub?.plan ?? null;
}

/**
 * Check whether the org can create another site without exceeding its plan.
 *
 * @param db    - D1Database binding.
 * @param orgId - Organization to check.
 * @param plan  - The active billing plan (`'paid'` → 50, anything else → 1).
 *   `null` is the unsigned-in / no-subscription default → free tier (1 site).
 * @returns Quota snapshot — `allowed`, `used`, `limit`, `remaining`.
 *
 * @example
 * ```ts
 * const quota = await checkBuildLimit(env.DB, orgId, subscription?.plan ?? null);
 * if (!quota.allowed) throw new AppError('FORBIDDEN', `Build limit reached (${quota.used}/${quota.limit})`);
 * ```
 */
export async function checkBuildLimit(
  db: D1Database,
  orgId: string,
  plan: string | null,
): Promise<{ allowed: boolean; used: number; limit: number; remaining: number }> {
  // Check if this org has unlimited builds
  if (UNLIMITED_ORGS.has(orgId)) {
    return { allowed: true, used: 0, limit: Infinity, remaining: Infinity };
  }

  // Owner on the unlimited whitelist → unlimited builds (shared with build_budget).
  if (await isUnlimitedOrgOwner(db, orgId)) {
    UNLIMITED_ORGS.add(orgId);
    return { allowed: true, used: 0, limit: Infinity, remaining: Infinity };
  }

  const limit = plan === 'paid' ? PAID_LIMIT : FREE_LIMIT;

  // FAIL-CLOSED on a transient D1 error (mirrors isUnlimitedOrgOwner above). `dbQuery` SWALLOWS a
  // D1 throw → `{ data: [], error }` (see db.ts — its own comment warns callers that ignore `error`
  // see a silent `[]`). Reading `data[0]?.count ?? 0` on that would make `used = 0` → `allowed =
  // true` → the per-org site cap is silently BYPASSED on a read-replica blip — the exact
  // entitlement-fail-closed-on-transient / swallowed-SQL-error class, and a cost-runaway hole
  // (builds are expensive). Retry ONCE (catches the common transient); if the error persists we
  // cannot confirm the count → DENY (deny-on-uncertainty beats a silent bypass; a genuine platform
  // DB outage blocks nothing that could have succeeded anyway).
  const COUNT_SQL = 'SELECT COUNT(*) as count FROM sites WHERE org_id = ? AND deleted_at IS NULL';
  let result = await dbQuery<{ count: number }>(db, COUNT_SQL, [orgId]);
  if (result.error !== null) {
    result = await dbQuery<{ count: number }>(db, COUNT_SQL, [orgId]);
  }
  if (result.error !== null) {
    return { allowed: false, used: limit, limit, remaining: 0 };
  }

  const used = result.data[0]?.count ?? 0;
  const remaining = Math.max(0, limit - used);

  return {
    allowed: used < limit,
    used,
    limit,
    remaining,
  };
}
