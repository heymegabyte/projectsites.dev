/**
 * GET /api/sites/:siteId/claude-code/status — WLK-39 S7-prep (the embedded "Claude Code" tab's
 * real dark-flag resolver, replacing the S0 default-OFF client constant).
 *
 * Contract this suite locks (a RESOLUTION endpoint — reports a boolean for the caller's OWN site,
 * so an owned site gets the honest value, never a 404 for the off case):
 *   - Authenticated + owned + flag OFF → 200 `{ data: { enabled: false } }` (console-clean dark path;
 *     the admin keeps the tab hidden). NO browser 404.
 *   - Authenticated + owned + flag ON → 200 `{ data: { enabled: true } }` → the tab may render.
 *   - Cross-org / missing site → 404 "Site not found" (IDOR guard), FLAG-AGNOSTIC.
 *   - Unauthenticated → 401.
 *   - Ownership runs BEFORE the flag resolve — a non-owner can never distinguish flag-off from
 *     flag-on (both → the same 404), so returning the honest boolean to the owner leaks nothing.
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

  it('returns { data: { enabled: false } } (200, console-clean) when authed + owned + flag OFF', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const req = makeApp({ orgId: 'org-1' });
    const res = await req('/api/sites/site-1/claude-code/status');
    // A RESOLUTION endpoint answers the owner honestly — NO 404 for the dark case (no browser console
    // error); the admin reads enabled:false and keeps the tab hidden.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { enabled?: boolean } };
    expect(body.data).toEqual({ enabled: false });
    // Ownership runs BEFORE the flag resolve now.
    expect(mockAssertSiteOwned).toHaveBeenCalledWith(expect.anything(), 'org-1', 'site-1');
  });

  it('requires authentication (401 with no org — neither ownership nor flag touched)', async () => {
    const req = makeApp({});
    const res = await req('/api/sites/site-1/claude-code/status');
    expect(res.status).toBe(401);
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
    expect(mockIsFlagOn).not.toHaveBeenCalled();
  });

  it('404s "Site not found" for a cross-org / missing site, FLAG-AGNOSTIC (IDOR guard before flag)', async () => {
    mockAssertSiteOwned.mockResolvedValue(false);
    const req = makeApp({ orgId: 'intruder' });
    const res = await req('/api/sites/site-1/claude-code/status');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toMatch(/not found/i);
    expect(mockAssertSiteOwned).toHaveBeenCalledWith(expect.anything(), 'intruder', 'site-1');
    // Ownership precedes the flag — a non-owner never even triggers flag resolution, so flag-off and
    // flag-on are indistinguishable to them (both → this same 404). No info leak.
    expect(mockIsFlagOn).not.toHaveBeenCalled();
  });

  it('returns { data: { enabled: true } } when authed + owned + flag ON', async () => {
    const req = makeApp({ orgId: 'org-1' });
    const res = await req('/api/sites/site-1/claude-code/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { enabled?: boolean } };
    expect(body.data).toEqual({ enabled: true });
    // Flag resolved with the owned-site scope so an org/tenant override can promote it per-tenant.
    expect(mockIsFlagOn).toHaveBeenCalledWith(expect.anything(), 'claude_code_panel', {
      orgId: 'org-1',
      siteId: 'site-1',
    });
  });
});
