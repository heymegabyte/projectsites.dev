/**
 * Unit tests for `teardownSiteWfp` — WfP Site Hosting Work Unit 5
 * (docs/wfp-site-hosting.md §Work units 5 "Teardown").
 *
 * Under test: the thin, fail-soft, flag-gated teardown hook the site delete/archive
 * paths call to REMOVE a site's WfP footprint — it deletes BOTH dispatch slots
 * (production `site-<id>` AND preview `site-<id>-preview`) from the shared
 * `USER_DISPATCH` namespace AND clears the site's `wfp_namespace` registry rows.
 *
 * Contract:
 *  - Flag OFF → ZERO WfP calls, ZERO registry writes (delete/archive path byte-identical).
 *  - Flag ON  → deletes BOTH slots (reuses `deleteSiteFunctionsWorker`) + clears the registry.
 *  - Idempotent — deleting an already-absent slot is a no-op success (delete never throws).
 *  - Fail-soft — a teardown error (slot delete throw OR registry-clear throw) is swallowed;
 *    `teardownSiteWfp` NEVER throws into the delete/archive path.
 *  - No orgId (unowned) → skip: no flag read, no WfP calls.
 *
 * swc-jest hoists `jest.mock` above imports ONLY when it sees the GLOBAL `jest`
 * (do NOT import `jest` from @jest/globals). From `src/__tests__/`, mock paths use
 * ONE `../` to reach `src/`.
 */

// ─── Mocks (must precede the SUT import) ──────────────────────────────────────
const mockIsFlagOn = jest.fn();
jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: (...a: unknown[]) => mockIsFlagOn(...a),
}));

const mockDeleteSlot = jest.fn();
jest.mock('../services/wfp_dispatch.js', () => {
  const actual = jest.requireActual('../services/wfp_dispatch.js');
  return {
    ...actual,
    deleteSiteFunctionsWorker: (...a: unknown[]) => mockDeleteSlot(...a),
  };
});

const mockClearRegistry = jest.fn();
jest.mock('../../libs/features/data_resource_registry/service.js', () => ({
  clearSiteWfpRegistry: (...a: unknown[]) => mockClearRegistry(...a),
}));

import { teardownSiteWfp } from '../services/wfp_site_hosting.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const OWNER_ORG = 'org_owner';
const SITE = 'abc123de-f012-7abc-9def-0123456789ab';

function env(): Record<string, unknown> {
  return { DB: {}, USER_DISPATCH: {} };
}

beforeEach(() => {
  mockIsFlagOn.mockReset().mockResolvedValue(true);
  mockDeleteSlot.mockReset().mockResolvedValue(undefined);
  mockClearRegistry.mockReset().mockResolvedValue({ ok: true, cleared: 2 });
});

describe('teardownSiteWfp', () => {
  it('flag OFF → makes NO WfP call and NO registry write (delete/archive byte-identical)', async () => {
    mockIsFlagOn.mockResolvedValue(false);

    const res = await teardownSiteWfp(env() as never, SITE, { orgId: OWNER_ORG });

    expect(mockIsFlagOn).toHaveBeenCalledWith(expect.anything(), 'site_wfp_hosting', {
      orgId: OWNER_ORG,
      siteId: SITE,
    });
    expect(mockDeleteSlot).not.toHaveBeenCalled();
    expect(mockClearRegistry).not.toHaveBeenCalled();
    expect(res.attempted).toBe(false);
  });

  it('flag ON → deletes BOTH slots (production + preview) and clears the registry', async () => {
    const res = await teardownSiteWfp(env() as never, SITE, { orgId: OWNER_ORG });

    // Both dispatch slots deleted — production (default) + preview.
    expect(mockDeleteSlot).toHaveBeenCalledTimes(2);
    expect(mockDeleteSlot).toHaveBeenCalledWith(expect.anything(), SITE, { preview: false });
    expect(mockDeleteSlot).toHaveBeenCalledWith(expect.anything(), SITE, { preview: true });

    // Registry rows cleared for the site.
    expect(mockClearRegistry).toHaveBeenCalledTimes(1);
    expect(mockClearRegistry).toHaveBeenCalledWith(expect.anything(), SITE);

    expect(res.attempted).toBe(true);
    expect(res.slotsDeleted).toBe(2);
    expect(res.registryCleared).toBe(2);
  });

  it('idempotent — deleting an already-absent slot is a no-op success (delete resolves undefined)', async () => {
    // deleteSiteFunctionsWorker is best-effort + returns undefined even when the slot is gone.
    mockDeleteSlot.mockResolvedValue(undefined);
    mockClearRegistry.mockResolvedValue({ ok: true, cleared: 0 });

    const res = await teardownSiteWfp(env() as never, SITE, { orgId: OWNER_ORG });

    expect(mockDeleteSlot).toHaveBeenCalledTimes(2);
    expect(res.attempted).toBe(true);
    // No throw, both slots "deleted", registry clear reported 0 rows — clean no-op.
    expect(res.registryCleared).toBe(0);
  });

  it('a slot-delete THROW is swallowed — teardown never throws into delete/archive', async () => {
    mockDeleteSlot.mockRejectedValue(new Error('cf boom'));

    await expect(
      teardownSiteWfp(env() as never, SITE, { orgId: OWNER_ORG }),
    ).resolves.toBeDefined();

    // The registry clear still runs even after a slot-delete throw.
    expect(mockClearRegistry).toHaveBeenCalledTimes(1);
  });

  it('a registry-clear THROW is swallowed — teardown never throws into delete/archive', async () => {
    mockClearRegistry.mockRejectedValue(new Error('d1 boom'));

    const res = await teardownSiteWfp(env() as never, SITE, { orgId: OWNER_ORG });

    expect(res).toBeDefined();
    // Slots were still deleted despite the registry-clear failure.
    expect(mockDeleteSlot).toHaveBeenCalledTimes(2);
  });

  it('no orgId (unowned) → skip: no flag read, no WfP call, no registry write', async () => {
    const res = await teardownSiteWfp(env() as never, SITE, { orgId: undefined });

    expect(mockIsFlagOn).not.toHaveBeenCalled();
    expect(mockDeleteSlot).not.toHaveBeenCalled();
    expect(mockClearRegistry).not.toHaveBeenCalled();
    expect(res.attempted).toBe(false);
  });
});
