/**
 * GET /api/sites/:siteId/functions — the Functions panel's read-only discovery
 * endpoint (Resources sub-tab #5). Lists a site's CODE-DEFINED Functions on
 * Workers-for-Platforms (its deployed `functions/` worker + its declared crons)
 * from authoritative persisted signals, for the OWNING org only.
 *
 * Contract this suite locks:
 *   - Flag `site_functions` OFF → 404 (never 403 — existence never leaked).
 *   - Unauthenticated → 401.
 *   - Cross-org / missing site → 404 (IDOR guard via assertSiteOwned).
 *   - Authenticated + owned + flag on → 200 with `{ data, functionsDeployed, wfpConfigured }`:
 *       • a deployed site → one `http` row (real WfP script name + bundle bytes from
 *         the R2 bundle) PLUS one `scheduled` row per `site_functions_schedules` cron.
 *       • a site with NO deployed functions AND no crons → honest-empty `data: []`
 *         (functionsDeployed:false), NOT a fabricated row.
 *
 * Mocks `isFlagOn` + `assertSiteOwned` + the WfP config/name helpers + the R2
 * bundle read at the module boundary (4-level `../` to reach src/, global `jest`
 * for @swc hoisting — per apps/project-sites/CLAUDE.md gotchas 11+12). D1 is stubbed
 * at `env.DB` so the handler's real `dbQuery`/`dbQueryOne` SELECTs run against
 * captured rows (sites deploy signal + schedule rows).
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { siteFunctions } from '../../libs/features/site_functions/handlers.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { assertSiteOwned } from '../services/site_ownership.js';
import { isWfpConfigured, siteFunctionsScriptName } from '../services/wfp_dispatch.js';
import { readFunctionsBundle } from '../services/functions_deploy.js';

jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(),
}));
jest.mock('../services/site_ownership.js', () => ({
  assertSiteOwned: jest.fn(),
}));
jest.mock('../services/wfp_dispatch.js', () => ({
  isWfpConfigured: jest.fn(),
  siteFunctionsScriptName: jest.fn((siteId: string) => `site-${siteId}`),
}));
jest.mock('../services/functions_deploy.js', () => ({
  readFunctionsBundle: jest.fn(),
}));

const mockIsFlagOn = isFlagOn as jest.Mock;
const mockAssertSiteOwned = assertSiteOwned as jest.Mock;
const mockIsWfpConfigured = isWfpConfigured as jest.Mock;
const mockScriptName = siteFunctionsScriptName as jest.Mock;
const mockReadBundle = readFunctionsBundle as jest.Mock;

/**
 * Minimal D1 stub that services the handler's two reads. Both go through the repo
 * `dbQuery` helper, which ONLY calls `.all()` → `{ results }` (dbQueryOne then takes
 * `results[0]`). So BOTH reads are serviced from `.all()`, routed by SQL text:
 *   - SELECT functions_deployed_at FROM sites …     → one deploy row (or none)
 *   - SELECT cron FROM site_functions_schedules …   → the schedule rows
 * Captures bind params for assertions.
 */
function makeDbStub(opts: {
  functionsDeployedAt: string | null;
  schedules: { cron: string }[];
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          const isSites = /FROM sites/i.test(sql);
          const isSchedules = /FROM site_functions_schedules/i.test(sql);
          return {
            all: async () => {
              if (isSites) {
                // dbQueryOne reads results[0]; return the deploy row only when deployed.
                return {
                  results:
                    opts.functionsDeployedAt !== null
                      ? [{ functions_deployed_at: opts.functionsDeployedAt }]
                      : [{ functions_deployed_at: null }],
                };
              }
              if (isSchedules) return { results: opts.schedules };
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return { db: db as unknown as Env['DB'], calls };
}

function makeApp(vars: Partial<Variables>, env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.orgId) c.set('orgId', vars.orgId);
    c.set('requestId', vars.requestId ?? 'test-req');
    await next();
  });
  app.route('/', siteFunctions);
  return (path: string) => app.request(path, {}, env as Env);
}

describe('GET /api/sites/:siteId/functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
    mockIsWfpConfigured.mockReturnValue(true);
    mockScriptName.mockImplementation((siteId: string) => `site-${siteId}`);
    mockReadBundle.mockResolvedValue(null);
  });

  it('404s when the flag is OFF (never leaks existence)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const { db } = makeDbStub({ functionsDeployedAt: null, schedules: [] });
    const req = makeApp({ orgId: 'org-1' }, { DB: db });
    const res = await req('/api/sites/site-1/functions');
    expect(res.status).toBe(404);
    // Ownership + store are never touched once the flag gate rejects.
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
  });

  it('requires authentication (401 with no org)', async () => {
    const { db } = makeDbStub({ functionsDeployedAt: null, schedules: [] });
    const req = makeApp({}, { DB: db });
    const res = await req('/api/sites/site-1/functions');
    expect(res.status).toBe(401);
  });

  it('404s for a cross-org / missing site (IDOR guard)', async () => {
    mockAssertSiteOwned.mockResolvedValue(false);
    const { db } = makeDbStub({ functionsDeployedAt: '2026-10-08T00:00:00.000Z', schedules: [] });
    const req = makeApp({ orgId: 'intruder' }, { DB: db });
    const res = await req('/api/sites/site-1/functions');
    expect(res.status).toBe(404);
    expect(mockAssertSiteOwned).toHaveBeenCalledWith(expect.anything(), 'intruder', 'site-1');
  });

  it('returns the deployed HTTP worker + scheduled rows from real signals', async () => {
    mockReadBundle.mockResolvedValue('export default { fetch(){} }'); // 28 bytes of real bundle
    const { db, calls } = makeDbStub({
      functionsDeployedAt: '2026-10-08T12:00:00.000Z',
      schedules: [{ cron: '0 * * * *' }, { cron: '*/15 * * * *' }],
    });
    const req = makeApp({ orgId: 'org-1' }, { DB: db });
    const res = await req('/api/sites/site-1/functions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        kind: string;
        name: string;
        status: string;
        cron: string | null;
        bundleBytes: number | null;
        deployed_at: string | null;
      }>;
      functionsDeployed: boolean;
      wfpConfigured: boolean;
    };

    expect(body.functionsDeployed).toBe(true);
    expect(body.wfpConfigured).toBe(true);
    // One http deployment unit + two scheduled crons.
    expect(body.data).toHaveLength(3);

    const http = body.data.find((d) => d.kind === 'http')!;
    expect(http).toEqual({
      id: 'site-site-1',
      kind: 'http',
      name: 'site-site-1',
      status: 'deployed',
      cron: null,
      bundleBytes: 28,
      deployed_at: '2026-10-08T12:00:00.000Z',
    });

    const scheduled = body.data.filter((d) => d.kind === 'scheduled');
    expect(scheduled.map((s) => s.cron)).toEqual(['0 * * * *', '*/15 * * * *']);
    expect(scheduled[0]).toEqual({
      id: 'cron:0 * * * *',
      kind: 'scheduled',
      name: '0 * * * *',
      status: 'deployed',
      cron: '0 * * * *',
      bundleBytes: null,
      deployed_at: '2026-10-08T12:00:00.000Z',
    });

    // Schedule query is scoped to the site (display reconciles with the store).
    const scheduleCall = calls.find((c) => /FROM site_functions_schedules/i.test(c.sql));
    expect(scheduleCall?.params).toContain('site-1');
  });

  it('honest-empty: 200 + [] when the site has no deployed functions and no crons', async () => {
    const { db } = makeDbStub({ functionsDeployedAt: null, schedules: [] });
    const req = makeApp({ orgId: 'org-1' }, { DB: db });
    const res = await req('/api/sites/site-1/functions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      functionsDeployed: boolean;
      wfpConfigured: boolean;
    };
    expect(body.data).toEqual([]);
    expect(body.functionsDeployed).toBe(false);
    // No bundle read attempted when nothing is deployed (no phantom worker row).
    expect(mockReadBundle).not.toHaveBeenCalled();
  });

  it('reports wfpConfigured:false honestly when WfP is not provisioned', async () => {
    mockIsWfpConfigured.mockReturnValue(false);
    const { db } = makeDbStub({ functionsDeployedAt: null, schedules: [] });
    const req = makeApp({ orgId: 'org-1' }, { DB: db });
    const res = await req('/api/sites/site-1/functions');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { wfpConfigured: boolean }).wfpConfigured).toBe(false);
  });
});
