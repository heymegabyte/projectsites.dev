/**
 * POST /api/sites/:siteId/automations/:id/retry — RES-AUTO slice 3 (the Automations
 * panel's RETRY mutation). Re-dispatches the site's `SITE_WORKFLOW` the SAME way
 * `POST /api/sites/:id/reset` does (reuse `reDispatchSiteWorkflow`), for the OWNING
 * org only, flag-gated identically to the slice-1 GET.
 *
 * Contract this suite locks:
 *   - Flag `site_automations` OFF → 404 (never 403 — existence never leaked), and the
 *     store/ownership are never touched once the flag gate rejects.
 *   - Unauthenticated → 401.
 *   - Cross-org / missing site → 404 (IDOR guard via assertSiteOwned).
 *   - Authenticated + owned + flag on → 200 `{ ok:true, status:'building' }`, the site
 *     row flips to `status='building'`, and SITE_WORKFLOW.create() is called once.
 *   - Workflow binding absent → 200 `{ ok:true }` (status still flips; graceful — mirrors reset).
 *
 * Mocks `isFlagOn` + `assertSiteOwned` at the module boundary (4-level `../` to reach
 * src/, GLOBAL `jest` for @swc hoisting — per apps/project-sites/CLAUDE.md gotchas 11+12).
 * D1 is stubbed at `env.DB`; SITE_WORKFLOW is a spy.
 */
import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { errorHandler } from '../middleware/error_handler.js';
import { siteAutomations } from '../../libs/features/site_automations/handlers.js';
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

interface SiteRow {
  id: string;
  slug: string;
  org_id: string;
  status: string | null;
}

/**
 * Minimal D1 stub. `SELECT … FROM sites` returns the single owner row (via `.all()` —
 * `dbQueryOne` reads `results[0]`); every other statement (the UPDATE, audit INSERTs)
 * resolves truthy. Captures run() calls so the test can assert the status flip happened.
 */
function makeDbStub(site: SiteRow | null) {
  const runs: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const results = /FROM sites/i.test(sql) && site ? [site] : [];
      return {
        bind(...params: unknown[]) {
          return {
            first: async () => (/FROM sites/i.test(sql) ? site : null),
            all: async () => ({ results }),
            run: async () => {
              runs.push({ sql, params });
              return { success: true };
            },
          };
        },
        first: async () => (/FROM sites/i.test(sql) ? site : null),
        all: async () => ({ results }),
        run: async () => {
          runs.push({ sql, params: [] });
          return { success: true };
        },
      };
    },
  };
  return { db: db as unknown as Env['DB'], runs };
}

/** SITE_WORKFLOW spy whose create() returns a deterministic instance id. */
function makeWorkflowSpy() {
  const create = jest.fn(async (opts: { id: string }) => ({ id: opts.id }));
  return { workflow: { create } as unknown as Env['SITE_WORKFLOW'], create };
}

function makeApp(vars: Partial<Variables>, env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    if (vars.orgId) c.set('orgId', vars.orgId);
    c.set('requestId', vars.requestId ?? 'test-req');
    await next();
  });
  app.route('/', siteAutomations);
  return (path: string) => app.request(path, { method: 'POST' }, env as Env);
}

const siteRow = (status: string | null = 'error'): SiteRow => ({
  id: 'site-1',
  slug: 'vitos',
  org_id: 'org-1',
  status,
});

describe('POST /api/sites/:siteId/automations/:id/retry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
  });

  it('404s when the flag is OFF (never leaks existence)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const { db } = makeDbStub(siteRow());
    const { workflow } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/retry');
    expect(res.status).toBe(404);
    // Ownership is never touched once the flag gate rejects.
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
  });

  it('requires authentication (401 with no org)', async () => {
    const { db } = makeDbStub(siteRow());
    const req = makeApp({}, { DB: db });
    const res = await req('/api/sites/site-1/automations/job-1/retry');
    expect(res.status).toBe(401);
  });

  it('404s for a cross-org / missing site (IDOR guard)', async () => {
    mockAssertSiteOwned.mockResolvedValue(false);
    const { db } = makeDbStub(siteRow());
    const { workflow, create } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'intruder' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/retry');
    expect(res.status).toBe(404);
    expect(mockAssertSiteOwned).toHaveBeenCalledWith(expect.anything(), 'intruder', 'site-1');
    // No workflow is dispatched for a non-owned site.
    expect(create).not.toHaveBeenCalled();
  });

  it('re-dispatches the site workflow + flips status to building (owned, flag on)', async () => {
    const { db, runs } = makeDbStub(siteRow('error'));
    const { workflow, create } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/retry');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status?: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('building');
    // The workflow was re-dispatched exactly once (same mechanism as reset).
    expect(create).toHaveBeenCalledTimes(1);
    // The site row was flipped to building.
    const flipped = runs.find((r) => /UPDATE sites/i.test(r.sql) && /building/i.test(r.sql));
    expect(flipped).toBeTruthy();
  });

  it('is graceful when the SITE_WORKFLOW binding is absent (still 200, status flips)', async () => {
    const { db, runs } = makeDbStub(siteRow('error'));
    const req = makeApp({ orgId: 'org-1' }, { DB: db }); // no SITE_WORKFLOW
    const res = await req('/api/sites/site-1/automations/job-1/retry');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(runs.find((r) => /UPDATE sites/i.test(r.sql))).toBeTruthy();
  });

  it('refuses when a build is already in flight (409 conflict)', async () => {
    const { db } = makeDbStub(siteRow('building'));
    const { workflow, create } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/retry');
    expect(res.status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });
});
