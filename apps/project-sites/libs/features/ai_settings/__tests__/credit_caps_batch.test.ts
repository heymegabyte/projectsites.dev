/**
 * Tests for the BATCH per-site credit-cap read — `GET /api/credit-caps`.
 *
 * This route exists to kill an N+1 waterfall on the admin billing page: the
 * page previously fired one `GET /api/sites/:siteId/credit-cap` per site (~110
 * sequential requests / ~9s load on a large roster). The batch route returns
 * every cap the caller's org owns in ONE org-scoped query.
 *
 * Mocks: dbQuery (src/services/db.js). Mounts the real `aiSettings` Hono app and
 * simulates the auth middleware having set orgId (mirrors prod_readiness_score).
 * Coverage:
 *   - unauthenticated (no orgId) → 401
 *   - populated roster → 200 + { data: rows }, query scoped to orgId
 *   - empty roster → 200 + { data: [] }
 *   - a foreign org's caps never leak (query WHERE org_id = <caller>)
 */
import { Hono } from 'hono';

// ── Mocks (must precede the handler import; global `jest` for @swc/jest hoist) ──
const mockDbQuery = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQuery: (...a: unknown[]) => mockDbQuery(...a),
}));

// ── Import after mocks ─────────────────────────────────────────────────────────
import { aiSettings } from '../handlers.js';

// ── Helper: mount app with orgId set (or not) + issue the request ───────────────
function requestCaps(orgId: string | null) {
  const env = { DB: {} } as unknown;
  const a = new Hono();
  if (orgId) {
    a.use('*', (c, next) => {
      c.set('orgId' as never, orgId as never);
      c.set('userId' as never, 'user-1' as never);
      return next();
    });
  }
  a.route('/', aiSettings);
  return a.request(
    '/api/credit-caps',
    { method: 'GET' },
    env as never,
    { waitUntil() {}, passThroughOnException() {} } as never,
  );
}

beforeEach(() => {
  mockDbQuery.mockReset();
});

describe('GET /api/credit-caps (batch)', () => {
  it('returns 401 when orgId is not set', async () => {
    const res = await requestCaps(null);
    expect(res.status).toBe(401);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it('returns every cap for the org in one query', async () => {
    mockDbQuery.mockResolvedValue({
      data: [
        { site_id: 'site-a', monthly_credit_cap: 500 },
        { site_id: 'site-b', monthly_credit_cap: null },
      ],
      error: null,
    });
    const res = await requestCaps('org-abc');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { site_id: string; monthly_credit_cap: number | null }[];
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toEqual({ site_id: 'site-a', monthly_credit_cap: 500 });

    // Exactly ONE query — the whole point of the batch route (no N+1).
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    // Org-scoped: the caller's orgId is bound so no foreign cap can leak.
    const [, sql, params] = mockDbQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toMatch(/WHERE\s+org_id\s*=\s*\?/i);
    expect(params).toEqual(['org-abc']);
  });

  it('returns { data: [] } for an org with no caps (honest empty)', async () => {
    mockDbQuery.mockResolvedValue({ data: [], error: null });
    const res = await requestCaps('org-empty');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });
});
