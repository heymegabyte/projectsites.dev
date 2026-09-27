/**
 * Unit tests for the READ-ONLY Backend-tab connected-resource INVENTORY service
 * (`backend_inventory.ts`, Data & Resource Platform Phase 8b — scheduled tasks + Worker bindings).
 *
 * The load-bearing guarantees under test:
 *  - Scheduled tasks come from `site_functions_schedules` (WfP has no native cron).
 *  - Worker bindings surface the shared data-plane catalog + only the per-kind bindings the site
 *    actually has (a blank site does not show a binding it doesn't own); each binding honestly says
 *    whether an integrated management API exists (managed + manageRoute) or not (notAvailableReason).
 *  - ⛔ SECRETS: the reader NEVER selects `value_encrypted` and the returned rows carry NO value
 *    field — names + last-change metadata only (INV-6 + the directive's hard rule). This is asserted
 *    explicitly, including a scan of the WHOLE serialized output for any secret-value shape.
 *  - The `ai_env_vars` read is org-scoped + site-scoped (a foreign org's secrets are never read).
 *
 * swc-jest hoists `jest.mock` above the imports only when it sees the GLOBAL `jest` — so we do NOT
 * import `jest` from @jest/globals. Mock paths use FOUR `../` to reach `src/` from
 * `libs/features/<slug>/__tests__/`.
 */

// ─── Mocks (must precede the service import) ──────────────────────────────────
const mockDbQuery = jest.fn();
jest.mock('../../../../src/services/db.js', () => ({
  dbQuery: (...a: unknown[]) => mockDbQuery(...a),
}));

import { getBackendInventory } from '../backend_inventory.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────
type TestEnv = { DB: unknown };
const env: TestEnv = { DB: {} };
const ORG = 'org_owner';
const SITE = 'site_owned';

/**
 * Queue the four `dbQuery` results the reader issues, in order:
 *   1. sites (functions_deployed_at)  2. schedules  3. registry kinds  4. secrets
 */
function primeDb(opts: {
  functionsDeployedAt?: string | null;
  schedules?: Array<{ cron: string }>;
  kinds?: Array<{ resource_kind: string }>;
  secrets?: Array<{
    key: string;
    scope: string;
    is_secret: number;
    created_at: number | string | null;
    updated_at: number | string | null;
  }>;
}) {
  mockDbQuery
    .mockResolvedValueOnce({
      data: [{ functions_deployed_at: opts.functionsDeployedAt ?? null }],
    })
    .mockResolvedValueOnce({ data: opts.schedules ?? [] })
    .mockResolvedValueOnce({ data: opts.kinds ?? [] })
    .mockResolvedValueOnce({ data: opts.secrets ?? [] });
}

beforeEach(() => {
  mockDbQuery.mockReset();
});

describe('getBackendInventory — scheduled tasks (Cron Triggers)', () => {
  it('surfaces the site\'s cron schedules from site_functions_schedules, dispatched by the platform cron', async () => {
    primeDb({
      functionsDeployedAt: '2026-09-01T00:00:00Z',
      schedules: [{ cron: '0 * * * *' }, { cron: '*/15 * * * *' }],
    });
    const inv = await getBackendInventory(env as never, SITE, ORG, 'production');

    expect(inv.functionsDeployed).toBe(true);
    expect(inv.schedules.map((s) => s.cron)).toEqual(['0 * * * *', '*/15 * * * *']);
    expect(inv.schedules.every((s) => s.dispatchedBy === 'platform_cron_dispatcher')).toBe(true);
    expect(inv.counts.schedules).toBe(2);
    // The schedules query reads the OWNED site's rows. dbQuery(db, sql, params) → [1]=sql, [2]=params.
    expect(mockDbQuery.mock.calls[1][1]).toMatch(/site_functions_schedules/);
    expect(mockDbQuery.mock.calls[1][2]).toEqual([SITE]);
  });

  it('reports functionsDeployed=false + zero schedules for a site with no deployed Functions worker', async () => {
    primeDb({ functionsDeployedAt: null, schedules: [] });
    const inv = await getBackendInventory(env as never, SITE, ORG);
    expect(inv.functionsDeployed).toBe(false);
    expect(inv.schedules).toEqual([]);
    expect(inv.counts.schedules).toBe(0);
  });
});

describe('getBackendInventory — Worker bindings', () => {
  it('always surfaces the shared data-plane catalog (KV/R2/D1/AI/service/Browser/Images) with honest managed flags', async () => {
    primeDb({ kinds: [] }); // no per-kind registry rows → only the shared catalog
    const inv = await getBackendInventory(env as never, SITE, ORG);

    const byName = new Map(inv.bindings.map((b) => [b.name, b]));
    // Managed data-plane bindings point at an in-platform route.
    expect(byName.get('__PS_KV')?.managed).toBe(true);
    expect(byName.get('__PS_KV')?.manageRoute).toMatch(/^\/admin\/data/);
    expect(byName.get('__PS_R2')?.managed).toBe(true);
    expect(byName.get('DATA')?.kind).toBe('d1');
    // Un-integrated products are honest: managed:false + a reason, NO fake manageRoute.
    const ai = byName.get('AI');
    expect(ai?.managed).toBe(false);
    expect(ai?.manageRoute).toBeNull();
    expect(ai?.notAvailableReason).toMatch(/.+/);
    const browser = byName.get('BROWSER');
    expect(browser?.managed).toBe(false);
    expect(browser?.notAvailableReason).toMatch(/.+/);
    // Every binding carries a useful description.
    expect(inv.bindings.every((b) => b.description.length > 0)).toBe(true);
  });

  it('adds a per-kind binding ONLY when the site has that registry kind (no fabricated bindings)', async () => {
    primeDb({ kinds: [{ resource_kind: 'vectorize' }, { resource_kind: 'connection' }] });
    const inv = await getBackendInventory(env as never, SITE, ORG);
    const names = inv.bindings.map((b) => b.name);
    expect(names).toContain('RAG_INDEX'); // vectorize present
    expect(names).toContain('connections'); // connection present
    expect(names).not.toContain('SITE_BUILDER'); // durable_object NOT present → not shown
    expect(names).not.toContain('ANALYTICS'); // analytics_engine NOT present → not shown
    // The registry-kinds query is scoped to the owned site + environment (params at index [2]).
    expect(mockDbQuery.mock.calls[2][2]).toEqual([SITE, 'production']);
  });

  it('renders the Queues binding as honest not-available when the registry has a queue row', async () => {
    primeDb({ kinds: [{ resource_kind: 'queue' }] });
    const inv = await getBackendInventory(env as never, SITE, ORG);
    const q = inv.bindings.find((b) => b.kind === 'queue');
    expect(q).toBeDefined();
    expect(q?.managed).toBe(false);
    expect(q?.notAvailableReason).toMatch(/not enabled|no QUEUE binding/i);
  });
});

describe('getBackendInventory — secrets (⛔ NAMES + last-change ONLY, never values)', () => {
  it('returns secret names + scope + is_secret + last-change, and the reader never SELECTs value_encrypted', async () => {
    primeDb({
      secrets: [
        { key: 'STRIPE_KEY', scope: 'site', is_secret: 1, created_at: 1000, updated_at: 2000 },
        { key: 'PUBLIC_URL', scope: 'org', is_secret: 0, created_at: 500, updated_at: 500 },
      ],
    });
    const inv = await getBackendInventory(env as never, SITE, ORG);

    expect(inv.secrets).toEqual([
      { name: 'STRIPE_KEY', scope: 'site', isSecret: true, lastChangedAt: '2000', createdAt: '1000' },
      { name: 'PUBLIC_URL', scope: 'org', isSecret: false, lastChangedAt: '500', createdAt: '500' },
    ]);
    expect(inv.counts.secrets).toBe(2);

    // The SELECT lists explicit columns and NEVER value_encrypted (INV-6 — value can't leak).
    // dbQuery(db, sql, params) → sql is at index [1].
    const secretsSql = mockDbQuery.mock.calls[3][1] as string;
    expect(secretsSql).toMatch(/ai_env_vars/);
    expect(secretsSql).not.toMatch(/value_encrypted/i);
    expect(secretsSql).not.toMatch(/\bvalue\b/i);
  });

  it('scopes the ai_env_vars read to the caller org + the owned site (a foreign org is never read)', async () => {
    primeDb({ secrets: [] });
    await getBackendInventory(env as never, SITE, ORG);
    const params = mockDbQuery.mock.calls[3][2] as unknown[]; // dbQuery(db, sql, params) → params at [2]
    expect(params).toEqual([ORG, SITE]); // org_id first, then site_id — never another org
  });

  it('EXPLICIT no-value-leak: no secret VALUE shape appears anywhere in the serialized inventory', async () => {
    primeDb({
      secrets: [
        { key: 'API_TOKEN', scope: 'mcp', is_secret: 1, created_at: 1, updated_at: 9 },
      ],
    });
    const inv = await getBackendInventory(env as never, SITE, ORG);

    // The secret object has ONLY name/scope/isSecret/lastChangedAt/createdAt — no value-bearing keys.
    const keys = Object.keys(inv.secrets[0]!);
    expect(keys.sort()).toEqual(['createdAt', 'isSecret', 'lastChangedAt', 'name', 'scope']);
    for (const banned of ['value', 'secret', 'ciphertext', 'valueEncrypted', 'plaintext', 'token']) {
      expect(keys).not.toContain(banned);
    }
    // Belt-and-braces: the whole serialized payload carries no value-column key.
    const serialized = JSON.stringify(inv);
    expect(serialized).not.toMatch(/value_encrypted/i);
    expect(serialized).not.toMatch(/"value"\s*:/i);
  });
});
