/**
 * Unit tests for `clearSiteWfpRegistry` — WfP Site Hosting Work Unit 5
 * (docs/wfp-site-hosting.md §Work units 5 "Teardown"). This is the registry-clear
 * half of teardown: on site delete/archive it soft-deletes the site's
 * `wfp_namespace` registry rows (both preview + production) so a torn-down site
 * leaves no live slot row behind.
 *
 * Under test: the D1 write shape + the fail-soft `{ ok, cleared }` contract.
 *
 * swc-jest hoists `jest.mock` above imports ONLY when it sees the GLOBAL `jest`.
 * From `libs/features/<slug>/__tests__/`, mock paths use FOUR `../` to reach `src/`.
 */

const mockDbExecute = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbExecute: (...a: unknown[]) => mockDbExecute(...a),
}));

import { clearSiteWfpRegistry } from '../service.js';

const SITE = 'abc123de-f012-7abc-9def-0123456789ab';

beforeEach(() => {
  mockDbExecute.mockReset().mockResolvedValue({ error: null, changes: 2 });
});

describe('clearSiteWfpRegistry', () => {
  it('soft-deletes the site’s wfp_namespace registry rows and returns the cleared count', async () => {
    const res = await clearSiteWfpRegistry({ DB: {} } as never, SITE);

    expect(mockDbExecute).toHaveBeenCalledTimes(1);
    const [, sql, params] = mockDbExecute.mock.calls[0] as [unknown, string, unknown[]];
    // Soft-delete (never a hard DELETE), scoped to the site + the wfp concept only.
    expect(sql).toMatch(/UPDATE\s+site_resource_registry/i);
    expect(sql).toMatch(/deleted_at\s*=/i);
    expect(sql).not.toMatch(/^\s*DELETE\s+FROM/i);
    expect(sql).toMatch(/resource_concept\s*=/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i); // don't re-touch already-cleared rows
    expect(params).toContain(SITE);
    expect(params).toContain('wfp_namespace');

    expect(res).toEqual({ ok: true, cleared: 2 });
  });

  it('fail-soft — a D1 error resolves { ok:false } (never throws)', async () => {
    mockDbExecute.mockResolvedValue({ error: 'd1 down', changes: 0 });

    const res = await clearSiteWfpRegistry({ DB: {} } as never, SITE);

    expect(res.ok).toBe(false);
    expect(res.cleared).toBe(0);
  });

  it('idempotent — clearing a site with no rows returns cleared: 0', async () => {
    mockDbExecute.mockResolvedValue({ error: null, changes: 0 });

    const res = await clearSiteWfpRegistry({ DB: {} } as never, SITE);

    expect(res).toEqual({ ok: true, cleared: 0 });
  });
});
