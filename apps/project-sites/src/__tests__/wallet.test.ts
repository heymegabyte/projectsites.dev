/**
 * Unit tests for the Stripe wallet billing service (`services/wallet.ts`,
 * sibling #100 — payment-critical).
 *
 * Strategy: mock the `db.js` helpers (dbQuery/dbQueryOne/dbInsert/dbUpdate)
 * so wallet rows + ledger inserts are deterministic, and provide a fake
 * `env.DB.prepare().bind().run()` chain to drive the atomic balance UPDATE
 * (the conditional `WHERE balance_cents >= ?` debit). `global.fetch` is
 * stubbed for every Stripe REST call.
 *
 * Coverage: getWalletState (with/without PM + topup window), startSubscription
 * (unconfigured / configured / email resolution / checkout failure),
 * chargeWallet (happy path, unknown category, disabled category, inactive
 * subscription, insufficient balance with + without auto-topup, min-charge
 * floor, base_cost override, auto-topup-after-debit, ledger insert shape,
 * org scoping, no double-credit), creditWallet (idempotency replay, ledger
 * insert), topUpWallet (no PM, success, stripe error), manualAdjustment,
 * handleStripeEvent (invoice.paid, payment_intent.succeeded, checkout.session
 * .completed, payment_method.attached, customer.subscription.deleted/updated,
 * missing org guard, ignored event), syncSubscriptionStatus.
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

import type { Env } from '../types/env.js';
import {
  getWalletState,
  startSubscription,
  chargeWallet,
  creditWallet,
  topUpWallet,
  manualAdjustment,
  handleStripeEvent,
  syncSubscriptionStatus,
  type WalletState,
} from '../services/wallet.js';
import { dbQuery, dbQueryOne, dbInsert, dbUpdate } from '../services/db.js';

const mockDbQuery = dbQuery as unknown as jest.Mock;
const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockDbInsert = dbInsert as unknown as jest.Mock;
const mockDbUpdate = dbUpdate as unknown as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────

const ORG = 'org-1';

interface FakeWalletRow {
  id: string;
  org_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_default_payment_method: string | null;
  subscription_status: string;
  balance_cents: number;
  auto_topup_threshold_cents: number;
  auto_topup_amount_cents: number;
  monthly_credit_cents: number;
  last_topup_at: string | null;
  created_at: string;
  updated_at: string;
}

function walletRow(overrides: Partial<FakeWalletRow> = {}): FakeWalletRow {
  return {
    id: 'wallet-1',
    org_id: ORG,
    stripe_customer_id: 'cus_123',
    stripe_subscription_id: 'sub_123',
    stripe_default_payment_method: 'pm_123',
    subscription_status: 'active',
    balance_cents: 5000,
    auto_topup_threshold_cents: 500,
    auto_topup_amount_cents: 5000,
    monthly_credit_cents: 5000,
    last_topup_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

interface CostCategory {
  slug: string;
  label: string;
  unit: string;
  base_cost_cents: number;
  markup_factor: number;
  min_charge_cents: number;
  billable: number;
}

function category(overrides: Partial<CostCategory> = {}): CostCategory {
  return {
    slug: 'ai_token',
    label: 'AI token',
    unit: 'token',
    base_cost_cents: 10,
    markup_factor: 2,
    min_charge_cents: 1,
    billable: 1,
    ...overrides,
  };
}

/**
 * Build a fake `env.DB` whose `prepare().bind().run()` resolves to the given
 * result. Records the bound args so tests can assert the debit amount + WHERE
 * guard params.
 */
function fakeDb(runResult: { success: boolean; meta?: { changes?: number } }) {
  const boundCalls: unknown[][] = [];
  const prepare = jest.fn(() => ({
    bind: (...args: unknown[]) => {
      boundCalls.push(args);
      return { run: jest.fn().mockResolvedValue(runResult) };
    },
  }));
  return { db: { prepare } as unknown as D1Database, boundCalls, prepare };
}

function makeEnv(db: unknown): Env {
  return {
    DB: db,
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_PRICE_ID_MONTHLY_WALLET: 'price_wallet_123',
  } as unknown as Env;
}

const okRun = { success: true, meta: { changes: 1 } };
const noChangeRun = { success: true, meta: { changes: 0 } };

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ data: [], error: null });
  mockDbQueryOne.mockResolvedValue(null);
  mockDbInsert.mockResolvedValue({ error: null });
  mockDbUpdate.mockResolvedValue({ error: null, changes: 1 });
  (global.fetch as unknown) = jest.fn();
});

// ── ensureWalletRow (via getWalletState) ───────────────────────────────────

describe('ensureWalletRow', () => {
  it('creates a new inactive zero-balance wallet when none exists', async () => {
    // First lookup → null (none), insert, then SELECT by id → created row.
    mockDbQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(walletRow({ subscription_status: 'inactive', balance_cents: 0 }));
    const { db } = fakeDb(okRun);
    const state = await getWalletState(makeEnv(db), ORG);
    expect(mockDbInsert).toHaveBeenCalledWith(
      db,
      'wallet_accounts',
      expect.objectContaining({
        org_id: ORG,
        subscription_status: 'inactive',
        balance_cents: 0,
        auto_topup_threshold_cents: 500,
        auto_topup_amount_cents: 5000,
        monthly_credit_cents: 5000,
      }),
    );
    expect(state.subscription_status).toBe('none');
    expect(state.balance_cents).toBe(0);
  });

  it('throws when the freshly-created wallet cannot be re-read', async () => {
    mockDbQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const { db } = fakeDb(okRun);
    await expect(getWalletState(makeEnv(db), ORG)).rejects.toThrow('Failed to create wallet');
  });
});

// ── getWalletState ─────────────────────────────────────────────────────────

describe('getWalletState', () => {
  it('returns balance, mapped status, and recent transactions (org-scoped)', async () => {
    mockDbQueryOne.mockResolvedValueOnce(
      walletRow({ stripe_default_payment_method: null, balance_cents: 4200 }),
    );
    mockDbQuery.mockResolvedValueOnce({
      data: [
        {
          id: 'tx1',
          created_at: '2026-02-01T00:00:00Z',
          category_slug: 'ai_token',
          amount_cents: -20,
          reference_type: 'chat',
          reference_id: 'c1',
          direction: 'debit',
        },
        {
          id: 'tx2',
          created_at: '2026-02-02T00:00:00Z',
          category_slug: null,
          amount_cents: 5000,
          reference_type: 'subscription',
          reference_id: 'sub_1',
          direction: 'credit',
        },
      ],
      error: null,
    });
    const env = makeEnv(fakeDb(okRun).db);
    const state = await getWalletState(env, ORG);
    expect(state.balance_cents).toBe(4200);
    expect(state.subscription_status).toBe('active');
    expect(state.recent_transactions).toHaveLength(2);
    expect(state.recent_transactions[0]).toMatchObject({
      direction: 'debit',
      category: 'ai_token',
    });
    expect(state.recent_transactions[1].direction).toBe('credit');
    // org-scoped query
    const sql = mockDbQuery.mock.calls[0][1] as string;
    const params = mockDbQuery.mock.calls[0][2] as unknown[];
    expect(sql).toContain('WHERE org_id = ?');
    expect(params).toEqual([ORG]);
    // No PM fetch when none stored.
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('falls back category to reference_type then "unknown"', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow({ stripe_default_payment_method: null }));
    mockDbQuery.mockResolvedValueOnce({
      data: [
        {
          id: 'a',
          created_at: 't',
          category_slug: null,
          amount_cents: 1,
          reference_type: 'topup',
          reference_id: null,
          direction: 'credit',
        },
        {
          id: 'b',
          created_at: 't',
          category_slug: null,
          amount_cents: 1,
          reference_type: null,
          reference_id: null,
          direction: 'debit',
        },
      ],
      error: null,
    });
    const state = await getWalletState(makeEnv(fakeDb(okRun).db), ORG);
    expect(state.recent_transactions[0].category).toBe('topup');
    expect(state.recent_transactions[1].category).toBe('unknown');
  });

  it('fetches PM brand/last4 from Stripe when a default PM is stored', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ card: { brand: 'visa', last4: '4242' } }),
    });
    const state = await getWalletState(makeEnv(fakeDb(okRun).db), ORG);
    expect(state.default_payment_method_brand).toBe('visa');
    expect(state.default_payment_method_last4).toBe('4242');
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/payment_methods/pm_123');
  });

  it('swallows a failing PM fetch and leaves brand/last4 null', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network'));
    const state = await getWalletState(makeEnv(fakeDb(okRun).db), ORG);
    expect(state.default_payment_method_brand).toBeNull();
    expect(state.default_payment_method_last4).toBeNull();
  });

  it('computes monthly_credit_remaining_days from last_topup_at', async () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    mockDbQueryOne.mockResolvedValueOnce(
      walletRow({ stripe_default_payment_method: null, last_topup_at: fiveDaysAgo }),
    );
    const state = await getWalletState(makeEnv(fakeDb(okRun).db), ORG);
    expect(state.monthly_credit_remaining_days).toBeGreaterThanOrEqual(24);
    expect(state.monthly_credit_remaining_days).toBeLessThanOrEqual(25);
  });

  it('clamps remaining days to 0 once the window has elapsed', async () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    mockDbQueryOne.mockResolvedValueOnce(
      walletRow({ stripe_default_payment_method: null, last_topup_at: fortyDaysAgo }),
    );
    const state = await getWalletState(makeEnv(fakeDb(okRun).db), ORG);
    expect(state.monthly_credit_remaining_days).toBe(0);
  });
});

// ── startSubscription ────────────────────────────────────────────────────

describe('startSubscription', () => {
  it('returns ok:false when the wallet price is not configured', async () => {
    const env = makeEnv(fakeDb(okRun).db);
    (env as { STRIPE_PRICE_ID_MONTHLY_WALLET?: string }).STRIPE_PRICE_ID_MONTHLY_WALLET = '';
    const res = await startSubscription(env, ORG, {
      success_url: 'https://x/ok',
      cancel_url: 'https://x/no',
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not configured');
  });

  it('creates a checkout session using the explicit email + existing customer', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://checkout.stripe.com/sess_1' }),
    });
    const res = await startSubscription(makeEnv(fakeDb(okRun).db), ORG, {
      success_url: 'https://x/ok',
      cancel_url: 'https://x/no',
      email: 'owner@x.com',
    });
    expect(res.ok).toBe(true);
    expect(res.checkout_url).toBe('https://checkout.stripe.com/sess_1');
    // Single Stripe call (checkout) — customer already on file.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/checkout/sessions');
  });

  it('resolves the owner email and creates a Stripe customer when none on file', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow({ stripe_customer_id: null })) // ensureWalletRow
      .mockResolvedValueOnce({ email: 'firstowner@x.com' }); // owner lookup
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'cus_new' }) }) // create customer
      .mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://checkout/sess' }) });
    const res = await startSubscription(makeEnv(fakeDb(okRun).db), ORG, {
      success_url: 'https://x/ok',
      cancel_url: 'https://x/no',
    });
    expect(res.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('/customers');
    // owner email forwarded into customer body
    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
    expect(body.get('email')).toBe('firstowner@x.com');
  });

  it('returns ok:false on Stripe checkout failure', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, text: async () => 'bad' });
    const res = await startSubscription(makeEnv(fakeDb(okRun).db), ORG, {
      success_url: 'https://x/ok',
      cancel_url: 'https://x/no',
      email: 'o@x.com',
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Stripe checkout failed');
  });

  it('throws when Stripe customer creation fails', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow({ stripe_customer_id: null }))
      .mockResolvedValueOnce({ email: 'o@x.com' });
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, text: async () => 'denied' });
    await expect(
      startSubscription(makeEnv(fakeDb(okRun).db), ORG, {
        success_url: 'https://x/ok',
        cancel_url: 'https://x/no',
      }),
    ).rejects.toThrow(/Stripe customer creation failed/);
  });
});

// ── chargeWallet ───────────────────────────────────────────────────────────

describe('chargeWallet', () => {
  const chargeParams = {
    category: 'ai_token',
    quantity: 3,
    reference_type: 'chat',
    reference_id: 'msg-1',
  };

  it('debits the wallet and writes a debit ledger row on the happy path', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow({ balance_cents: 5000 })) // ensureWalletRow
      .mockResolvedValueOnce(
        category({ base_cost_cents: 10, markup_factor: 2, min_charge_cents: 1 }),
      ); // loadCategory
    const { db, boundCalls } = fakeDb(okRun);
    const res = await chargeWallet(makeEnv(db), ORG, chargeParams);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 10 * 3 * 2 = 60
      expect(res.charged_cents).toBe(60);
      expect(res.balance_after_cents).toBe(4940);
    }
    // atomic UPDATE bound with [amount, walletId, amount] — WHERE balance >= amount
    expect(boundCalls[0]).toEqual([60, 'wallet-1', 60]);
    // ledger insert: negative amount_cents, debit direction, org-scoped
    expect(mockDbInsert).toHaveBeenCalledWith(
      db,
      'wallet_transactions',
      expect.objectContaining({
        org_id: ORG,
        direction: 'debit',
        amount_cents: -60,
        balance_after_cents: 4940,
        category_slug: 'ai_token',
      }),
    );
  });

  it('applies the min_charge_cents floor when computed cost is below it', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow())
      .mockResolvedValueOnce(
        category({ base_cost_cents: 1, markup_factor: 1, min_charge_cents: 50 }),
      );
    const { db, boundCalls } = fakeDb(okRun);
    const res = await chargeWallet(makeEnv(db), ORG, { ...chargeParams, quantity: 1 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.charged_cents).toBe(50); // floored
    expect(boundCalls[0][0]).toBe(50);
  });

  it('honors a base_cost_cents override for variable-cost categories', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow())
      .mockResolvedValueOnce(
        category({ base_cost_cents: 10, markup_factor: 1.5, min_charge_cents: 1 }),
      );
    const { db } = fakeDb(okRun);
    const res = await chargeWallet(makeEnv(db), ORG, {
      ...chargeParams,
      quantity: 1,
      base_cost_cents: 200, // override → 200 * 1 * 1.5 = 300
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.charged_cents).toBe(300);
  });

  it('returns reason:error for an unknown category (no debit, no ledger)', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow()).mockResolvedValueOnce(null); // loadCategory → none
    const { db } = fakeDb(okRun);
    const res = await chargeWallet(makeEnv(db), ORG, chargeParams);
    expect(res).toMatchObject({ ok: false, reason: 'error' });
    expect(res.ok === false && res.message).toContain('unknown category');
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('returns reason:error for a disabled (non-billable) category', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow())
      .mockResolvedValueOnce(category({ billable: 0 }));
    const res = await chargeWallet(makeEnv(fakeDb(okRun).db), ORG, chargeParams);
    expect(res).toMatchObject({ ok: false, reason: 'error', message: 'category disabled' });
  });

  it('rejects when the subscription is not active', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow({ subscription_status: 'past_due' }))
      .mockResolvedValueOnce(category());
    const res = await chargeWallet(makeEnv(fakeDb(okRun).db), ORG, chargeParams);
    expect(res).toMatchObject({
      ok: false,
      reason: 'error',
      message: 'wallet_subscription_inactive',
    });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('returns insufficient when the atomic UPDATE changes 0 rows (no double-debit ledger)', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow({ balance_cents: 5, stripe_default_payment_method: null }))
      .mockResolvedValueOnce(
        category({ base_cost_cents: 100, markup_factor: 1, min_charge_cents: 1 }),
      );
    const { db } = fakeDb(noChangeRun);
    const res = await chargeWallet(makeEnv(db), ORG, { ...chargeParams, quantity: 1 });
    expect(res).toMatchObject({ ok: false, reason: 'insufficient', balance_cents: 5 });
    // CRITICAL: no ledger row written when the debit didn't apply (no phantom debit).
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('fires auto-topup on insufficient balance when a PM is on file', async () => {
    mockDbQueryOne
      // chargeWallet ensureWalletRow
      .mockResolvedValueOnce(walletRow({ balance_cents: 5 }))
      .mockResolvedValueOnce(
        category({ base_cost_cents: 100, markup_factor: 1, min_charge_cents: 1 }),
      )
      // topUpWallet ensureWalletRow (async, not awaited by chargeWallet)
      .mockResolvedValueOnce(walletRow({ balance_cents: 5 }));
    // topUp PaymentIntent
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ id: 'pi_1' }) });
    const res = await chargeWallet(makeEnv(fakeDb(noChangeRun).db), ORG, {
      ...chargeParams,
      quantity: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('insufficient');
    // give the un-awaited topup microtask a tick
    await new Promise((r) => setTimeout(r, 0));
    const piCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes('/payment_intents'),
    );
    expect(piCall).toBeDefined();
    // Double-charge guard: the auto-topup charge MUST carry a stable wallet+bucket
    // Idempotency-Key so two racing chargeWallet calls collapse to ONE real card charge.
    expect((piCall![1].headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^wallet-autotopup:wallet-1:/,
    );
  });

  it('fires auto-topup after a successful debit drops below threshold', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow({ balance_cents: 60, auto_topup_threshold_cents: 500 }))
      .mockResolvedValueOnce(
        category({ base_cost_cents: 10, markup_factor: 1, min_charge_cents: 1 }),
      )
      // topUpWallet ensureWalletRow
      .mockResolvedValueOnce(walletRow({ balance_cents: 50 }));
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ id: 'pi_2' }) });
    const res = await chargeWallet(makeEnv(fakeDb(okRun).db), ORG, {
      ...chargeParams,
      quantity: 1,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.balance_after_cents).toBe(50); // 60 - 10, below 500 threshold
    await new Promise((r) => setTimeout(r, 0));
    const piCall = (global.fetch as jest.Mock).mock.calls.find((c) =>
      String(c[0]).includes('/payment_intents'),
    );
    expect(piCall).toBeDefined();
    expect((piCall![1].headers as Record<string, string>)['Idempotency-Key']).toMatch(
      /^wallet-autotopup:wallet-1:/,
    );
  });
});

// ── creditWallet ───────────────────────────────────────────────────────────

describe('creditWallet', () => {
  it('credits the balance and writes a positive credit ledger row', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(null) // idempotency: no dup event
      .mockResolvedValueOnce(walletRow({ balance_cents: 1000 })); // ensureWalletRow
    const { db } = fakeDb(okRun);
    await creditWallet(makeEnv(db), ORG, {
      amount_cents: 5000,
      reason: 'monthly_subscription_credit',
      reference_type: 'subscription',
      reference_id: 'sub_1',
      stripe_event_id: 'evt_1',
    });
    expect(mockDbInsert).toHaveBeenCalledWith(
      db,
      'wallet_transactions',
      expect.objectContaining({
        direction: 'credit',
        amount_cents: 5000,
        balance_after_cents: 6000,
        stripe_event_id: 'evt_1',
      }),
    );
  });

  it('is idempotent: a replayed stripe_event_id is a no-op (NO double-credit)', async () => {
    mockDbQueryOne.mockResolvedValueOnce({ id: 'existing-tx' }); // dup found
    const { db, prepare } = fakeDb(okRun);
    await creditWallet(makeEnv(db), ORG, {
      amount_cents: 5000,
      reason: 'monthly_subscription_credit',
      reference_type: 'subscription',
      reference_id: 'sub_1',
      stripe_event_id: 'evt_dup',
    });
    // No balance UPDATE, no ledger insert.
    expect(prepare).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('DB-level dedupe (0635): a UNIQUE stripe_event_id violation reverses the add + is a no-op (NOT a throw)', async () => {
    // The race: the idempotency SELECT missed a concurrent delivery (null), the balance is
    // credited, then the UNIQUE(stripe_event_id) index (migration 0635) rejects the duplicate
    // ledger insert. creditWallet must REVERSE its own balance add and return cleanly —
    // exactly-once, no spurious webhook failure. (Without the reverse this would double-credit.)
    mockDbQueryOne
      .mockResolvedValueOnce(null) // idempotency SELECT: no dup seen (the race window)
      .mockResolvedValueOnce(walletRow({ balance_cents: 1000 })); // ensureWalletRow
    mockDbInsert.mockResolvedValueOnce({
      error: 'D1_ERROR: UNIQUE constraint failed: wallet_transactions.stripe_event_id',
    });
    const { db, prepare } = fakeDb(okRun);
    await expect(
      creditWallet(makeEnv(db), ORG, {
        amount_cents: 5000,
        reason: 'monthly_subscription_credit',
        reference_type: 'subscription',
        reference_id: 'sub_1',
        stripe_event_id: 'evt_race',
      }),
    ).resolves.toBeUndefined(); // idempotent no-op, never throws
    expect(mockDbInsert).toHaveBeenCalledTimes(1); // the insert WAS attempted...
    // ...and the credit UPDATE + the reversal UPDATE both ran (2 prepare calls) → net-zero
    // balance change, so exactly one credit survives (the winning delivery's).
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('a NON-unique insert error still fails loud (reversed + thrown) so the webhook retries', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(walletRow({ balance_cents: 1000 }));
    mockDbInsert.mockResolvedValueOnce({ error: 'D1_ERROR: disk I/O error' });
    const { db } = fakeDb(okRun);
    await expect(
      creditWallet(makeEnv(db), ORG, {
        amount_cents: 5000,
        reason: 'monthly_subscription_credit',
        reference_type: 'subscription',
        reference_id: 'sub_1',
        stripe_event_id: 'evt_ioerr',
      }),
    ).rejects.toThrow(/Failed to record wallet credit/);
  });

  it('credits without an idempotency key (manual credit path)', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow({ balance_cents: 0 }));
    const { db } = fakeDb(okRun);
    await creditWallet(makeEnv(db), ORG, {
      amount_cents: 250,
      reason: 'gift',
      reference_type: 'manual',
      reference_id: 'g1',
    });
    expect(mockDbInsert).toHaveBeenCalledWith(
      db,
      'wallet_transactions',
      expect.objectContaining({
        amount_cents: 250,
        balance_after_cents: 250,
        stripe_event_id: null,
      }),
    );
  });
});

// ── topUpWallet ────────────────────────────────────────────────────────────

describe('topUpWallet', () => {
  it('returns ok:false when there is no payment method on file', async () => {
    mockDbQueryOne.mockResolvedValueOnce(
      walletRow({ stripe_customer_id: null, stripe_default_payment_method: null }),
    );
    const res = await topUpWallet(makeEnv(fakeDb(okRun).db), ORG, 5000);
    expect(res).toEqual({ ok: false, message: 'no payment method on file' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fires an off-session PaymentIntent and returns fresh state on success', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow()) // topUpWallet ensureWalletRow
      .mockResolvedValueOnce(walletRow()); // getWalletState ensureWalletRow
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'pi_ok' }) }) // payment_intent
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ card: { brand: 'visa', last4: '1' } }),
      }); // PM lookup in getWalletState
    const res = await topUpWallet(makeEnv(fakeDb(okRun).db), ORG, 5000);
    expect(res.ok).toBe(true);
    expect((res.state as WalletState).balance_cents).toBe(5000);
    const piBody = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
    expect(piBody.get('off_session')).toBe('true');
    expect(piBody.get('confirm')).toBe('true');
    expect(piBody.get('amount')).toBe('5000');
    expect(piBody.get('metadata[purpose]')).toBe('wallet_topup');
  });

  it('returns ok:false with the stripe error text on PaymentIntent failure', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => 'card_declined',
    });
    const res = await topUpWallet(makeEnv(fakeDb(okRun).db), ORG, 5000);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('stripe_402');
  });

  it('forwards a provided Idempotency-Key to the Stripe PaymentIntent create', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow()) // topUpWallet ensureWalletRow
      .mockResolvedValueOnce(walletRow()); // getWalletState ensureWalletRow
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'pi_ok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: { brand: 'visa', last4: '1' } }) });
    await topUpWallet(makeEnv(fakeDb(okRun).db), ORG, 5000, 'wallet-autotopup:wallet-1:999');
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('wallet-autotopup:wallet-1:999');
  });

  it('omits Idempotency-Key when none is provided (manual routes use the HTTP idempotency middleware)', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow())
      .mockResolvedValueOnce(walletRow());
    mockDbQuery.mockResolvedValueOnce({ data: [], error: null });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'pi_ok' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: { brand: 'visa', last4: '1' } }) });
    await topUpWallet(makeEnv(fakeDb(okRun).db), ORG, 5000);
    const headers = (global.fetch as jest.Mock).mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeUndefined();
  });
});

// ── manualAdjustment ───────────────────────────────────────────────────────

describe('manualAdjustment', () => {
  it('records an adjustment ledger row with actor + reason and returns the new balance', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow({ balance_cents: 1000 }));
    const { db } = fakeDb(okRun);
    const res = await manualAdjustment(makeEnv(db), ORG, {
      amount_cents: -200,
      reason: 'refund correction',
      actor_id: 'admin-1',
    });
    expect(res.balance_after).toBe(800);
    expect(mockDbInsert).toHaveBeenCalledWith(
      db,
      'wallet_transactions',
      expect.objectContaining({
        direction: 'adjustment',
        amount_cents: -200,
        balance_after_cents: 800,
        reference_type: 'manual_adjustment',
        created_by: 'admin-1',
      }),
    );
  });
});

// ── handleStripeEvent ──────────────────────────────────────────────────────

describe('handleStripeEvent', () => {
  it('invoice.paid credits the monthly amount and flips status to active', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow()) // ensureWalletRow (invoice handler)
      .mockResolvedValueOnce(null) // creditWallet idempotency
      .mockResolvedValueOnce(walletRow({ balance_cents: 0 })); // creditWallet ensureWalletRow
    const { db } = fakeDb(okRun);
    await handleStripeEvent(makeEnv(db), 'invoice.paid', {
      id: 'evt_inv_1',
      subscription: 'sub_9',
      amount_paid: 5000,
      metadata: { org_id: ORG },
    });
    expect(mockDbInsert).toHaveBeenCalledWith(
      db,
      'wallet_transactions',
      expect.objectContaining({
        direction: 'credit',
        amount_cents: 5000,
        stripe_event_id: 'evt_inv_1',
      }),
    );
    expect(mockDbUpdate).toHaveBeenCalledWith(
      db,
      'wallet_accounts',
      { subscription_status: 'active' },
      'org_id = ?',
      [ORG],
    );
  });

  it('invoice.paid THROWS when the status-flip write fails (payment-critical: webhook marked failed, not a silent stale success)', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow()) // ensureWalletRow (invoice handler)
      .mockResolvedValueOnce(null) // creditWallet idempotency
      .mockResolvedValueOnce(walletRow({ balance_cents: 0 })); // creditWallet ensureWalletRow
    // Fail ONLY the subscription_status flip; the credit path stays healthy — proves a
    // dropped activation write surfaces (throws) instead of a lying silent success that
    // leaves a PAID org stuck past_due.
    mockDbUpdate.mockImplementation((_db: unknown, _t: unknown, patch: Record<string, unknown>) =>
      Promise.resolve(
        patch?.subscription_status
          ? { error: 'D1_ERROR: disk full', changes: 0 }
          : { error: null, changes: 1 },
      ),
    );
    await expect(
      handleStripeEvent(makeEnv(fakeDb(okRun).db), 'invoice.paid', {
        id: 'evt_inv_fail',
        subscription: 'sub_9',
        amount_paid: 5000,
        metadata: { org_id: ORG },
      }),
    ).rejects.toThrow(/activate subscription/i);
  });

  it('invoice.paid without a subscription is skipped (one-time invoice)', async () => {
    mockDbQueryOne.mockResolvedValue(walletRow());
    await handleStripeEvent(makeEnv(fakeDb(okRun).db), 'invoice.paid', {
      id: 'evt_x',
      metadata: { org_id: ORG },
    });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('invoice.paid without an org_id is a guard no-op', async () => {
    await handleStripeEvent(makeEnv(fakeDb(okRun).db), 'invoice.paid', {
      id: 'evt_y',
      subscription: 'sub_1',
      metadata: {},
    });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('payment_intent.succeeded credits a wallet_topup', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(null) // creditWallet idempotency
      .mockResolvedValueOnce(walletRow({ balance_cents: 0 })); // ensureWalletRow
    const { db } = fakeDb(okRun);
    await handleStripeEvent(makeEnv(db), 'payment_intent.succeeded', {
      id: 'pi_top',
      amount_received: 5000,
      metadata: { org_id: ORG, purpose: 'wallet_topup' },
    });
    expect(mockDbInsert).toHaveBeenCalledWith(
      db,
      'wallet_transactions',
      expect.objectContaining({
        amount_cents: 5000,
        reference_type: 'topup',
        stripe_event_id: 'pi_top',
      }),
    );
  });

  it('payment_intent.succeeded ignores non-topup purposes', async () => {
    await handleStripeEvent(makeEnv(fakeDb(okRun).db), 'payment_intent.succeeded', {
      id: 'pi_other',
      amount_received: 100,
      metadata: { org_id: ORG, purpose: 'something_else' },
    });
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('checkout.session.completed pulls the default PM and syncs status active', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow()) // syncSubscriptionStatus ensureWalletRow
      .mockResolvedValue(walletRow());
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ default_payment_method: 'pm_new' }),
    });
    const { db } = fakeDb(okRun);
    await handleStripeEvent(makeEnv(db), 'checkout.session.completed', {
      subscription: 'sub_c',
      customer: 'cus_c',
      metadata: { org_id: ORG, purpose: 'wallet_subscription' },
    });
    // syncSubscriptionStatus writes status + sub id + default PM
    expect(mockDbUpdate).toHaveBeenCalledWith(
      db,
      'wallet_accounts',
      expect.objectContaining({
        subscription_status: 'active',
        stripe_subscription_id: 'sub_c',
        stripe_default_payment_method: 'pm_new',
      }),
      'id = ?',
      ['wallet-1'],
    );
    // and records the customer id
    expect(mockDbUpdate).toHaveBeenCalledWith(
      db,
      'wallet_accounts',
      { stripe_customer_id: 'cus_c' },
      'org_id = ?',
      [ORG],
    );
  });

  it('checkout.session.completed ignores a non-wallet purpose', async () => {
    await handleStripeEvent(makeEnv(fakeDb(okRun).db), 'checkout.session.completed', {
      subscription: 'sub_c',
      customer: 'cus_c',
      metadata: { org_id: ORG, purpose: 'something' },
    });
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('payment_method.attached adopts the PM as default when none is set', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow({ stripe_default_payment_method: null }));
    const { db } = fakeDb(okRun);
    await handleStripeEvent(makeEnv(db), 'payment_method.attached', {
      id: 'pm_attached',
      customer: 'cus_c',
    });
    expect(mockDbUpdate).toHaveBeenCalledWith(
      db,
      'wallet_accounts',
      { stripe_default_payment_method: 'pm_attached' },
      'id = ?',
      ['wallet-1'],
    );
  });

  it('payment_method.attached does NOT overwrite an existing default PM', async () => {
    mockDbQueryOne.mockResolvedValueOnce(
      walletRow({ stripe_default_payment_method: 'pm_existing' }),
    );
    await handleStripeEvent(makeEnv(fakeDb(okRun).db), 'payment_method.attached', {
      id: 'pm_new',
      customer: 'cus_c',
    });
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('customer.subscription.deleted syncs status to canceled', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    const { db } = fakeDb(okRun);
    await handleStripeEvent(makeEnv(db), 'customer.subscription.deleted', {
      id: 'sub_del',
      metadata: { org_id: ORG },
    });
    expect(mockDbUpdate).toHaveBeenCalledWith(
      db,
      'wallet_accounts',
      expect.objectContaining({ subscription_status: 'canceled' }),
      'id = ?',
      ['wallet-1'],
    );
  });

  it('customer.subscription.updated maps an unknown status to inactive', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    const { db } = fakeDb(okRun);
    await handleStripeEvent(makeEnv(db), 'customer.subscription.updated', {
      id: 'sub_u',
      status: 'incomplete_expired',
      default_payment_method: 'pm_z',
      metadata: { org_id: ORG, purpose: 'wallet_subscription' },
    });
    expect(mockDbUpdate).toHaveBeenCalledWith(
      db,
      'wallet_accounts',
      expect.objectContaining({
        subscription_status: 'inactive',
        stripe_default_payment_method: 'pm_z',
      }),
      'id = ?',
      ['wallet-1'],
    );
  });

  it('ignores unrelated event types', async () => {
    await handleStripeEvent(makeEnv(fakeDb(okRun).db), 'charge.refunded', {
      id: 'ch_1',
      metadata: {},
    });
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });
});

// ── syncSubscriptionStatus ─────────────────────────────────────────────────

describe('syncSubscriptionStatus', () => {
  it('patches status + subscription id, omitting PM when undefined', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    const { db } = fakeDb(okRun);
    await syncSubscriptionStatus(makeEnv(db), {
      org_id: ORG,
      subscription_id: 'sub_p',
      status: 'past_due',
    });
    const patch = mockDbUpdate.mock.calls[0][2] as Record<string, unknown>;
    expect(patch).toEqual({ subscription_status: 'past_due', stripe_subscription_id: 'sub_p' });
    expect(patch).not.toHaveProperty('stripe_default_payment_method');
  });

  it('includes the default PM when explicitly provided (even null)', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow());
    const { db } = fakeDb(okRun);
    await syncSubscriptionStatus(makeEnv(db), {
      org_id: ORG,
      subscription_id: 'sub_p',
      status: 'active',
      default_payment_method: null,
    });
    const patch = mockDbUpdate.mock.calls[0][2] as Record<string, unknown>;
    expect(patch).toHaveProperty('stripe_default_payment_method', null);
  });
});

// ── ledger-write failure compensation (financial integrity) ────────────────
// A `wallet_transactions` INSERT that silently fails AFTER the balance was
// already mutated used to leave money moved with no ledger record (a debit
// retry would then double-charge; a credit would break stripe_event_id
// idempotency). Each mutation now REVERSES the balance change and throws, so
// wallet_accounts.balance_cents never diverges from the (absent) ledger.

describe('ledger-write failure compensation', () => {
  it('chargeWallet: reverses the debit + throws when the ledger insert fails', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(walletRow({ balance_cents: 5000 })) // ensureWalletRow
      .mockResolvedValueOnce(
        category({ base_cost_cents: 10, markup_factor: 2, min_charge_cents: 1 }),
      ); // loadCategory
    mockDbInsert.mockResolvedValueOnce({ error: 'ledger down' }); // ledger write fails
    const { db, boundCalls } = fakeDb(okRun);
    await expect(
      chargeWallet(makeEnv(db), ORG, {
        category: 'ai_token',
        quantity: 3,
        reference_type: 'chat',
        reference_id: 'msg-1',
      }),
    ).rejects.toThrow(/Failed to record wallet debit/);
    // boundCalls[0] = the atomic debit ([amount, walletId, amount]); boundCalls[1]
    // = the compensating reversal that ADDS the 60¢ back to the balance.
    expect(boundCalls[0]).toEqual([60, 'wallet-1', 60]);
    expect(boundCalls[1]).toEqual([60, 'wallet-1']);
  });

  it('creditWallet: reverses the credit + throws when the ledger insert fails', async () => {
    mockDbQueryOne
      .mockResolvedValueOnce(null) // idempotency: no dup event
      .mockResolvedValueOnce(walletRow({ balance_cents: 1000 })); // ensureWalletRow
    mockDbInsert.mockResolvedValueOnce({ error: 'ledger down' });
    const { db, boundCalls } = fakeDb(okRun);
    await expect(
      creditWallet(makeEnv(db), ORG, {
        amount_cents: 5000,
        reason: 'monthly_subscription_credit',
        reference_type: 'subscription',
        reference_id: 'sub_1',
        stripe_event_id: 'evt_x',
      }),
    ).rejects.toThrow(/Failed to record wallet credit/);
    expect(boundCalls[0]).toEqual([5000, 'wallet-1']); // credit: balance + 5000
    expect(boundCalls[1]).toEqual([-5000, 'wallet-1']); // reverse: balance + (−5000)
  });

  it('manualAdjustment: reverses the adjustment + throws when the ledger insert fails', async () => {
    mockDbQueryOne.mockResolvedValueOnce(walletRow({ balance_cents: 1000 })); // ensureWalletRow
    mockDbInsert.mockResolvedValueOnce({ error: 'ledger down' });
    const { db, boundCalls } = fakeDb(okRun);
    await expect(
      manualAdjustment(makeEnv(db), ORG, {
        amount_cents: -200,
        reason: 'refund correction',
        actor_id: 'admin-1',
      }),
    ).rejects.toThrow(/Failed to record wallet adjustment/);
    expect(boundCalls[0]).toEqual([-200, 'wallet-1']); // adjust: balance + (−200)
    expect(boundCalls[1]).toEqual([200, 'wallet-1']); // reverse: balance + 200
  });
});
