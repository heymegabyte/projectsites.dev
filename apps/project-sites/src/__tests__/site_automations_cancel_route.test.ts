/**
 * POST /api/sites/:siteId/automations/:id/cancel — RES-AUTO slice 4 (the Automations
 * panel's CANCEL mutation). Marks a RUNNING/QUEUED `workflow_jobs` row `cancelled`
 * (+ `cancel_requested=1` so the workflow can honor it) and best-effort terminates the
 * CF Workflow instance, for the OWNING org only, flag-gated identically to the slice-1 GET.
 * Mirrors the retry route 1:1 (reuse-not-reimplement) — same gate order, same mocks.
 *
 * Contract this suite locks:
 *   - Flag `site_automations` OFF → 404 (never 403 — existence never leaked), and the
 *     store/ownership are never touched once the flag gate rejects.
 *   - Unauthenticated → 401.
 *   - Cross-org / missing site → 404 (IDOR guard via assertSiteOwned).
 *   - Authenticated + owned + flag on + a running/queued job → 200 `{ ok:true,
 *     status:'cancelled' }`, the job row flips to `status='cancelled'` + `cancel_requested=1`,
 *     and SITE_WORKFLOW.get(instance).terminate() is attempted once (best-effort).
 *   - A job NOT in a cancellable state (success/failed) → 409 conflict, no terminate.
 *   - Workflow binding absent (or terminate throws) → still 200 (row cancel stands; graceful).
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

interface JobRow {
  id: string;
  site_id: string;
  status: string;
}

/**
 * Minimal D1 stub. A `SELECT … FROM workflow_jobs` returns the single job row (via
 * `.first()` — `dbQueryOne` reads `results[0]`/`first()`); the `SELECT latest_workflow_instance
 * FROM sites` returns the instance pointer; every other statement (the UPDATE, audit INSERTs)
 * resolves truthy. Captures run() calls so the test can assert the cancel flip happened.
 */
function makeDbStub(job: JobRow | null, instancePointer = 'inst-1') {
  const runs: { sql: string; params: unknown[] }[] = [];
  const db = {
    prepare(sql: string) {
      const isJob = /FROM workflow_jobs/i.test(sql);
      const isSitePtr = /latest_workflow_instance\s+FROM sites/i.test(sql);
      const firstRow = isJob
        ? job
        : isSitePtr
          ? { latest_workflow_instance: instancePointer }
          : null;
      const results = firstRow ? [firstRow] : [];
      return {
        bind(...params: unknown[]) {
          return {
            first: async () => firstRow,
            all: async () => ({ results }),
            run: async () => {
              runs.push({ sql, params });
              return { success: true };
            },
          };
        },
        first: async () => firstRow,
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

/** SITE_WORKFLOW spy whose get() returns an instance with a terminate() spy. */
function makeWorkflowSpy(terminateImpl?: () => Promise<void>) {
  const terminate = jest.fn(terminateImpl ?? (async () => undefined));
  const get = jest.fn(async (id: string) => ({ id, terminate }));
  return { workflow: { get } as unknown as Env['SITE_WORKFLOW'], get, terminate };
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

const jobRow = (status: string = 'running'): JobRow => ({
  id: 'job-1',
  site_id: 'site-1',
  status,
});

describe('POST /api/sites/:siteId/automations/:id/cancel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFlagOn.mockResolvedValue(true);
    mockAssertSiteOwned.mockResolvedValue(true);
  });

  it('404s when the flag is OFF (never leaks existence)', async () => {
    mockIsFlagOn.mockResolvedValue(false);
    const { db } = makeDbStub(jobRow());
    const { workflow } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(404);
    // Ownership is never touched once the flag gate rejects.
    expect(mockAssertSiteOwned).not.toHaveBeenCalled();
  });

  it('requires authentication (401 with no org)', async () => {
    const { db } = makeDbStub(jobRow());
    const req = makeApp({}, { DB: db });
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(401);
  });

  it('404s for a cross-org / missing site (IDOR guard)', async () => {
    mockAssertSiteOwned.mockResolvedValue(false);
    const { db } = makeDbStub(jobRow());
    const { workflow, terminate } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'intruder' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(404);
    expect(mockAssertSiteOwned).toHaveBeenCalledWith(expect.anything(), 'intruder', 'site-1');
    // No workflow is terminated for a non-owned site.
    expect(terminate).not.toHaveBeenCalled();
  });

  it('404s when the owned job row does not exist for this site', async () => {
    const { db } = makeDbStub(null); // no matching workflow_jobs row
    const { workflow, terminate } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/missing/cancel');
    expect(res.status).toBe(404);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('cancels a RUNNING job: flips status=cancelled + cancel_requested + best-effort terminate', async () => {
    const { db, runs } = makeDbStub(jobRow('running'));
    const { workflow, get, terminate } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status?: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('cancelled');
    // The job row was flipped to cancelled AND cancel_requested was set (the workflow honors it).
    const flipped = runs.find(
      (r) => /UPDATE workflow_jobs/i.test(r.sql) && /cancelled/i.test(r.sql),
    );
    expect(flipped).toBeTruthy();
    expect(flipped!.sql).toMatch(/cancel_requested/i);
    // Best-effort terminate of the resolved instance, exactly once.
    expect(get).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('cancels a QUEUED job too (queued is a cancellable in-flight state)', async () => {
    const { db, runs } = makeDbStub(jobRow('queued'));
    const { workflow } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status?: string }).status).toBe('cancelled');
    expect(runs.find((r) => /UPDATE workflow_jobs/i.test(r.sql))).toBeTruthy();
  });

  it('refuses to cancel a terminal job (success) — 409 conflict, no terminate', async () => {
    const { db } = makeDbStub(jobRow('success'));
    const { workflow, terminate } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(409);
    expect(terminate).not.toHaveBeenCalled();
  });

  it('refuses to cancel a terminal job (failed) — 409 conflict', async () => {
    const { db } = makeDbStub(jobRow('failed'));
    const { workflow } = makeWorkflowSpy();
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(409);
  });

  it('is graceful when the SITE_WORKFLOW binding is absent (still 200, row cancel stands)', async () => {
    const { db, runs } = makeDbStub(jobRow('running'));
    const req = makeApp({ orgId: 'org-1' }, { DB: db }); // no SITE_WORKFLOW
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(
      runs.find((r) => /UPDATE workflow_jobs/i.test(r.sql) && /cancelled/i.test(r.sql)),
    ).toBeTruthy();
  });

  it('is graceful when terminate() throws (already terminal instance) — still 200, row cancel stands', async () => {
    const { db, runs } = makeDbStub(jobRow('running'));
    const { workflow, terminate } = makeWorkflowSpy(async () => {
      throw new Error('instance already terminated');
    });
    const req = makeApp({ orgId: 'org-1' }, { DB: db, SITE_WORKFLOW: workflow });
    const res = await req('/api/sites/site-1/automations/job-1/cancel');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(
      runs.find((r) => /UPDATE workflow_jobs/i.test(r.sql) && /cancelled/i.test(r.sql)),
    ).toBeTruthy();
  });
});
