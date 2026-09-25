/**
 * Route-LAYER tests for site_analytics handler (Hono app.request + harness).
 * Covers: 401 unauth, 404 flag-off, 404 site-not-owned, 200 owned summary.
 */

import { siteAnalytics } from '../handlers.js';
import { mintShareToken } from '../share.js';
import { authApp, harnessEnv } from '../../../../src/__tests__/helpers/route_harness.js';

/** D1 double: site→org lookup (configurable) + zeroed analytics counts; .first()→null. */
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
        // getCloudflareRumForSite's owned-host resolver (`SELECT s.slug … FROM sites s`).
        if (sql.includes('FROM sites s')) {
          return { results: [{ slug: 'acme', hostname: null }] as unknown as T[] };
        }
        // GROUP BY breakdowns (bySource/topPaths/byType) also contain COUNT(*) —
        // return [] BEFORE the scalar COUNT branch, else a {n:0} row with no
        // grouped column fails schema parse.
        if (sql.includes('GROUP BY')) return { results: [] };
        if (sql.includes('COUNT')) return { results: [{ n: 0 }] as unknown as T[] };
        return { results: [] }; // visitor_events scalars + flag override
      },
    };
    return api;
  }
  return { prepare } as unknown as D1Database;
}

const URL = '/api/sites/site1/analytics';

/** Public-share env: harness DB + the manifest signing secret (verifies the token) + CF creds
 *  (so getCloudflareRumForSite can populate cloudflareRum). */
const PUB_SECRET = 'test-manifest-signing-secret';
function pubEnv(database: D1Database): ReturnType<typeof harnessEnv> {
  const base = harnessEnv(database, true) as unknown as Record<string, unknown>;
  base.MANIFEST_SIGNING_SECRET = PUB_SECRET;
  base.CLOUDFLARE_API_KEY = 'k';
  base.CLOUDFLARE_EMAIL = 'e@x.com';
  base.CF_ACCOUNT_ID = 'acct';
  return base as unknown as ReturnType<typeof harnessEnv>;
}

/** Minimal live-shaped RUM GraphQL body for the mocked fetch (µs timing). */
const RUM_BODY = {
  data: {
    viewer: {
      accounts: [
        {
          pageload: [{ count: 20 }],
          webVitals: [{ count: 20, quantiles: { largestContentfulPaintP75: 1_248_000, interactionToNextPaintP75: 0, cumulativeLayoutShiftP75: 0 } }],
          perf: [{ count: 10, quantiles: { responseTimeP75: 14_000, firstContentfulPaintP75: 0, pageLoadTimeP75: 1_917_000, dnsTimeP75: 0, connectionTimeP75: 0 } }],
        },
      ],
    },
  },
};

describe('site_analytics handler (route layer)', () => {
  it('401 when unauthenticated', async () => {
    const app = authApp(siteAnalytics);
    expect((await app.request(URL, {}, harnessEnv(db(), true))).status).toBe(401);
  });

  it('404 when the flag is off', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    expect((await app.request(URL, {}, harnessEnv(db(), false))).status).toBe(404);
  });

  it('404 when the site belongs to another org', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    expect((await app.request(URL, {}, harnessEnv(db('OTHER_ORG'), true))).status).toBe(404);
  });

  it('200 returns the summary for an org-owned site', async () => {
    const app = authApp(siteAnalytics, { userId: 'u', orgId: 'org1' });
    const res = await app.request(URL, {}, harnessEnv(db('org1'), true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      siteId: string;
      contacts: { total: number };
      traffic: { pageviews: number };
    };
    expect(body.siteId).toBe('site1');
    expect(body.contacts.total).toBe(0);
    expect(body.traffic.pageviews).toBe(0);
  });
});

// The PUBLIC share endpoint (`GET /api/public/analytics/:token`) — no session; the HMAC token IS
// the capability. Closes the wire-through gap: proves the assembled envelope carries the summary,
// the SIBLING cloudflareRum (independent CF source), and expiresAt — and that a bad token 404s.
describe('site_analytics public share endpoint (route layer)', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => RUM_BODY })) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('404s a bad/tampered token (no valid token → no access; never leaks)', async () => {
    const app = authApp(siteAnalytics); // no session — the token is the only capability
    const res = await app.request('/api/public/analytics/not.a.token', {}, pubEnv(db('org1')));
    expect(res.status).toBe(404);
  });

  it('200 assembles { summary, cloudflareRum, expiresAt } for a valid token — cloudflareRum is a SIBLING, populated', async () => {
    const exp = Date.now() + 60_000;
    const token = await mintShareToken(PUB_SECRET, 'site1', exp);
    const app = authApp(siteAnalytics);
    const res = await app.request(`/api/public/analytics/${token}`, {}, pubEnv(db('org1')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { siteId: string; traffic: { pageviews: number; cloudflareRum?: unknown } };
      cloudflareRum: { host: string; webVitals: { lcp: { p75: number } } } | null;
      expiresAt: number;
    };
    // summary present (tenant-resolved from the token, not a client id)
    expect(body.summary.siteId).toBe('site1');
    // cloudflareRum wired as a SIBLING (never inside the Zod summary) + populated for the owned host
    expect(body.cloudflareRum).not.toBeNull();
    expect(body.cloudflareRum!.host).toBe('acme.projectsites.dev'); // resolved server-side from slug
    expect(body.cloudflareRum!.webVitals.lcp.p75).toBe(1248); // µs→ms conversion flowed through
    expect(body.summary.traffic.cloudflareRum).toBeUndefined(); // NOT nested in summary
    // the exact grant expiry is echoed
    expect(body.expiresAt).toBe(exp);
  });
});
