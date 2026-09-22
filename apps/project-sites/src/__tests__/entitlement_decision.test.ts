/**
 * Tests for the canonical entitlement decision (BILLING INTEGRITY).
 * Every case pins a revenue-leak/lock-out rule: fail-closed-FIRST on transient, trialing counts,
 * non-entitling statuses deny, unknown status denies by default, plan floor is orthogonal to status.
 */
import {
  decideEntitlement,
  isEntitled,
  ENTITLING_STATUSES,
} from '../services/entitlement_decision.js';

const RANK = { starter: 1, pro: 2, business: 3 };

describe('entitlement_decision: fail-closed on transient error', () => {
  it('DENIES on a store error even when the status would otherwise entitle (checked first)', () => {
    expect(decideEntitlement({ storeError: true, status: 'active', plan: 'business' })).toEqual({
      entitled: false,
      reason: 'transient_error',
    });
  });
});

describe('entitlement_decision: status gate', () => {
  it('entitles active and trialing (trialing counts)', () => {
    expect(decideEntitlement({ status: 'active' })).toEqual({ entitled: true, reason: 'entitled' });
    expect(decideEntitlement({ status: 'trialing' })).toEqual({
      entitled: true,
      reason: 'entitled',
    });
    expect([...ENTITLING_STATUSES]).toEqual(['active', 'trialing']);
  });
  it('denies past_due / canceled / unpaid / paused / null / unknown', () => {
    for (const s of [
      'past_due',
      'canceled',
      'unpaid',
      'paused',
      'incomplete',
      'some_future_status',
    ]) {
      expect(decideEntitlement({ status: s }).entitled).toBe(false);
    }
    expect(decideEntitlement({ status: null }).reason).toBe('not_entitling_status');
    expect(decideEntitlement({}).entitled).toBe(false);
  });
});

describe('entitlement_decision: plan floor (orthogonal to status)', () => {
  it('requires the plan to meet a declared floor even with an entitling status', () => {
    expect(
      decideEntitlement({
        status: 'active',
        plan: 'starter',
        featurePlanFloor: 'pro',
        planRank: RANK,
      }),
    ).toEqual({
      entitled: false,
      reason: 'below_plan_floor',
    });
    expect(
      decideEntitlement({ status: 'active', plan: 'pro', featurePlanFloor: 'pro', planRank: RANK })
        .entitled,
    ).toBe(true);
    expect(
      decideEntitlement({
        status: 'active',
        plan: 'business',
        featurePlanFloor: 'pro',
        planRank: RANK,
      }).entitled,
    ).toBe(true);
  });
  it('ignores the floor for status-only features (no featurePlanFloor)', () => {
    expect(decideEntitlement({ status: 'active', plan: 'starter' }).entitled).toBe(true);
  });
  it('fail-closed when a floor is declared but the plan is unknown / no rank map', () => {
    expect(
      decideEntitlement({
        status: 'active',
        plan: 'mystery',
        featurePlanFloor: 'pro',
        planRank: RANK,
      }).entitled,
    ).toBe(false);
    expect(
      decideEntitlement({ status: 'active', plan: 'pro', featurePlanFloor: 'pro' }).entitled,
    ).toBe(false);
  });
});

describe('entitlement_decision: isEntitled wrapper', () => {
  it('mirrors decideEntitlement.entitled', () => {
    expect(isEntitled({ status: 'active' })).toBe(true);
    expect(isEntitled({ storeError: true })).toBe(false);
    expect(isEntitled({ status: 'canceled' })).toBe(false);
  });
});
