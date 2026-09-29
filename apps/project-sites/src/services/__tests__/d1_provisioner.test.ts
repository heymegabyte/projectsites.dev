/**
 * Per-site D1 provisioner (Data Platform re-arch, Phase 0c). Runs the REAL provisioning SQL against
 * a real SQLite (node:sqlite) with a MOCKED Cloudflare fetch — so it creates ZERO real resources.
 * Covers: deterministic naming, create + record, idempotent reuse (no second CF create), honest
 * failures (no creds / CF error) that record NOTHING.
 */
import { provisionSiteD1, siteD1Name } from '../d1_provisioner.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

// Mirrors migration 0573 + 0633 (the two provisioning columns).
const ALLOC_DDL = `CREATE TABLE site_database_allocations (
  tenant_id TEXT NOT NULL, site_id TEXT NOT NULL PRIMARY KEY, db_plan TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto', shard_id TEXT, hyperdrive_binding_name TEXT,
  neon_project_id TEXT, neon_database TEXT, neon_schema TEXT, status TEXT NOT NULL DEFAULT 'active',
  d1_database_id TEXT, d1_database_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

function envWithCreds(h: D1SqliteHarness): Env {
  return {
    DB: h.db,
    CF_ACCOUNT_ID: 'acct-1',
    CLOUDFLARE_EMAIL: 'e@x.com',
    CLOUDFLARE_API_KEY: 'gkey',
  } as unknown as Env;
}

const mockFetch = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
});

function cfCreated(uuid: string): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { uuid, name: 'x' } }),
  } as unknown as Response);
}
const allocCount = (h: D1SqliteHarness): number =>
  (h.raw.prepare('SELECT COUNT(*) c FROM site_database_allocations').get() as { c: number }).c;

describe('siteD1Name', () => {
  it('prefixes + sanitizes to CF-safe chars, bounded', () => {
    expect(siteD1Name('abc-123')).toBe('ps-site-abc-123');
    expect(siteD1Name('a/b c!')).toBe('ps-site-a-b-c-');
    expect(siteD1Name('x'.repeat(80)).length).toBeLessThanOrEqual('ps-site-'.length + 48);
  });
});

describe('provisionSiteD1', () => {
  it('creates a D1 via CF + records the allocation (tenant/plan/status/d1_database_id)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      mockFetch.mockReturnValueOnce(cfCreated('uuid-abc'));

      const r = await provisionSiteD1(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r).toEqual({
        ok: true,
        databaseId: 'uuid-abc',
        databaseName: 'ps-site-site1',
        reused: false,
      });

      // CF called with a POST to the D1 create endpoint carrying the deterministic name.
      const [url, opts] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toContain('/accounts/acct-1/d1/database');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body).name).toBe('ps-site-site1');

      const row = h.raw
        .prepare("SELECT * FROM site_database_allocations WHERE site_id='site1'")
        .get() as Record<string, unknown>;
      expect(row.tenant_id).toBe('org1');
      expect(row.db_plan).toBe('d1_tenant_db');
      expect(row.status).toBe('active');
      expect(row.d1_database_id).toBe('uuid-abc');
      expect(row.d1_database_name).toBe('ps-site-site1');
    } finally {
      h.close();
    }
  });

  it('is IDEMPOTENT — a second call reuses the allocation, never a second CF create', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      mockFetch.mockReturnValueOnce(cfCreated('uuid-abc'));
      await provisionSiteD1(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });

      const r2 = await provisionSiteD1(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r2).toEqual({
        ok: true,
        databaseId: 'uuid-abc',
        databaseName: 'ps-site-site1',
        reused: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1); // no duplicate database on retry
      expect(allocCount(h)).toBe(1);
    } finally {
      h.close();
    }
  });

  it('no CF credentials → honest failure, no CF call, no allocation', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      const env = { DB: h.db, CF_ACCOUNT_ID: 'acct-1' } as unknown as Env; // no creds

      const r = await provisionSiteD1(env, { siteId: 'site1', tenantId: 'org1' });
      expect(r).toEqual({ ok: false, reason: 'no_cf_credentials' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(allocCount(h)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('CF create failure → typed error, records NOTHING (never a fabricated id)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      mockFetch.mockReturnValueOnce(
        Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({ success: false, errors: [{ message: 'denied' }] }),
        } as unknown as Response),
      );

      const r = await provisionSiteD1(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r).toEqual({ ok: false, reason: 'cf_create_failed', status: 403 });
      expect(allocCount(h)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('CONCURRENT provision of one site → ONE allocation, both callers get the SAME id', async () => {
    // The cold-provision RACE: two calls arrive before either has recorded an allocation, so both
    // pass the step-1 "existing?" read and both create a CF D1 (two different uuids). The write MUST
    // collapse to a SINGLE allocation row (INSERT OR IGNORE on the site_id PK) and BOTH callers must
    // return the WINNER's id — never two rows, never divergent ids.
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      // Each concurrent create gets its OWN uuid from CF — the collapse must pick exactly one.
      mockFetch.mockReturnValueOnce(cfCreated('uuid-A')).mockReturnValueOnce(cfCreated('uuid-B'));

      const [r1, r2] = await Promise.all([
        provisionSiteD1(envWithCreds(h), { siteId: 'race1', tenantId: 'org1' }),
        provisionSiteD1(envWithCreds(h), { siteId: 'race1', tenantId: 'org1' }),
      ]);

      // Exactly ONE allocation row survives.
      expect(allocCount(h)).toBe(1);
      // Both callers succeeded and agree on the SAME database id (the one the row actually holds).
      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;
      expect(r1.databaseId).toBe(r2.databaseId);
      const row = h.raw
        .prepare("SELECT d1_database_id FROM site_database_allocations WHERE site_id='race1'")
        .get() as { d1_database_id: string };
      expect(r1.databaseId).toBe(row.d1_database_id);
      // The stored id is one of the two CF-created uuids (the loser's create is discarded by the row).
      expect(['uuid-A', 'uuid-B']).toContain(row.d1_database_id);
      // Exactly one caller sees a fresh create; the loser reports the reuse of the winner's row.
      expect([r1.reused, r2.reused].sort()).toEqual([false, true]);
    } finally {
      h.close();
    }
  });

  it('CF "database already exists" (name conflict) → treated as success, reuses the allocation', async () => {
    // A prior create recorded an allocation, but the caller lost the row read (e.g. a stale replica)
    // and re-issued the create; CF answers with a name-conflict. That is NOT a failure — the DB
    // exists — so we must re-read the allocation and return the existing id, never a cf_create_failed.
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      // Seed the allocation the way a prior successful provision would have.
      h.exec(
        `INSERT INTO site_database_allocations (tenant_id, site_id, db_plan, status, d1_database_id, d1_database_name)
         VALUES ('org1','dup1','d1_tenant_db','active','uuid-existing','ps-site-dup1')`,
      );
      // Force the lazy path to still hit CF (simulate a stale read missing the row on attempt 1) by
      // clearing then re-inserting is overkill; instead assert the happy reuse: with the row present,
      // provision must NOT call CF at all and must return the existing id.
      const r = await provisionSiteD1(envWithCreds(h), { siteId: 'dup1', tenantId: 'org1' });
      expect(r).toEqual({
        ok: true,
        databaseId: 'uuid-existing',
        databaseName: 'ps-site-dup1',
        reused: true,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });

  it('CF "already exists" error AFTER a create attempt → re-reads + succeeds (not cf_create_failed)', async () => {
    // The true name-conflict path: the row genuinely wasn't visible on the pre-create read, the create
    // races another provisioner and CF returns "already exists". Our fetch mock returns that conflict;
    // meanwhile the sibling's allocation row lands. Provision must re-read and return that id.
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      mockFetch.mockImplementationOnce(async () => {
        // Simulate the sibling provisioner having recorded the row by the time our create returns.
        h.exec(
          `INSERT INTO site_database_allocations (tenant_id, site_id, db_plan, status, d1_database_id, d1_database_name)
           VALUES ('org1','conf1','d1_tenant_db','active','uuid-sibling','ps-site-conf1')`,
        );
        return {
          ok: false,
          status: 409,
          json: async () => ({
            success: false,
            errors: [{ code: 7502, message: 'a database with that name already exists' }],
          }),
        } as unknown as Response;
      });

      const r = await provisionSiteD1(envWithCreds(h), { siteId: 'conf1', tenantId: 'org1' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.databaseId).toBe('uuid-sibling');
      expect(r.reused).toBe(true);
      expect(allocCount(h)).toBe(1);
    } finally {
      h.close();
    }
  });
});
