/**
 * TDD tests for the PROVISIONING wire-up — `service.provisionResource` (d1/kv/r2) + the d1/kv/r2
 * adapter `mutate({action:'provision'})` bridge.
 *
 * NO real Cloudflare resources are ever created: the CF `fetch` (quota list + the provisioner's CF
 * create POST) is MOCKED, and the registry/allocation SQL runs against a REAL in-memory SQLite
 * (node:sqlite) harness — so the idempotency + registry-record + partial-recovery behaviour is
 * exercised against ground truth, never a canned double. Global-jest convention (NO `import { jest }`
 * — swc-jest hoists only the global). 4× `../` reaches `src/` from `libs/features/<slug>/__tests__/`.
 *
 * Contracts under test:
 *   (a) confirm gate — confirm:false/absent → confirmation_required, ZERO CF calls, nothing recorded
 *   (b) quota at cap — the account count >= cap → quota_at_cap, provisioner NEVER called (no silent share)
 *   (c) quota indeterminate — the count can't be read → quota_check_failed (fail closed, no provision)
 *   (d) happy path — quota OK → provisioner creates → registry row recorded tenancy='dedicated', created:true
 *   (e) IDEMPOTENT — a second provision returns the existing row, creates NOTHING (no 2nd CF create)
 *   (f) partial recovery — provisioner succeeds but the registry record FAILS → record_failed WITH the id
 *   (g) org isolation — a foreign org (ownsSite=false) → not_owned, ZERO CF calls
 *   (h) the adapter bridge — d1Adapter.mutate({action:'provision'}) delegates + returns the typed envelope
 */
import { createD1Sqlite, type D1SqliteHarness } from '../../../../src/__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../../../src/types/env.js';
import { provisionResource } from '../service.js';
import { d1Adapter } from '../adapters/d1.js';
import type { ResolvedScope } from '../adapter.js';

// Mirrors migration 0573 + 0633/0634 (the columns the provisioners write).
const ALLOC_DDL = `CREATE TABLE site_database_allocations (
  tenant_id TEXT NOT NULL, site_id TEXT NOT NULL PRIMARY KEY, db_plan TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto', status TEXT NOT NULL DEFAULT 'active',
  d1_database_id TEXT, d1_database_name TEXT,
  kv_namespace_id TEXT, kv_namespace_name TEXT, r2_bucket_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

// A minimal site_resource_registry (the columns recordResource writes + the resolver reads).
const REGISTRY_DDL = `CREATE TABLE site_resource_registry (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, site_id TEXT NOT NULL, owner_user_id TEXT,
  environment TEXT NOT NULL, resource_concept TEXT NOT NULL, resource_kind TEXT NOT NULL,
  tenancy TEXT NOT NULL, cf_account_id TEXT NOT NULL,
  wfp_dispatch_namespace TEXT, user_worker_script TEXT,
  resource_id_or_name TEXT, resource_display_name TEXT, binding_name TEXT, vectorize_namespace TEXT,
  lifecycle_state TEXT NOT NULL, provisioning_method TEXT NOT NULL, access_policy TEXT NOT NULL,
  deletion_protected INTEGER NOT NULL DEFAULT 1, deploy_id TEXT, deployed_version TEXT,
  last_sync_at TEXT, drift_code TEXT, drift_detail TEXT, last_error_code TEXT, last_error_detail TEXT,
  usage_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
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

/** A CF quota-list response: D1/KV report result_info.total_count. */
function quotaListResponse(totalCount: number): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: [], result_info: { total_count: totalCount } }),
  } as unknown as Response);
}
/** A CF D1-create response: result.uuid is the new database id. */
function d1CreatedResponse(uuid: string): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { uuid } }),
  } as unknown as Response);
}

const registryRows = (h: D1SqliteHarness): Record<string, unknown>[] =>
  h.raw.prepare('SELECT * FROM site_resource_registry').all() as Record<string, unknown>[];
const allocRow = (h: D1SqliteHarness): Record<string, unknown> | undefined =>
  h.raw.prepare("SELECT * FROM site_database_allocations WHERE site_id='site1'").get() as
    | Record<string, unknown>
    | undefined;

const ownsTrue = async () => true;

describe('provisionResource (d1)', () => {
  it('(a) confirm gate — confirm absent → confirmation_required, ZERO CF calls, nothing recorded', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      const r = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        environment: 'production',
        orgId: 'org1',
        ownsSite: ownsTrue,
      });
      expect(r).toEqual({ ok: false, reason: 'confirmation_required' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(registryRows(h)).toHaveLength(0);
      expect(allocRow(h)).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('(b) quota at cap → quota_at_cap, the provisioner is NEVER called (no silent shared substitution)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      // The account already has 45_000 D1s (== the cap) → at cap.
      mockFetch.mockReturnValueOnce(quotaListResponse(45_000));
      const r = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        confirm: true,
        environment: 'production',
        orgId: 'org1',
        ownsSite: ownsTrue,
      });
      expect(r).toEqual({ ok: false, reason: 'quota_at_cap' });
      // Only the quota list was called — NO create POST.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(registryRows(h)).toHaveLength(0);
      expect(allocRow(h)).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it('(c) quota indeterminate (count unreadable) → quota_check_failed, fail closed, no provision', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      // A 500 from the list endpoint — indeterminate. Never assume under cap.
      mockFetch.mockReturnValueOnce(
        Promise.resolve({ ok: false, status: 500, json: async () => ({ success: false }) } as unknown as Response),
      );
      const r = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        confirm: true,
        environment: 'production',
        orgId: 'org1',
        ownsSite: ownsTrue,
      });
      expect(r).toEqual({ ok: false, reason: 'quota_check_failed', status: 500 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(registryRows(h)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('(d) happy path — quota OK → provisioner creates → dedicated registry row recorded, created:true', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      mockFetch
        .mockReturnValueOnce(quotaListResponse(10)) // quota: well under cap
        .mockReturnValueOnce(d1CreatedResponse('db-uuid-1')); // provisioner CF create
      const r = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        confirm: true,
        environment: 'production',
        orgId: 'org1',
        ownsSite: ownsTrue,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.resourceId).toBe('db-uuid-1');
      expect(r.created).toBe(true);
      expect(r.displayName).toBe('ps-site-site1');
      // The allocation row was written by the provisioner.
      expect(allocRow(h)?.d1_database_id).toBe('db-uuid-1');
      // A tenancy='dedicated' account_resource registry row was recorded, scoped to the owned site+org.
      const rows = registryRows(h);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        site_id: 'site1',
        org_id: 'org1',
        environment: 'production',
        resource_kind: 'd1',
        resource_concept: 'account_resource',
        tenancy: 'dedicated',
        resource_id_or_name: 'db-uuid-1',
        cf_account_id: 'acct-1',
        access_policy: 'no_direct',
      });
    } finally {
      h.close();
    }
  });

  it('(e) IDEMPOTENT — a second provision returns the existing row, creates NOTHING (no 2nd CF create)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      mockFetch
        .mockReturnValueOnce(quotaListResponse(10))
        .mockReturnValueOnce(d1CreatedResponse('db-uuid-1'));
      const first = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        confirm: true,
        environment: 'production',
        orgId: 'org1',
        ownsSite: ownsTrue,
      });
      expect(first.ok).toBe(true);
      const callsAfterFirst = mockFetch.mock.calls.length;

      const second = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        confirm: true,
        environment: 'production',
        orgId: 'org1',
        ownsSite: ownsTrue,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected ok');
      expect(second.created).toBe(false); // reused, not created
      expect(second.resourceId).toBe('db-uuid-1');
      // The idempotency short-circuit fires BEFORE the quota check → NO extra CF calls at all.
      expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
      // Still exactly ONE registry row (no duplicate).
      expect(registryRows(h)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('(g) org isolation — a foreign org (ownsSite=false) → not_owned, ZERO CF calls', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      const r = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        confirm: true,
        environment: 'production',
        orgId: 'other-org',
        ownsSite: async () => false,
      });
      expect(r).toEqual({ ok: false, reason: 'not_owned' });
      expect(mockFetch).not.toHaveBeenCalled();
      expect(registryRows(h)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('unauthorized — no orgId → unauthorized, ZERO CF calls', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      const r = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        confirm: true,
        environment: 'production',
        orgId: undefined,
        ownsSite: ownsTrue,
      });
      expect(r).toEqual({ ok: false, reason: 'unauthorized' });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });
});

describe('provisionResource (f) partial recovery', () => {
  it('provisioner succeeds but the registry record FAILS → record_failed WITH the created id (recoverable)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      // Intentionally DO NOT create the registry table → recordResource's INSERT fails (dbInsert returns
      // an error), while the provisioner's allocation INSERT succeeds. The CF resource exists; the row
      // didn't record → a recoverable partial the caller must surface.
      mockFetch
        .mockReturnValueOnce(quotaListResponse(10))
        .mockReturnValueOnce(d1CreatedResponse('db-uuid-1'));
      const r = await provisionResource(envWithCreds(h), 'site1', 'd1', {
        confirm: true,
        environment: 'production',
        orgId: 'org1',
        ownsSite: ownsTrue,
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('record_failed');
      if (r.reason !== 'record_failed') throw new Error('expected record_failed');
      // The created CF id IS reported so the partial state is recoverable (re-run reuses it).
      expect(r.resourceId).toBe('db-uuid-1');
      // The allocation WAS written (the resource genuinely exists) — proving this is a true partial.
      expect(allocRow(h)?.d1_database_id).toBe('db-uuid-1');
    } finally {
      h.close();
    }
  });
});

describe('d1Adapter.mutate({action:provision}) bridge (h)', () => {
  const baseScope = (h: D1SqliteHarness): ResolvedScope => ({
    accessPolicy: 'no_direct',
    accountId: 'acct-1',
    auth: { email: 'e', key: 'k' } as never,
    environment: 'production',
    orgId: 'org1',
    resourceId: '', // empty for a fresh provision — the id is the OUTPUT
    siteId: 'site1',
    // Server-attached env — ONLY the provision verb reads it.
    env: envWithCreds(h),
  });

  it('confirm absent → the adapter returns a confirmation_required envelope, nothing created', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      const res = await d1Adapter.mutate(baseScope(h), { action: 'provision' });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('confirmation_required');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(registryRows(h)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('confirm:true → delegates + returns the created id in a typed provision envelope', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      mockFetch
        .mockReturnValueOnce(quotaListResponse(10))
        .mockReturnValueOnce(d1CreatedResponse('db-uuid-1'));
      const res = await d1Adapter.mutate(baseScope(h), { action: 'provision', confirm: true });
      expect(res.ok).toBe(true);
      const data = res.data as { action: string; resourceId: string; created: boolean } | undefined;
      expect(data?.action).toBe('provision');
      expect(data?.resourceId).toBe('db-uuid-1');
      expect(data?.created).toBe(true);
      expect(registryRows(h)).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('quota at cap → the adapter surfaces quota_at_cap (no silent shared substitution)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(ALLOC_DDL);
      h.exec(REGISTRY_DDL);
      mockFetch.mockReturnValueOnce(quotaListResponse(45_000));
      const res = await d1Adapter.mutate(baseScope(h), { action: 'provision', confirm: true });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('quota_at_cap');
      expect(registryRows(h)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('declares the provision mutation in supports', () => {
    expect(d1Adapter.supports.mutations).toContain('provision');
  });
});
