/**
 * Route-layer coverage for the AI model router's two endpoints in
 * `src/routes/features.ts`, gated by the `model_registry` flag (the standalone
 * ai_auto_router flag was folded into model_registry 2026-08-14):
 *   - POST /api/router/pick   → experimentalFeatures.autoRoutePrompt
 *   - GET  /api/router/stats  → experimentalFeatures.getRouterStats
 *
 * The SERVICE layer (autoRoutePrompt / getRouterStats) is already covered by
 * experimental_features.test.ts. The ROUTE layer — the `requireFlag('model_registry')` gate
 * (404 when off, no leak) + org-scoping — is covered here. Org comes from the AUTHED
 * session (`c.get('orgId')`), NEVER a client `org_id` body/query (IDOR-hardened
 * 2026-09-06, AL-061), so we mount `features` behind a seedable-orgId middleware that
 * stands in for the real auth middleware (which runs before `app.route('/', features)`).
 * Mocks only the two boundaries: the flag resolver and the experimental-features service.
 */

// Override isFlagOn while keeping the rest of the module (features.ts also imports
// resolveFlag + FLAG_REGISTRY from here at module load).
jest.mock('../modules/feature_flags/services.js', () => ({
  ...jest.requireActual('../modules/feature_flags/services.js'),
  isFlagOn: jest.fn(),
}));

// Override just the two router service fns; keep every other experimentalFeatures.* export intact
// (features.ts does `import * as B` and wires dozens of other handlers).
jest.mock('../services/experimental_features.js', () => ({
  ...jest.requireActual('../services/experimental_features.js'),
  autoRoutePrompt: jest.fn(),
  getRouterStats: jest.fn(),
}));

import { Hono } from 'hono';
import features from '../routes/features.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { autoRoutePrompt, getRouterStats } from '../services/experimental_features.js';

const mockIsFlagOn = isFlagOn as jest.MockedFunction<typeof isFlagOn>;
const mockAutoRoute = autoRoutePrompt as jest.MockedFunction<typeof autoRoutePrompt>;
const mockStats = getRouterStats as jest.MockedFunction<typeof getRouterStats>;

const env = {} as never;

/** Mount `features` behind a seedable-orgId middleware — stands in for the auth middleware. */
function mountWithOrg(orgId?: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (orgId) c.set('orgId', orgId);
    await next();
  });
  app.route('/', features);
  return app;
}

const post = (orgId: string | undefined, path: string, body?: unknown) =>
  mountWithOrg(orgId).request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    },
    env,
  );
const get = (orgId: string | undefined, path: string) => mountWithOrg(orgId).request(path, {}, env);

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFlagOn.mockResolvedValue(true);
  mockAutoRoute.mockResolvedValue({ model: 'claude-sonnet-4-6', shape: 'implement' } as never);
  mockStats.mockResolvedValue({ total: 0, savings_usd: 0 } as never);
});

describe('POST /api/router/pick (model_registry)', () => {
  it('404s (not_found, no leak) when the flag is off + never calls the service', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await post('org-1', '/api/router/pick', { prompt: 'x' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('not_found');
    expect(mockAutoRoute).not.toHaveBeenCalled();
  });

  it('401s when there is no authed org + never calls the service', async () => {
    const res = await post(undefined, '/api/router/pick', { prompt: 'x', org_id: 'org-attacker' });
    expect(res.status).toBe(401);
    expect(mockAutoRoute).not.toHaveBeenCalled();
  });

  it('routes the prompt through with the AUTHED org, ignoring a client org_id (IDOR regression)', async () => {
    const res = await post('org-real', '/api/router/pick', {
      prompt: 'refactor safety',
      org_id: 'org-victim',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: 'claude-sonnet-4-6', shape: 'implement' });
    // orgId is the AUTHED session org, NEVER the client-supplied 'org-victim'
    expect(mockAutoRoute).toHaveBeenCalledWith(env, {
      prompt: 'refactor safety',
      orgId: 'org-real',
    });
  });

  it('falls back to the demo prompt when the body is empty (still the authed org)', async () => {
    const res = await post('org-real', '/api/router/pick', {});
    expect(res.status).toBe(200);
    expect(mockAutoRoute).toHaveBeenCalledWith(env, { prompt: 'demo prompt', orgId: 'org-real' });
  });

  it('400s on a non-string prompt (Zod boundary — promotion retrofit, gotcha #10) + never calls the service', async () => {
    const res = await post('org-real', '/api/router/pick', { prompt: 123 });
    expect(res.status).toBe(400);
    expect(mockAutoRoute).not.toHaveBeenCalled();
  });

  it('400s on an over-long prompt + never calls the service', async () => {
    const res = await post('org-real', '/api/router/pick', { prompt: 'x'.repeat(8001) });
    expect(res.status).toBe(400);
    expect(mockAutoRoute).not.toHaveBeenCalled();
  });
});

describe('GET /api/router/stats (model_registry)', () => {
  it('404s when the flag is off', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const res = await get('org-1', '/api/router/stats');
    expect(res.status).toBe(404);
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('401s when there is no authed org', async () => {
    const res = await get(undefined, '/api/router/stats?org_id=org-attacker');
    expect(res.status).toBe(401);
    expect(mockStats).not.toHaveBeenCalled();
  });

  it('queries stats for the AUTHED org, ignoring a client ?org_id (IDOR regression)', async () => {
    const res = await get('org-real', '/api/router/stats?org_id=org-victim');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ total: 0, savings_usd: 0 });
    expect(mockStats).toHaveBeenCalledWith(env, 'org-real');
  });
});
