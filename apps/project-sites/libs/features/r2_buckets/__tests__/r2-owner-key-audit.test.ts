/**
 * Service-layer audit coverage for the owner-facing scoped R2 key lifecycle (`site_r2.ts` §owner key,
 * B5 — R6 P2 audit fix). The route test (`r2-owner-keys.test.ts`) mocks the whole `site_r2` service, so
 * it can't see the audit write; this suite runs the REAL `createSiteOwnerKey` / `rotateSiteOwnerKey` /
 * `revokeSiteOwnerKey` against a real SQLite D1 (so the INSERT + `activeOwnerKeyRow` SELECT execute for
 * real) and asserts each writes exactly one `audit_logs` entry via `writeAuditLog`.
 *
 * The load-bearing assertion: the audit metadata carries the `accessKeyId` (so an operator can correlate
 * the key at Cloudflare) but NEVER the `secretAccessKey` — the secret is show-once + unrecoverable, and
 * writing it into the audit trail would be a leak. We deep-scan every argument for the secret string.
 *
 * Boundary mocks: `cf_credentials` (so creds resolve without a real account) + the global `fetch` (the CF
 * Create-Token POST + the revoke DELETE) + `audit` (to spy on `writeAuditLog`). D1 is REAL SQLite. The
 * GLOBAL `jest` is used so @swc hoists the mocks above the service import. (A jest.mock of a src/ module
 * from this dir needs FOUR `../`.)
 */
jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: jest.fn(() => ({ 'x-auth': 'test' })),
  resolveCfCredentials: jest.fn(async () => ({ apiToken: 'test-token', kind: 'token' })),
}));
jest.mock('../../../../src/services/audit.js', () => ({
  writeAuditLog: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first -- imports must follow jest.mock (swc hoists the mocks)
import {
  createSiteOwnerKey,
  revokeSiteOwnerKey,
  rotateSiteOwnerKey,
  type SiteR2Context,
} from '../../../../src/services/site_r2.js';
// eslint-disable-next-line import/first
import { writeAuditLog } from '../../../../src/services/audit.js';
// eslint-disable-next-line import/first
import { createD1Sqlite, type D1SqliteHarness } from '../../../../src/__tests__/helpers/d1_sqlite.js';
// eslint-disable-next-line import/first
import type { Env } from '../../../../src/types/env.js';

const mockAudit = writeAuditLog as unknown as jest.Mock;

// ── Schema the owner-key service reads/writes (mirrors 0660 + 0661 `kind` + 0662 `bucket_name`, 0645) ─
const TOKENS_DDL = `CREATE TABLE site_r2_s3_tokens (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  access_key_id TEXT NOT NULL,
  secret_enc TEXT NOT NULL,
  cf_token_id TEXT NOT NULL,
  scope_bucket_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  kind TEXT NOT NULL DEFAULT 'internal',
  bucket_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  rotated_at TEXT,
  deleted_at TEXT
)`;
const ALLOC_DDL = `CREATE TABLE site_r2_allocations (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'preview',
  is_default INTEGER NOT NULL DEFAULT 0,
  public_access INTEGER NOT NULL DEFAULT 0,
  public_base_url TEXT,
  jurisdiction TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
)`;

const SITE = 'site-1';
const ORG = 'org-1';
const ACTOR = 'user-1';
// The raw CF token `value`; the Secret Access Key is its SHA-256 hex (service-derived, not stored).
const CF_TOKEN_VALUE = 'cf-raw-token-value-abcdef';
const CF_TOKEN_ID = 'cf-token-id-AKIAEXAMPLE';

function env(h: D1SqliteHarness): Env {
  return { CF_ACCOUNT_ID: 'acct-1', DB: h.db } as unknown as Env;
}

function ctx(): SiteR2Context {
  return { actorId: ACTOR, orgId: ORG, siteId: SITE, tenantId: ORG };
}

/** Seed the site's default bucket allocation so the token scope resolves to a real bucket name. */
function seedAllocation(h: D1SqliteHarness): void {
  h.raw
    .prepare(
      `INSERT INTO site_r2_allocations
         (id, tenant_id, site_id, bucket_name, display_name, is_default, status)
       VALUES (?, ?, ?, ?, ?, 1, 'active')`,
    )
    .run(`alloc-${SITE}`, ORG, SITE, `ps-site-${SITE}-preview`, 'Preview');
}

function harness(): D1SqliteHarness {
  const h = createD1Sqlite();
  h.exec(TOKENS_DDL);
  h.exec(ALLOC_DDL);
  seedAllocation(h);
  return h;
}

/** Stub the global `fetch`: CF Create-Token POST → {id,value}; token DELETE (revoke) → ok. */
function stubFetch(): jest.Mock {
  const f = jest.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (/\/tokens$/.test(url) && method === 'POST') {
      return new Response(
        JSON.stringify({ result: { id: CF_TOKEN_ID, value: CF_TOKEN_VALUE }, success: true }),
        { status: 200 },
      );
    }
    if (/\/tokens\//.test(url) && method === 'DELETE') {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = f as unknown as typeof fetch;
  return f;
}

/** Recursively collect every string reachable from a value (for the no-secret-leak scan). */
function allStrings(value: unknown, acc: string[] = []): string[] {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, acc);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) allStrings(v, acc);
  return acc;
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  mockAudit.mockReset();
  mockAudit.mockResolvedValue(undefined);
});
afterEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
});

describe('owner-key create — writes an audit row, never the secret', () => {
  it('createSiteOwnerKey writes r2.owner_key.created with the accessKeyId and NO secret', async () => {
    const h = harness();
    stubFetch();
    try {
      const res = await createSiteOwnerKey(env(h), ctx());
      expect(res.ok).toBe(true);
      if (!res.ok || res.reused) throw new Error('expected a fresh mint');
      const secret = res.key.secretAccessKey;
      expect(secret).toBeTruthy();

      // Exactly one audit write, with the create action + site/org/actor + the accessKeyId.
      expect(mockAudit).toHaveBeenCalledTimes(1);
      const [db, entry] = mockAudit.mock.calls[0]!;
      expect(db).toBe(h.db); // audited against the site's D1 binding
      expect(entry).toMatchObject({
        action: 'r2.owner_key.created',
        actor_id: ACTOR,
        org_id: ORG,
        target_id: SITE,
        target_type: 'site_r2_owner_key',
      });
      expect(entry.metadata_json).toMatchObject({ access_key_id: CF_TOKEN_ID, site_id: SITE });

      // The load-bearing guarantee: the show-once secret appears NOWHERE in the audit arguments.
      const strings = allStrings(entry);
      expect(strings.some((s) => s.includes(secret))).toBe(false);
      expect(strings).not.toContain(CF_TOKEN_VALUE); // nor the raw token the secret derives from
    } finally {
      h.close();
    }
  });

  it('attributes actor_id: null when no acting user is threaded', async () => {
    const h = harness();
    stubFetch();
    try {
      const res = await createSiteOwnerKey(env(h), { orgId: ORG, siteId: SITE, tenantId: ORG });
      expect(res.ok).toBe(true);
      expect(mockAudit).toHaveBeenCalledTimes(1);
      expect(mockAudit.mock.calls[0]![1]).toMatchObject({ actor_id: null, org_id: ORG });
    } finally {
      h.close();
    }
  });

  it('does NOT re-audit when an active key already exists (idempotent create is a no-op)', async () => {
    const h = harness();
    stubFetch();
    try {
      await createSiteOwnerKey(env(h), ctx()); // first mint → 1 audit
      mockAudit.mockClear();
      const again = await createSiteOwnerKey(env(h), ctx()); // existing key → masked, no new mint
      expect(again.ok).toBe(true);
      if (again.ok) expect('reused' in again && again.reused).toBe(true);
      expect(mockAudit).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });
});

describe('owner-key rotate + revoke — each writes its own audit row', () => {
  it('rotateSiteOwnerKey writes r2.owner_key.rotated with the NEW accessKeyId, no secret', async () => {
    const h = harness();
    stubFetch();
    try {
      const res = await rotateSiteOwnerKey(env(h), ctx());
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('rotate failed');
      const secret = res.key.secretAccessKey;

      // Rotate with no prior key behaves like create → one mint → one audit, action=rotated.
      expect(mockAudit).toHaveBeenCalledTimes(1);
      const entry = mockAudit.mock.calls[0]![1];
      expect(entry.action).toBe('r2.owner_key.rotated');
      expect(entry.metadata_json).toMatchObject({ access_key_id: CF_TOKEN_ID });
      expect(allStrings(entry).some((s) => s.includes(secret))).toBe(false);
    } finally {
      h.close();
    }
  });

  it('revokeSiteOwnerKey writes r2.owner_key.revoked for an existing key', async () => {
    const h = harness();
    stubFetch();
    try {
      await createSiteOwnerKey(env(h), ctx()); // mint a key to revoke
      mockAudit.mockClear();
      const res = await revokeSiteOwnerKey(env(h), ctx());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.revoked).toBe(true);
      expect(mockAudit).toHaveBeenCalledTimes(1);
      const entry = mockAudit.mock.calls[0]![1];
      expect(entry.action).toBe('r2.owner_key.revoked');
      expect(entry.target_id).toBe(SITE);
      expect(entry.metadata_json).toMatchObject({ access_key_id: CF_TOKEN_ID });
    } finally {
      h.close();
    }
  });

  it('does NOT audit an idempotent revoke when there is no key to revoke', async () => {
    const h = harness();
    stubFetch();
    try {
      const res = await revokeSiteOwnerKey(env(h), ctx());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.revoked).toBe(false);
      expect(mockAudit).not.toHaveBeenCalled();
    } finally {
      h.close();
    }
  });
});
