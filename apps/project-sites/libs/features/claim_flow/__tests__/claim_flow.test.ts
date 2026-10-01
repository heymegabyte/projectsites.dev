/**
 * claim_flow — unit tests (fire-60, TDD-first).
 *
 * Covers the four briefed surfaces:
 *  1. Price lookup-or-create idempotency (KV cache → Stripe lookup → guarded create).
 *  2. Claim checkout handler ownership guard (assertSiteOwned IDOR class) + flag gate.
 *  3. Webhook claim-transition CONTRACT: the session carries the exact metadata keys
 *     (`org_id`, `site_id`) the existing `handleCheckoutCompleted` reads to mark the
 *     site claimed (`sites.plan='paid'`) — the transition itself is billing's tested code.
 *  4. Top-bar render branch: APP_JS ships the claim-pitch branch + the server-side
 *     attr builder escapes attribute values.
 */
import { Hono } from 'hono';

import type { Env, Variables } from '../../../../src/types/env.js';

jest.mock('../../../../src/services/db.js', () => ({
  dbQueryOne: jest.fn(),
}));
jest.mock('../../../../src/services/billing.js', () => ({
  getOrCreateStripeCustomer: jest.fn(),
}));
jest.mock('../../../../src/services/site_ownership.js', () => ({
  assertSiteOwned: jest.fn(),
}));
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../../../../src/services/audit.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../src/services/build_limits.js', () => ({
  resolveActiveOrgPlan: jest.fn(),
}));

import { dbQueryOne } from '../../../../src/services/db.js';
import { getOrCreateStripeCustomer } from '../../../../src/services/billing.js';
import { assertSiteOwned } from '../../../../src/services/site_ownership.js';
import { isFlagOn } from '../../../../src/modules/feature_flags/services.js';
import { resolveActiveOrgPlan } from '../../../../src/services/build_limits.js';

import {
  CLAIM_MONTHLY_CENTS,
  CLAIM_PRICE_LOOKUP_KEY,
  claimPitchScriptAttrs,
  createClaimCheckoutSession,
  getOrCreateClaimPrice,
  isSiteClaimed,
} from '../service.js';
import { claimFlowRoutes } from '../handlers.js';
import { manifest } from '../feature.manifest.js';
import { APP_JS } from '../../../../src/generated/app_js.js';

const mockDbQueryOne = dbQueryOne as jest.Mock;
const mockGetCustomer = getOrCreateStripeCustomer as jest.Mock;
const mockAssertOwned = assertSiteOwned as jest.Mock;
const mockIsFlagOn = isFlagOn as jest.Mock;
const mockResolvePlan = resolveActiveOrgPlan as jest.Mock;

/** Minimal env with a KV stub; CACHE_KV optional-chained in the service. */
function makeEnv(overrides: Record<string, unknown> = {}): Env {
  const kvStore = new Map<string, string>();
  return {
    DB: {} as D1Database,
    CACHE_KV: {
      get: jest.fn(async (k: string) => kvStore.get(k) ?? null),
      put: jest.fn(async (k: string, v: string) => {
        kvStore.set(k, v);
      }),
    },
    STRIPE_SECRET_KEY: 'sk_test_123',
    ...overrides,
  } as unknown as Env;
}

function fetchResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function buildApp(
  auth: { orgId?: string | null; userId?: string | null } = { orgId: 'org-1', userId: 'user-1' },
): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (auth.orgId) c.set('orgId', auth.orgId);
    if (auth.userId) c.set('userId', auth.userId);
    await next();
  });
  app.route('/', claimFlowRoutes);
  return app;
}

const realFetch = globalThis.fetch;

describe('claim_flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // ── 1. Price lookup-or-create idempotency ─────────────────────────────────

  describe('getOrCreateClaimPrice', () => {
    it('returns the KV-cached price id without calling Stripe', async () => {
      const env = makeEnv();
      await (env.CACHE_KV as KVNamespace).put('claim_flow:stripe_price_id', 'price_cached');
      const fetchSpy = jest.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const id = await getOrCreateClaimPrice(env);

      expect(id).toBe('price_cached');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('finds an existing price by lookup_key and caches it (idempotent on re-call)', async () => {
      const env = makeEnv();
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(fetchResponse(200, { data: [{ id: 'price_live_1' }] }));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const first = await getOrCreateClaimPrice(env);
      expect(first).toBe('price_live_1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = String(fetchSpy.mock.calls[0][0]);
      expect(url).toContain('/v1/prices');
      expect(url).toContain(CLAIM_PRICE_LOOKUP_KEY);

      // Second call: served from KV, no further Stripe traffic.
      const second = await getOrCreateClaimPrice(env);
      expect(second).toBe('price_live_1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('creates the price in TEST mode with a stable Idempotency-Key when lookup is empty', async () => {
      const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_abc' });
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(fetchResponse(200, { data: [] }))
        .mockResolvedValueOnce(fetchResponse(200, { id: 'price_new_test' }));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const id = await getOrCreateClaimPrice(env);

      expect(id).toBe('price_new_test');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const [createUrl, createInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(String(createUrl)).toContain('/v1/prices');
      const headers = createInit.headers as Record<string, string>;
      expect(headers['Idempotency-Key']).toBe(`claim-price:${CLAIM_PRICE_LOOKUP_KEY}`);
      const body = String(createInit.body);
      expect(body).toContain(`unit_amount=${CLAIM_MONTHLY_CENTS}`);
      expect(body).toContain('recurring%5Binterval%5D=month');
      expect(body).toContain(`lookup_key=${CLAIM_PRICE_LOOKUP_KEY}`);
    });

    it('NEVER creates in LIVE mode — returns null so checkout falls back to inline price_data', async () => {
      const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_live_real' });
      const fetchSpy = jest.fn().mockResolvedValueOnce(fetchResponse(200, { data: [] }));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const id = await getOrCreateClaimPrice(env);

      expect(id).toBeNull();
      // exactly ONE call (the read-only lookup) — no POST create in live mode
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fails soft (null) when Stripe is unreachable', async () => {
      const env = makeEnv();
      globalThis.fetch = jest
        .fn()
        .mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

      await expect(getOrCreateClaimPrice(env)).resolves.toBeNull();
    });
  });

  // ── 3. Checkout session → webhook claim-transition contract ──────────────

  describe('createClaimCheckoutSession', () => {
    it('carries metadata[org_id]+metadata[site_id]+kind=claim (the keys handleCheckoutCompleted reads) and falls back to inline $29 price_data when no price id', async () => {
      const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_live_x' });
      mockGetCustomer.mockResolvedValue({ stripe_customer_id: 'cus_9' });
      const fetchSpy = jest
        .fn()
        // price lookup (live mode, empty) → null → inline fallback
        .mockResolvedValueOnce(fetchResponse(200, { data: [] }))
        // checkout session create
        .mockResolvedValueOnce(
          fetchResponse(200, { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }),
        );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const result = await createClaimCheckoutSession(env.DB, env, {
        orgId: 'org-1',
        siteId: 'site-1',
        customerEmail: 'owner@biz.com',
        successUrl: 'https://projectsites.dev/ok',
        cancelUrl: 'https://projectsites.dev/no',
      });

      expect(result).toEqual({
        checkout_url: 'https://checkout.stripe.com/c/pay/cs_1',
        session_id: 'cs_1',
      });
      const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const body = String(init.body);
      expect(body).toContain('metadata%5Borg_id%5D=org-1');
      expect(body).toContain('metadata%5Bsite_id%5D=site-1');
      expect(body).toContain('metadata%5Bkind%5D=claim');
      expect(body).toContain('mode=subscription');
      expect(body).toContain(`unit_amount%5D=${CLAIM_MONTHLY_CENTS}`);
    });

    it('uses the resolved price id when one exists', async () => {
      const env = makeEnv();
      await (env.CACHE_KV as KVNamespace).put('claim_flow:stripe_price_id', 'price_ok');
      mockGetCustomer.mockResolvedValue({ stripe_customer_id: 'cus_9' });
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(fetchResponse(200, { id: 'cs_2', url: 'https://cs/2' }));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await createClaimCheckoutSession(env.DB, env, {
        orgId: 'org-1',
        siteId: 'site-1',
        customerEmail: 'o@b.c',
        successUrl: 'https://s',
        cancelUrl: 'https://c',
      });

      const body = String((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body);
      expect(body).toContain('line_items%5B0%5D%5Bprice%5D=price_ok');
      expect(body).not.toContain('price_data');
    });
  });

  // ── isSiteClaimed (entitlement seam) ──────────────────────────────────────

  describe('isSiteClaimed', () => {
    it('true when the site row is plan=paid', async () => {
      mockDbQueryOne.mockResolvedValue({ plan: 'paid', org_id: 'org-1' });
      await expect(isSiteClaimed(makeEnv(), 'site-1')).resolves.toBe(true);
      expect(mockResolvePlan).not.toHaveBeenCalled();
    });

    it('true when the owning org has an active/trialing paid plan (SSOT resolver)', async () => {
      mockDbQueryOne.mockResolvedValue({ plan: 'free', org_id: 'org-1' });
      mockResolvePlan.mockResolvedValue('paid');
      await expect(isSiteClaimed(makeEnv(), 'site-1')).resolves.toBe(true);
      expect(mockResolvePlan).toHaveBeenCalledWith(expect.anything(), 'org-1');
    });

    it('false for an unclaimed site on a free org', async () => {
      mockDbQueryOne.mockResolvedValue({ plan: 'free', org_id: 'org-1' });
      mockResolvePlan.mockResolvedValue(null);
      await expect(isSiteClaimed(makeEnv(), 'site-1')).resolves.toBe(false);
    });
  });

  // ── 2. Handler guards ─────────────────────────────────────────────────────

  describe('POST /api/sites/:siteId/claim/checkout', () => {
    const post = (
      app: Hono<{ Bindings: Env; Variables: Variables }>,
      env: Env,
      body: unknown = {},
    ): Promise<Response> =>
      app.request(
        '/api/sites/site-1/claim/checkout',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env,
      );

    it('404s dark when the claim_flow flag is OFF', async () => {
      mockIsFlagOn.mockResolvedValue(false);
      const res = await post(buildApp(), makeEnv());
      expect(res.status).toBe(404);
    });

    it('401s an anonymous caller when the flag is ON', async () => {
      mockIsFlagOn.mockResolvedValue(true);
      const res = await post(buildApp({ orgId: null, userId: null }), makeEnv());
      expect(res.status).toBe(401);
    });

    it('404s (never 403) a foreign site — assertSiteOwned IDOR guard', async () => {
      mockIsFlagOn.mockResolvedValue(true);
      mockAssertOwned.mockResolvedValue(false);
      const res = await post(buildApp(), makeEnv());
      expect(res.status).toBe(404);
      expect(mockAssertOwned).toHaveBeenCalledWith(expect.anything(), 'org-1', 'site-1');
    });

    it('409s an already-claimed site', async () => {
      mockIsFlagOn.mockResolvedValue(true);
      mockAssertOwned.mockResolvedValue(true);
      mockDbQueryOne.mockResolvedValue({ plan: 'paid', email: null });
      const res = await post(buildApp(), makeEnv());
      expect(res.status).toBe(409);
    });

    it('returns {data:{checkout_url,session_id}} on the happy path', async () => {
      mockIsFlagOn.mockResolvedValue(true);
      mockAssertOwned.mockResolvedValue(true);
      // 1st dbQueryOne: site plan row; 2nd: user email row
      mockDbQueryOne
        .mockResolvedValueOnce({ plan: 'free' })
        .mockResolvedValueOnce({ email: 'owner@biz.com' });
      mockGetCustomer.mockResolvedValue({ stripe_customer_id: 'cus_1' });
      const env = makeEnv();
      await (env.CACHE_KV as KVNamespace).put('claim_flow:stripe_price_id', 'price_ok');
      globalThis.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          fetchResponse(200, { id: 'cs_h', url: 'https://checkout.stripe.com/c/pay/cs_h' }),
        ) as unknown as typeof fetch;

      const res = await post(buildApp(), env);

      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { checkout_url: string; session_id: string };
      };
      expect(json.data.checkout_url).toBe('https://checkout.stripe.com/c/pay/cs_h');
      expect(json.data.session_id).toBe('cs_h');
    });

    it('400s an invalid body (bad success_url)', async () => {
      mockIsFlagOn.mockResolvedValue(true);
      mockAssertOwned.mockResolvedValue(true);
      mockDbQueryOne.mockResolvedValueOnce({ plan: 'free' });
      const res = await post(buildApp(), makeEnv(), { success_url: 'not-a-url' });
      expect(res.status).toBe(400);
    });
  });

  // ── 4. Top-bar render branch ──────────────────────────────────────────────

  describe('top-bar claim pitch', () => {
    it('claimPitchScriptAttrs emits escaped data attributes', () => {
      const attrs = claimPitchScriptAttrs('Vito\'s "Salon" <LLC> & Co');
      expect(attrs).toContain('data-claim="1"');
      expect(attrs).toContain('data-business=');
      expect(attrs).not.toMatch(/data-business="[^"]*[<>]/);
      expect(attrs).toContain('&quot;');
      expect(attrs).toContain('&amp;');
    });

    it('claimPitchScriptAttrs truncates absurdly long names', () => {
      const attrs = claimPitchScriptAttrs('x'.repeat(500));
      expect(attrs.length).toBeLessThan(300);
    });

    it('APP_JS ships the claim-pitch branch (data-claim gate + $29/mo copy)', () => {
      expect(APP_JS).toContain("attr('data-claim'");
      expect(APP_JS).toContain("attr('data-business'");
      expect(APP_JS).toContain('$29/mo');
      expect(APP_JS).toContain('This site was built for');
      // The flag-off fallback copy must survive untouched.
      expect(APP_JS).toContain('This website is yours');
      expect(APP_JS).toContain('Register Now');
    });

    it('APP_JS is still syntactically valid JS after the claim-branch edit', () => {
      // A template-literal slip would ship a parse error to EVERY served site.
      expect(() => new Function(APP_JS)).not.toThrow();
    });
  });

  // ── Manifest sanity (drift gate alignment) ────────────────────────────────

  it('manifest binds slug/flag claim_flow and declares the route', () => {
    expect(manifest.slug).toBe('claim_flow');
    expect(manifest.flagKey).toBe('claim_flow');
    expect(manifest.apiPaths).toContain('/api/sites/:siteId/claim/checkout');
  });
});
