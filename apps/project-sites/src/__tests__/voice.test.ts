/**
 * @module __tests__/voice
 * @description Route-layer tests for the AI Voice + SMS module. Focus: every
 * resource-ownership-by-id gate now returns **404 (never 403)** for a
 * site/number/call/recording the caller's org doesn't own — and a foreign-org
 * resource is indistinguishable from a missing one (existence oracle closed).
 * Previously `requireSiteMembership` + the number/call gates split into 404
 * (missing) vs 403 (foreign), leaking that the id was real.
 *
 * Twilio/audit/agent services are mocked so these exercise the ownership
 * plumbing, not the integrations.
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
}));

jest.mock('../services/twilio.js', () => ({
  isTwilioConfigured: jest.fn().mockReturnValue(true),
  searchAvailableNumbers: jest.fn().mockResolvedValue([]),
  purchaseNumber: jest.fn(),
  releaseNumber: jest.fn().mockResolvedValue(undefined),
  formatVanity: jest.fn().mockReturnValue(null),
  letterToDigit: jest.fn().mockReturnValue(''),
}));

jest.mock('../services/vanity_generator.js', () => ({ suggestVanityWords: jest.fn() }));
jest.mock('../services/sms_agent.js', () => ({ simulateInbound: jest.fn() }));
jest.mock('../services/audit.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));
// The purchase handler is now gated behind the `voice_numbers` killswitch
// (default OFF). Force it ON here so these tests exercise the ownership/cap/
// orphan-compensation plumbing; the flag-OFF 404 is covered in
// voice_numbers_flag.test.ts.
jest.mock('../modules/feature_flags/services.js', () => ({
  __esModule: true,
  isFlagOn: jest.fn().mockResolvedValue(true),
}));

import { Hono } from 'hono';
import { dbQuery, dbQueryOne, dbUpdate, dbInsert } from '../services/db.js';
import { purchaseNumber, releaseNumber, isTwilioConfigured } from '../services/twilio.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { voiceRoutes } from '../routes/voice.js';
import { errorHandler } from '../middleware/error_handler.js';
import type { Env, Variables } from '../types/env.js';

const mockQuery = dbQuery as jest.MockedFunction<typeof dbQuery>;
const mockQueryOne = dbQueryOne as jest.MockedFunction<typeof dbQueryOne>;
const mockUpdate = dbUpdate as jest.MockedFunction<typeof dbUpdate>;
const mockIsFlagOn = isFlagOn as jest.MockedFunction<typeof isFlagOn>;

const baseDb = () =>
  ({
    prepare: () => ({ bind: () => ({ run: async () => ({ meta: {} }) }) }),
  }) as unknown as Env['DB'];

function app(ids?: { userId?: string; orgId?: string }) {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    if (ids?.userId) c.set('userId', ids.userId);
    if (ids?.orgId) c.set('orgId', ids.orgId);
    c.set('requestId', 'test-req');
    await next();
  });
  a.onError(errorHandler);
  a.route('/', voiceRoutes);
  const env = { DB: baseDb(), ENVIRONMENT: 'test' } as unknown as Env;
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  const request = (path: string, init?: RequestInit) => a.request(path, init, env, ctx);
  return { request };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockQuery.mockResolvedValue({ data: [], error: null });
  mockQueryOne.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({ error: null, changes: 1 });
  // Re-arm after resetAllMocks: the purchase handler is gated behind `voice_numbers`
  // (default OFF) — force it ON so these tests reach the handler body (the OFF 404 is
  // covered in voice_numbers_flag.test.ts).
  mockIsFlagOn.mockResolvedValue(true);
});

// ─── requireSiteMembership (via GET /numbers?siteId=) ─────────────────
describe('site-membership gate (404 never 403)', () => {
  it('401 when unauthenticated', async () => {
    const { request } = app();
    expect((await request('/api/voice/numbers?siteId=s1')).status).toBe(401);
  });

  it('400 when siteId is missing', async () => {
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    expect((await request('/api/voice/numbers')).status).toBe(400);
  });

  it('404 for a non-existent site', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // requireSiteMembership site lookup
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    expect((await request('/api/voice/numbers?siteId=s1')).status).toBe(404);
  });

  it('404 (NOT 403) for a foreign-org site — identical to missing (oracle closed)', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 's1', org_id: 'OTHER_ORG' } as never);
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    const res = await request('/api/voice/numbers?siteId=s1');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(mockQuery).not.toHaveBeenCalled(); // never lists a foreign site's numbers
  });

  it('200 lists numbers for an org-owned site', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 's1', org_id: 'org-a' } as never);
    mockQuery.mockResolvedValueOnce({
      data: [{ id: 'n1', phone_number: '+15551234567' }],
      error: null,
    });
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    const res = await request('/api/voice/numbers?siteId=s1');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { numbers: unknown[] }).numbers).toHaveLength(1);
  });
});

// ─── DELETE /numbers/:id (number ownership) ──────────────────────────
describe('DELETE /api/voice/numbers/:id (404 never 403)', () => {
  it('404 for a missing number', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    expect((await request('/api/voice/numbers/n1', { method: 'DELETE' })).status).toBe(404);
  });

  it('404 (NOT 403) for a foreign-org number (no release, no update)', async () => {
    mockQueryOne.mockResolvedValueOnce({
      id: 'n1',
      org_id: 'OTHER_ORG',
      twilio_sid: 'PNxxx',
      phone_number: '+15551234567',
    } as never);
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    const res = await request('/api/voice/numbers/n1', { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(mockUpdate).not.toHaveBeenCalled(); // never soft-deletes a foreign number
  });
});

// ─── GET /calls/:id (call ownership) ─────────────────────────────────
describe('GET /api/voice/calls/:id (404 never 403)', () => {
  it('404 for a missing call', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    expect((await request('/api/voice/calls/c1')).status).toBe(404);
  });

  it('404 (NOT 403) for a foreign-org call (transcript never returned)', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'c1', org_id: 'OTHER_ORG' } as never);
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    const res = await request('/api/voice/calls/c1');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect(mockQuery).not.toHaveBeenCalled(); // recordings query never runs for a foreign call
  });

  it('200 returns call + recordings for an owned call', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 'c1', org_id: 'org-a' } as never);
    mockQuery.mockResolvedValueOnce({ data: [{ id: 'rec1' }], error: null });
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    const res = await request('/api/voice/calls/c1');
    expect(res.status).toBe(200);
    const out = (await res.json()) as { call: unknown; recordings: unknown[] };
    expect(out.recordings).toHaveLength(1);
  });
});

// ─── GET /recordings/:id/stream (recording ownership via call) ───────
describe('GET /api/voice/recordings/:id/stream (404 never 403)', () => {
  it('404 for a missing recording', async () => {
    mockQueryOne.mockResolvedValueOnce(null); // recording lookup
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    expect((await request('/api/voice/recordings/r1/stream')).status).toBe(404);
  });

  it('404 (NOT 403) when the recording’s call belongs to another org', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        id: 'r1',
        call_id: 'c1',
        r2_key: 'k',
        mime: null,
        size_bytes: null,
      } as never) // recording
      .mockResolvedValueOnce({ org_id: 'OTHER_ORG' } as never); // owning call
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    const res = await request('/api/voice/recordings/r1/stream');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

// ─── POST /numbers/purchase — orphan-number compensation (B0, money-loss fix) ──
// A successful Twilio buy followed by a D1 insert failure MUST release the number,
// or the org is charged monthly for a line that exists nowhere in our system.
describe('POST /api/voice/numbers/purchase — orphan compensation (B0)', () => {
  it('releases the just-purchased Twilio number when the D1 insert fails', async () => {
    (isTwilioConfigured as jest.MockedFunction<typeof isTwilioConfigured>).mockReturnValue(true);
    (isFlagOn as jest.MockedFunction<typeof isFlagOn>).mockResolvedValue(true); // pass the voice_numbers killswitch
    mockQueryOne.mockResolvedValueOnce({ id: 's1', org_id: 'org-a' } as never); // membership passes
    mockQuery.mockResolvedValueOnce({ data: [], error: null }); // active-count under the cap
    (purchaseNumber as jest.MockedFunction<typeof purchaseNumber>).mockResolvedValueOnce({
      sid: 'PNtest',
      phone_number: '+15550000000',
      friendly_name: 'x',
      capabilities: { voice: true, sms: true, mms: false },
    } as never);
    (dbInsert as jest.MockedFunction<typeof dbInsert>).mockResolvedValueOnce({
      error: 'boom',
    } as never);
    const { request } = app({ userId: 'u', orgId: 'org-a' });
    const res = await request('/api/voice/numbers/purchase', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 's1', phoneNumber: '+15550000000' }),
    });
    expect(res.status).toBe(500);
    // The compensating release is what keeps a paid Twilio line from being orphaned.
    expect(releaseNumber).toHaveBeenCalledWith(expect.anything(), 'PNtest');
  });
});

// ─── POST /test/call-token — response envelope (A0, Test Console token bug) ────
// The Angular console reads res.data.token; a bare { token } → undefined → every
// test call silently fails.
describe('POST /api/voice/test/call-token — { data } envelope (A0)', () => {
  const appTwilioClient = (ids: { userId: string; orgId: string }) => {
    const a = new Hono<{ Bindings: Env; Variables: Variables }>();
    a.use('*', async (c, next) => {
      c.set('userId', ids.userId);
      c.set('orgId', ids.orgId);
      c.set('requestId', 'test-req');
      await next();
    });
    a.onError(errorHandler);
    a.route('/', voiceRoutes);
    const env = {
      DB: baseDb(),
      ENVIRONMENT: 'test',
      TWILIO_API_KEY: 'SKtest',
      TWILIO_API_SECRET: 'secretsecretsecretsecret',
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_TWIML_APP_SID: 'APtest',
    } as unknown as Env;
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    return { request: (p: string, i?: RequestInit) => a.request(p, i, env, ctx) };
  };

  it('wraps the token in { data: { token, identity } } for the Angular console', async () => {
    mockQueryOne.mockResolvedValueOnce({ id: 's1', org_id: 'org-a' } as never); // membership passes
    const { request } = appTwilioClient({ userId: 'u', orgId: 'org-a' });
    const res = await request('/api/voice/test/call-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: 's1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { token?: string; identity?: string } };
    expect(body.data?.token).toBeTruthy();
    expect(body.data?.identity).toBe('user-u-site-s1');
  });
});
