/**
 * Tests for:
 * 1. `getClickSummary` service — row folding (null/empty label skipped), honest `total` (sums ALL
 *    labels, not just the top-10 shown), and the fail-soft error path.
 * 2. `GET /api/sites/:siteId/analytics/clicks` route — tenant boundary (404 foreign-org / 200 owned).
 *
 * Mirrors entry_pages.test.ts EXACTLY: the REAL `dbQuery` runs against a D1 double (no module mock),
 * so the ownership `SELECT org_id FROM sites` AND the aggregator `GROUP BY label` query both resolve
 * through the same double — the way `siteOrgId` + `getClickSummary` call D1.
 */
import { getClickSummary } from '../../visitor_events_core/service.js';
import type { ClickSummary } from '../../visitor_events_core/service.js';
import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * D1 double: serves the ownership row (`SELECT org_id FROM sites`) and the aggregator's
 * `GROUP BY label` rows. `throwOnGroup` simulates a D1 failure so the fail-soft path is exercised.
 */
function db(
  opts: {
    owner?: string | null;
    labelRows?: Array<{ label: string | null; n: number }>;
    throwOnGroup?: boolean;
  } = {},
): D1Database {
  const { owner = 'org1', labelRows = [], throwOnGroup = false } = opts;
  function prepare(sql: string) {
    const api = {
      bind: () => api,
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async <T>(): Promise<{ results: T[] }> => {
        if (sql.includes('SELECT org_id FROM sites')) {
          return { results: (owner ? [{ org_id: owner }] : []) as unknown as T[] };
        }
        if (sql.includes('GROUP BY')) {
          if (throwOnGroup) throw new Error('D1 timeout');
          return { results: labelRows as unknown as T[] };
        }
        return { results: [] };
      },
    };
    return api;
  }
  return { prepare } as unknown as D1Database;
}

function makeEnv(database: D1Database): Env {
  return { DB: database } as unknown as Env;
}

// ─── 1. Aggregator ───────────────────────────────────────────────────────────

describe('getClickSummary — aggregator', () => {
  it('returns labels sorted by count with an honest total, skipping null/empty label rows', async () => {
    const env = makeEnv(
      db({
        labelRows: [
          { label: 'Book Now', n: 9 },
          { label: 'View Menu', n: 4 },
          { label: null, n: 7 }, // null label → skipped from BOTH total and the shown set
          { label: '', n: 3 }, // empty label → skipped
        ],
      }),
    );
    const result: ClickSummary = await getClickSummary(env, 'site1', 30);
    expect(result).toEqual({
      total: 13, // 9 + 4 — the null(7) + empty(3) rows are NOT counted
      byLabel: [
        { label: 'Book Now', count: 9 },
        { label: 'View Menu', count: 4 },
      ],
    });
  });

  it('caps the shown set at 10 but keeps `total` the honest sum across ALL labels', async () => {
    // 12 distinct labels each with count 1 → total must be 12, byLabel must be exactly 10.
    const labelRows = Array.from({ length: 12 }, (_v, i) => ({ label: `btn-${i}`, n: 1 }));
    const env = makeEnv(db({ labelRows }));
    const result = await getClickSummary(env, 'site1', 30);
    expect(result.total).toBe(12); // honest — NOT capped to the shown 10
    expect(result.byLabel).toHaveLength(10);
  });

  it('returns the empty summary when the query errors (fail-soft, never a fabricated 0)', async () => {
    const env = makeEnv(db({ throwOnGroup: true }));
    const result = await getClickSummary(env, 'site1', 30);
    expect(result).toEqual({ total: 0, byLabel: [] });
  });
});

// ─── 2. Route — tenant boundary ──────────────────────────────────────────────

const CLICKS_URL = '/api/sites/site1/analytics/clicks';

describe('GET /api/sites/:siteId/analytics/clicks — tenant boundary', () => {
  it('404 when the site belongs to a different org (no cross-tenant read)', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(CLICKS_URL, {}, harnessEnv(db({ owner: 'OTHER_ORG' }), true));
    expect(res.status).toBe(404);
  });

  it('200 + JSON summary for the org-owned site', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(
      CLICKS_URL,
      {},
      harnessEnv(
        db({ owner: 'org1', labelRows: [{ label: 'Book Now', n: 9 }, { label: 'View Menu', n: 4 }] }),
        true,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClickSummary;
    expect(body).toEqual({
      total: 13,
      byLabel: [
        { label: 'Book Now', count: 9 },
        { label: 'View Menu', count: 4 },
      ],
    });
  });
});
