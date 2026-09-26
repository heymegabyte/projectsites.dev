/**
 * Per-site R2 provisioner (Data Platform re-arch, Phase 0c). Runs the REAL provisioning SQL
 * against a real SQLite (node:sqlite) with a MOCKED Cloudflare fetch — so it creates ZERO real
 * resources. Covers: deterministic naming, create + record, idempotent reuse (no second CF
 * create), honest failures (no creds / CF error) that record NOTHING.
 */
import { provisionSiteR2, r2BucketName } from '../r2_provisioner.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

// Mirrors migration 0634 (adds r2_bucket_name) on top of 0573 + 0633 columns.
const ALLOC_DDL = `CREATE TABLE site_database_allocations (
  tenant_id TEXT NOT NULL, site_id TEXT NOT NULL PRIMARY KEY, db_plan TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto', shard_id TEXT, hyperdrive_binding_name TEXT,
  neon_project_id TEXT, neon_database TEXT, neon_schema TEXT, status TEXT NOT NULL DEFAULT 'active',
  d1_database_id TEXT, d1_database_name TEXT, r2_bucket_name TEXT,
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

function cfCreated(): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: {} }),
  } as unknown as Response);
}

const allocCount = (h: D1SqliteHarness): number =>
  (h.raw.prepare('SELECT COUNT(*) c FROM site_database_allocations').get() as { c: number }).c;

describe('r2BucketName', () => {
  it('lowercases, sanitizes to R2-safe chars, and keeps total name ≤63 chars', () => {
    expect(r2BucketName('abc-123')).toBe('ps-site-abc-123');
    expect(r2BucketName('A/B C!')).toBe('ps-site-a-b-c-');
    const long = r2BucketName('x'.repeat(80));
    expect(long.length).toBeLessThanOrEqual(63);
    // must only contain lowercase alphanumeric + hyphens
    expect(long).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('provisionSiteR2', () => {
  it('creates an R2 bucket via CF + records the allocation (tenant/plan/status/r2_bucket_name)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      mockFetch.mockReturnValueOnce(cfCreated());

      const r = await provisionSiteR2(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r).toEqual({
        ok: true,
        bucketName: 'ps-site-site1',
        reused: false,
      });

      // CF called with a POST to the R2 buckets endpoint carrying the deterministic name.
      const [url, opts] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toContain('/accounts/acct-1/r2/buckets');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body).name).toBe('ps-site-site1');

      const row = h.raw
        .prepare("SELECT * FROM site_database_allocations WHERE site_id='site1'")
        .get() as Record<string, unknown>;
      expect(row.tenant_id).toBe('org1');
      expect(row.db_plan).toBe('d1_tenant_db');
      expect(row.status).toBe('active');
      expect(row.r2_bucket_name).toBe('ps-site-site1');
    } finally {
      h.close();
    }
  });

  it('is IDEMPOTENT — a second call reuses the allocation, never a second CF create', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      mockFetch.mockReturnValueOnce(cfCreated());
      await provisionSiteR2(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });

      const r2 = await provisionSiteR2(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r2).toEqual({
        ok: true,
        bucketName: 'ps-site-site1',
        reused: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1); // no duplicate bucket on retry
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

      const r = await provisionSiteR2(env, { siteId: 'site1', tenantId: 'org1' });
      expect(r).toEqual({ ok: false, reason: 'no_cf_credentials' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(allocCount(h)).toBe(0);
    } finally {
      h.close();
    }
  });

  it('CF create failure → typed error, records NOTHING (never a fabricated bucket name)', async () => {
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

      const r = await provisionSiteR2(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r).toEqual({ ok: false, reason: 'cf_create_failed', status: 403 });
      expect(allocCount(h)).toBe(0);
    } finally {
      h.close();
    }
  });
});
