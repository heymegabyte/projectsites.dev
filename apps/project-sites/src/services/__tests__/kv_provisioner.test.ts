/**
 * Per-site KV namespace provisioner (Data Platform re-arch, Phase 0c). Runs the REAL provisioning
 * SQL against a real SQLite (node:sqlite) with a MOCKED Cloudflare fetch — so it creates ZERO
 * real resources. Covers: deterministic naming, create + record, idempotent reuse (no second CF
 * create), honest failures (no creds / CF error) that record NOTHING.
 */
import { kvNamespaceName, provisionSiteKv } from '../kv_provisioner.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

// Mirrors migration 0634 (adds kv_namespace_id + kv_namespace_name to site_database_allocations).
const ALLOC_DDL = `CREATE TABLE site_database_allocations (
  tenant_id TEXT NOT NULL, site_id TEXT NOT NULL PRIMARY KEY, db_plan TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto', shard_id TEXT, hyperdrive_binding_name TEXT,
  neon_project_id TEXT, neon_database TEXT, neon_schema TEXT, status TEXT NOT NULL DEFAULT 'active',
  d1_database_id TEXT, d1_database_name TEXT,
  kv_namespace_id TEXT, kv_namespace_name TEXT,
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

function cfCreated(id: string): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { id, name: 'x' } }),
  } as unknown as Response);
}
const allocCount = (h: D1SqliteHarness): number =>
  (h.raw.prepare('SELECT COUNT(*) c FROM site_database_allocations').get() as { c: number }).c;

describe('kvNamespaceName', () => {
  it('prefixes + sanitizes to CF-safe chars, bounded', () => {
    expect(kvNamespaceName('abc-123')).toBe('ps-site-abc-123-kv');
    expect(kvNamespaceName('a/b c!')).toBe('ps-site-a-b-c--kv');
    expect(kvNamespaceName('x'.repeat(80)).length).toBeLessThanOrEqual(
      'ps-site-'.length + 48 + '-kv'.length,
    );
  });
});

describe('provisionSiteKv', () => {
  it('creates a KV namespace via CF + records the allocation (tenant/status/kv_namespace_id correct)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      mockFetch.mockReturnValueOnce(cfCreated('ns-abc'));

      const r = await provisionSiteKv(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r).toEqual({
        ok: true,
        namespaceId: 'ns-abc',
        namespaceName: 'ps-site-site1-kv',
        reused: false,
      });

      // CF called with a POST to the KV create endpoint carrying the deterministic name.
      const [url, opts] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toContain('/accounts/acct-1/storage/kv/namespaces');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body).title).toBe('ps-site-site1-kv');

      const row = h.raw
        .prepare("SELECT * FROM site_database_allocations WHERE site_id='site1'")
        .get() as Record<string, unknown>;
      expect(row.tenant_id).toBe('org1');
      expect(row.db_plan).toBe('d1_tenant_db');
      expect(row.status).toBe('active');
      expect(row.kv_namespace_id).toBe('ns-abc');
      expect(row.kv_namespace_name).toBe('ps-site-site1-kv');
    } finally {
      h.close();
    }
  });

  it('is IDEMPOTENT — a second call reuses the allocation, never a second CF create', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      mockFetch.mockReturnValueOnce(cfCreated('ns-abc'));
      await provisionSiteKv(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });

      const r2 = await provisionSiteKv(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r2).toEqual({
        ok: true,
        namespaceId: 'ns-abc',
        namespaceName: 'ps-site-site1-kv',
        reused: true,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1); // no duplicate namespace on retry
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

      const r = await provisionSiteKv(env, { siteId: 'site1', tenantId: 'org1' });
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

      const r = await provisionSiteKv(envWithCreds(h), { siteId: 'site1', tenantId: 'org1' });
      expect(r).toEqual({ ok: false, reason: 'cf_create_failed', status: 403 });
      expect(allocCount(h)).toBe(0);
    } finally {
      h.close();
    }
  });
});
