/**
 * entitlement_decision.ts — the PURE, canonical revenue-entitlement decision (BILLING INTEGRITY).
 * The gate that decides "may this org use a paid feature?" is existential correctness, so its rules
 * live here as one tested function the entitlement middleware ADOPTS (replacing inline logic) — no
 * second source of truth. Every rule below is a hardened lesson from a real incident:
 *
 *  - FAIL-CLOSED on a transient store error → DENY, never open on uncertainty
 *    ([[entitlement-check-fail-closed-on-transient-is-false-hard-limit]] +
 *     [[dbqueryone-never-throws-use-dbquery-error-for-failclosed-gates]] — the caller MUST pass
 *     `storeError: true` when the status read errored, using dbQuery+.error, NOT dbQueryOne).
 *  - COUNT trialing, not just active ([[entitlement-gate-active-only-excludes-trialing]]).
 *  - plan ⟂ status ([[billing-plan-and-status-are-orthogonal]]) — a valid STATUS still must meet a
 *    feature's PLAN floor when one is set; neither implies the other.
 *
 * Pure — no DB, no Stripe, no env. The middleware maps its store/error state into {@link EntitlementInput}.
 */

/** Subscription status from the store (Stripe-derived). Open string — new Stripe statuses are DENY by default. */
export type SubStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid'
  | 'paused'
  | (string & {});

/** The ONLY statuses that entitle paid features. Everything else (past_due/canceled/unpaid/paused/…) does not. */
export const ENTITLING_STATUSES = ['active', 'trialing'] as const;

export interface EntitlementInput {
  /** Subscription status from the store; null/absent → treated as unentitled (free). */
  status?: SubStatus | null;
  /** Current plan/tier (orthogonal to status). */
  plan?: string | null;
  /** The plan a specific feature requires, if it is plan-gated; omit for status-only features. */
  featurePlanFloor?: string | null;
  /** plan → numeric rank (higher = higher tier), for floor comparison. */
  planRank?: Record<string, number>;
  /**
   * TRUE when the status/plan read hit a TRANSIENT error (the caller used dbQuery and saw `.error`).
   * Forces a fail-CLOSED deny — an entitlement gate must NEVER open because the store was briefly down.
   */
  storeError?: boolean;
}

/** A denied decision carries a machine reason for observability + a doomed-control message. */
export type EntitlementReason =
  | 'transient_error'
  | 'not_entitling_status'
  | 'below_plan_floor'
  | 'entitled';

/**
 * The canonical entitlement decision. Fail-closed, trialing-aware, plan-floor-aware.
 *
 * @returns `{ entitled, reason }` — `entitled=false` on ANY uncertainty (the hard-limit default).
 * @example decideEntitlement({ storeError: true, status: 'active' }) // { entitled:false, reason:'transient_error' }
 * @example decideEntitlement({ status: 'trialing' }) // { entitled:true, reason:'entitled' }  (trialing counts)
 * @example decideEntitlement({ status: 'past_due' }) // { entitled:false, reason:'not_entitling_status' }
 * @example decideEntitlement({ status:'active', plan:'starter', featurePlanFloor:'pro', planRank:{starter:1,pro:2} }) // below floor → false
 */
export function decideEntitlement(input: EntitlementInput): {
  entitled: boolean;
  reason: EntitlementReason;
} {
  // 1. Transient store error → fail CLOSED (never open on uncertainty). Checked FIRST, before status.
  if (input.storeError) return { entitled: false, reason: 'transient_error' };

  // 2. Status must be entitling (active or trialing). Unknown/absent/any other status → deny.
  const status = String(input.status ?? '');
  if (!(ENTITLING_STATUSES as readonly string[]).includes(status)) {
    return { entitled: false, reason: 'not_entitling_status' };
  }

  // 3. plan ⟂ status: when the feature declares a plan floor, the org's plan must meet it.
  if (input.featurePlanFloor) {
    const ranks = input.planRank ?? {};
    const have = ranks[String(input.plan ?? '')] ?? -1;
    const need = ranks[input.featurePlanFloor] ?? Number.POSITIVE_INFINITY;
    if (have < need) return { entitled: false, reason: 'below_plan_floor' };
  }

  return { entitled: true, reason: 'entitled' };
}

/** Convenience boolean wrapper for call sites that only need yes/no. */
export function isEntitled(input: EntitlementInput): boolean {
  return decideEntitlement(input).entitled;
}
