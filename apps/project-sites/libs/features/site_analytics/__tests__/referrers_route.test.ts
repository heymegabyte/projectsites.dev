/**
 * /api/sites/:siteId/analytics/referrers — top external referring domains, owner-scoped +
 * drilldown-filter-aware + self-referrer-excluding. Locks the tenant boundary + the end-to-end
 * self-host exclusion (the route resolves the site's OWN hosts and drops them):
 *   - owned site → 200 { domains, capped }, self host excluded,
 *   - non-owned site → 404 (a valid filter never widens authz),
 *   - unknown/injected filterDim → 400.
 */

import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';

/**
 * D1 double routing by SQL:
 *  - `SELECT org_id FROM sites`      → ownership (requireOwnedSite),
 *  - `... FROM sites s LEFT JOIN hostnames` → the site's OWN hosts (slug + custom),
 *  - `SELECT referrer, COUNT(*)`     → the raw-referrer rows.
 */
function db(siteOwner: string | null = 'org1', referrerRows: unknown[] = []) {
  function prepare(sql: string) {
    const api = {
      bind: () => api,
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async <T>(): Promise<{ results: T[] }> => {
        if (sql.includes('SELECT org_id FROM sites')) {
          return { results: (siteOwner ? [{ org_id: siteOwner }] : []) as unknown as T[] };
        }
        if (sql.includes('LEFT JOIN hostnames')) {
          return { results: [{ slug: 'acme', hostname: null }] as unknown as T[] };
        }
        if (sql.includes('referrer')) {
          return { results: referrerRows as T[] };
        }
        return { results: [] };
      },
    };
    return api;
  }
  return { prepare } as unknown as D1Database;
}

const ownedApp = () => authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
const get = (query: string, owner: string | null = 'org1', rows: unknown[] = []) =>
  ownedApp().request(
    `/api/sites/site1/analytics/referrers${query}`,
    {},
    harnessEnv(db(owner, rows), true),
  );

describe('site_analytics route — /analytics/referrers', () => {
  it('owned site → 200 { domains, capped }, excluding the site OWN host', async () => {
    const res = await get('?days=30', 'org1', [
      { referrer: 'https://acme.projectsites.dev/x', n: 9 }, // self — excluded
      { referrer: 'https://reddit.com/r/a', n: 4 },
      { referrer: 'https://news.ycombinator.com/item?id=1', n: 6 },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: { label: string; count: number }[]; capped: boolean };
    expect(body.domains).toEqual([
      { label: 'news.ycombinator.com', count: 6 },
      { label: 'reddit.com', count: 4 },
    ]);
    expect(body.capped).toBe(false);
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
