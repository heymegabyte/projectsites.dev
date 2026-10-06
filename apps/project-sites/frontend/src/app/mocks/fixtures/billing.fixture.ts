/**
 * @module mocks/fixtures/billing
 *
 * @description
 * Mock fixtures for the three money-path reads that light up the Billing surface (and
 * the shell's plan badge, which reads the subscription via {@link
 * import('../../pages/admin/admin-state.service').AdminStateService}):
 *
 * | Route                         | Factory                | Worker contract                                   |
 * | ----------------------------- | ---------------------- | ------------------------------------------------- |
 * | `GET /api/billing/subscription` | {@link subscriptionFixture} | `{ data: <sub row> \| null }` (getOrgSubscription) |
 * | `GET /api/billing/entitlements` | {@link entitlementsFixture} | `{ data: <entitlements> }` (getOrgEntitlements)    |
 * | `GET /api/wallet`               | {@link walletFixture}       | BARE `WalletState` — **no `{ data }` wrapper**    |
 *
 * Each returns the EXACT worker wire shape so the real endpoint is a provider SWAP.
 * `empty` demos a brand-new free org (null subscription · free entitlements · fresh $0
 * wallet); `populated` demos a funded paid org. The interceptor owns loading + the
 * `error` short-circuit.
 */
import type { FixtureFactory, MockState } from './index';

// ─────────────────────────── GET /billing/subscription ───────────────────────────

/**
 * The subscription row the worker's `getOrgSubscription` returns (D1 `subscriptions`),
 * or `null` for a free org that never upgraded. `cancel_at_period_end` is already a JS
 * boolean (the worker converts the D1 0/1), `current_period_end` an ISO timestamp.
 */
export interface SubscriptionRow {
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
}

/** `GET /api/billing/subscription` envelope — `data` is `null` for a free org. */
export interface SubscriptionResponse {
  data: SubscriptionRow | null;
}

/**
 * Subscription factory. `empty` → `{ data: null }` (free org — the worker returns null);
 * `populated`/`loading`/default → a paid, active subscription with a full billing period.
 */
export const subscriptionFixture: FixtureFactory<SubscriptionResponse> = (
  state: MockState,
): SubscriptionResponse => {
  if (state === 'empty') return { data: null };
  return {
    data: {
      plan: 'paid',
      status: 'active',
      stripe_customer_id: 'cus_PsMock0001Demo',
      stripe_subscription_id: 'sub_1PsMock0001Demo',
      cancel_at_period_end: false,
      // ~3 weeks into the future so the "renews on" copy reads naturally.
      current_period_end: new Date(Date.parse('2026-10-28T00:00:00Z')).toISOString(),
    },
  };
};

// ─────────────────────────── GET /billing/entitlements ───────────────────────────

/**
 * The entitlements object the worker's `getOrgEntitlements` returns — the shared
 * `getEntitlements(orgId, plan)` shape (8 keys, ALWAYS all present). Mirrors
 * `@project-sites/shared` ENTITLEMENTS so the fixture and the real resolver agree.
 */
export interface EntitlementsRow {
  org_id: string;
  plan: 'free' | 'paid';
  topBarHidden: boolean;
  maxCustomDomains: number;
  chatEnabled: boolean;
  analyticsEnabled: boolean;
  customEndpoints: boolean;
  maxTeamSeats: number;
}

/** `GET /api/billing/entitlements` envelope. */
export interface EntitlementsResponse {
  data: EntitlementsRow;
}

/** The demo org id both the entitlements + `/auth/me` fixtures share (one identity). */
const DEMO_ORG_ID = 'org-mock-0001';

/**
 * Entitlements factory. `empty` → the FREE baseline (paid features off, solo seat);
 * `populated`/`loading`/default → the full PAID set (10 domains, analytics, 10 seats).
 * Values mirror the shared `ENTITLEMENTS` constant exactly.
 */
export const entitlementsFixture: FixtureFactory<EntitlementsResponse> = (
  state: MockState,
): EntitlementsResponse => {
  const paid = state !== 'empty';
  return {
    data: {
      org_id: DEMO_ORG_ID,
      plan: paid ? 'paid' : 'free',
      topBarHidden: paid,
      maxCustomDomains: paid ? 10 : 0,
      // chatEnabled is TRUE on both tiers per the shared constant.
      chatEnabled: true,
      analyticsEnabled: paid,
      customEndpoints: paid,
      maxTeamSeats: paid ? 10 : 1,
    },
  };
};

// ─────────────────────────────── GET /wallet ───────────────────────────────

/** Subscription status of the wallet rail (mapped by the worker's `mapStatus`). */
export type WalletSubscriptionStatus = 'none' | 'active' | 'past_due' | 'canceled' | 'trialing';

/** One wallet ledger row (mirrors the worker's `WalletTransaction`). */
export interface WalletTransactionRow {
  id: string;
  created_at: string;
  category: string;
  amount_cents: number;
  reference_type: string | null;
  reference_id: string | null;
  direction: 'debit' | 'credit';
}

/**
 * The BARE wallet state the worker's `getWalletState` returns on `GET /api/wallet`
 * (NO `{ data }` wrapper — the Billing component reads `r.data ?? r`). `balance_cents`
 * is in CENTS (the UI divides by 100).
 */
export interface WalletResponse {
  balance_cents: number;
  subscription_status: WalletSubscriptionStatus;
  default_payment_method_brand: string | null;
  default_payment_method_last4: string | null;
  last_topup_at: string | null;
  monthly_credit_remaining_days: number | null;
  recent_transactions: WalletTransactionRow[];
}

/**
 * Wallet factory. `empty` → a fresh get-or-create wallet: honest $0 balance (never null),
 * inactive, no PM, no ledger. `populated`/`loading`/default → a funded wallet ($42.50)
 * with an active rail, a Visa on file, and a believable credit/debit ledger.
 */
export const walletFixture: FixtureFactory<WalletResponse> = (
  state: MockState,
): WalletResponse => {
  if (state === 'empty') {
    return {
      balance_cents: 0,
      subscription_status: 'none',
      default_payment_method_brand: null,
      default_payment_method_last4: null,
      last_topup_at: null,
      monthly_credit_remaining_days: null,
      recent_transactions: [],
    };
  }
  return {
    balance_cents: 4250,
    subscription_status: 'active',
    default_payment_method_brand: 'visa',
    default_payment_method_last4: '4242',
    last_topup_at: new Date(Date.parse('2026-10-01T15:12:00Z')).toISOString(),
    monthly_credit_remaining_days: 25,
    recent_transactions: WALLET_LEDGER,
  };
};

/** A believable 6-row ledger — a top-up credit + AI/render debits, newest first. */
const WALLET_LEDGER: WalletTransactionRow[] = buildWalletLedger();

/** Build the wallet ledger (pure; deterministic; newest-first). */
function buildWalletLedger(): WalletTransactionRow[] {
  type Seed = [
    category: string,
    amountCents: number,
    direction: 'debit' | 'credit',
    referenceType: string | null,
  ];
  const seeds: Seed[] = [
    ['topup', 5000, 'credit', 'stripe_charge'],
    ['ai_call', 42, 'debit', 'site_build'],
    ['site_render', 120, 'debit', 'site_render'],
    ['ai_call', 38, 'debit', 'site_build'],
    ['image_generation', 250, 'debit', 'media'],
    ['ai_call', 50, 'debit', 'contact_form'],
  ];
  const anchor = Date.parse('2026-10-05T18:00:00Z');
  return seeds.map((s, i) => {
    const [category, amount_cents, direction, reference_type] = s;
    return {
      id: `wtx-${String(i + 1).padStart(3, '0')}`,
      created_at: new Date(anchor - i * 7 * 60 * 60 * 1000).toISOString(),
      category,
      amount_cents,
      reference_type,
      reference_id: reference_type ? `${reference_type}-${1000 + i}` : null,
      direction,
    };
  });
}
