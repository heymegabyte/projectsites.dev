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
 * EAGER per-site D1 provisioning on site-create, gated behind the NEW default-off
 * `eager_site_d1` flag (fire-72, A1). Distinct from the `per_site_data` block that
 * provisions D1+KV+R2 together: `eager_site_d1` eagerly warms ONLY the per-site D1
 * (calling the SAME idempotent provisionSiteD1 the lazy Data-tab path uses) so a
 * site's first Tables read never pays the cold create+propagate wait.
 *
 * Contract proven here:
 *   - flag OFF  → provisionSiteD1 is NOT called by the eager path
 *   - flag ON   → provisionSiteD1 called EXACTLY once (idempotent allocation reused)
 *   - a provisionSiteD1 throw → site creation STILL succeeds (fail-soft, falls back to lazy)
 *
 * Mocks the src-sibling side-effect deps; @swc/jest intercepts both the static
 * imports (for the assertions) and the dynamic import inside the eager IIFE.
 */
jest.mock('../services/db.js', () => ({ dbInsert: jest.fn() }));
jest.mock('../services/audit.js', () => ({ writeAuditLog: jest.fn() }));
jest.mock('../lib/posthog.js', () => ({ trackSite: jest.fn() }));
jest.mock('../services/emit_event.js', () => ({ tryEmitEvent: jest.fn() }));
jest.mock('../services/authz_bootstrap.js', () => ({ grantSiteOwner: jest.fn() }));
jest.mock('../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
jest.mock('../services/d1_provisioner.js', () => ({ provisionSiteD1: jest.fn() }));
jest.mock('../services/kv_provisioner.js', () => ({ provisionSiteKv: jest.fn() }));
jest.mock('../services/r2_provisioner.js', () => ({ provisionSiteR2: jest.fn() }));

const mockInsert = dbInsert as jest.Mock;
const mockFlag = isFlagOn as jest.Mock;
const mockD1 = provisionSiteD1 as jest.Mock;
const mockKv = provisionSiteKv as jest.Mock;
const mockR2 = provisionSiteR2 as jest.Mock;

const env = { DB: {} } as never;

/**
 * A capturing executionCtx — the eager block is `waitUntil`'d, so a no-op ctx
 * would let the test finish before the async IIFE settles. This collects the
 * promises so the test can await them deterministically.
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
  jest.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  (writeAuditLog as jest.Mock).mockResolvedValue(undefined);
  (trackSite as jest.Mock).mockReturnValue(undefined);
  (tryEmitEvent as jest.Mock).mockResolvedValue({ inserted: true });
  (grantSiteOwner as jest.Mock).mockResolvedValue(undefined);
  mockD1.mockResolvedValue({
    ok: true,
    databaseId: 'db-x',
    databaseName: 'ps-site-x',
    reused: false,
  });
  mockKv.mockResolvedValue({ ok: true });
  mockR2.mockResolvedValue({ ok: true });
});

describe('eager per-site D1 provisioning (eager_site_d1 flag)', () => {
  it('does NOT eagerly provision D1 when eager_site_d1 is OFF (and per_site_data is OFF)', async () => {
    mockFlag.mockResolvedValue(false); // every flag off
    const { ctx, settle } = capturingCtx();
    await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { actorId: 'user-1', executionCtx: ctx },
    );
    await settle();
    expect(mockD1).not.toHaveBeenCalled();
  });

  it('eagerly provisions D1 exactly once when eager_site_d1 is ON (per_site_data OFF)', async () => {
    mockFlag.mockImplementation((_e: unknown, key: string) =>
      Promise.resolve(key === 'eager_site_d1'),
    );
    const { ctx, settle } = capturingCtx();
    const site = await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { actorId: 'user-1', executionCtx: ctx },
    );
    await settle();
    // Called once, with the SAME {siteId, tenantId, orgId} shape the per_site_data path uses.
    expect(mockD1).toHaveBeenCalledTimes(1);
    expect(mockD1).toHaveBeenCalledWith(env, { siteId: site.id, tenantId: 'o', orgId: 'user-1' });
    // Eager-D1 is D1-only — it must NOT drag KV/R2 along (that is per_site_data's job).
    expect(mockKv).not.toHaveBeenCalled();
    expect(mockR2).not.toHaveBeenCalled();
  });

  it('idempotent: D1 is provisioned ONCE even when BOTH eager_site_d1 and per_site_data are ON', async () => {
    mockFlag.mockResolvedValue(true); // both flags on
    const { ctx, settle } = capturingCtx();
    await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { actorId: 'user-1', executionCtx: ctx },
    );
    await settle();
    // The eager path must reuse the per_site_data provision — never double-provision D1.
    expect(mockD1).toHaveBeenCalledTimes(1);
  });

  it('a provisionSiteD1 throw NEVER blocks site creation (fail-soft → falls back to lazy)', async () => {
    mockFlag.mockImplementation((_e: unknown, key: string) =>
      Promise.resolve(key === 'eager_site_d1'),
    );
    mockD1.mockRejectedValue(new Error('cf d1 down'));
    const { ctx, settle } = capturingCtx();
    const site = await createSite(
      env,
      { orgId: 'o', slug: 's', businessName: 'B' },
      { actorId: 'user-1', executionCtx: ctx },
    );
    await settle();
    expect(site.status).toBe('draft'); // still returned despite the eager-provision throw
  });

  it('does NOT eagerly provision without an executionCtx (no request scope to waitUntil)', async () => {
    mockFlag.mockResolvedValue(true);
    await createSite(env, { orgId: 'o', slug: 's', businessName: 'B' }, { actorId: 'user-1' });
    expect(mockD1).not.toHaveBeenCalled();
  });
});
