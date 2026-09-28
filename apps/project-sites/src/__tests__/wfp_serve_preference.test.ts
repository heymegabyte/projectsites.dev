/**
 * Unit tests for `serveSiteViaWfpIfPreferred` — WfP Site Hosting Work Unit 3
 * (docs/wfp-site-hosting.md §Work units 3 "Serving preference").
 *
 * Under test: the additive, flag-gated preference branch in the site request path.
 * When `site_wfp_hosting` is ON for the site AND a WfP slot is recorded for that
 * env (Unit-2 registry row, `resourceConcept='wfp_namespace'`, live, with a
 * `userWorkerScript`), the request is DISPATCHED to the per-site User Worker via
 * `dispatchToUserWorker` (USER_DISPATCH). Otherwise the helper returns `null` so the
 * caller falls through to the byte-identical existing R2 path. Fail-soft: any miss,
 * unconfigured WfP, or dispatch throw returns `null` (never a 5xx from this branch).
 *
 * Isolation: preview host resolves the `-preview` slot; production the prod slot.
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

const mockListResources = jest.fn();
jest.mock('../../libs/features/data_resource_registry/service.js', () => ({
  listResources: (...a: unknown[]) => mockListResources(...a),
}));

const mockIsWfpConfigured = jest.fn();
const mockDispatchToUserWorker = jest.fn();
jest.mock('../services/wfp_dispatch.js', () => ({
  isWfpConfigured: (...a: unknown[]) => mockIsWfpConfigured(...a),
  // Real slot-name SSOT so the test asserts the exact script we dispatch to.
  siteFunctionsScriptName: (siteId: string, opts: { preview?: boolean } = {}) => {
    const base = `site-${siteId.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    return opts.preview ? `${base}-preview` : base;
  },
  dispatchToUserWorker: (...a: unknown[]) => mockDispatchToUserWorker(...a),
}));

import { serveSiteViaWfpIfPreferred } from '../services/site_serving.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────
const OWNER_ORG = 'org_owner';
const SITE_ID = 'abc123de-f012-7abc-9def-0123456789ab';
const PROD_SCRIPT = `site-${SITE_ID}`;
const PREVIEW_SCRIPT = `site-${SITE_ID}-preview`;

const PROD_SITE = {
  site_id: SITE_ID,
  slug: 'vitos',
  org_id: OWNER_ORG,
  current_build_version: 'v2',
  plan: 'paid',
};

/** A live production WfP slot registry row (the shape Unit 2's recordResource writes). */
function wfpRow(over: Record<string, unknown> = {}) {
  return {
    id: 'row_wfp_1',
    orgId: OWNER_ORG,
    siteId: SITE_ID,
    environment: 'production',
    resourceConcept: 'wfp_namespace',
    resourceKind: 'durable_object',
    userWorkerScript: PROD_SCRIPT,
    lifecycleState: 'active',
    deployedVersion: 'v2',
    ...over,
  };
}

function envWith(): { DB: unknown; USER_DISPATCH: unknown } {
  return { DB: {}, USER_DISPATCH: {} };
}

function req(url = 'https://vitos.projectsites.dev/'): Request {
  return new Request(url);
}

beforeEach(() => {
  mockIsFlagOn.mockReset().mockResolvedValue(true);
  mockIsWfpConfigured.mockReset().mockReturnValue(true);
  mockListResources.mockReset().mockResolvedValue([wfpRow()]);
  mockDispatchToUserWorker
    .mockReset()
    .mockResolvedValue(new Response('<!doctype html><h1>via dispatch</h1>', { status: 200 }));
});

describe('serveSiteViaWfpIfPreferred', () => {
  it('flag OFF → returns null (no registry read, no dispatch) so the caller serves from R2', async () => {
    mockIsFlagOn.mockResolvedValue(false);

    const out = await serveSiteViaWfpIfPreferred(
      envWith() as never,
      PROD_SITE,
      req(),
      'vitos.projectsites.dev',
    );

    expect(out).toBeNull();
    // Flag is the FIRST gate — nothing WfP-side runs when it's off (byte-identical R2 path).
    expect(mockListResources).not.toHaveBeenCalled();
    expect(mockDispatchToUserWorker).not.toHaveBeenCalled();
  });

  it('flag ON + a live prod WfP slot → dispatches to the per-site production worker and returns its 200', async () => {
    const out = await serveSiteViaWfpIfPreferred(
      envWith() as never,
      PROD_SITE,
      req(),
      'vitos.projectsites.dev',
    );

    expect(out).not.toBeNull();
    expect(out!.status).toBe(200);
    // The flag was checked scoped to this site (org + site), not globally.
    expect(mockIsFlagOn).toHaveBeenCalledWith(expect.anything(), 'site_wfp_hosting', {
      orgId: OWNER_ORG,
      siteId: SITE_ID,
    });
    // Dispatched to the PRODUCTION slot for a non-branch host.
    expect(mockDispatchToUserWorker).toHaveBeenCalledTimes(1);
    expect(mockDispatchToUserWorker.mock.calls[0][1]).toBe(PROD_SCRIPT);
    // Marker header proves the response came via the WfP dispatch branch.
    expect(out!.headers.get('x-ps-serve')).toBe('wfp');
  });

  it('flag ON + a live PREVIEW slot on a branch host → dispatches to the -preview worker', async () => {
    mockListResources.mockResolvedValue([
      wfpRow({ environment: 'preview', userWorkerScript: PREVIEW_SCRIPT }),
    ]);
    const previewSite = { ...PROD_SITE, slug: 'feat--vitos', plan: 'free' };

    const out = await serveSiteViaWfpIfPreferred(
      envWith() as never,
      previewSite,
      req('https://feat--vitos.projectsites.dev/'),
      'feat--vitos.projectsites.dev',
    );

    expect(out).not.toBeNull();
    expect(out!.status).toBe(200);
    // Preview host resolves the preview env + the -preview slot (never the prod slot).
    expect(mockListResources).toHaveBeenCalledWith(expect.anything(), SITE_ID, 'preview');
    expect(mockDispatchToUserWorker.mock.calls[0][1]).toBe(PREVIEW_SCRIPT);
  });

  it('flag ON but NO WfP slot recorded → returns null (fall through to R2)', async () => {
    mockListResources.mockResolvedValue([]); // no rows for this env

    const out = await serveSiteViaWfpIfPreferred(
      envWith() as never,
      PROD_SITE,
      req(),
      'vitos.projectsites.dev',
    );

    expect(out).toBeNull();
    expect(mockDispatchToUserWorker).not.toHaveBeenCalled();
  });

  it('flag ON, slot present, but dispatch THROWS → returns null (fail-soft to R2, never a 5xx)', async () => {
    mockDispatchToUserWorker.mockRejectedValue(new Error('dispatch boom'));

    const out = await serveSiteViaWfpIfPreferred(
      envWith() as never,
      PROD_SITE,
      req(),
      'vitos.projectsites.dev',
    );

    expect(out).toBeNull();
    expect(mockDispatchToUserWorker).toHaveBeenCalledTimes(1);
  });

  it('flag ON, slot present, but WfP not configured → returns null (fall through to R2)', async () => {
    mockIsWfpConfigured.mockReturnValue(false);

    const out = await serveSiteViaWfpIfPreferred(
      envWith() as never,
      PROD_SITE,
      req(),
      'vitos.projectsites.dev',
    );

    expect(out).toBeNull();
    expect(mockDispatchToUserWorker).not.toHaveBeenCalled();
  });

  it('dispatch returns a 5xx from the user worker → returns null so R2 serves instead (never worse than R2)', async () => {
    mockDispatchToUserWorker.mockResolvedValue(new Response('boom', { status: 502 }));

    const out = await serveSiteViaWfpIfPreferred(
      envWith() as never,
      PROD_SITE,
      req(),
      'vitos.projectsites.dev',
    );

    expect(out).toBeNull();
  });

  it('a bolt-community site (no real org) → returns null without touching WfP', async () => {
    const boltSite = { ...PROD_SITE, site_id: 'bolt-vitos', org_id: 'bolt-community' };

    const out = await serveSiteViaWfpIfPreferred(
      envWith() as never,
      boltSite,
      req(),
      'vitos.projectsites.dev',
    );

    expect(out).toBeNull();
    expect(mockIsFlagOn).not.toHaveBeenCalled();
    expect(mockDispatchToUserWorker).not.toHaveBeenCalled();
  });
});
