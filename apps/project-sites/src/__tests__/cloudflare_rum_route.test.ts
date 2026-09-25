/**
 * Route coverage for `GET /api/sites/:siteId/cloudflare-rum` (`routes/cloudflare_rum.ts`).
 * Mocks the D1 helper + the RUM service so this exercises AUTH, tenant scoping, server-side host
 * resolution, and fail-soft behavior — not the CF network.
 */
jest.mock('../services/db.js', () => ({ dbQueryOne: jest.fn() }));
jest.mock('../services/cloudflare_rum.js', () => ({ getCloudflareRumSummary: jest.fn() }));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { cloudflareRum } from '../routes/cloudflare_rum.js';
import { dbQueryOne } from '../services/db.js';
import { getCloudflareRumSummary } from '../services/cloudflare_rum.js';

const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockGetRum = getCloudflareRumSummary as unknown as jest.Mock;

function makeEnv(): Env {
  return { ENVIRONMENT: 'test', DB: {} } as unknown as Env;
}

function makeApp(vars: Partial<Variables> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    if (vars.userId) {
      c.set('userId', vars.userId);
    }
    if (vars.orgId) {
      c.set('orgId', vars.orgId);
    }
    await next();
  });
  app.route('/', cloudflareRum);
  return app;
}

const AUTH: Partial<Variables> = { userId: 'u1', orgId: 'org-1' };
const PATH = '/api/sites/acme/cloudflare-rum';
const get = (app: Hono<{ Bindings: Env; Variables: Variables }>, env: Env, path = PATH) =>
  app.request(path, { method: 'GET' }, env);

const SUMMARY = {
  source: 'cloudflare_rum',
  sampled: true,
  host: 'acme.projectsites.dev',
  pageviews: 1837,
  webVitals: { lcp: { p75: 1988, rating: 'good', samples: 1126 } },
  navTiming: { ttfb: { p75: 14, rating: 'good', samples: 670 } },
  window: { since: 'S', until: 'U' },
};

beforeEach(() => jest.clearAllMocks());

it('returns 401 when unauthenticated (site never queried)', async () => {
  const res = await get(makeApp(), makeEnv());
  expect(res.status).toBe(401);
  expect(mockDbQueryOne).not.toHaveBeenCalled();
});

it('returns 404 for a site not in the caller org (non-leak) — RUM never fetched', async () => {
  mockDbQueryOne.mockResolvedValueOnce(null); // site not owned
  const res = await get(makeApp(AUTH), makeEnv());
  expect(res.status).toBe(404);
  expect(mockGetRum).not.toHaveBeenCalled();
});

it('scopes the site lookup by org_id (tenant boundary)', async () => {
  mockDbQueryOne.mockResolvedValueOnce(null);
  await get(makeApp(AUTH), makeEnv());
  // dbQueryOne(db, sql, params) — params must carry the caller's org.
  expect(mockDbQueryOne.mock.calls[0][2]).toEqual(['acme', 'org-1']);
});

it('owned site with NO custom hostname → resolves the slug subdomain server-side', async () => {
  mockDbQueryOne.mockResolvedValueOnce({ id: 's1', slug: 'acme' }); // site
  mockDbQueryOne.mockResolvedValueOnce(null); // no hostname row
  mockGetRum.mockResolvedValueOnce(SUMMARY);
  const res = await get(makeApp(AUTH), makeEnv());
  expect(res.status).toBe(200);
  const json = (await res.json()) as { available: boolean; host: string };
  expect(json.available).toBe(true);
  expect(json.host).toBe('acme.projectsites.dev');
  // The host handed to the CF query is the server-resolved slug subdomain, not a client value.
  expect(mockGetRum.mock.calls[0][1]).toBe('acme.projectsites.dev');
});

it('owned site WITH a primary custom hostname → uses it (lowercased)', async () => {
  mockDbQueryOne.mockResolvedValueOnce({ id: 's1', slug: 'acme' }); // site
  mockDbQueryOne.mockResolvedValueOnce({ hostname: 'Acme.COM' }); // primary custom host
  mockGetRum.mockResolvedValueOnce({ ...SUMMARY, host: 'acme.com' });
  await get(makeApp(AUTH), makeEnv());
  expect(mockGetRum.mock.calls[0][1]).toBe('acme.com');
});

it('fails soft to available:false (200, never 500) when RUM returns null', async () => {
  mockDbQueryOne.mockResolvedValueOnce({ id: 's1', slug: 'acme' });
  mockDbQueryOne.mockResolvedValueOnce(null);
  mockGetRum.mockResolvedValueOnce(null); // CF error / no creds
  const res = await get(makeApp(AUTH), makeEnv());
  expect(res.status).toBe(200);
  const json = (await res.json()) as { available: boolean; host: string; reason: string };
  expect(json.available).toBe(false);
  expect(json.host).toBe('acme.projectsites.dev');
  expect(json.reason).toMatch(/Cloudflare RUM/i);
});

it('clamps days to the 1..30 window', async () => {
  mockDbQueryOne.mockResolvedValueOnce({ id: 's1', slug: 'acme' });
  mockDbQueryOne.mockResolvedValueOnce(null);
  mockGetRum.mockResolvedValueOnce(SUMMARY);
  const res = await get(makeApp(AUTH), makeEnv(), `${PATH}?days=999`);
  const json = (await res.json()) as { days: number };
  expect(json.days).toBe(30);
});
