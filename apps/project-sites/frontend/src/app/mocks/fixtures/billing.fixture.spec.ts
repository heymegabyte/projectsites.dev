import {
  subscriptionFixture,
  entitlementsFixture,
  walletFixture,
  type SubscriptionResponse,
  type EntitlementsResponse,
  type WalletResponse,
} from './billing.fixture';
import { toRegistryKey } from './index';

/**
 * billing.fixture — mock bodies for the three money-path reads the Billing surface
 * funnels through ApiService:
 *   GET /billing/subscription  → { data: <sub row> | null }   (worker getOrgSubscription)
 *   GET /billing/entitlements  → { data: <entitlements> }      (worker getOrgEntitlements)
 *   GET /wallet                → <WalletState> (BARE, no { data } wrapper)
 * Each matches the worker wire contract EXACTLY so the real endpoint is a drop-in swap.
 * State variants: populated (a realistic paid org) · empty (free / fresh wallet). The
 * interceptor owns loading + the error short-circuit.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('subscriptionFixture (GET /billing/subscription → { data: sub | null })', () => {
  it('populated → a paid, active subscription under { data } with every worker field', () => {
    const res: SubscriptionResponse = subscriptionFixture('populated', q());
    expect(res.data).not.toBeNull();
    const d = res.data!;
    expect(d.plan).toBe('paid');
    // status drives the paid-eligible gate (active|trialing). Must be one of those.
    expect(['active', 'trialing']).toContain(d.status);
    expect(typeof d.stripe_customer_id).toBe('string');
    expect(typeof d.stripe_subscription_id).toBe('string');
    expect(typeof d.cancel_at_period_end).toBe('boolean');
    expect(typeof d.current_period_end).toBe('string');
    expect(Number.isNaN(Date.parse(d.current_period_end!))).toBe(false);
  });

  it('empty → data is null (free org, never upgraded — the worker returns null)', () => {
    const res = subscriptionFixture('empty', q());
    expect(res.data).toBeNull();
  });

  it('normalizes to the registry key GET /billing/subscription', () => {
    expect(toRegistryKey('GET', '/api/billing/subscription').key).toBe('GET /billing/subscription');
  });
});

describe('entitlementsFixture (GET /billing/entitlements → { data: entitlements })', () => {
  it('populated → the full PAID entitlement set (all 8 worker keys)', () => {
    const res: EntitlementsResponse = entitlementsFixture('populated', q());
    const d = res.data;
    expect(typeof d.org_id).toBe('string');
    expect(d.plan).toBe('paid');
    expect(d.topBarHidden).toBe(true);
    expect(d.maxCustomDomains).toBe(10);
    expect(d.chatEnabled).toBe(true);
    expect(d.analyticsEnabled).toBe(true);
    expect(d.customEndpoints).toBe(true);
    expect(d.maxTeamSeats).toBe(10);
  });

  it('empty → the FREE baseline (paid features off, solo seat) — matches shared ENTITLEMENTS.free', () => {
    const d = entitlementsFixture('empty', q()).data;
    expect(d.plan).toBe('free');
    expect(d.topBarHidden).toBe(false);
    expect(d.maxCustomDomains).toBe(0);
    expect(d.analyticsEnabled).toBe(false);
    expect(d.customEndpoints).toBe(false);
    expect(d.maxTeamSeats).toBe(1);
    // chatEnabled is true on BOTH tiers per the shared constant.
    expect(d.chatEnabled).toBe(true);
  });

  it('always carries all 8 keys regardless of state (no optional entitlement)', () => {
    for (const state of ['populated', 'empty'] as const) {
      const d = entitlementsFixture(state, q()).data;
      expect(Object.keys(d).sort()).toEqual(
        [
          'analyticsEnabled',
          'chatEnabled',
          'customEndpoints',
          'maxCustomDomains',
          'maxTeamSeats',
          'org_id',
          'plan',
          'topBarHidden',
        ].sort(),
      );
    }
  });

  it('normalizes to the registry key GET /billing/entitlements', () => {
    expect(toRegistryKey('GET', '/api/billing/entitlements').key).toBe('GET /billing/entitlements');
  });
});

describe('walletFixture (GET /wallet → BARE WalletState, no { data } wrapper)', () => {
  it('populated → a funded wallet with every WalletState field (balance in CENTS)', () => {
    const res: WalletResponse = walletFixture('populated', q());
    expect(typeof res.balance_cents).toBe('number');
    expect(res.balance_cents).toBeGreaterThan(0);
    // bare envelope: there is NO `data` wrapper (the component reads r.data ?? r).
    expect((res as unknown as { data?: unknown }).data).toBeUndefined();
    expect(['none', 'active', 'past_due', 'canceled', 'trialing']).toContain(
      res.subscription_status,
    );
    expect(Array.isArray(res.recent_transactions)).toBe(true);
    expect(res.recent_transactions.length).toBeGreaterThan(0);
  });

  it('populated → a realistic PM + a credit/debit ledger spread (each row typed)', () => {
    const res = walletFixture('populated', q());
    expect(typeof res.default_payment_method_brand).toBe('string');
    expect(typeof res.default_payment_method_last4).toBe('string');
    for (const t of res.recent_transactions) {
      expect(typeof t.id).toBe('string');
      expect(typeof t.amount_cents).toBe('number');
      expect(['debit', 'credit']).toContain(t.direction);
      expect(Number.isNaN(Date.parse(t.created_at))).toBe(false);
    }
    expect(res.recent_transactions.some((t) => t.direction === 'credit')).toBe(true);
    expect(res.recent_transactions.some((t) => t.direction === 'debit')).toBe(true);
  });

  it('empty → a fresh wallet: zero balance (never null), inactive, no PM, no ledger', () => {
    const res = walletFixture('empty', q());
    // A fresh wallet is a HONEST 0 (the worker get-or-create starts at 0) — not null.
    expect(res.balance_cents).toBe(0);
    expect(res.subscription_status).toBe('none');
    expect(res.default_payment_method_brand).toBeNull();
    expect(res.default_payment_method_last4).toBeNull();
    expect(res.recent_transactions).toEqual([]);
  });

  it('normalizes to the registry key GET /wallet', () => {
    expect(toRegistryKey('GET', '/api/wallet').key).toBe('GET /wallet');
  });
});
