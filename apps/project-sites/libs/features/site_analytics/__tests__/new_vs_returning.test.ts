/**
 * Tests for:
 * 1. `getNewVsReturningSummary` service — row folding (incl. nv=null → unknown, never returning) + error path.
 * 2. `GET /api/sites/:siteId/analytics/visitors` route — tenant boundary (404 foreign-org / 200 owned).
 *
 * Mirrors site_analytics_handlers.test.ts EXACTLY: the REAL `dbQuery` runs against a D1 double (no
 * module mock), so the ownership `SELECT org_id FROM sites` AND the aggregator `GROUP BY nv` query
 * both resolve through the same double — the way `siteOrgId` + `getNewVsReturningSummary` call D1.
 */
import { getNewVsReturningSummary } from '../../visitor_events_core/service.js';
import type { NewVsReturningSummary } from '../../visitor_events_core/service.js';
import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';
import type { Env } from '../../../../src/types/env.js';

/**
 * D1 double: serves the ownership row (`SELECT org_id FROM sites`) and the aggregator's `GROUP BY nv`
 * rows. `throwOnGroup` simulates a D1 failure so the aggregator's fail-soft path can be exercised.
 */
function db(
  opts: {
    owner?: string | null;
    nvRows?: Array<{ nv: number | null; n: number }>;
    throwOnGroup?: boolean;
  } = {},
): D1Database {
  const { owner = 'org1', nvRows = [], throwOnGroup = false } = opts;
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
          return { results: nvRows as unknown as T[] };
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

describe('getNewVsReturningSummary — aggregator', () => {
  it('folds nv=1→newVisits, nv=0→returningVisits, nv=null→unknownVisits', async () => {
    const env = makeEnv(
      db({ nvRows: [{ nv: 1, n: 5 }, { nv: 0, n: 12 }, { nv: null, n: 3 }] }),
    );
    const result: NewVsReturningSummary = await getNewVsReturningSummary(env, 'site1', 30);
    // nv=null must land in unknownVisits — NOT folded into returning (Number(null)===0 trap).
    expect(result).toEqual({ newVisits: 5, returningVisits: 12, unknownVisits: 3 });
  });

  it('returns all-zero when the query errors (fail-soft)', async () => {
    const env = makeEnv(db({ throwOnGroup: true }));
    const result = await getNewVsReturningSummary(env, 'site1', 30);
    expect(result).toEqual({ newVisits: 0, returningVisits: 0, unknownVisits: 0 });
  });
});

// ─── 2. Route — tenant boundary ──────────────────────────────────────────────

const VISITORS_URL = '/api/sites/site1/analytics/visitors';

describe('GET /api/sites/:siteId/analytics/visitors — tenant boundary', () => {
  it('404 when the site belongs to a different org', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(VISITORS_URL, {}, harnessEnv(db({ owner: 'OTHER_ORG' }), true));
    expect(res.status).toBe(404);
  });

  it('200 + JSON summary for the org-owned site', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(
      VISITORS_URL,
      {},
      harnessEnv(
        db({ owner: 'org1', nvRows: [{ nv: 1, n: 7 }, { nv: 0, n: 4 }, { nv: null, n: 1 }] }),
        true,
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as NewVsReturningSummary;
    expect(body).toEqual({ newVisits: 7, returningVisits: 4, unknownVisits: 1 });
  });
});
