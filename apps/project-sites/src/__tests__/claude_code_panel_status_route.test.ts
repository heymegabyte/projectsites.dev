/**
 * GET /api/sites/:siteId/claude-code/status — WLK-39 S7-prep (the embedded "Claude Code" tab's
 * real dark-flag resolver, replacing the S0 default-OFF client constant).
 *
 * Contract this suite locks (mirrors the `per_site_data` dark-flag path):
 *   - Flag `claude_code_panel` OFF → 404 whose message says "not enabled" (never 403 — existence
 *     never leaked). This is the signal the admin translates to `{ enabled:false }` so the tab hides.
 *   - Authenticated + owned + flag ON → 200 with `{ data: { enabled: true } }` → the tab may render.
 *   - Cross-org / missing site → 404 (IDOR guard via assertSiteOwned).
 *   - Unauthenticated → 401.
 *   - The flag gate runs BEFORE ownership (an off flag never even touches assertSiteOwned).
 *
 * Mocks `isFlagOn` + `assertSiteOwned` at the module boundary (2-level `../` reaches src/ from
 * src/__tests__/; global `jest` for @swc hoisting — per apps/project-sites/CLAUDE.md gotchas 11+12).
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { claudeCodePanel } from '../../libs/features/claude_code_panel/handlers.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { assertSiteOwned } from '../services/site_ownership.js';

jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../services/site_ownership.js', () => ({
  assertSiteOwned: jest.fn(),
}));

const mockIsFlagOn = isFlagOn as jest.Mock;
const mockAssertSiteOwned = assertSiteOwned as jest.Mock;

function makeApp(vars: Partial<Variables>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.orgId) c.set('orgId', vars.orgId);
    c.set('requestId', vars.requestId ?? 'test-req');
    await next();
  });
  app.route('/', claudeCodePanel);
  return (path: string) => app.request(path, {}, {} as Env);
}

describe('GET /api/sites/:siteId/claude-code/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
  });

  it('404s with "not enabled" when the flag is OFF (never leaks existence; ownership untouched)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const req = makeApp({ orgId: 'org-1' });
    const res = await req('/api/sites/site-1/claude-code/status');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/not enabled/i);
    // The flag gate runs BEFORE ownership — an off flag never even touches assertSiteOwned.
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
  });

  it('requires authentication (401 with no org)', async () => {
    const req = makeApp({});
    const res = await req('/api/sites/site-1/claude-code/status');
    expect(res.status).toBe(401);
    expect(mockIsFlagOn).not.toHaveBeenCalled();
  });

  it('404s for a cross-org / missing site (IDOR guard)', async () => {
    mockAssertSiteOwned.mockResolvedValue(false);
    const req = makeApp({ orgId: 'intruder' });
    const res = await req('/api/sites/site-1/claude-code/status');
    expect(res.status).toBe(404);
    expect(mockAssertSiteOwned).toHaveBeenCalledWith(expect.anything(), 'intruder', 'site-1');
  });

  it('returns { data: { enabled: true } } when authed + owned + flag ON', async () => {
    const req = makeApp({ orgId: 'org-1' });
    const res = await req('/api/sites/site-1/claude-code/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { enabled?: boolean } };
    expect(body.data).toEqual({ enabled: true });
    // Flag resolved with the owned-site scope so an org/tenant override can promote it per-tenant.
    expect(mockIsFlagOn).toHaveBeenCalledWith(
      expect.anything(),
      'claude_code_panel',
      { orgId: 'org-1', siteId: 'site-1' },
    );
  });
});
