/**
 * Unit tests for `getCloudflareRumForSite` — the owned-host resolver + CF RUM fetch used by the
 * public share report. Tenant-critical: the host is resolved from the site's OWN records
 * (slug subdomain / primary hostname), never a client value; fail-soft to null when the site is gone.
 */
import { getCloudflareRumForSite } from '../service.js';
import type { Env } from '../../../../src/types/env.js';

function makeEnv(row: { slug: string; hostname: string | null } | null): Env {
  const prepare = (sql: string) => {
    const api = {
      bind: () => api,
      all: async <T>(): Promise<{ results: T[] }> => ({
        results: (sql.includes('FROM sites s') && row ? [row] : []) as unknown as T[],
      }),
    };
    return api;
  };
  return {
    DB: { prepare } as unknown as D1Database,
    CLOUDFLARE_API_KEY: 'k',
    CLOUDFLARE_EMAIL: 'e@x.com',
    CF_ACCOUNT_ID: 'acct',
  } as unknown as Env;
}

/** A minimal live-shaped RUM GraphQL response (µs timing) for the mocked fetch. */
const RUM_BODY = {
  data: {
    viewer: {
      accounts: [
        {
          pageload: [{ count: 20 }],
          webVitals: [
            { count: 20, quantiles: { largestContentfulPaintP75: 1_248_000, interactionToNextPaintP75: 0, cumulativeLayoutShiftP75: 0 } },
          ],
          perf: [
            { count: 10, quantiles: { responseTimeP75: 14_000, firstContentfulPaintP75: 0, pageLoadTimeP75: 1_917_000, dnsTimeP75: 53_000, connectionTimeP75: 112_000 } },
          ],
        },
      ],
    },
  },
};

describe('getCloudflareRumForSite', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => RUM_BODY }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('resolves the slug subdomain when there is no custom hostname, and queries CF for THAT host', async () => {
    const r = await getCloudflareRumForSite(makeEnv({ slug: 'acme', hostname: null }), 'site1', 30);
    expect(r).not.toBeNull();
    expect(r!.host).toBe('acme.projectsites.dev');
    // The resolved host is what got sent to Cloudflare — never a client value.
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.variables.h).toBe('acme.projectsites.dev');
    // µs→ms conversion flows through: LCP 1_248_000µs → 1248ms.
    expect(r!.webVitals.lcp.p75).toBe(1248);
  });

  it('prefers a primary custom hostname (lowercased)', async () => {
    const r = await getCloudflareRumForSite(makeEnv({ slug: 'acme', hostname: 'Acme.COM' }), 'site1', 30);
    expect(r!.host).toBe('acme.com');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.variables.h).toBe('acme.com');
  });

  it('fails soft to null when the site does not exist — CF is never queried', async () => {
    const r = await getCloudflareRumForSite(makeEnv(null), 'ghost', 30);
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
