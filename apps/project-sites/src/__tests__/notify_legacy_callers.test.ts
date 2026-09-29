/**
 * Money-path regression (fire-54, follow-on to fire-52 / site_generation_build_notify) —
 * the REMAINING owner-bell callers must emit the CANONICAL psnotify event shape
 * (`{ name, subscriberId, payload }`, per `services/psnotify.ts` PsnotifyEventSchema).
 *
 * The gap this guards: after fire-52 converted the site-generation workflow's
 * `build.*` notifies, five callers STILL passed the legacy novu-era
 * `{ event, tenantId, … }` object, which FAILS `PsnotifyEventSchema.safeParse` →
 * `notifyEvent`/`notifyOwnerEvent` return `invalid_event` and the bell silently
 * never fires:
 *
 *   1. routes/webhooks.ts  checkout.session.completed → `payment.succeeded`
 *   2. routes/webhooks.ts  invoice.payment_failed     → `payment.failed`
 *   3. routes/ai_admin.ts  POST /api/team/invites     → `member.invited`
 *   4. routes/ai_admin.ts  POST /api/team/invites/accept → `member.joined`
 *   5. libs/features/hostnames POST /api/admin/domains/:id/verify → `domain.active`
 *
 * These specs drive the REAL route handlers (Hono apps, service boundaries mocked)
 * and assert the exact args reaching the notify layer: canonical `name` +
 * `subscriberId` + owner-friendly `payload.subject`/`body`, and NO legacy
 * `event`/`tenantId` keys. Mock-only arg assertions were exactly how the legacy
 * shape survived before — so each spec pins the canonical contract keys explicitly.
 *
 * @swc/jest hoists jest.mock only when it sees the GLOBAL `jest` — do NOT import it
 * from @jest/globals (project CLAUDE.md gotcha #12).
 */
jest.mock('../services/notify.js', () => {
  const actual = jest.requireActual('../services/notify.js');
  return {
    __esModule: true,
    ...actual,
    notifyOwnerEvent: jest.fn(async () => ({ ok: true, detail: 'do-notif-1' })),
    notifyEvent: jest.fn(async () => ({ ok: true, detail: 'do-notif-1' })),
  };
});
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
  getOrgEntitlements: jest.fn(async () => ({ maxTeamSeats: 10 })),
}));
jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/emit_event.js', () => ({
  tryEmitEvent: jest.fn(async () => ({ inserted: true })),
}));
jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(async () => ({ data: [], error: null })),
  dbQueryOne: jest.fn(async () => null),
  dbInsert: jest.fn(async () => ({ error: null })),
  dbUpdate: jest.fn(async () => ({ error: null, changes: 1 })),
  dbExecute: jest.fn(async () => ({ error: null, changes: 1 })),
}));
jest.mock('../services/team_seats.js', () => ({
  resolveSeatLimit: jest.fn(() => 10),
  countSeatUsage: jest.fn(async () => ({ members: 1, invites: 0, total: 1 })),
  canInviteMember: jest.fn(() => ({ allowed: true })),
  transferOwnership: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/domains.js', () => ({
  checkHostnameStatus: jest.fn(),
}));
jest.mock('../services/notifications.js', () => ({
  notifyDomainVerified: jest.fn(async () => undefined),
  notifySiteBuilt: jest.fn(async () => undefined),
}));
jest.mock('@project-sites/shared', () => {
  const actual = jest.requireActual('@project-sites/shared');
  return { ...actual, sha256Hex: jest.fn().mockResolvedValue('mockhash') };
});

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { webhooks } from '../routes/webhooks.js';
import { aiAdmin } from '../routes/ai_admin.js';
import { hostnames } from '../../libs/features/hostnames/handlers.js';
import { notifyOwnerEvent, notifyEvent } from '../services/notify.js';
import {
  verifyStripeSignature,
  checkWebhookIdempotency,
  storeWebhookEvent,
  markWebhookProcessed,
} from '../services/webhook.js';
import { dbQueryOne } from '../services/db.js';
import { checkHostnameStatus } from '../services/domains.js';

const mockNotifyOwnerEvent = notifyOwnerEvent as unknown as jest.Mock;
const mockNotifyEvent = notifyEvent as unknown as jest.Mock;
const mockVerify = verifyStripeSignature as unknown as jest.Mock;
const mockIdempotency = checkWebhookIdempotency as unknown as jest.Mock;
const mockStore = storeWebhookEvent as unknown as jest.Mock;
const mockMark = markWebhookProcessed as unknown as jest.Mock;
const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockCfStatus = checkHostnameStatus as unknown as jest.Mock;

/** The canonical `input` arg shape `notifyOwnerEvent(env, db, input)` receives. */
interface OwnerEventArgs {
  orgId: string;
  workflowId?: string;
  actionUrl?: string;
  event: { name?: string; subscriberId?: string; payload?: Record<string, unknown> } & Record<
    string,
    unknown
  >;
}

/** Let the fire-and-forget async IIFE / waitUntil promise settle before asserting. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const makeCtx = () =>
  ({ waitUntil: () => {}, passThroughOnException: () => {} }) as unknown as ExecutionContext;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockNotifyOwnerEvent.mockResolvedValue({ ok: true, detail: 'do-notif-1' });
  mockNotifyEvent.mockResolvedValue({ ok: true, detail: 'do-notif-1' });
});
afterEach(() => jest.restoreAllMocks());

// ─── 1+2. Stripe webhooks → payment.succeeded / payment.failed ──────────────

describe('stripe webhook owner-bell emits the CANONICAL psnotify shape', () => {
  const webhookApp = () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('requestId', 'req-1');
      await next();
    });
    app.route('/', webhooks);
    return app;
  };

  const post = (event: object) =>
    webhookApp().request(
      '/webhooks/stripe',
      {
        method: 'POST',
        body: JSON.stringify(event),
        headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test-sig' },
      },
      { STRIPE_WEBHOOK_SECRET: 'whsec_test', DB: {} } as unknown as Env,
      makeCtx(),
    );

  beforeEach(() => {
    mockVerify.mockResolvedValue({ valid: true });
    mockIdempotency.mockResolvedValue({ isDuplicate: false });
    mockStore.mockResolvedValue({ id: 'wh-evt-001', error: null });
    mockMark.mockResolvedValue(undefined);
  });

  it('checkout.session.completed → payment.succeeded with amount in the owner copy', async () => {
    const res = await post({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          amount_total: 4900,
          currency: 'usd',
          metadata: { org_id: 'org-1' },
        },
      },
    });
    expect(res.status).toBe(200);
    await flush();

    expect(mockNotifyOwnerEvent).toHaveBeenCalledTimes(1);
    const args = mockNotifyOwnerEvent.mock.calls[0][2] as OwnerEventArgs;
    expect(args.orgId).toBe('org-1');
    // CANONICAL shape — the legacy `{event, tenantId}` novu keys FAIL PsnotifyEventSchema.
    expect(args.event.name).toBe('payment.succeeded');
    expect(args.event.subscriberId).toBe('org-1');
    expect(args.event.event).toBeUndefined();
    expect(args.event.tenantId).toBeUndefined();
    const payload = args.event.payload ?? {};
    expect(payload.amountCents).toBe(4900);
    expect(payload.currency).toBe('usd');
    expect(String(payload.subject)).toMatch(/payment|plan/i);
    expect(String(payload.body)).toContain('49.00');
  });

  it('invoice.payment_failed → payment.failed deep-linking the billing page', async () => {
    const res = await post({
      id: 'evt_2',
      type: 'invoice.payment_failed',
      data: {
        object: {
          id: 'in_1',
          subscription: 'sub_1',
          amount_due: 2500,
          currency: 'usd',
          metadata: { org_id: 'org-1' },
        },
      },
    });
    expect(res.status).toBe(200);
    await flush();

    expect(mockNotifyOwnerEvent).toHaveBeenCalledTimes(1);
    const args = mockNotifyOwnerEvent.mock.calls[0][2] as OwnerEventArgs;
    expect(args.orgId).toBe('org-1');
    expect(args.event.name).toBe('payment.failed');
    expect(args.event.subscriberId).toBe('org-1');
    expect(args.event.event).toBeUndefined();
    expect(args.event.tenantId).toBeUndefined();
    const payload = args.event.payload ?? {};
    expect(payload.amountCents).toBe(2500);
    expect(payload.currency).toBe('usd');
    expect(String(payload.subject)).toMatch(/fail|action/i);
    expect(String(payload.body)).toContain('25.00');
    // The bell row must deep-link the fix (billing) — action_url in the payload.
    expect(String(payload.action_url)).toContain('/admin/billing');
  });
});

// ─── 3+4. ai_admin team routes → member.invited / member.joined ─────────────

describe('team invite/accept owner-bell emits the CANONICAL psnotify shape', () => {
  type Row = Record<string, unknown>;
  /** SQL-substring-routed D1 stub (same pattern as ai_admin_routes.test.ts). */
  function makeDb(rules: Array<{ match: string; resp: { first?: Row | null } }>) {
    const prepare = jest.fn((sql: string) => {
      const rule = rules.find((r) => sql.includes(r.match));
      const chain = {
        bind: jest.fn(() => chain),
        first: jest.fn(async () => (rule?.resp.first === undefined ? null : rule.resp.first)),
        all: jest.fn(async () => ({ results: [] })),
        run: jest.fn(async () => ({ success: true })),
      };
      return chain;
    });
    return { prepare, batch: jest.fn(async () => []) } as unknown as D1Database;
  }

  const adminApp = () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      c.set('orgId', 'org-1');
      c.set('requestId', 'req-1');
      await next();
    });
    app.route('/', aiAdmin);
    return app;
  };

  const post = (path: string, env: Env, body: unknown) =>
    adminApp().request(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
      makeCtx(),
    );

  it('POST /api/team/invites → member.invited naming the invitee', async () => {
    const env = { ENVIRONMENT: 'test', DB: makeDb([]) } as unknown as Env;
    const res = await post('/api/team/invites', env, { email: 'alice@x.com', role: 'viewer' });
    expect(res.status).toBe(201);
    await flush();

    expect(mockNotifyOwnerEvent).toHaveBeenCalledTimes(1);
    const args = mockNotifyOwnerEvent.mock.calls[0][2] as OwnerEventArgs;
    expect(args.orgId).toBe('org-1');
    expect(args.event.name).toBe('member.invited');
    expect(args.event.subscriberId).toBe('org-1');
    expect(args.event.event).toBeUndefined();
    expect(args.event.tenantId).toBeUndefined();
    const payload = args.event.payload ?? {};
    expect(payload.email).toBe('alice@x.com');
    expect(payload.role).toBe('viewer');
    expect(String(payload.subject).length).toBeGreaterThan(0);
    expect(String(payload.body)).toContain('alice@x.com');
  });

  it('POST /api/team/invites/accept → member.joined naming who joined', async () => {
    const env = {
      ENVIRONMENT: 'test',
      DB: makeDb([
        {
          match: 'FROM team_invites',
          resp: {
            first: {
              id: 'inv1',
              org_id: 'org-2',
              email: 'invitee@y.z',
              role: 'viewer',
              expires_at: new Date(Date.now() + 86400_000).toISOString(),
            },
          },
        },
        {
          match: 'SELECT email FROM users WHERE id = ?',
          resp: { first: { email: 'invitee@y.z' } },
        },
      ]),
    } as unknown as Env;
    const res = await post('/api/team/invites/accept', env, { token: 'tok-abc' });
    expect(res.status).toBe(200);
    await flush();

    expect(mockNotifyOwnerEvent).toHaveBeenCalledTimes(1);
    const args = mockNotifyOwnerEvent.mock.calls[0][2] as OwnerEventArgs;
    expect(args.orgId).toBe('org-2');
    expect(args.event.name).toBe('member.joined');
    expect(args.event.subscriberId).toBe('org-2');
    expect(args.event.event).toBeUndefined();
    expect(args.event.tenantId).toBeUndefined();
    const payload = args.event.payload ?? {};
    expect(payload.role).toBe('viewer');
    expect(payload.userId).toBe('user-1');
    expect(String(payload.subject).length).toBeGreaterThan(0);
    expect(String(payload.body)).toContain('invitee@y.z');
  });
});

// ─── 5. hostnames verify → domain.active ────────────────────────────────────

describe('domain verify owner-bell emits the CANONICAL psnotify shape', () => {
  const hostApp = () => {
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('userId', 'user-1');
      c.set('orgId', 'org-1');
      c.set('requestId', 'req-1');
      await next();
    });
    app.route('/', hostnames);
    return app;
  };

  it('POST /api/admin/domains/:id/verify (pending→active) → domain.active with the live URL', async () => {
    mockDbQueryOne.mockImplementation(async (_db: unknown, sql: string) => {
      if (sql.includes('FROM hostnames WHERE id = ?')) {
        return {
          id: 'h1',
          hostname: 'shop.example.com',
          cf_custom_hostname_id: 'cfh_1',
          org_id: 'org-1',
          site_id: 'site-1',
          status: 'pending',
        };
      }
      if (sql.includes('SELECT u.email')) return { email: 'owner@shop.com' };
      if (sql.includes('FROM sites WHERE id = ?')) return { slug: 'acme', business_name: 'Acme' };
      if (sql.includes('FROM hostnames WHERE site_id = ?')) return { hostname: 'shop.example.com' };
      return null;
    });
    mockCfStatus.mockResolvedValue({ status: 'active', ssl_status: 'active', verification_errors: [] });

    const res = await hostApp().request(
      '/api/admin/domains/h1/verify',
      { method: 'POST' },
      { ENVIRONMENT: 'test', DB: {} } as unknown as Env,
      makeCtx(),
    );
    expect(res.status).toBe(200);
    await flush();

    expect(mockNotifyEvent).toHaveBeenCalledTimes(1);
    // notifyEvent(env, input) — input is arg[1].
    const args = mockNotifyEvent.mock.calls[0][1] as {
      subscriberId: string;
      workflowId?: string;
      actionUrl?: string;
      event: { name?: string; subscriberId?: string; payload?: Record<string, unknown> } & Record<
        string,
        unknown
      >;
    };
    // The bell subscriber is the OWNER email (matches the bell's subscriberId).
    expect(args.subscriberId).toBe('owner@shop.com');
    expect(args.event.name).toBe('domain.active');
    expect(args.event.subscriberId).toBe('owner@shop.com');
    expect(args.event.event).toBeUndefined();
    expect(args.event.tenantId).toBeUndefined();
    const payload = args.event.payload ?? {};
    expect(payload.hostname).toBe('shop.example.com');
    expect(String(payload.subject)).toContain('shop.example.com');
    // One click opens the newly-live domain.
    expect(payload.action_url).toBe('https://shop.example.com');
  });
});
