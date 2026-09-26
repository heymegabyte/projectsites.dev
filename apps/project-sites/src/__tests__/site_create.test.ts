import { createSite } from '../services/site_create';
import { dbInsert } from '../services/db.js';
import { writeAuditLog } from '../services/audit.js';
import { trackSite } from '../lib/posthog.js';
import { tryEmitEvent } from '../services/emit_event.js';
import { grantSiteOwner } from '../services/authz_bootstrap.js';
import { isFlagOn } from '../modules/feature_flags/services.js';
import { provisionSiteD1 } from '../services/d1_provisioner.js';
import { provisionSiteKv } from '../services/kv_provisioner.js';
import { provisionSiteR2 } from '../services/r2_provisioner.js';

/**
 * The site-creation core extracted from POST /api/sites (so the claim funnel can
 * reuse it). Mocks the side-effect deps (db insert / audit / posthog / bus emit /
 * authz owner-grant) — all src-sibling module mocks, which @swc/jest intercepts
 * in src/__tests__.
 */
jest.mock('../services/db.js', () => ({ dbInsert: jest.fn() }));
jest.mock('../services/audit.js', () => ({ writeAuditLog: jest.fn() }));
jest.mock('../lib/posthog.js', () => ({ trackSite: jest.fn() }));
jest.mock('../services/emit_event.js', () => ({ tryEmitEvent: jest.fn() }));
jest.mock('../services/authz_bootstrap.js', () => ({ grantSiteOwner: jest.fn() }));
// Phase 0c.2 wiring: the feature-flag gate + the three per-site provisioners are
// pulled in via DYNAMIC import inside the provision IIFE — jest.mock intercepts
// both the static import (for the assertions below) and that dynamic import.
jest.mock('../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
jest.mock('../services/d1_provisioner.js', () => ({ provisionSiteD1: jest.fn() }));
jest.mock('../services/kv_provisioner.js', () => ({ provisionSiteKv: jest.fn() }));
jest.mock('../services/r2_provisioner.js', () => ({ provisionSiteR2: jest.fn() }));

const mockInsert = dbInsert as jest.Mock;
const mockAudit = writeAuditLog as jest.Mock;
const mockTrack = trackSite as jest.Mock;
const mockEmit = tryEmitEvent as jest.Mock;
const mockGrantOwner = grantSiteOwner as jest.Mock;

const env = { DB: {} } as never;
const execCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockAudit.mockResolvedValue(undefined);
  mockEmit.mockResolvedValue({ inserted: true });
  mockGrantOwner.mockResolvedValue(undefined);
});

describe('createSite', () => {
  it('inserts a draft site row with the resolved fields + a uuid id', async () => {
    const site = await createSite(env, {
      orgId: 'org-1',
      slug: 'acme',
      businessName: 'Acme Plumbing',
      businessPhone: '+1973',
      businessAddress: '1 Main St',
      googlePlaceId: 'place-9',
    });
    expect(site.status).toBe('draft');
    expect(site.org_id).toBe('org-1');
    expect(site.slug).toBe('acme');
    expect(site.business_name).toBe('Acme Plumbing');
    expect(site.business_phone).toBe('+1973');
    expect(site.business_address).toBe('1 Main St');
    expect(site.google_place_id).toBe('place-9');
    expect(typeof site.id).toBe('string');
    expect(site.id.length).toBeGreaterThan(0);

    const [, table, row] = mockInsert.mock.calls[0];
    expect(table).toBe('sites');
    expect(row).toEqual(
      expect.objectContaining({ org_id: 'org-1', slug: 'acme', status: 'draft' }),
    );
  });

  it('nulls absent optional fields', async () => {
    const site = await createSite(env, { orgId: 'o', slug: 's', businessName: 'B' });
    expect(site.business_phone).toBeNull();
    expect(site.business_email).toBeNull();
    expect(site.business_address).toBeNull();
    expect(site.google_place_id).toBeNull();
  });

  it('writes a site.created audit log with the site id + actor', async () => {
    const site = await createSite(
      env,
      { orgId: 'org-1', slug: 'acme', businessName: 'Acme' },
      { actorId: 'user-1', requestId: 'req-1' },
    );
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const entry = mockAudit.mock.calls[0][1];
    expect(entry).toEqual(
      expect.objectContaining({
        org_id: 'org-1',
        actor_id: 'user-1',
        action: 'site.created',
        target_type: 'site',
        target_id: site.id,
        request_id: 'req-1',
      }),
    );
  });

  it('throws BAD_REQUEST when the insert fails (slug collision)', async () => {
    mockInsert.mockResolvedValue({ error: 'UNIQUE constraint failed: sites.slug' });
    await expect(
      createSite(env, { orgId: 'o', slug: 'taken', businessName: 'B' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    // audit + posthog never fire on a failed insert.
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('fires PostHog created only when an executionCtx is present', async () => {
    await createSite(env, { orgId: 'o', slug: 's', businessName: 'B' }); // no ctx
    expect(mockTrack).not.toHaveBeenCalled();

    await createSite(env, { orgId: 'o', slug: 's', businessName: 'B' }, { executionCtx: execCtx });
    expect(mockTrack).toHaveBeenCalledTimes(1);
    const [, , action] = mockTrack.mock.calls[0];
    expect(action).toBe('created');
  });

  it('emits site.created onto the bus with the site id + tenant', async () => {
    const site = await createSite(
      env,
      { orgId: 'org-1', slug: 'acme', businessName: 'Acme' },
      { actorId: 'user-1', requestId: 'req-1' },
    );
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [, input, deps] = mockEmit.mock.calls[0];
    expect(input).toEqual(
      expect.objectContaining({
        type: 'site.created',
        producer: 'worker',
        tenantId: 'org-1',
        siteId: site.id,
        userId: 'user-1',
        traceId: 'req-1',
      }),
    );
    expect(input.data).toEqual({ slug: 'acme', businessName: 'Acme' });
    expect(deps).toEqual({ scope: [site.id] });
  });

  it('does NOT emit site.created when the insert fails', async () => {
    mockInsert.mockResolvedValue({ error: 'UNIQUE constraint failed: sites.slug' });
    await expect(
      createSite(env, { orgId: 'o', slug: 'taken', businessName: 'B' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a PostHog throw never blocks creation', async () => {
    mockTrack.mockImplementation(() => {
      throw new Error('posthog down');
    });
    const site = await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { executionCtx: execCtx },
    );
    expect(site.status).toBe('draft'); // still returned
  });

  // ── authz relationship bootstrap (§29/ADR-0005) ──
  // A real user creating a site becomes its owner in the authz graph, so the
  // (deferred) requireAuthz('can_publish') guard will pass once OpenFGA is live.
  it('grants the creating user owner of the new site when actorId is present', async () => {
    const site = await createSite(
      env,
      { orgId: 'org-1', slug: 'acme', businessName: 'Acme' },
      { actorId: 'user-1', requestId: 'req-1' },
    );
    expect(mockGrantOwner).toHaveBeenCalledTimes(1);
    const [grantEnv, userId, siteId] = mockGrantOwner.mock.calls[0];
    expect(grantEnv).toBe(env);
    expect(userId).toBe('user-1');
    expect(siteId).toBe(site.id);
  });

  it('does NOT grant ownership for an anonymous/workflow create (no actorId)', async () => {
    await createSite(env, { orgId: 'o', slug: 's', businessName: 'B' });
    expect(mockGrantOwner).not.toHaveBeenCalled();
  });

  it('does NOT grant ownership when the insert fails', async () => {
    mockInsert.mockResolvedValue({ error: 'UNIQUE constraint failed: sites.slug' });
    await expect(
      createSite(env, { orgId: 'o', slug: 'taken', businessName: 'B' }, { actorId: 'user-1' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockGrantOwner).not.toHaveBeenCalled();
  });

  it('a grantSiteOwner rejection never blocks creation (fail-soft)', async () => {
    mockGrantOwner.mockRejectedValue(new Error('openfga down'));
    const site = await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { actorId: 'user-1' },
    );
    expect(site.status).toBe('draft'); // still returned
  });
});

// ── Per-site data-resource provisioning (Data Platform re-arch, Phase 0c.2) ──
// Every (paid) site gets its OWN D1 + KV + R2, provisioned IN PARALLEL from the
// site-create pipeline. Gated behind the DARK `per_site_data` flag (default-off →
// no real Cloudflare resources until promoted). Fail-soft: a provisioner throw
// never blocks creation; each provisioner is idempotent + records the allocation.
describe('per-site data provisioning (Phase 0c.2)', () => {
  const mockFlag = isFlagOn as jest.Mock;
  const mockD1 = provisionSiteD1 as jest.Mock;
  const mockKv = provisionSiteKv as jest.Mock;
  const mockR2 = provisionSiteR2 as jest.Mock;

  /**
   * A capturing executionCtx — the provision block is `waitUntil`'d, so the
   * default no-op `execCtx` would let the test finish before the async IIFE
   * settles. This one collects the promises so the test can await them.
   */
  function capturingCtx(): { ctx: ExecutionContext; settle: () => Promise<unknown> } {
    const promises: Promise<unknown>[] = [];
    return {
      ctx: {
        waitUntil: (p: Promise<unknown>) => void promises.push(p),
        passThroughOnException: () => {},
      } as never,
      settle: () => Promise.allSettled(promises),
    };
  }

  beforeEach(() => {
    mockD1.mockResolvedValue({ ok: true });
    mockKv.mockResolvedValue({ ok: true });
    mockR2.mockResolvedValue({ ok: true });
  });

  it('provisions D1 + KV + R2 in parallel when the per_site_data flag is ON', async () => {
    mockFlag.mockImplementation((_e: unknown, key: string) =>
      Promise.resolve(key === 'per_site_data'),
    );
    const { ctx, settle } = capturingCtx();
    const site = await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { actorId: 'user-1', executionCtx: ctx },
    );
    await settle();
    // tenantId comes from input.orgId; orgId from the actor (the creating user).
    const args = { siteId: site.id, tenantId: 'o', orgId: 'user-1' };
    expect(mockD1).toHaveBeenCalledWith(env, args);
    expect(mockKv).toHaveBeenCalledWith(env, args);
    expect(mockR2).toHaveBeenCalledWith(env, args);
  });

  it('does NOT provision when the per_site_data flag is OFF', async () => {
    mockFlag.mockResolvedValue(false);
    const { ctx, settle } = capturingCtx();
    await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { actorId: 'user-1', executionCtx: ctx },
    );
    await settle();
    expect(mockD1).not.toHaveBeenCalled();
    expect(mockKv).not.toHaveBeenCalled();
    expect(mockR2).not.toHaveBeenCalled();
  });

  it('does NOT provision without an executionCtx (no request scope to waitUntil)', async () => {
    mockFlag.mockResolvedValue(true);
    await createSite(env, { orgId: 'o', slug: 's', businessName: 'B' }, { actorId: 'user-1' });
    expect(mockD1).not.toHaveBeenCalled();
    expect(mockKv).not.toHaveBeenCalled();
    expect(mockR2).not.toHaveBeenCalled();
  });

  it('a provisioner rejection never blocks site creation (fail-soft)', async () => {
    mockFlag.mockImplementation((_e: unknown, key: string) =>
      Promise.resolve(key === 'per_site_data'),
    );
    mockD1.mockRejectedValue(new Error('cf down'));
    const { ctx, settle } = capturingCtx();
    const site = await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { actorId: 'user-1', executionCtx: ctx },
    );
    await settle();
    expect(site.status).toBe('draft'); // still returned despite the provisioner throw
  });

  it('passes orgId=null for an anonymous/workflow create (no actorId)', async () => {
    mockFlag.mockImplementation((_e: unknown, key: string) =>
      Promise.resolve(key === 'per_site_data'),
    );
    const { ctx, settle } = capturingCtx();
    const site = await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { executionCtx: ctx },
    );
    await settle();
    expect(mockD1).toHaveBeenCalledWith(env, { siteId: site.id, tenantId: 'o', orgId: null });
  });
});
