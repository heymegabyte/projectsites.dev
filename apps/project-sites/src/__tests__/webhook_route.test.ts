jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('../services/webhook.js', () => ({
  verifyStripeSignature: jest.fn(),
  checkWebhookIdempotency: jest.fn(),
  storeWebhookEvent: jest.fn(),
  markWebhookProcessed: jest.fn(),
  resetWebhookForRetry: jest.fn(),
}));

jest.mock('../services/billing.js', () => ({
  handleCheckoutCompleted: jest.fn(),
  handleSubscriptionUpdated: jest.fn(),
  handleSubscriptionDeleted: jest.fn(),
  handlePaymentFailed: jest.fn(),
}));

jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn(),
}));

jest.mock('../services/emit_event.js', () => ({
  tryEmitEvent: jest.fn(),
}));

jest.mock('@project-sites/shared', () => {
  const actual = jest.requireActual('@project-sites/shared');
  return { ...actual, sha256Hex: jest.fn().mockResolvedValue('mockhash') };
});

import { Hono } from 'hono';
import { webhooks } from '../routes/webhooks.js';
import {
  verifyStripeSignature,
  checkWebhookIdempotency,
  storeWebhookEvent,
  markWebhookProcessed,
  resetWebhookForRetry,
} from '../services/webhook.js';
import * as billingService from '../services/billing.js';
import * as auditService from '../services/audit.js';
import { tryEmitEvent } from '../services/emit_event.js';

const mockEmit = tryEmitEvent as jest.MockedFunction<typeof tryEmitEvent>;

/**
 * Integration tests for the POST /webhooks/stripe route.
 * All external services are mocked; tests verify the route's
 * orchestration logic (verify -> idempotency -> store -> process -> mark).
 */

const mockVerify = verifyStripeSignature as jest.MockedFunction<typeof verifyStripeSignature>;
const mockIdempotency = checkWebhookIdempotency as jest.MockedFunction<
  typeof checkWebhookIdempotency
>;
const mockStore = storeWebhookEvent as jest.MockedFunction<typeof storeWebhookEvent>;
const mockMark = markWebhookProcessed as jest.MockedFunction<typeof markWebhookProcessed>;
const mockReset = resetWebhookForRetry as jest.MockedFunction<typeof resetWebhookForRetry>;
const mockCheckoutCompleted = billingService.handleCheckoutCompleted as jest.MockedFunction<
  typeof billingService.handleCheckoutCompleted
>;
const mockSubscriptionUpdated = billingService.handleSubscriptionUpdated as jest.MockedFunction<
  typeof billingService.handleSubscriptionUpdated
>;
const mockSubscriptionDeleted = billingService.handleSubscriptionDeleted as jest.MockedFunction<
  typeof billingService.handleSubscriptionDeleted
>;
const mockPaymentFailed = billingService.handlePaymentFailed as jest.MockedFunction<
  typeof billingService.handlePaymentFailed
>;
const mockAuditLog = auditService.writeAuditLog as jest.MockedFunction<
  typeof auditService.writeAuditLog
>;

const mockDb = {} as D1Database;

const mockEnv = {
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  DB: mockDb,
};

const createApp = () => {
  const app = new Hono<{ Bindings: any; Variables: any }>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req-id');
    await next();
  });
  app.route('/', webhooks);
  return app;
};

/**
 * Helper to build a Stripe event object.
 */
function makeStripeEvent(
  type: string,
  object: Record<string, unknown> = {},
  eventId = 'evt_test_123',
) {
  return {
    id: eventId,
    type,
    data: { object },
  };
}

/**
 * Helper to send a POST to /webhooks/stripe.
 */
function postWebhook(app: ReturnType<typeof createApp>, event: object) {
  return app.request(
    '/webhooks/stripe',
    {
      method: 'POST',
      body: JSON.stringify(event),
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': 'test-sig',
      },
    },
    mockEnv,
  );
}

/**
 * Sets up the default mock chain so the route proceeds past
 * verification, idempotency, and storage.
 */
function setupDefaultMocks() {
  mockVerify.mockResolvedValue({ valid: true });
  mockIdempotency.mockResolvedValue({ isDuplicate: false });
  mockStore.mockResolvedValue({ id: 'wh-evt-001', error: null });
  mockMark.mockResolvedValue(undefined);
  mockReset.mockResolvedValue({ error: null });
  mockAuditLog.mockResolvedValue(undefined);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  setupDefaultMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── Signature verification ────────────────────────────────────

describe('POST /webhooks/stripe - signature verification', () => {
  it('returns 401 when signature verification fails', async () => {
    mockVerify.mockResolvedValue({ valid: false, reason: 'Signature mismatch' });
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed');
    const res = await postWebhook(app, event);

    expect(res.status).toBe(401);
  });

  it('response body includes WEBHOOK_SIGNATURE_INVALID code', async () => {
    mockVerify.mockResolvedValue({ valid: false, reason: 'Signature mismatch' });
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed');
    const res = await postWebhook(app, event);
    const body = await res.json();

    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(body.error.message).toBe('Signature mismatch');
  });

  it('logs warning when signature fails', async () => {
    // AL-847: sig-fail now logs through the structured `whLog` (createLogger → console.warn sink,
    // service 'webhooks', reason in the `reason` field), not a freeform console.error.
    const consoleSpy = jest.spyOn(console, 'warn');
    mockVerify.mockResolvedValue({ valid: false, reason: 'Timestamp expired' });
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed');
    await postWebhook(app, event);

    const logCall = consoleSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.level === 'warn' && parsed.service === 'webhooks';
      } catch {
        return false;
      }
    });
    expect(logCall).toBeDefined();
    const parsed = JSON.parse(logCall![0] as string);
    expect(parsed.msg).toContain('signature verification failed');
    expect(parsed.reason).toContain('Timestamp expired');
  });
});

// ─── Idempotency ───────────────────────────────────────────────

describe('POST /webhooks/stripe - idempotency', () => {
  it('returns 200 with duplicate:true for duplicate events', async () => {
    mockIdempotency.mockResolvedValue({ isDuplicate: true, existingId: 'existing-id' });
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed');
    const res = await postWebhook(app, event);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.duplicate).toBe(true);
    expect(body.received).toBe(true);
  });

  it('does NOT process duplicate events', async () => {
    mockIdempotency.mockResolvedValue({ isDuplicate: true, existingId: 'existing-id' });
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      customer: 'cus_test',
      subscription: 'sub_test',
      metadata: { org_id: 'org-1' },
    });
    await postWebhook(app, event);

    expect(mockCheckoutCompleted).not.toHaveBeenCalled();
    expect(mockStore).not.toHaveBeenCalled();
  });

  it('does NOT process when storeWebhookEvent loses the UNIQUE(provider,event_id) race', async () => {
    // The double-spend guard. Two concurrent deliveries of the SAME event both pass the
    // SELECT idempotency check (no row yet), then both INSERT — the loser hits
    // UNIQUE(provider,event_id). dbInsert RETURNS {error} (never throws), so
    // storeWebhookEvent returns {id:null,error}. The handler MUST treat that as a
    // duplicate and NOT process — otherwise the losing delivery also credits the
    // wallet / activates billing (double-spend). Regression for the swallowed-error bug.
    mockIdempotency.mockResolvedValue({ isDuplicate: false });
    mockStore.mockResolvedValue({
      id: null,
      error: 'D1_ERROR: UNIQUE constraint failed: webhook_events.provider, webhook_events.event_id',
    });
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      customer: 'cus_test',
      subscription: 'sub_test',
      metadata: { org_id: 'org-1' },
    });
    const res = await postWebhook(app, event);
    const body = await res.json();

    expect(res.status).toBe(200); // ack so Stripe stops retrying THIS (losing) delivery
    expect(body.duplicate).toBe(true);
    expect(mockCheckoutCompleted).not.toHaveBeenCalled();
  });

  it('returns 500 (Stripe retries) when storeWebhookEvent fails for a NON-uniqueness reason', async () => {
    // A transient store failure must NOT be swallowed as a duplicate — that would DROP
    // the event (Stripe stops retrying → charged-but-not-provisioned). It must 500 so
    // Stripe redelivers; still MUST NOT process on this failed-store delivery.
    mockIdempotency.mockResolvedValue({ isDuplicate: false });
    mockStore.mockResolvedValue({ id: null, error: 'D1_ERROR: database is locked' });
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      customer: 'cus_test',
      subscription: 'sub_test',
      metadata: { org_id: 'org-1' },
    });
    const res = await postWebhook(app, event);

    expect(res.status).toBe(500);
    expect(mockCheckoutCompleted).not.toHaveBeenCalled();
  });
});

// ─── Event processing ──────────────────────────────────────────

describe('POST /webhooks/stripe - event processing', () => {
  it('checkout.session.completed calls handleCheckoutCompleted', async () => {
    mockCheckoutCompleted.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      customer: 'cus_test',
      subscription: 'sub_test',
      metadata: { org_id: 'org-1', site_id: 'site-1' },
    });
    const res = await postWebhook(app, event);

    expect(res.status).toBe(200);
    expect(mockCheckoutCompleted).toHaveBeenCalledTimes(1);
    expect(mockCheckoutCompleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        customer: 'cus_test',
        subscription: 'sub_test',
        metadata: { org_id: 'org-1', site_id: 'site-1' },
      }),
    );
  });

  it('customer.subscription.updated calls handleSubscriptionUpdated', async () => {
    mockSubscriptionUpdated.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_123',
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      metadata: { org_id: 'org-2' },
    });
    const res = await postWebhook(app, event);

    expect(res.status).toBe(200);
    expect(mockSubscriptionUpdated).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionUpdated).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'sub_123',
        status: 'active',
        metadata: { org_id: 'org-2' },
      }),
    );
    // active status → subscription.active on the durable bus (funnel "Converted").
    const active = mockEmit.mock.calls.find(
      (call) => (call[1] as { type?: string })?.type === 'subscription.active',
    );
    expect(active).toBeTruthy();
    expect((active![1] as { tenantId: string }).tenantId).toBe('org-2');
  });

  it('customer.subscription.updated with status past_due emits subscription.past_due (dunning/churn telemetry)', async () => {
    mockSubscriptionUpdated.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_pd',
      status: 'past_due',
      metadata: { org_id: 'org-5' },
    });
    const res = await postWebhook(app, event);
    expect(res.status).toBe(200);

    const pastDue = mockEmit.mock.calls.find(
      (call) => (call[1] as { type?: string })?.type === 'subscription.past_due',
    );
    expect(pastDue).toBeTruthy();
    expect((pastDue![1] as { tenantId: string }).tenantId).toBe('org-5');
  });

  it('checkout.session.completed emits subscription.active (the "Converted" funnel event) with org + amount', async () => {
    mockCheckoutCompleted.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      id: 'cs_test_1',
      mode: 'subscription',
      payment_status: 'paid',
      customer: 'cus_1',
      subscription: 'sub_1',
      amount_total: 5000,
      currency: 'usd',
      metadata: { org_id: 'org-conv' },
    });
    const res = await postWebhook(app, event);
    expect(res.status).toBe(200);

    const conv = mockEmit.mock.calls.find(
      (call) => (call[1] as { type?: string })?.type === 'subscription.active',
    );
    expect(conv).toBeTruthy();
    const evt = conv![1] as { tenantId: string; producer: string; data: Record<string, unknown> };
    expect(evt.tenantId).toBe('org-conv');
    expect(evt.producer).toBe('stripe');
    expect(evt.data).toMatchObject({ customer: 'cus_1', subscription: 'sub_1' });

    // Same handler emits entitlement.updated (plan free→paid) — the golden-path
    // "entitlement activated" signal the orchestration plane provisions against.
    const ent = mockEmit.mock.calls.find(
      (call) => (call[1] as { type?: string })?.type === 'entitlement.updated',
    );
    expect(ent).toBeTruthy();
    const entEvt = ent![1] as { tenantId: string; data: Record<string, unknown> };
    expect(entEvt.tenantId).toBe('org-conv');
    expect(entEvt.data).toMatchObject({ plan: 'paid', paid: true });
  });

  it('customer.subscription.deleted calls handleSubscriptionDeleted', async () => {
    mockSubscriptionDeleted.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('customer.subscription.deleted', {
      id: 'sub_del_456',
      metadata: { org_id: 'org-3' },
    });
    const res = await postWebhook(app, event);

    expect(res.status).toBe(200);
    expect(mockSubscriptionDeleted).toHaveBeenCalledTimes(1);
    expect(mockSubscriptionDeleted).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'sub_del_456',
        metadata: { org_id: 'org-3' },
      }),
    );
  });

  it('invoice.payment_failed calls handlePaymentFailed', async () => {
    mockPaymentFailed.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('invoice.payment_failed', {
      subscription: 'sub_fail_789',
      metadata: { org_id: 'org-4' },
    });
    const res = await postWebhook(app, event);

    expect(res.status).toBe(200);
    expect(mockPaymentFailed).toHaveBeenCalledTimes(1);
    expect(mockPaymentFailed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        subscription: 'sub_fail_789',
        metadata: { org_id: 'org-4' },
      }),
    );
  });

  it('invoice.paid is a no-op and returns 200', async () => {
    const app = createApp();
    const event = makeStripeEvent('invoice.paid', { id: 'inv_123' });
    const res = await postWebhook(app, event);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.received).toBe(true);
    expect(mockCheckoutCompleted).not.toHaveBeenCalled();
    expect(mockSubscriptionUpdated).not.toHaveBeenCalled();
    expect(mockSubscriptionDeleted).not.toHaveBeenCalled();
    expect(mockPaymentFailed).not.toHaveBeenCalled();
  });
});

// ─── Event marking ─────────────────────────────────────────────

describe('POST /webhooks/stripe - event marking', () => {
  it('marks event as processed on success', async () => {
    const app = createApp();
    const event = makeStripeEvent('invoice.paid', { id: 'inv_ok' });
    await postWebhook(app, event);

    expect(mockMark).toHaveBeenCalledWith(expect.anything(), 'wh-evt-001', 'processed');
  });

  it('marks event as failed on processing error', async () => {
    mockCheckoutCompleted.mockRejectedValue(new Error('DB write failed'));
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      customer: 'cus_test',
      subscription: 'sub_test',
      metadata: {},
    });
    await postWebhook(app, event);

    expect(mockMark).toHaveBeenCalledWith(
      expect.anything(),
      'wh-evt-001',
      'failed',
      'DB write failed',
    );
  });
});

// ─── Error handling ────────────────────────────────────────────

describe('POST /webhooks/stripe - error handling', () => {
  it('returns 500 on a TRANSIENT processing failure so Stripe redelivers (not a silent 200)', async () => {
    // Payment-critical: a transient failure must NOT be acked away — returning 200 here
    // permanently stranded paid-but-not-upgraded webhooks. 500 → Stripe's retry recovers.
    mockSubscriptionUpdated.mockRejectedValue(new Error('Unexpected failure'));
    const app = createApp();
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_err',
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      metadata: {},
    });
    const res = await postWebhook(app, event);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('WEBHOOK_PROCESSING_ERROR');
    // marked 'failed' (retry-eligible), NOT 'quarantined', on the first attempt
    expect(mockMark).toHaveBeenCalledWith(
      expect.anything(),
      'wh-evt-001',
      'failed',
      'Unexpected failure',
    );
  });

  it('QUARANTINES and acks 200 after MAX attempts (poison-pill guard — stop Stripe retrying forever)', async () => {
    // A prior FAILED row at attempt 4 → this delivery is attempt 5 (== MAX) → quarantine + 200.
    mockIdempotency.mockResolvedValue({
      isDuplicate: false,
      existingId: 'wh-evt-001',
      existingStatus: 'failed',
      existingAttempts: 4,
    });
    mockSubscriptionUpdated.mockRejectedValue(new Error('still broken'));
    const app = createApp();
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_poison',
      status: 'active',
      cancel_at_period_end: false,
      current_period_start: 1700000000,
      current_period_end: 1702592000,
      metadata: {},
    });
    const res = await postWebhook(app, event);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.received).toBe(true);
    expect(mockReset).toHaveBeenCalledWith(expect.anything(), 'wh-evt-001');
    expect(mockMark).toHaveBeenCalledWith(
      expect.anything(),
      'wh-evt-001',
      'quarantined',
      'still broken',
    );
  });

  it('REPROCESSES a previously-failed event on redelivery (does not skip it as a duplicate)', async () => {
    // The core recovery: idempotency reports the prior 'failed' row as retry-eligible →
    // the route resets that row (reusing it) and reprocesses → success.
    mockIdempotency.mockResolvedValue({
      isDuplicate: false,
      existingId: 'wh-evt-001',
      existingStatus: 'failed',
      existingAttempts: 1,
    });
    mockCheckoutCompleted.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      customer: 'cus_retry',
      subscription: 'sub_retry',
      metadata: { org_id: 'org-retry' },
    });
    const res = await postWebhook(app, event);

    expect(res.status).toBe(200);
    // reused the existing row (no fresh insert — webhook_events is UNIQUE per provider+event_id)
    expect(mockReset).toHaveBeenCalledWith(expect.anything(), 'wh-evt-001');
    expect(mockStore).not.toHaveBeenCalled();
    expect(mockCheckoutCompleted).toHaveBeenCalledTimes(1);
    expect(mockMark).toHaveBeenCalledWith(expect.anything(), 'wh-evt-001', 'processed');
  });

  it('writes audit log when org_id exists in metadata', async () => {
    mockCheckoutCompleted.mockResolvedValue(undefined);
    mockAuditLog.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      customer: 'cus_audit',
      subscription: 'sub_audit',
      metadata: { org_id: 'org-audit-1' },
    });
    await postWebhook(app, event);

    expect(mockAuditLog).toHaveBeenCalledTimes(1);
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        org_id: 'org-audit-1',
        action: 'webhook.stripe.checkout.session.completed',
        target_type: 'webhook',
        target_id: 'evt_test_123',
        request_id: 'test-req-id',
      }),
    );
  });

  it('does not write audit log when org_id is absent from metadata', async () => {
    mockCheckoutCompleted.mockResolvedValue(undefined);
    const app = createApp();
    const event = makeStripeEvent('checkout.session.completed', {
      customer: 'cus_no_org',
      subscription: 'sub_no_org',
      metadata: {},
    });
    await postWebhook(app, event);

    expect(mockAuditLog).not.toHaveBeenCalled();
  });
});

// ─── Unknown events ────────────────────────────────────────────

describe('POST /webhooks/stripe - unknown events', () => {
  it('unknown event type returns 200 (acknowledged)', async () => {
    const app = createApp();
    const event = makeStripeEvent('some.unknown.event', { id: 'obj_unknown' });
    const res = await postWebhook(app, event);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.received).toBe(true);
  });

  it('logs info message for unhandled event type', async () => {
    const consoleSpy = jest.spyOn(console, 'warn');
    const app = createApp();
    const event = makeStripeEvent('some.future.event', { id: 'obj_future' });
    await postWebhook(app, event);

    // AL-847: unhandled-type now logs through the structured `whLog` (msg + event_type field),
    // not a freeform console.warn whose message embedded the type.
    const logCall = consoleSpy.mock.calls.find((call) => {
      try {
        const parsed = JSON.parse(call[0] as string);
        return parsed.msg?.includes('unhandled stripe event type');
      } catch {
        return false;
      }
    });
    expect(logCall).toBeDefined();
    const parsed = JSON.parse(logCall![0] as string);
    expect(parsed.event_type).toContain('some.future.event');
  });
});
