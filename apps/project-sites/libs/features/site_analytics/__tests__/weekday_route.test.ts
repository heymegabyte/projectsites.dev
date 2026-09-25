/**
 * /api/sites/:siteId/analytics/weekday route — day-of-week breakdown, owner-scoped +
 * drilldown-filter-aware. Locks the tenant boundary + filter validation:
 *   - owned site → 200 with { byWeekday, tzApplied },
 *   - non-owned site → 404 (a valid filter never widens authz),
 *   - unknown/injected filterDim → 400 (never reaches SQL),
 *   - a real tz offset → tzApplied:true (owner-local bucketing).
 *
 * Reuses the shared route harness; the D1 double echoes empty analytics rows.
 */

import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';

function db(siteOwner: string | null = 'org1', rows: unknown[] = []) {
  function prepare(sql: string) {
    const api = {
      bind: () => api,
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async <T>(): Promise<{ results: T[] }> => {
        if (sql.includes('SELECT org_id FROM sites')) {
          return { results: (siteOwner ? [{ org_id: siteOwner }] : []) as unknown as T[] };
        }
        return { results: rows as T[] };
      },
    };
    return api;
  }
  return { prepare } as unknown as D1Database;
}

const ownedApp = () => authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
const get = (query: string, owner: string | null = 'org1', rows: unknown[] = []) =>
  ownedApp().request(
    `/api/sites/site1/analytics/weekday${query}`,
    {},
    harnessEnv(db(owner, rows), true),
  );

describe('site_analytics route — /analytics/weekday', () => {
  it('owned site → 200 with { byWeekday, tzApplied }', async () => {
    const res = await get('?days=30&tz=-480', 'org1', [
      { wd: 1, n: 8 },
      { wd: 5, n: 20 },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      byWeekday: { weekday: number; count: number }[];
      tzApplied: boolean;
    };
    expect(body.byWeekday).toEqual([
      { weekday: 1, count: 8 },
      { weekday: 5, count: 20 },
    ]);
    expect(body.tzApplied).toBe(true); // a real offset → owner-local bucketing
  });

  it('absent tz → tzApplied:false (honest UTC fallback)', async () => {
    const res = await get('?days=7');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tzApplied: boolean };
    expect(body.tzApplied).toBe(false);
  });

  it('non-owned site → 404 (tenant boundary — a filter never widens authz)', async () => {
    const res = await get('?days=30&filterDim=country&filterValue=US', 'org2');
    expect(res.status).toBe(404);
  });

  it('unknown/injected filterDim → 400 (allowlist, never reaches SQL)', async () => {
    const res = await get('?filterDim=zone_id&filterValue=abc');
    expect(res.status).toBe(400);
  });
});
