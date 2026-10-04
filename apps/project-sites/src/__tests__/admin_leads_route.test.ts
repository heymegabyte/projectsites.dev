import { Hono } from 'hono';

import { adminLeads } from '../routes/admin_leads';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { isSuperAdmin } from '../services/sysadmin.js';

/**
 * Super-Admin lead scanner route (#9) — the HTTP transport guards layered on the
 * pure lead-scanner cores (scanResultsToLeads / searchPlacesByQuery / createLead,
 * each unit-proven separately). These lock the route's own contract: auth-required
 * (401), flag-gated `lead_scanner` (404 not 403), Zod body (400), and the
 * search→score→store wiring on the happy path. The flag service + the Places
 * search + createLead are mocked so no KV/D1/network is touched; scanResultsToLeads
 * runs for real over the mocked search results.
 */
jest.mock('../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
jest.mock('../services/sysadmin.js', () => ({ isSuperAdmin: jest.fn() }));
jest.mock('../services/places_search.js', () => ({ searchPlacesByQuery: jest.fn() }));
jest.mock('../services/lead_store.js', () => ({
  createLead: jest.fn(),
  listLeads: jest.fn(),
  countLeads: jest.fn(),
  getLead: jest.fn(),
}));
jest.mock('../services/claim_links.js', () => ({ createClaimLink: jest.fn() }));
jest.mock('../services/lead_query_discovery.js', () => ({ discoverLeadsForQuery: jest.fn() }));

const mockIsFlagOn = isFlagOn as jest.MockedFunction<typeof isFlagOn>;
const mockIsSuperAdmin = isSuperAdmin as jest.MockedFunction<typeof isSuperAdmin>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockSearch = require('../services/places_search.js').searchPlacesByQuery as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockCreateLead = require('../services/lead_store.js').createLead as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockListLeads = require('../services/lead_store.js').listLeads as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockCountLeads = require('../services/lead_store.js').countLeads as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockGetLead = require('../services/lead_store.js').getLead as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockCreateClaimLink = require('../services/claim_links.js').createClaimLink as jest.Mock;
const mockDiscover = require('../services/lead_query_discovery.js')
  .discoverLeadsForQuery as jest.Mock;

/** Mount the route behind a middleware that injects the authed-session vars. */
function makeApp(auth: { userId?: string; orgId?: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req-test');
    if (auth.userId) c.set('userId', auth.userId);
    if (auth.orgId) c.set('orgId', auth.orgId);
    await next();
  });
  app.route('/', adminLeads);
  return app;
}

const env = { DB: {}, GOOGLE_PLACES_API_KEY: 'k' } as never;

function post(app: Hono, body: unknown) {
  return app.request(
    '/api/admin/leads/scan',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
}

function hit(over: Record<string, unknown> = {}) {
  return {
    place_id: 'p1',
    name: 'Joe Plumbing',
    formatted_address: '1 Main St',
    types: ['plumber'],
    rating: 4.5,
    reviewCount: 12,
    businessStatus: 'OPERATIONAL',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockIsSuperAdmin.mockResolvedValue(true);
  mockSearch.mockResolvedValue([]);
  mockCreateLead.mockResolvedValue({ leadId: 'lead_1' });
  mockListLeads.mockResolvedValue([]);
  mockCountLeads.mockResolvedValue(0);
  mockGetLead.mockResolvedValue({ leadId: 'lead_1', profile: { businessName: 'Acme' } });
  mockCreateClaimLink.mockResolvedValue({ token: 'abc12345', leadId: 'lead_1' });
});

function getLeads(app: Hono, query = '') {
  return app.request(`/api/admin/leads${query}`, { method: 'GET' }, env);
}

function mintLink(app: Hono, leadId = 'lead_1') {
  return app.request(`/api/admin/leads/${leadId}/claim-link`, { method: 'POST' }, env);
}

describe('POST /api/admin/leads/scan', () => {
  it('401s when unauthenticated', async () => {
    const res = await post(makeApp({}), { query: 'plumbers austin tx' });
    expect(res.status).toBe(401);
  });

  it('404s when the lead_scanner flag is off (existence not leaked)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await post(makeApp({ userId: 'u1', orgId: 'o1' }), { query: 'plumbers austin tx' });
    expect(res.status).toBe(404);
  });

  it('403s when authed + flag-on but the user is not a super-admin', async () => {
    mockIsSuperAdmin.mockResolvedValue(false);
    const res = await post(makeApp({ userId: 'u1', orgId: 'o1' }), { query: 'plumbers austin tx' });
    expect(res.status).toBe(403);
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('400s on an invalid body (query too short)', async () => {
    const res = await post(makeApp({ userId: 'u1', orgId: 'o1' }), { query: 'x' });
    expect(res.status).toBe(400);
  });

  it('400s on a malformed JSON body', async () => {
    const app = makeApp({ userId: 'u1', orgId: 'o1' });
    const res = await app.request(
      '/api/admin/leads/scan',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ not json' },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('200s and creates leads for no-website results on the happy path', async () => {
    mockSearch.mockResolvedValue([
      hit({ place_id: 'p1' }),
      hit({ place_id: 'p2', name: 'Bob HVAC' }),
    ]);
    const res = await post(makeApp({ userId: 'u1', orgId: 'o1' }), { query: 'plumbers austin tx' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { scanned: number; created: number } };
    expect(body.summary.scanned).toBe(2);
    expect(body.summary.created).toBe(2);
    expect(mockCreateLead).toHaveBeenCalledTimes(2);
    // The Places API key is forwarded to the search core.
    expect(mockSearch).toHaveBeenCalledWith('k', 'plumbers austin tx');
  });

  it('dedupes repeated place_id within one scan', async () => {
    mockSearch.mockResolvedValue([hit({ place_id: 'dup' }), hit({ place_id: 'dup' })]);
    const res = await post(makeApp({ userId: 'u1', orgId: 'o1' }), { query: 'roofers newark nj' });
    const body = (await res.json()) as { summary: { created: number; skippedDuplicate: number } };
    expect(body.summary.created).toBe(1);
    expect(body.summary.skippedDuplicate).toBe(1);
  });
});

describe('GET /api/admin/leads', () => {
  it('401s when unauthenticated', async () => {
    expect((await getLeads(makeApp({}))).status).toBe(401);
    expect(mockListLeads).not.toHaveBeenCalled();
  });

  it('404s when the lead_scanner flag is off (existence not leaked)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await getLeads(makeApp({ userId: 'u1', orgId: 'o1' }))).status).toBe(404);
    expect(mockListLeads).not.toHaveBeenCalled();
  });

  it('403s when authed + flag-on but not a super-admin', async () => {
    mockIsSuperAdmin.mockResolvedValue(false);
    expect((await getLeads(makeApp({ userId: 'u1', orgId: 'o1' }))).status).toBe(403);
    expect(mockListLeads).not.toHaveBeenCalled();
  });

  it('200s with the lead list + count + total for a super-admin', async () => {
    mockListLeads.mockResolvedValue([
      {
        leadId: 'l1',
        businessName: 'Acme',
        hasWebsite: false,
        leadScore: 88,
        priority: true,
        email: null,
        emailStatus: null,
        source: 'google_places',
        createdAt: '2026-06-19T00:00:00Z',
      },
    ]);
    mockCountLeads.mockResolvedValue(1);
    const res = await getLeads(makeApp({ userId: 'u1', orgId: 'o1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { leads: unknown[]; count: number; total: number };
    expect(body.count).toBe(1);
    expect(body.total).toBe(1);
    expect(body.leads).toHaveLength(1);
  });

  it('returns the TRUE total (not the page length) when the store holds more than one page', async () => {
    // fire-137 lying-count regression: a 50-row page over a 109-row store must report
    // count=50 (page) AND total=109 (store), never total=50.
    mockListLeads.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ leadId: `l${i}` })));
    mockCountLeads.mockResolvedValue(109);
    const res = await getLeads(makeApp({ userId: 'u1', orgId: 'o1' }), '?limit=50');
    const body = (await res.json()) as { count: number; total: number };
    expect(body.count).toBe(50);
    expect(body.total).toBe(109);
    // countLeads MUST receive the same filter opts as listLeads (page/total can't drift)
    expect(mockCountLeads).toHaveBeenCalledWith(env.DB, expect.objectContaining({ limit: 50 }));
  });

  it('forwards parsed query params (limit/offset/onlyNoWebsite) to listLeads', async () => {
    await getLeads(
      makeApp({ userId: 'u1', orgId: 'o1' }),
      '?limit=10&offset=20&onlyNoWebsite=true',
    );
    expect(mockListLeads).toHaveBeenCalledWith(env.DB, {
      limit: 10,
      offset: 20,
      onlyNoWebsite: true,
    });
  });

  it('400s on an invalid query param (limit over max)', async () => {
    const res = await getLeads(makeApp({ userId: 'u1', orgId: 'o1' }), '?limit=99999');
    expect(res.status).toBe(400);
    expect(mockListLeads).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/leads/:id/claim-link', () => {
  it('401s when unauthenticated', async () => {
    expect((await mintLink(makeApp({}))).status).toBe(401);
    expect(mockCreateClaimLink).not.toHaveBeenCalled();
  });

  it('404s when the lead_scanner flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    expect((await mintLink(makeApp({ userId: 'u1', orgId: 'o1' }))).status).toBe(404);
    expect(mockCreateClaimLink).not.toHaveBeenCalled();
  });

  it('403s when authed + flag-on but not a super-admin', async () => {
    mockIsSuperAdmin.mockResolvedValue(false);
    expect((await mintLink(makeApp({ userId: 'u1', orgId: 'o1' }))).status).toBe(403);
    expect(mockCreateClaimLink).not.toHaveBeenCalled();
  });

  it('404s when the lead does not exist (no junk claim link)', async () => {
    mockGetLead.mockResolvedValue(null);
    const res = await mintLink(makeApp({ userId: 'u1', orgId: 'o1' }), 'gone');
    expect(res.status).toBe(404);
    expect(mockCreateClaimLink).not.toHaveBeenCalled();
  });

  it('200s with the token + shareable claim URL for an existing lead', async () => {
    const res = await mintLink(makeApp({ userId: 'u1', orgId: 'o1' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; claimUrl: string };
    expect(body.token).toBe('abc12345');
    expect(body.claimUrl).toBe('https://projectsites.dev/api/claim/abc12345');
    expect(mockCreateClaimLink).toHaveBeenCalledWith(env.DB, 'lead_1');
  });
});

describe('scan fallback chain (Places billing-dead → free OSM)', () => {
  it('falls back to query discovery when Places returns nothing and stores OSM-sourced leads', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockIsSuperAdmin.mockResolvedValue(true);
    mockSearch.mockResolvedValue([]);
    mockDiscover.mockResolvedValue({
      results: [hit({ place_id: 'osm:node/9', name: 'OSM Joe' })],
      degraded: null,
    });
    const res = await post(makeApp({ userId: 'u1', orgId: 'o1' }), {
      query: 'plumbers in Newark NJ',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { scanned: number; created: number };
      source: string;
      degraded: string | null;
    };
    expect(body.summary.scanned).toBe(1);
    expect(body.summary.created).toBe(1);
    expect(body.source).toBe('osm');
    expect(mockCreateLead).toHaveBeenCalled();
    // createLead(db, profile, meta) — meta is the 3rd argument.
    const meta = mockCreateLead.mock.calls[0][2] as { source?: string };
    expect(meta.source).toBe('osm');
  });

  it('surfaces an honest degraded message when both engines come up empty', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockIsSuperAdmin.mockResolvedValue(true);
    mockSearch.mockResolvedValue([]);
    mockDiscover.mockResolvedValue({
      results: [],
      degraded: 'Could not geocode \"Nowhereville ZZ\".',
    });
    const res = await post(makeApp({ userId: 'u1', orgId: 'o1' }), {
      query: 'plumbers in Nowhereville ZZ',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { created: number }; degraded: string | null };
    expect(body.summary.created).toBe(0);
    expect(body.degraded).toContain('geocode');
  });

  it('keeps the Places-first path when Places still returns hits', async () => {
    mockIsFlagOn.mockResolvedValue(true);
    mockIsSuperAdmin.mockResolvedValue(true);
    mockSearch.mockResolvedValue([hit()]);
    mockDiscover.mockResolvedValue({ results: [], degraded: null });
    const res = await post(makeApp({ userId: 'u1', orgId: 'o1' }), {
      query: 'roofers in Austin TX',
    });
    const body = (await res.json()) as { source: string };
    expect(body.source).toBe('google_places');
    expect(mockDiscover).not.toHaveBeenCalled();
  });
});
