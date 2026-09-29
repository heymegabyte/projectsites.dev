/**
 * B0 killswitch + A0 token-shape coverage for `routes/voice.ts`.
 *
 * B0 — the Twilio phone-number PURCHASE handler (`POST /api/voice/numbers/purchase`)
 * spends real carrier money, so it MUST be gated behind the `voice_numbers` feature
 * flag. Flag OFF (its default) → 404 (never 403 — don't leak existence) and, crucially,
 * NO carrier purchase fires (fail-safe: off = no money spent). Flag ON → the handler
 * proceeds to its normal auth/membership/cap/Twilio path.
 *
 * A0 — `POST /api/voice/test/call-token` must return the token UNDER `data`
 * (`{ data: { token, identity, ... } }`) because the Test Console frontend reads
 * `res.data.token`. A top-level `{ token }` left `res.data.token` undefined → the
 * Twilio Device booted with `undefined` and every test call failed.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';

// The money-loss side effect — mock so a leaked carrier buy is observable, and so
// `isTwilioConfigured` passes (the flag gate must 404 BEFORE this 501 anyway).
const mockPurchaseNumber = jest.fn().mockResolvedValue({
  sid: 'PN_test',
  phone_number: '+15551230001',
  friendly_name: '+15551230001',
  capabilities: { voice: true, sms: true },
});
jest.mock('../services/twilio.js', () => ({
  __esModule: true,
  isTwilioConfigured: () => true,
  purchaseNumber: (...args: unknown[]) => mockPurchaseNumber(...args),
  searchAvailableNumbers: jest.fn(),
  releaseNumber: jest.fn(),
  formatVanity: (n: string) => n,
  letterToDigit: (l: string) => l,
}));

// Feature-flag engine — flipped per test.
const mockIsFlagOn = jest.fn();
jest.mock('../modules/feature_flags/services.js', () => ({
  __esModule: true,
  isFlagOn: (...args: unknown[]) => mockIsFlagOn(...args),
}));

// eslint-disable-next-line import/first
import { voiceRoutes } from '../routes/voice.js';

// dbQueryOne/dbQuery both read from `.all().results`, so `all()` returns the owned
// site row: it satisfies requireSiteMembership (results[0] = the org-1 site) AND
// keeps the 3-numbers-per-site cap under the limit (results.length === 1 < 3).
const SITE_ROW = {
  id: 'site-1',
  org_id: 'org-1',
  business_name: 'Test Biz',
  business_address: '1 Main St',
};
const mockDb = {
  prepare: jest.fn(() => ({
    bind: jest.fn(() => ({
      first: jest.fn().mockResolvedValue(SITE_ROW),
      all: jest.fn().mockResolvedValue({ results: [SITE_ROW] }),
      run: jest.fn().mockResolvedValue({}),
    })),
  })),
} as unknown as D1Database;

function makeEnv(): Env {
  return {
    ENVIRONMENT: 'test',
    DB: mockDb,
    TWILIO_ACCOUNT_SID: 'AC_test',
    TWILIO_AUTH_TOKEN: 'tok_test',
    TWILIO_API_KEY: 'SK_test',
    TWILIO_API_SECRET: 'secret_test',
    TWILIO_TWIML_APP_SID: 'AP_test',
  } as unknown as Env;
}

function buildApp() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('orgId', 'org-1');
    c.set('userId', 'user-1');
    c.set('requestId', 'req-1');
    await next();
  });
  app.route('/', voiceRoutes);
  return app;
}

function purchaseReq(app: ReturnType<typeof buildApp>) {
  return app.request(
    '/api/voice/numbers/purchase',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId: 'site-1', phoneNumber: '+15551230001' }),
    },
    makeEnv(),
  );
}

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockPurchaseNumber.mockClear();
  mockIsFlagOn.mockReset();
});
afterEach(() => jest.restoreAllMocks());

describe('B0 — voice_numbers killswitch gates the carrier purchase', () => {
  it('404s the purchase endpoint when voice_numbers is OFF and fires NO carrier buy', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await purchaseReq(buildApp());
    expect(res.status).toBe(404); // never 403 — don't leak existence
    expect(mockPurchaseNumber).not.toHaveBeenCalled(); // fail-safe: OFF = no money spent
  });

  it('does NOT 404 (proceeds past the flag gate) when voice_numbers is ON', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await purchaseReq(buildApp());
    expect(res.status).not.toBe(404);
    expect(res.status).toBeLessThan(500);
  });
});

describe('A0 — call-token response is nested under data', () => {
  it('returns { data: { token } } so the Test Console res.data.token resolves', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    const res = await buildApp().request(
      '/api/voice/test/call-token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: 'site-1' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data?: { token?: string; identity?: string } };
    expect(json.data).toBeDefined();
    expect(typeof json.data?.token).toBe('string');
    expect(json.data?.token?.length).toBeGreaterThan(0);
    expect(json.data?.identity).toContain('user-');
  });
});
