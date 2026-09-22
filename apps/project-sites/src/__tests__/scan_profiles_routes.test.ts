/**
 * Route coverage for the Lead-Scanner Scan Profiles admin API (SCOPE.md:68).
 *
 * Exercises every handler end-to-end through the real Hono app + the shared
 * {@link errorHandler}, mocking only the boundaries (feature flag, super-admin
 * check, the D1 store service). The handlers gate on
 * auth (401) → `isFlagOn('scan_profiles')` (404, never 403, so feature
 * existence never leaks) → super-admin (403), then Zod `safeParse` (400) and
 * delegate to the store.
 *
 * Covers the CRUD surface:
 *  - GET    list:   auth 401 · flag-off 404 · success 200 · invalid limit 400
 *  - POST   create: auth 401 · flag-off 404 · Zod 400 (bad name / empty bboxes
 *                   / intervalMinutes out of range) · success 201
 *  - PATCH  update: unknown id 404 · Zod 400 · success 200
 *  - DELETE remove: unknown id 404 · success 200
 */

jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));

jest.mock('../services/sysadmin.js', () => ({
  isSuperAdmin: jest.fn(),
}));

jest.mock('../services/scan_profile_store.js', () => ({
  listScanProfiles: jest.fn(),
  getScanProfile: jest.fn(),
  insertScanProfile: jest.fn(),
  updateScanProfile: jest.fn(),
  deleteScanProfile: jest.fn(),
}));

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { scanProfiles } from '../routes/scan_profiles.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { isSuperAdmin } from '../services/sysadmin.js';
import {
  listScanProfiles,
  getScanProfile,
  insertScanProfile,
  updateScanProfile,
  deleteScanProfile,
} from '../services/scan_profile_store.js';

const mockIsFlagOn = isFlagOn as unknown as jest.Mock;
const mockIsSuperAdmin = isSuperAdmin as unknown as jest.Mock;
const mockList = listScanProfiles as unknown as jest.Mock;
const mockGet = getScanProfile as unknown as jest.Mock;
const mockInsert = insertScanProfile as unknown as jest.Mock;
const mockUpdate = updateScanProfile as unknown as jest.Mock;
const mockDelete = deleteScanProfile as unknown as jest.Mock;

// ─── Harness ───────────────────────────────────────────────────────────────

function makeEnv(): Env {
  return { ENVIRONMENT: 'test', DB: {} as D1Database } as unknown as Env;
}

/**
 * Build the app with a middleware that seeds the auth context vars the handler
 * reads (`userId`, `orgId`, `requestId`). Passing no vars simulates an
 * unauthenticated request (the gate returns 401).
 */
function makeApp(vars: Partial<Variables> = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.userId) c.set('userId', vars.userId);
    if (vars.orgId) c.set('orgId', vars.orgId);
    c.set('requestId', 'req_test_1');
    await next();
  });
  app.route('/', scanProfiles);
  return app;
}

const AUTHD = { userId: 'u_1', orgId: 'org_1' } as Partial<Variables>;

const validProfile = {
  name: 'Newark trades — weekly',
  enabled: false,
  bboxes: [[40.69, -74.27, 40.79, -74.13]],
  categories: ['shop', 'craft'],
  providers: ['osm'],
  filters: '',
  source: 'osm',
  maxLeadsPerRun: 50,
  intervalMinutes: 60,
};

async function req(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  method: string,
  path: string,
  body?: unknown,
) {
  return app.request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    makeEnv(),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockIsSuperAdmin.mockResolvedValue(true);
});

// ─── GET list ──────────────────────────────────────────────────────────────

describe('GET /api/admin/scan-profiles', () => {
  it('401s when unauthenticated (before any flag check)', async () => {
    const res = await req(makeApp(), 'GET', '/api/admin/scan-profiles');
    expect(res.status).toBe(401);
    expect(mockIsFlagOn).not.toHaveBeenCalled();
  });

  it('404s (never 403) when the scan_profiles flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await req(makeApp(AUTHD), 'GET', '/api/admin/scan-profiles');
    expect(res.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('403s for an authenticated non-super-admin', async () => {
    mockIsSuperAdmin.mockResolvedValue(false);
    const res = await req(makeApp(AUTHD), 'GET', '/api/admin/scan-profiles');
    expect(res.status).toBe(403);
  });

  it('400s on an out-of-range limit query param', async () => {
    const res = await req(makeApp(AUTHD), 'GET', '/api/admin/scan-profiles?limit=9999');
    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('200s with the profile list for a super-admin', async () => {
    mockList.mockResolvedValue([{ id: 'p1', name: 'A' }]);
    const res = await req(makeApp(AUTHD), 'GET', '/api/admin/scan-profiles');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { profiles: unknown[]; count: number };
    expect(json.count).toBe(1);
    expect(json.profiles).toHaveLength(1);
  });
});

// ─── POST create ───────────────────────────────────────────────────────────

describe('POST /api/admin/scan-profiles', () => {
  it('401s when unauthenticated', async () => {
    const res = await req(makeApp(), 'POST', '/api/admin/scan-profiles', validProfile);
    expect(res.status).toBe(401);
  });

  it('404s when the flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await req(makeApp(AUTHD), 'POST', '/api/admin/scan-profiles', validProfile);
    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('400s on an empty bboxes array (schema requires >= 1)', async () => {
    const res = await req(makeApp(AUTHD), 'POST', '/api/admin/scan-profiles', {
      ...validProfile,
      bboxes: [],
    });
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('400s on a missing name', async () => {
    const { name: _drop, ...rest } = validProfile;
    const res = await req(makeApp(AUTHD), 'POST', '/api/admin/scan-profiles', rest);
    expect(res.status).toBe(400);
  });

  it('400s when intervalMinutes exceeds the 43200 cap', async () => {
    const res = await req(makeApp(AUTHD), 'POST', '/api/admin/scan-profiles', {
      ...validProfile,
      intervalMinutes: 999_999,
    });
    expect(res.status).toBe(400);
  });

  it('201s and returns the created profile', async () => {
    mockInsert.mockResolvedValue({ error: null });
    const res = await req(makeApp(AUTHD), 'POST', '/api/admin/scan-profiles', validProfile);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { profile: { id: string; name: string } };
    expect(json.profile.id).toBeTruthy();
    expect(json.profile.name).toBe('Newark trades — weekly');
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});

// ─── PATCH update ──────────────────────────────────────────────────────────

describe('PATCH /api/admin/scan-profiles/:id', () => {
  it('404s when the profile does not exist', async () => {
    mockUpdate.mockResolvedValue({ error: null, changes: 0 });
    const res = await req(makeApp(AUTHD), 'PATCH', '/api/admin/scan-profiles/missing', {
      enabled: true,
    });
    expect(res.status).toBe(404);
  });

  it('400s on an invalid patch body', async () => {
    const res = await req(makeApp(AUTHD), 'PATCH', '/api/admin/scan-profiles/p1', {
      intervalMinutes: -5,
    });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('200s on a successful patch and returns the reloaded profile', async () => {
    mockUpdate.mockResolvedValue({ error: null, changes: 1 });
    mockGet.mockResolvedValue({ id: 'p1', name: 'A', enabled: true });
    const res = await req(makeApp(AUTHD), 'PATCH', '/api/admin/scan-profiles/p1', {
      enabled: true,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      updated: boolean;
      profile: { id: string; enabled: boolean };
    };
    expect(json.updated).toBe(true);
    expect(json.profile.enabled).toBe(true);
  });
});

// ─── DELETE ────────────────────────────────────────────────────────────────

describe('DELETE /api/admin/scan-profiles/:id', () => {
  it('404s when the profile does not exist', async () => {
    mockDelete.mockResolvedValue({ error: null, changes: 0 });
    const res = await req(makeApp(AUTHD), 'DELETE', '/api/admin/scan-profiles/missing');
    expect(res.status).toBe(404);
  });

  it('200s on a soft delete', async () => {
    mockDelete.mockResolvedValue({ error: null, changes: 1 });
    const res = await req(makeApp(AUTHD), 'DELETE', '/api/admin/scan-profiles/p1');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { deleted: boolean };
    expect(json.deleted).toBe(true);
  });
});
