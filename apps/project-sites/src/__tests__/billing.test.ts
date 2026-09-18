jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('@project-sites/shared', () => {
  const actual = jest.requireActual('@project-sites/shared');
  return {
    ...actual,
    hmacSha256: jest.fn().mockResolvedValue('mock-signature'),
  };
});

import { dbQueryOne, dbInsert, dbUpdate } from '../services/db.js';
import {
  getOrCreateStripeCustomer,
  createCheckoutSession,
  createEmbeddedCheckoutSession,
  createPaymentIntent,
  handleCheckoutCompleted,
  handleSubscriptionUpdated,
  handleSubscriptionDeleted,
  handlePaymentFailed,
  getOrgEntitlements,
  getOrgSubscription,
  createBillingPortalSession,
} from '../services/billing.js';

const mockQueryOne = dbQueryOne as jest.MockedFunction<typeof dbQueryOne>;
const mockInsert = dbInsert as jest.MockedFunction<typeof dbInsert>;
const mockUpdate = dbUpdate as jest.MockedFunction<typeof dbUpdate>;

const mockEnv = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_PUBLISHABLE_KEY: 'pk_test_123',
  SALE_WEBHOOK_URL: undefined,
  SALE_WEBHOOK_SECRET: undefined,
} as any;

const mockDb = {} as D1Database;

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// getOrCreateStripeCustomer
// ---------------------------------------------------------------------------
describe('getOrCreateStripeCustomer', () => {
  it('returns existing customer ID when subscription has one', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'sub_1', stripe_customer_id: 'cus_existing' });

    const result = await getOrCreateStripeCustomer(mockDb, mockEnv, 'org_1', 'a@b.com');

    expect(result).toEqual({ stripe_customer_id: 'cus_existing' });
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('creates new Stripe customer when none exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    mockInsert.mockResolvedValueOnce({ error: null });

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cus_new' }),
      text: async () => '',
    });

    const result = await getOrCreateStripeCustomer(mockDb, mockEnv, 'org_1', 'a@b.com');

    expect(result).toEqual({ stripe_customer_id: 'cus_new' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/customers',
      expect.objectContaining({ method: 'POST' }),
    );
    // AL-746 — the POST MUST carry a stable per-org Idempotency-Key so a double-click /
    // retry returns the SAME customer instead of minting a duplicate (the check-then-act
    // above is non-atomic). RED before the fix (no header sent).
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe('create-customer:org_1');
    // Should insert subscription record
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledWith(
      mockDb,
      'subscriptions',
      expect.objectContaining({
        org_id: 'org_1',
        stripe_customer_id: 'cus_new',
        plan: 'free',
        status: 'active',
      }),
    );
  });

  it('WARNS but still returns the customer when the subscription-row insert fails', async () => {
    // The Stripe customer was already created — a throw would fail checkout. Log for
    // reconciliation + return the customer; the stable Idempotency-Key (AL-746) makes the
    // next call self-heal (SELECT misses → re-POST same key → same customer → row retries).
    mockQueryOne.mockResolvedValueOnce(null);
    mockInsert.mockResolvedValueOnce({ error: 'D1_ERROR: disk full' });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cus_new2' }),
      text: async () => '',
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await getOrCreateStripeCustomer(mockDb, mockEnv, 'org_1', 'a@b.com');

    expect(result).toEqual({ stripe_customer_id: 'cus_new2' });
    const logged = warnSpy.mock.calls
      .map((c) => JSON.parse(c[0]))
      .find((l) => l.message === 'subscription_row_insert_failed');
    expect(logged).toMatchObject({ service: 'billing', stripe_customer_id: 'cus_new2' });
    warnSpy.mockRestore();
  });

  it('throws on Stripe API failure', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
      text: async () => 'Stripe error',
    });

    await expect(getOrCreateStripeCustomer(mockDb, mockEnv, 'org_1', 'a@b.com')).rejects.toThrow(
      'Failed to create Stripe customer',
    );
  });
});

// ---------------------------------------------------------------------------
// createCheckoutSession
// ---------------------------------------------------------------------------
describe('createCheckoutSession', () => {
  const opts = {
    orgId: 'org_1',
    customerEmail: 'a@b.com',
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel',
  };

  function mockExistingCustomer() {
    mockQueryOne.mockResolvedValueOnce({ id: 'sub_1', stripe_customer_id: 'cus_existing' });
  }

  it('returns checkout_url and session_id on success', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cs_123', url: 'https://checkout.stripe.com/cs_123' }),
      text: async () => '',
    });

    const result = await createCheckoutSession(mockDb, mockEnv, opts);

    expect(result).toEqual({
      checkout_url: 'https://checkout.stripe.com/cs_123',
      session_id: 'cs_123',
    });
  });

  it('includes org_id in metadata', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cs_123', url: 'https://checkout.stripe.com/cs_123' }),
      text: async () => '',
    });

    await createCheckoutSession(mockDb, mockEnv, opts);

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const body = fetchCall[1].body as URLSearchParams;
    expect(body.get('metadata[org_id]')).toBe('org_1');
  });

  it('throws on Stripe API failure', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
      text: async () => 'Checkout error',
    });

    await expect(createCheckoutSession(mockDb, mockEnv, opts)).rejects.toThrow(
      'Stripe checkout failed',
    );
  });
});

// ---------------------------------------------------------------------------
// createEmbeddedCheckoutSession
// ---------------------------------------------------------------------------
describe('createEmbeddedCheckoutSession', () => {
  const opts = {
    orgId: 'org_1',
    customerEmail: 'a@b.com',
    returnUrl: 'https://example.com/?billing=success',
  };

  function mockExistingCustomer() {
    mockQueryOne.mockResolvedValueOnce({ id: 'sub_1', stripe_customer_id: 'cus_existing' });
  }

  it('returns client_secret and session_id on success', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cs_123', client_secret: 'cs_123_secret_abc' }),
      text: async () => '',
    });

    const result = await createEmbeddedCheckoutSession(mockDb, mockEnv, opts);

    expect(result).toEqual({
      client_secret: 'cs_123_secret_abc',
      session_id: 'cs_123',
    });
  });

  it('sends ui_mode=embedded to Stripe API', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cs_123', client_secret: 'cs_123_secret_abc' }),
      text: async () => '',
    });

    await createEmbeddedCheckoutSession(mockDb, mockEnv, opts);

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const body = fetchCall[1].body as URLSearchParams;
    expect(body.get('ui_mode')).toBe('embedded');
    expect(body.get('return_url')).toBe('https://example.com/?billing=success');
  });

  it('includes org_id in metadata', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cs_123', client_secret: 'cs_123_secret_abc' }),
      text: async () => '',
    });

    await createEmbeddedCheckoutSession(mockDb, mockEnv, opts);

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const body = fetchCall[1].body as URLSearchParams;
    expect(body.get('metadata[org_id]')).toBe('org_1');
  });

  it('throws on Stripe API failure', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
      text: async () => 'Embedded checkout error',
    });

    await expect(createEmbeddedCheckoutSession(mockDb, mockEnv, opts)).rejects.toThrow(
      'Stripe embedded checkout failed',
    );
  });

  it('includes site_id in metadata when provided', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'cs_456', client_secret: 'cs_456_secret_xyz' }),
      text: async () => '',
    });

    await createEmbeddedCheckoutSession(mockDb, mockEnv, {
      ...opts,
      siteId: 'site_99',
    });

    const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
    const body = fetchCall[1].body as URLSearchParams;
    expect(body.get('metadata[site_id]')).toBe('site_99');
  });
});

// ---------------------------------------------------------------------------
// createPaymentIntent — the embedded Payment Element / saved-card money path.
// Previously UNTESTED (P0-REV money-path coverage gap): a regression here =
// broken payments = $0. Locks the success shape, the Stripe param contract,
// and (critically) the two error envelopes a buyer can hit at the pay step.
// ---------------------------------------------------------------------------
describe('createPaymentIntent', () => {
  const opts = {
    orgId: 'org_1',
    customerEmail: 'a@b.com',
    amountCents: 5000,
  };

  function mockExistingCustomer() {
    mockQueryOne.mockResolvedValueOnce({ id: 'sub_1', stripe_customer_id: 'cus_existing' });
  }

  it('returns client_secret and payment_intent_id on success', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'pi_123', client_secret: 'pi_123_secret_abc' }),
      text: async () => '',
    });

    const result = await createPaymentIntent(mockDb, mockEnv, opts);

    expect(result).toEqual({
      client_secret: 'pi_123_secret_abc',
      payment_intent_id: 'pi_123',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/payment_intents',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends amount, customer, org_id metadata, and a no-redirect automatic PM contract', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'pi_123', client_secret: 'pi_123_secret_abc' }),
      text: async () => '',
    });

    await createPaymentIntent(mockDb, mockEnv, opts);

    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
    expect(body.get('amount')).toBe('5000');
    expect(body.get('customer')).toBe('cus_existing');
    expect(body.get('metadata[org_id]')).toBe('org_1');
    expect(body.get('automatic_payment_methods[enabled]')).toBe('true');
    // allow_redirects=never keeps the embedded element on-page (no off-site bounce).
    expect(body.get('automatic_payment_methods[allow_redirects]')).toBe('never');
    expect(body.get('currency')).toBeTruthy();
    // setup_future_usage defaults ON so a card is saved for off-session reuse.
    expect(body.get('setup_future_usage')).toBe('off_session');
  });

  it('omits setup_future_usage when saveForFutureUse is explicitly false', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'pi_123', client_secret: 'pi_123_secret_abc' }),
      text: async () => '',
    });

    await createPaymentIntent(mockDb, mockEnv, { ...opts, saveForFutureUse: false });

    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
    expect(body.get('setup_future_usage')).toBeNull();
  });

  it('passes site_id metadata and description through when provided', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'pi_456', client_secret: 'pi_456_secret_xyz' }),
      text: async () => '',
    });

    await createPaymentIntent(mockDb, mockEnv, {
      ...opts,
      siteId: 'site_99',
      description: 'Annual plan',
    });

    const body = (global.fetch as jest.Mock).mock.calls[0][1].body as URLSearchParams;
    expect(body.get('metadata[site_id]')).toBe('site_99');
    expect(body.get('description')).toBe('Annual plan');
  });

  it('surfaces the Stripe error code in a clean badRequest envelope (declined card)', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
      text: async () =>
        JSON.stringify({
          error: { code: 'card_declined', message: 'Your card was declined.', type: 'card_error' },
        }),
    });

    // The buyer-facing message must carry the Stripe code, never a raw 500/stack.
    await expect(createPaymentIntent(mockDb, mockEnv, opts)).rejects.toThrow(/card_declined/);
  });

  it('maps a Stripe network failure to a retryable badRequest (never an uncaught 500)', async () => {
    mockExistingCustomer();

    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('socket hang up'));

    await expect(createPaymentIntent(mockDb, mockEnv, opts)).rejects.toThrow(
      /stripe_network_error/,
    );
  });
});

// ---------------------------------------------------------------------------
// handleCheckoutCompleted
// ---------------------------------------------------------------------------
describe('handleCheckoutCompleted', () => {
  it('updates subscription to paid/active', async () => {
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    await handleCheckoutCompleted(mockDb, mockEnv, {
      customer: 'cus_1',
      subscription: 'sub_1',
      metadata: { org_id: 'org_1' },
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      mockDb,
      'subscriptions',
      expect.objectContaining({
        plan: 'paid',
        status: 'active',
        stripe_subscription_id: 'sub_1',
        dunning_stage: 0,
      }),
      'org_id = ?',
      ['org_1'],
    );
  });

  it('throws badRequest when org_id missing from metadata', async () => {
    await expect(
      handleCheckoutCompleted(mockDb, mockEnv, {
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: {},
      }),
    ).rejects.toThrow('Missing org_id in checkout metadata');
  });

  it('calls sale webhook when URL configured', async () => {
    const envWithWebhook = {
      ...mockEnv,
      SALE_WEBHOOK_URL: 'https://hooks.example.com/sale',
      SALE_WEBHOOK_SECRET: 'whsec_test',
    };

    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true });

    await handleCheckoutCompleted(mockDb, envWithWebhook, {
      customer: 'cus_1',
      subscription: 'sub_1',
      metadata: { org_id: 'org_1', site_id: 'site_1' },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://hooks.example.com/sale',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Webhook-Signature': 'mock-signature',
        }),
      }),
    );

    // Verify the body contains expected fields
    const webhookCall = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(webhookCall[1].body);
    expect(body.org_id).toBe('org_1');
    expect(body.site_id).toBe('site_1');
    expect(body.stripe_customer_id).toBe('cus_1');
    expect(body.stripe_subscription_id).toBe('sub_1');
    expect(body.plan).toBe('paid');
  });

  it('THROWS when the upgrade write fails (paid org must not silently stay free)', async () => {
    mockUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    await expect(
      handleCheckoutCompleted(mockDb, mockEnv, {
        customer: 'cus_1',
        subscription: 'sub_1',
        metadata: { org_id: 'org_1' },
      }),
    ).rejects.toThrow(/activate paid subscription/i);
  });
});

// ---------------------------------------------------------------------------
// handleSubscriptionUpdated
// ---------------------------------------------------------------------------
describe('handleSubscriptionUpdated', () => {
  it('updates subscription status and period dates', async () => {
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    const periodStart = 1700000000;
    const periodEnd = 1702592000;

    await handleSubscriptionUpdated(mockDb, {
      id: 'sub_1',
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      metadata: { org_id: 'org_1' },
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      mockDb,
      'subscriptions',
      expect.objectContaining({
        status: 'active',
        cancel_at_period_end: 0,
        current_period_start: new Date(periodStart * 1000).toISOString(),
        current_period_end: new Date(periodEnd * 1000).toISOString(),
      }),
      'org_id = ?',
      ['org_1'],
    );
  });

  it('does nothing when org_id missing', async () => {
    const result = await handleSubscriptionUpdated(mockDb, {
      id: 'sub_1',
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      metadata: {},
    });

    expect(result).toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('passes cancel_at_period_end correctly', async () => {
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    await handleSubscriptionUpdated(mockDb, {
      id: 'sub_1',
      status: 'active',
      cancel_at_period_end: true,
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      metadata: { org_id: 'org_1' },
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      mockDb,
      'subscriptions',
      expect.objectContaining({
        cancel_at_period_end: 1,
      }),
      'org_id = ?',
      ['org_1'],
    );
  });

  it('THROWS when the status-sync write fails (no silent entitlement drift)', async () => {
    mockUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    await expect(
      handleSubscriptionUpdated(mockDb, {
        id: 'sub_1',
        status: 'active',
        cancel_at_period_end: false,
        current_period_start: 1700000000,
        current_period_end: 1702592000,
        metadata: { org_id: 'org_1' },
      }),
    ).rejects.toThrow(/sync subscription update/i);
  });
});

// ---------------------------------------------------------------------------
// handleSubscriptionDeleted
// ---------------------------------------------------------------------------
describe('handleSubscriptionDeleted', () => {
  it('sets plan=free, status=canceled', async () => {
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    await handleSubscriptionDeleted(mockDb, {
      id: 'sub_1',
      metadata: { org_id: 'org_1' },
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      mockDb,
      'subscriptions',
      expect.objectContaining({
        plan: 'free',
        status: 'canceled',
        stripe_subscription_id: null,
      }),
      'org_id = ?',
      ['org_1'],
    );
  });

  it('does nothing when org_id missing', async () => {
    const result = await handleSubscriptionDeleted(mockDb, {
      id: 'sub_1',
      metadata: {},
    });

    expect(result).toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('THROWS when the downgrade write fails (canceled org must not stay paid)', async () => {
    mockUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    await expect(
      handleSubscriptionDeleted(mockDb, { id: 'sub_1', metadata: { org_id: 'org_1' } }),
    ).rejects.toThrow(/downgrade canceled subscription/i);
  });
});

// ---------------------------------------------------------------------------
// handlePaymentFailed
// ---------------------------------------------------------------------------
describe('handlePaymentFailed', () => {
  it('sets status=past_due', async () => {
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 1 });

    await handlePaymentFailed(mockDb, {
      subscription: 'sub_1',
      metadata: { org_id: 'org_1' },
    });

    expect(mockUpdate).toHaveBeenCalledWith(
      mockDb,
      'subscriptions',
      expect.objectContaining({
        status: 'past_due',
      }),
      'org_id = ?',
      ['org_1'],
    );
  });

  it('does nothing when org_id missing', async () => {
    const result = await handlePaymentFailed(mockDb, {
      subscription: 'sub_1',
      metadata: {},
    });

    expect(result).toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('THROWS when the past_due write fails (failed-payment org must not stay active)', async () => {
    mockUpdate.mockResolvedValueOnce({ error: 'D1_ERROR: disk full', changes: 0 });
    await expect(
      handlePaymentFailed(mockDb, { subscription: 'sub_1', metadata: { org_id: 'org_1' } }),
    ).rejects.toThrow(/past_due/i);
  });
});

// ---------------------------------------------------------------------------
// getOrgEntitlements
// ---------------------------------------------------------------------------
describe('getOrgEntitlements', () => {
  // getOrgEntitlements now delegates plan resolution to the shared SSOT
  // `resolveActiveOrgPlan`, whose query is `SELECT plan FROM subscriptions
  // WHERE org_id = ? AND status IN ('active', 'trialing')`. The status gate lives
  // in SQL — so the mocked `dbQueryOne` returns a `{ plan }` row for an
  // active/trialing sub, and `null` for a past_due/canceled sub (the WHERE clause
  // excludes it → no row). (build_limits.test.ts locks the SQL itself.)
  it('returns paid entitlements when sub is paid+active', async () => {
    mockQueryOne.mockResolvedValueOnce({ plan: 'paid' });

    const result = await getOrgEntitlements(mockDb, 'org_1');

    expect(result).toEqual({
      org_id: 'org_1',
      plan: 'paid',
      topBarHidden: true,
      maxCustomDomains: 10,
      chatEnabled: true,
      analyticsEnabled: true,
      customEndpoints: true,
      maxTeamSeats: 10,
    });
  });

  // THE FIX (trialing-drift, third instance): a TRIALING paid subscriber is entitled
  // to paid features. Before routing through resolveActiveOrgPlan, getOrgEntitlements
  // gated on `status !== 'active'` → a paying trial user was handed FREE entitlements
  // (top bar shown, 0 custom domains, 1 team seat) despite being provisioned paid.
  // The SSOT SQL includes `trialing`, so a `{ plan: 'paid' }` row comes back → paid.
  it('returns PAID entitlements when sub is paid+trialing (trialing is entitled, not free)', async () => {
    let capturedSql = '';
    mockQueryOne.mockImplementationOnce(async (_db, sql) => {
      capturedSql = sql;
      return { plan: 'paid' };
    });

    const result = await getOrgEntitlements(mockDb, 'org_1');

    // Prove getOrgEntitlements routes through the trialing-inclusive resolver, not a
    // hand-rolled active-only query that would regress the fix.
    expect(capturedSql).toContain("status IN ('active', 'trialing')");
    expect(result.plan).toBe('paid');
    expect(result.topBarHidden).toBe(true);
    expect(result.maxCustomDomains).toBe(10);
    expect(result.analyticsEnabled).toBe(true);
    expect(result.maxTeamSeats).toBe(10);
  });

  it('returns free entitlements when sub is free', async () => {
    mockQueryOne.mockResolvedValueOnce({ plan: 'free' });

    const result = await getOrgEntitlements(mockDb, 'org_1');

    expect(result).toEqual({
      org_id: 'org_1',
      plan: 'free',
      topBarHidden: false,
      maxCustomDomains: 0,
      chatEnabled: true,
      analyticsEnabled: false,
      customEndpoints: false,
      maxTeamSeats: 1,
    });
  });

  it('returns free entitlements when no subscription found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getOrgEntitlements(mockDb, 'org_1');

    expect(result).toEqual({
      org_id: 'org_1',
      plan: 'free',
      topBarHidden: false,
      maxCustomDomains: 0,
      chatEnabled: true,
      analyticsEnabled: false,
      customEndpoints: false,
      maxTeamSeats: 1,
    });
  });

  // Revenue-integrity guard: a delinquent (past_due) or canceled subscriber whose
  // `plan` column still reads 'paid' MUST lose premium entitlements — otherwise a
  // failed payment leaves them on premium forever (direct revenue leak). The SSOT
  // resolver's `status IN ('active', 'trialing')` filter excludes both statuses →
  // the query returns NO row (mocked as `null`) → free. These lock that a regression
  // to a plan-only (status-less) query can't silently keep delinquents premium.
  it('returns FREE entitlements when paid but past_due (failed payment → premium revoked)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getOrgEntitlements(mockDb, 'org_1');

    expect(result.plan).toBe('free');
    expect(result.topBarHidden).toBe(false);
    expect(result.maxCustomDomains).toBe(0);
    expect(result.analyticsEnabled).toBe(false);
  });

  it('returns FREE entitlements when paid but canceled (premium revoked on cancel)', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getOrgEntitlements(mockDb, 'org_1');

    expect(result.plan).toBe('free');
    expect(result.topBarHidden).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getOrgSubscription
// ---------------------------------------------------------------------------
describe('getOrgSubscription', () => {
  it('returns subscription data when found', async () => {
    mockQueryOne.mockResolvedValueOnce({
      plan: 'paid',
      status: 'active',
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      cancel_at_period_end: 0,
      current_period_end: '2024-12-31T00:00:00Z',
    });

    const result = await getOrgSubscription(mockDb, 'org_1');

    expect(result).toEqual({
      plan: 'paid',
      status: 'active',
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
      cancel_at_period_end: false,
      current_period_end: '2024-12-31T00:00:00Z',
    });
  });

  it('returns null when not found', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    const result = await getOrgSubscription(mockDb, 'org_1');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createBillingPortalSession
// ---------------------------------------------------------------------------
describe('createBillingPortalSession', () => {
  it('returns portal_url on success', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: 'https://billing.stripe.com/session/xyz' }),
      text: async () => '',
    });

    const result = await createBillingPortalSession(
      mockEnv,
      'cus_1',
      'https://example.com/settings',
    );

    expect(result).toEqual({ portal_url: 'https://billing.stripe.com/session/xyz' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/billing_portal/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk_test_123',
        }),
      }),
    );
  });

  it('throws on Stripe API failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({}),
      text: async () => 'Portal error',
    });

    await expect(
      createBillingPortalSession(mockEnv, 'cus_1', 'https://example.com/settings'),
    ).rejects.toThrow('Failed to create billing portal');
  });
});
