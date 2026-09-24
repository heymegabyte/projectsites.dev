/**
 * Route coverage for `src/routes/voice_insights.ts`
 *
 * Tests the GET /api/voice/insights endpoint which returns org-scoped aggregates
 * over voice_calls: total calls, direction breakdown, avg duration, sentiment
 * breakdown, and total cost.
 *
 * Mocks only D1 (db service) — exercises the real Hono routing + Zod validation.
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn(),
  dbQueryOne: jest.fn(),
  dbInsert: jest.fn(),
  dbUpdate: jest.fn(),
  dbExecute: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { voiceInsightsRoutes } from '../routes/voice_insights.js';
import { dbQuery } from '../services/db.js';

const mDbQuery = dbQuery as unknown as jest.Mock;

// ─── test app factory ──────────────────────────────────────────────────────
function buildApp(userId = 'u1', orgId = 'org1') {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (userId) c.set('userId', userId);
    if (orgId) c.set('orgId', orgId);
    await next();
  });
  app.onError(errorHandler);
  app.route('/', voiceInsightsRoutes);
  return app;
}

const mockEnv = { DB: {} } as unknown as Env;

// ─── helpers ───────────────────────────────────────────────────────────────

/** A realistic aggregate row returned by the SQL query */
function makeAggRow(
  overrides: Partial<{
    total_calls: number;
    inbound: number;
    outbound: number;
    avg_duration_seconds: number;
    positive: number;
    neutral: number;
    negative: number;
    escalated_safety: number;
    flagged_scam: number;
    total_cost_cents: number;
  }> = {},
) {
  return [
    {
      total_calls: 12,
      inbound: 9,
      outbound: 3,
      avg_duration_seconds: 47,
      positive: 5,
      neutral: 4,
      negative: 2,
      escalated_safety: 1,
      flagged_scam: 0,
      total_cost_cents: 480,
      ...overrides,
    },
  ];
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe('GET /api/voice/insights', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when caller is unauthenticated', async () => {
    const app = buildApp('', '');
    const res = await app.request('/api/voice/insights', {}, mockEnv);
    expect(res.status).toBe(401);
  });

  it('returns aggregate KPIs for the authenticated org', async () => {
    mDbQuery.mockResolvedValueOnce({ data: makeAggRow() });
    const app = buildApp();
    const res = await app.request('/api/voice/insights', {}, mockEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.total_calls).toBe(12);
    expect(body.data.by_direction).toEqual({ inbound: 9, outbound: 3 });
    expect(body.data.avg_duration_seconds).toBe(47);
    expect(body.data.sentiment_breakdown).toEqual({
      positive: 5,
      neutral: 4,
      negative: 2,
      escalated_safety: 1,
      flagged_scam: 0,
    });
    expect(body.data.total_cost_cents).toBe(480);
  });

  it('returns zero-value defaults when org has no calls (empty-safe)', async () => {
    mDbQuery.mockResolvedValueOnce({ data: [] });
    const app = buildApp();
    const res = await app.request('/api/voice/insights', {}, mockEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.total_calls).toBe(0);
    expect(body.data.by_direction).toEqual({ inbound: 0, outbound: 0 });
    expect(body.data.avg_duration_seconds).toBe(0);
    expect(body.data.total_cost_cents).toBe(0);
  });

  it('scopes query to the AUTHED org (IDOR regression: ignores any ?org_id query param)', async () => {
    mDbQuery.mockResolvedValueOnce({ data: makeAggRow() });
    const app = buildApp('u1', 'org1');
    // Attacker passes a different org_id in the query string
    const res = await app.request('/api/voice/insights?org_id=evil-org', {}, mockEnv);
    expect(res.status).toBe(200);
    // The SQL query must have been called with org1, NOT evil-org
    const callArgs = mDbQuery.mock.calls[0];
    // callArgs[2] is the params array — first param should be the authed orgId
    expect(callArgs[2]).toContain('org1');
    expect(callArgs[2]).not.toContain('evil-org');
  });

  it('degrades gracefully when DB throws — returns zeros not 500', async () => {
    mDbQuery.mockRejectedValueOnce(new Error('D1 unavailable'));
    const app = buildApp();
    const res = await app.request('/api/voice/insights', {}, mockEnv);
    // Should return 200 with zero data, not 500
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.total_calls).toBe(0);
  });
});
