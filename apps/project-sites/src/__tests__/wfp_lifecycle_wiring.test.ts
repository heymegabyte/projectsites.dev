/**
 * Unit tests for `deploySiteWfpSlotsOnLifecycle` — WfP Site Hosting Work Unit 4
 * (docs/wfp-site-hosting.md §Work units 4 "Wire lifecycle").
 *
 * Under test: the thin, fail-soft lifecycle helper the site build/publish path
 * calls to give a site its WfP slots — the PREVIEW slot after `upload-final`
 * (build success) and the PRODUCTION slot on publish/promote. It is ADDITIVE and
 * flag-gated: with `site_wfp_hosting` OFF it makes ZERO WfP calls (the build/publish
 * path is byte-identical); with it ON it calls `deploySiteToWfp` for each requested
 * slot. A WfP deploy failure NEVER propagates — the helper resolves a typed summary,
 * never throws, so the build/publish is never failed by a WfP miss (R2 stays served).
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

const mockDeploySiteToWfp = jest.fn();
jest.mock('../services/wfp_site_hosting.js', () => {
  const actual = jest.requireActual('../services/wfp_site_hosting.js');
  return {
    ...actual,
    deploySiteToWfp: (...a: unknown[]) => mockDeploySiteToWfp(...a),
  };
});

import { deploySiteWfpSlotsOnLifecycle } from '../services/wfp_site_hosting.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const OWNER_ORG = 'org_owner';
const SITE = 'abc123de-f012-7abc-9def-0123456789ab';

function env(): Record<string, unknown> {
  return { DB: {}, SITES_BUCKET: {} };
}

beforeEach(() => {
  mockIsFlagOn.mockReset().mockResolvedValue(true);
  mockDeploySiteToWfp
    .mockReset()
    .mockResolvedValue({ ok: true, scriptName: 'site-x', slot: 'production', version: 'v2' });
});

describe('deploySiteWfpSlotsOnLifecycle', () => {
  it('flag OFF → makes NO WfP call (build/publish path byte-identical)', async () => {
    mockIsFlagOn.mockResolvedValue(false);

    const res = await deploySiteWfpSlotsOnLifecycle(env() as never, SITE, {
      orgId: OWNER_ORG,
      slots: ['preview', 'production'],
      version: 'v2',
    });

    expect(mockIsFlagOn).toHaveBeenCalledWith(expect.anything(), 'site_wfp_hosting', {
      orgId: OWNER_ORG,
      siteId: SITE,
    });
    expect(mockDeploySiteToWfp).not.toHaveBeenCalled();
    expect(res.attempted).toBe(false);
  });

  it('flag ON → deploys the PREVIEW slot on build success (the upload-final path)', async () => {
    const res = await deploySiteWfpSlotsOnLifecycle(env() as never, SITE, {
      orgId: OWNER_ORG,
      slots: ['preview'],
      version: 'v2',
    });

    expect(mockDeploySiteToWfp).toHaveBeenCalledTimes(1);
    expect(mockDeploySiteToWfp).toHaveBeenCalledWith(expect.anything(), SITE, {
      orgId: OWNER_ORG,
      slot: 'preview',
      version: 'v2',
    });
    expect(res.attempted).toBe(true);
    expect(res.results.preview?.ok).toBe(true);
  });

  it('flag ON → deploys the PRODUCTION slot on publish/promote', async () => {
    await deploySiteWfpSlotsOnLifecycle(env() as never, SITE, {
      orgId: OWNER_ORG,
      slots: ['production'],
      version: 'v2',
    });
    expect(mockDeploySiteToWfp).toHaveBeenCalledWith(expect.anything(), SITE, {
      orgId: OWNER_ORG,
      slot: 'production',
      version: 'v2',
    });
  });

  it('flag ON → deploys BOTH slots when both are requested (finalize-build path)', async () => {
    await deploySiteWfpSlotsOnLifecycle(env() as never, SITE, {
      orgId: OWNER_ORG,
      slots: ['preview', 'production'],
      version: 'v2',
    });
    expect(mockDeploySiteToWfp).toHaveBeenCalledTimes(2);
    const slots = mockDeploySiteToWfp.mock.calls.map((c) => (c[2] as { slot: string }).slot);
    expect(slots).toEqual(['preview', 'production']);
  });

  it('a WfP deploy FAILURE does NOT throw (fail-soft — build/publish is never failed)', async () => {
    mockDeploySiteToWfp.mockResolvedValue({ ok: false, error: 'wfp_not_configured' });

    const res = await deploySiteWfpSlotsOnLifecycle(env() as never, SITE, {
      orgId: OWNER_ORG,
      slots: ['production'],
      version: 'v2',
    });

    // Resolved, not thrown; the failure is captured in the summary.
    expect(res.attempted).toBe(true);
    expect(res.results.production?.ok).toBe(false);
  });

  it('a THROW inside deploySiteToWfp is swallowed (fail-soft)', async () => {
    mockDeploySiteToWfp.mockRejectedValue(new Error('boom'));

    await expect(
      deploySiteWfpSlotsOnLifecycle(env() as never, SITE, {
        orgId: OWNER_ORG,
        slots: ['production'],
        version: 'v2',
      }),
    ).resolves.toBeDefined();
  });

  it('no orgId (unowned) → no WfP call, no flag read', async () => {
    const res = await deploySiteWfpSlotsOnLifecycle(env() as never, SITE, {
      orgId: undefined,
      slots: ['production'],
      version: 'v2',
    });
    expect(mockIsFlagOn).not.toHaveBeenCalled();
    expect(mockDeploySiteToWfp).not.toHaveBeenCalled();
    expect(res.attempted).toBe(false);
  });
});
