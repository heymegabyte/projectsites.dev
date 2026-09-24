/**
 * AN-FILTER route layer — the owner analytics route accepts an optional drilldown
 * filter (`?filterDim=&filterValue=`) and validates it against the allowlist BEFORE
 * it can reach SQL. This spec locks the boundary:
 *   - a valid filter → 200 and is ECHOED back as `appliedFilter` (so the UI can show a
 *     chip AND confirm the server honored it, never a client-only claim),
 *   - an unknown/injected `filterDim`, a missing half, or an over-long value → 400,
 *   - a filter NEVER widens authz — a non-owned site still 404s even with a valid filter.
 *
 * Reuses the shared route harness; the D1 double echoes zeroed analytics.
 */

import { siteAnalytics } from '../handlers.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';

function db(siteOwner: string | null = 'org1') {
  function prepare(sql: string) {
    const api = {
      bind: () => api,
      first: async () => null,
      run: async () => ({ meta: { changes: 0 } }),
      all: async <T>(): Promise<{ results: T[] }> => {
        if (sql.includes('SELECT org_id FROM sites')) {
          return { results: (siteOwner ? [{ org_id: siteOwner }] : []) as unknown as T[] };
        }
        if (sql.includes('GROUP BY')) return { results: [] };
        if (sql.includes('COUNT')) return { results: [{ n: 0 }] as unknown as T[] };
        return { results: [] };
      },
    };
    return api;
  }
  return { prepare } as unknown as D1Database;
}

const ownedApp = () => authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
const get = (query: string, owner: string | null = 'org1') =>
  ownedApp().request(`/api/sites/site1/analytics${query}`, {}, harnessEnv(db(owner), true));

describe('site_analytics route — drilldown filter validation', () => {
  it('accepts a valid filter and ECHOES it back as appliedFilter', async () => {
    const res = await get('?filterDim=country&filterValue=US');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appliedFilter?: { dim: string; value: string } };
    expect(body.appliedFilter).toEqual({ dim: 'country', value: 'US' });
  });

  it('omits appliedFilter entirely when no filter is requested', async () => {
    const res = await get('');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appliedFilter?: unknown };
    expect(body.appliedFilter).toBeUndefined();
  });

  it('rejects an UNKNOWN dimension with 400 (allowlist) — never reaches SQL', async () => {
    const res = await get('?filterDim=zone_id&filterValue=abc');
    expect(res.status).toBe(400);
  });

  it('rejects an injection-shaped dimension with 400', async () => {
    const res = await get(`?filterDim=${encodeURIComponent("metadata')=1;--")}&filterValue=x`);
    expect(res.status).toBe(400);
  });

  it('rejects a filterDim with no filterValue (schema requires both)', async () => {
    const res = await get('?filterDim=country');
    expect(res.status).toBe(400);
  });

  it('rejects an over-long filterValue (>256 chars)', async () => {
    const res = await get(`?filterDim=path&filterValue=${'a'.repeat(300)}`);
    expect(res.status).toBe(400);
  });

  it('a VALID filter never bypasses tenant authz — a non-owned site still 404s', async () => {
    // Site owned by org2; caller is org1. The filter must NOT widen access.
    const res = await get('?filterDim=country&filterValue=US', 'org2');
    expect(res.status).toBe(404);
  });
});
