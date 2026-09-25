/**
 * /api/sites/:siteId/analytics/daily — the drilldown filter now threads through the chart's
 * time-series too (it previously ignored it, so a `country=US` drill re-scoped every card EXCEPT
 * the daily line). Locks the tenant boundary + filter validation on THIS route:
 *   - a valid filter → 200 and the bound value reaches the daily query (not just the summary),
 *   - an unknown/injected filterDim → 400 (never reaches SQL),
 *   - a non-owned site → 404 even WITH a valid filter.
 */

import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';

/** Captures the last GROUP-BY (daily) query's params so we can assert the filter value is bound. */
function db(siteOwner: string | null = 'org1', cap?: { sql: string; params: unknown[] }) {
  function prepare(sql: string) {
    const api = {
      bind: (...params: unknown[]) => {
        if (cap && sql.includes('GROUP BY')) {
          cap.sql = sql;
          cap.params = params;
        }
        return api;
      },
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async <T>(): Promise<{ results: T[] }> => {
        if (sql.includes('SELECT org_id FROM sites')) {
          return { results: (siteOwner ? [{ org_id: siteOwner }] : []) as unknown as T[] };
        }
        return { results: [] };
      },
    };
    return api;
  }
  return { prepare } as unknown as D1Database;
}

const ownedApp = () => authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
const get = (
  query: string,
  owner: string | null = 'org1',
  cap?: { sql: string; params: unknown[] },
) => ownedApp().request(`/api/sites/site1/analytics/daily${query}`, {}, harnessEnv(db(owner, cap), true));

describe('site_analytics route — /analytics/daily drilldown filter', () => {
  it('a valid filter reaches the daily query as a BOUND value', async () => {
    const cap = { sql: '', params: [] as unknown[] };
    const res = await get('?days=30&filterDim=country&filterValue=US', 'org1', cap);
    expect(res.status).toBe(200);
    expect(cap.sql).toMatch(/json_extract\(metadata, '\$\.country'\) = \?/);
    expect(cap.params).toContain('US'); // the value is bound, never concatenated
  });

  it('unknown/injected filterDim → 400 (allowlist, never reaches SQL)', async () => {
    expect((await get('?filterDim=zone_id&filterValue=abc')).status).toBe(400);
  });

  it('non-owned site → 404 (tenant boundary — a filter never widens authz)', async () => {
    expect((await get('?days=30&filterDim=country&filterValue=US', 'org2')).status).toBe(404);
  });

  it('no filter → 200 (unchanged behaviour)', async () => {
    expect((await get('?days=7')).status).toBe(200);
  });
});
