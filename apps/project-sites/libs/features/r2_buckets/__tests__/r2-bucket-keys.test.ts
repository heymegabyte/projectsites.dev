/**
 * Service-layer coverage for the per-BUCKET owner-facing scoped R2 key (Buckets B4). A finer grain than
 * the SITE-wide owner key (B5 slice 4): an owner key scoped to ONE of the site's buckets, not all of
 * them. Proves the load-bearing guarantees against a REAL SQLite D1 (so the INSERT + lookup SELECTs
 * execute for real):
 *
 *   • SCOPING — the CF Create-Token policy resources are EXACTLY `[thatBucket]` (one element), never the
 *     site-wide set. The persisted `bucket_name` matches, and `scope_bucket_ids` is the single bucket.
 *   • ISOLATION — a key for bucket A scopes to A only; its resources EXCLUDE bucket B (and vice-versa).
 *     Site-wide (bucket_name NULL) and per-bucket keys COEXIST without colliding.
 *   • IDOR — `createBucketOwnerKey` for a bucket the site does NOT own resolves no allocation → honest
 *     `not_allocated` (never mints); `assertBucketOwnedBySite` HARD-THROWS on a cross-site bucket.
 *   • AUDIT — create/rotate/revoke each write exactly one `audit_logs` row carrying the accessKeyId but
 *     NEVER the secret (deep-scanned).
 *   • MIGRATION — 0662 is additive + idempotent (apply twice) and leaves existing rows unchanged
 *     (bucket_name reads back NULL for a site-wide 0661 row).
 *
 * Boundary mocks: `cf_credentials` (creds resolve without a real account) + global `fetch` (the CF
 * Create-Token POST + revoke DELETE) + `audit` (spy on `writeAuditLog`). D1 is REAL SQLite. The GLOBAL
 * `jest` is used so @swc hoists the mocks above the service import. (A jest.mock of a src/ module from
 * this dir needs FOUR `../`.)
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
  assertBucketOwnedBySite,
  BucketOwnershipError,
} from '../../../../src/services/site_r2_manager.js';
// eslint-disable-next-line import/first
import {
  createBucketOwnerKey,
  createSiteOwnerKey,
  getBucketOwnerKeyStatus,
  revokeBucketOwnerKey,
  rotateBucketOwnerKey,
  type SiteR2Context,
} from '../../../../src/services/site_r2.js';
// eslint-disable-next-line import/first
import { writeAuditLog } from '../../../../src/services/audit.js';
// eslint-disable-next-line import/first
import { createD1Sqlite, type D1SqliteHarness } from '../../../../src/__tests__/helpers/d1_sqlite.js';
// eslint-disable-next-line import/first
import type { Env } from '../../../../src/types/env.js';

const mockAudit = writeAuditLog as unknown as jest.Mock;

// ── Schema the per-bucket owner-key service reads/writes (mirrors 0660 + 0661 kind + 0662 bucket_name) ──
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
const BUCKET_A = `ps-site-${SITE}-alpha`;
const BUCKET_B = `ps-site-${SITE}-beta`;
const CF_TOKEN_VALUE = 'cf-raw-token-value-abcdef';
const CF_TOKEN_ID = 'cf-token-id-AKIAEXAMPLE';
const ACCOUNT = 'acct-1';

function env(h: D1SqliteHarness): Env {
  return { CF_ACCOUNT_ID: ACCOUNT, DB: h.db } as unknown as Env;
}
function ctx(): SiteR2Context {
  return { actorId: ACTOR, orgId: ORG, siteId: SITE, tenantId: ORG };
}

/** Seed TWO owned bucket allocations (alpha + beta) so per-bucket scope resolves to a real name. */
function seedAllocations(h: D1SqliteHarness): void {
  const ins = (id: string, bucket: string, display: string, def: number) =>
    h.raw
      .prepare(
        `INSERT INTO site_r2_allocations (id, tenant_id, site_id, bucket_name, display_name, is_default, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(id, ORG, SITE, bucket, display, def);
  ins(`alloc-a`, BUCKET_A, 'Alpha', 1);
  ins(`alloc-b`, BUCKET_B, 'Beta', 0);
}

function harness(): D1SqliteHarness {
  const h = createD1Sqlite();
  h.exec(TOKENS_DDL);
  h.exec(ALLOC_DDL);
  seedAllocations(h);
  return h;
}

/**
 * Stub the global `fetch`. The CF Create-Token POST captures the policy `resources` keys so a test can
 * assert the EXACT bucket scope. Returns {id,value}; token DELETE (revoke) → ok.
 */
function stubFetch(captured: { resources: string[][] }): jest.Mock {
  const f = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (/\/tokens$/.test(url) && method === 'POST') {
      try {
        const body = JSON.parse(init?.body ?? '{}') as {
          policies?: Array<{ resources?: Record<string, string> }>;
        };
        const keys = Object.keys(body.policies?.[0]?.resources ?? {});
        captured.resources.push(keys);
      } catch {
        captured.resources.push([]);
      }
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

/** The exact Access-Policy resource key the bucket-scoped token must carry (one per bucket). */
const resourceKey = (bucket: string) => `com.cloudflare.edge.r2.bucket.${ACCOUNT}_default_${bucket}`;

const realFetch = globalThis.fetch;
beforeEach(() => {
  mockAudit.mockReset();
  mockAudit.mockResolvedValue(undefined);
});
afterEach(() => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = realFetch;
});

describe('per-bucket owner key — scoping (resources == [bucket], not site-wide)', () => {
  it('scopes the minted token to EXACTLY the one bucket + persists bucket_name', async () => {
    const h = harness();
    const cap = { resources: [] as string[][] };
    stubFetch(cap);
    try {
      const res = await createBucketOwnerKey(env(h), ctx(), BUCKET_A);
      expect(res.ok).toBe(true);
      if (!res.ok || res.reused) throw new Error('expected a fresh mint');
      expect(res.key.secretAccessKey).toBeTruthy();

      // The CF token policy resources are EXACTLY [bucket A] — one element, not the site-wide set.
      expect(cap.resources).toHaveLength(1);
      expect(cap.resources[0]).toEqual([resourceKey(BUCKET_A)]);

      // The row persists bucket_name = BUCKET_A (per-bucket), kind='owner', scope = [BUCKET_A].
      const row = h.raw
        .prepare(`SELECT bucket_name, kind, scope_bucket_ids FROM site_r2_s3_tokens WHERE site_id = ?`)
        .get(SITE) as { bucket_name: string; kind: string; scope_bucket_ids: string };
      expect(row.bucket_name).toBe(BUCKET_A);
      expect(row.kind).toBe('owner');
      expect(JSON.parse(row.scope_bucket_ids)).toEqual([BUCKET_A]);
    } finally {
      h.close();
    }
  });

  it('is idempotent per bucket — a 2nd create returns the existing key MASKED, no 2nd mint', async () => {
    const h = harness();
    const cap = { resources: [] as string[][] };
    const f = stubFetch(cap);
    try {
      await createBucketOwnerKey(env(h), ctx(), BUCKET_A); // 1st → mint
      const again = await createBucketOwnerKey(env(h), ctx(), BUCKET_A); // 2nd → masked
      expect(again.ok).toBe(true);
      if (again.ok) expect('reused' in again && again.reused).toBe(true);
      // Only ONE CF token minted (one POST /tokens).
      const posts = f.mock.calls.filter(
        (c) => /\/tokens$/.test(c[0] as string) && (c[1] as { method?: string })?.method === 'POST',
      );
      expect(posts).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

describe('per-bucket owner key — isolation (A excludes B) + coexists with site-wide', () => {
  it('a key for bucket A scopes to A only; a key for bucket B scopes to B only', async () => {
    const h = harness();
    const cap = { resources: [] as string[][] };
    stubFetch(cap);
    try {
      await createBucketOwnerKey(env(h), ctx(), BUCKET_A);
      await createBucketOwnerKey(env(h), ctx(), BUCKET_B);
      expect(cap.resources[0]).toEqual([resourceKey(BUCKET_A)]);
      expect(cap.resources[0]).not.toContain(resourceKey(BUCKET_B));
      expect(cap.resources[1]).toEqual([resourceKey(BUCKET_B)]);
      expect(cap.resources[1]).not.toContain(resourceKey(BUCKET_A));

      // Two distinct per-bucket rows coexist.
      const rows = h.raw
        .prepare(
          `SELECT bucket_name FROM site_r2_s3_tokens WHERE site_id = ? AND kind='owner' AND status='active' ORDER BY bucket_name`,
        )
        .all(SITE) as Array<{ bucket_name: string }>;
      expect(rows.map((r) => r.bucket_name)).toEqual([BUCKET_A, BUCKET_B]);
    } finally {
      h.close();
    }
  });

  it('the SITE-WIDE owner key (bucket_name NULL) and a per-bucket key coexist independently', async () => {
    const h = harness();
    const cap = { resources: [] as string[][] };
    stubFetch(cap);
    try {
      await createSiteOwnerKey(env(h), ctx()); // site-wide → bucket_name NULL, scope = ALL buckets
      await createBucketOwnerKey(env(h), ctx(), BUCKET_A); // per-bucket → bucket_name = A

      const siteWide = h.raw
        .prepare(
          `SELECT scope_bucket_ids FROM site_r2_s3_tokens WHERE site_id=? AND kind='owner' AND bucket_name IS NULL AND status='active'`,
        )
        .get(SITE) as { scope_bucket_ids: string };
      // Site-wide scope covers BOTH buckets; per-bucket scope is A only — they don't collide.
      expect(JSON.parse(siteWide.scope_bucket_ids).sort()).toEqual([BUCKET_A, BUCKET_B].sort());

      const perBucket = h.raw
        .prepare(
          `SELECT scope_bucket_ids FROM site_r2_s3_tokens WHERE site_id=? AND kind='owner' AND bucket_name=? AND status='active'`,
        )
        .get(SITE, BUCKET_A) as { scope_bucket_ids: string };
      expect(JSON.parse(perBucket.scope_bucket_ids)).toEqual([BUCKET_A]);

      // getBucketOwnerKeyStatus sees the per-bucket key; the site-wide one does NOT bleed into it.
      const status = await getBucketOwnerKeyStatus(env(h), ctx(), BUCKET_A);
      expect(status.ok).toBe(true);
      if (status.ok) expect(status.key.exists).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('per-bucket owner key — IDOR (cannot mint for a bucket the site does not own)', () => {
  it('createBucketOwnerKey for an unowned bucket resolves no allocation → not_allocated (never mints)', async () => {
    const h = harness();
    const cap = { resources: [] as string[][] };
    const f = stubFetch(cap);
    try {
      const res = await createBucketOwnerKey(env(h), ctx(), 'ps-site-OTHER-secret');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('not_allocated');
      // No CF token minted for a bucket the site doesn't own.
      const posts = f.mock.calls.filter(
        (c) => /\/tokens$/.test(c[0] as string) && (c[1] as { method?: string })?.method === 'POST',
      );
      expect(posts).toHaveLength(0);
      // Nothing persisted.
      const row = h.raw
        .prepare(`SELECT COUNT(*) AS n FROM site_r2_s3_tokens WHERE site_id = ?`)
        .get(SITE) as { n: number };
      expect(row.n).toBe(0);
    } finally {
      h.close();
    }
  });

  it('refuses a FORBIDDEN shared platform bucket name (defense-in-depth)', async () => {
    const h = harness();
    const cap = { resources: [] as string[][] };
    stubFetch(cap);
    try {
      const res = await createBucketOwnerKey(env(h), ctx(), 'project-sites-production');
      expect(res.ok).toBe(false);
    } finally {
      h.close();
    }
  });

  it('assertBucketOwnedBySite HARD-THROWS BucketOwnershipError on a cross-site bucket', () => {
    const foreign = {
      accountId: ACCOUNT,
      bucketName: BUCKET_A,
      displayName: 'Alpha',
      id: 'bkt-1',
      isSystem: false,
      jurisdiction: null,
      kind: 'custom' as const,
      mutable: true,
      provisionState: 'active' as const,
      siteId: 'some-other-site',
    };
    expect(() => assertBucketOwnedBySite(foreign, SITE)).toThrow(BucketOwnershipError);
    // Same-site passes.
    expect(() => assertBucketOwnedBySite({ ...foreign, siteId: SITE }, SITE)).not.toThrow();
  });
});

describe('per-bucket owner key — rotate / revoke / audit (never the secret)', () => {
  it('createBucketOwnerKey writes r2.bucket_key.created with the accessKeyId + bucket, NO secret', async () => {
    const h = harness();
    stubFetch({ resources: [] });
    try {
      const res = await createBucketOwnerKey(env(h), ctx(), BUCKET_A);
      expect(res.ok).toBe(true);
      if (!res.ok || res.reused) throw new Error('expected a fresh mint');
      const secret = res.key.secretAccessKey;

      expect(mockAudit).toHaveBeenCalledTimes(1);
      const entry = mockAudit.mock.calls[0]![1];
      expect(entry.action).toBe('r2.bucket_key.created');
      expect(entry.target_id).toBe(SITE);
      expect(entry.metadata_json).toMatchObject({ access_key_id: CF_TOKEN_ID, bucket_name: BUCKET_A });
      // The show-once secret appears NOWHERE in the audit arguments.
      expect(allStrings(entry).some((s) => s.includes(secret))).toBe(false);
      expect(allStrings(entry)).not.toContain(CF_TOKEN_VALUE);
    } finally {
      h.close();
    }
  });

  it('rotateBucketOwnerKey supersedes + mints a NEW show-once secret, audit action=rotated', async () => {
    const h = harness();
    stubFetch({ resources: [] });
    try {
      await createBucketOwnerKey(env(h), ctx(), BUCKET_A);
      mockAudit.mockClear();
      const res = await rotateBucketOwnerKey(env(h), ctx(), BUCKET_A);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('rotate failed');
      expect(res.key.secretAccessKey).toBeTruthy();
      expect(mockAudit).toHaveBeenCalledTimes(1);
      expect(mockAudit.mock.calls[0]![1].action).toBe('r2.bucket_key.rotated');
      // Exactly one ACTIVE per-bucket row remains (the prior one superseded).
      const n = h.raw
        .prepare(
          `SELECT COUNT(*) AS n FROM site_r2_s3_tokens WHERE site_id=? AND kind='owner' AND bucket_name=? AND status='active'`,
        )
        .get(SITE, BUCKET_A) as { n: number };
      expect(n.n).toBe(1);
    } finally {
      h.close();
    }
  });

  it('revokeBucketOwnerKey tears down the key (audit action=revoked); idempotent no-op otherwise', async () => {
    const h = harness();
    stubFetch({ resources: [] });
    try {
      // Idempotent no-op first (no key yet) → revoked:false, no audit.
      const none = await revokeBucketOwnerKey(env(h), ctx(), BUCKET_A);
      expect(none.ok).toBe(true);
      if (none.ok) expect(none.revoked).toBe(false);
      expect(mockAudit).not.toHaveBeenCalled();

      await createBucketOwnerKey(env(h), ctx(), BUCKET_A);
      mockAudit.mockClear();
      const res = await revokeBucketOwnerKey(env(h), ctx(), BUCKET_A);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.revoked).toBe(true);
      expect(mockAudit).toHaveBeenCalledTimes(1);
      expect(mockAudit.mock.calls[0]![1].action).toBe('r2.bucket_key.revoked');
    } finally {
      h.close();
    }
  });

  it('revoking a per-bucket key does NOT touch another bucket key or the site-wide key', async () => {
    const h = harness();
    stubFetch({ resources: [] });
    try {
      await createSiteOwnerKey(env(h), ctx());
      await createBucketOwnerKey(env(h), ctx(), BUCKET_A);
      await createBucketOwnerKey(env(h), ctx(), BUCKET_B);
      await revokeBucketOwnerKey(env(h), ctx(), BUCKET_A);

      // A revoked; B + site-wide still active.
      const active = h.raw
        .prepare(
          `SELECT bucket_name FROM site_r2_s3_tokens WHERE site_id=? AND kind='owner' AND status='active' ORDER BY bucket_name`,
        )
        .all(SITE) as Array<{ bucket_name: string | null }>;
      const names = active.map((r) => r.bucket_name);
      expect(names).toContain(BUCKET_B);
      expect(names).toContain(null); // site-wide
      expect(names).not.toContain(BUCKET_A);
    } finally {
      h.close();
    }
  });

  it('getBucketOwnerKeyStatus returns the calm empty state when no per-bucket key exists', async () => {
    const h = harness();
    stubFetch({ resources: [] });
    try {
      const res = await getBucketOwnerKeyStatus(env(h), ctx(), BUCKET_A);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.key.exists).toBe(false);
        expect(res.key.status).toBe('none');
        expect(res.key).not.toHaveProperty('secretAccessKey');
      }
    } finally {
      h.close();
    }
  });
});

describe('migration 0662 — additive + idempotent + existing rows unchanged', () => {
  const MIG_0660 = `CREATE TABLE IF NOT EXISTS site_r2_s3_tokens (
    id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL,
    access_key_id TEXT NOT NULL, secret_enc TEXT NOT NULL, cf_token_id TEXT NOT NULL,
    scope_bucket_ids TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    rotated_at TEXT, deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_site_r2_s3_tokens_site ON site_r2_s3_tokens (site_id, status);`;
  const MIG_0661 = `ALTER TABLE site_r2_s3_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'internal';
  CREATE INDEX IF NOT EXISTS idx_site_r2_s3_tokens_site_kind ON site_r2_s3_tokens (site_id, kind, status);`;
  // The 0662 body under test (bucket_name scope).
  const MIG_0662 = `ALTER TABLE site_r2_s3_tokens ADD COLUMN bucket_name TEXT;
  CREATE INDEX IF NOT EXISTS idx_site_r2_s3_tokens_site_kind_bucket ON site_r2_s3_tokens (site_id, kind, bucket_name, status);`;

  /** `ALTER TABLE ADD COLUMN` is NOT idempotent in SQLite; mirror the runner tolerating "duplicate column". */
  function applyMigration(h: D1SqliteHarness, sql: string): void {
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      try {
        h.exec(stmt);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
    }
  }

  it('applies cleanly over 0660+0661, is re-appliable, and leaves a site-wide (0661) row NULL', () => {
    const h = createD1Sqlite();
    try {
      applyMigration(h, MIG_0660);
      applyMigration(h, MIG_0661);
      // Seed a pre-0662 owner row (the site-wide key: kind='owner', no bucket concept yet).
      h.raw
        .prepare(
          `INSERT INTO site_r2_s3_tokens (id, tenant_id, site_id, access_key_id, secret_enc, cf_token_id, scope_bucket_ids, status, kind)
           VALUES ('r1', ?, ?, 'AKIAOLD', ' ', 'tok-old', ?, 'active', 'owner')`,
        )
        .run(ORG, SITE, JSON.stringify([BUCKET_A, BUCKET_B]));

      // Apply 0662 (adds bucket_name + index), then apply AGAIN — idempotent (no throw, dup-column tolerated).
      applyMigration(h, MIG_0662);
      expect(() => applyMigration(h, MIG_0662)).not.toThrow();

      // The existing row reads back UNCHANGED, with bucket_name NULL (→ it's the site-wide owner key).
      const row = h.raw
        .prepare(`SELECT access_key_id, kind, scope_bucket_ids, bucket_name FROM site_r2_s3_tokens WHERE id='r1'`)
        .get() as { access_key_id: string; kind: string; scope_bucket_ids: string; bucket_name: string | null };
      expect(row.access_key_id).toBe('AKIAOLD');
      expect(row.kind).toBe('owner');
      expect(JSON.parse(row.scope_bucket_ids)).toEqual([BUCKET_A, BUCKET_B]);
      expect(row.bucket_name).toBeNull();

      // The new composite index exists.
      const idx = h.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
        .get('idx_site_r2_s3_tokens_site_kind_bucket') as { name: string } | undefined;
      expect(idx?.name).toBe('idx_site_r2_s3_tokens_site_kind_bucket');

      // A per-bucket row can now be inserted alongside the NULL site-wide row.
      h.raw
        .prepare(
          `INSERT INTO site_r2_s3_tokens (id, tenant_id, site_id, access_key_id, secret_enc, cf_token_id, scope_bucket_ids, status, kind, bucket_name)
           VALUES ('r2', ?, ?, 'AKIANEW', ' ', 'tok-new', ?, 'active', 'owner', ?)`,
        )
        .run(ORG, SITE, JSON.stringify([BUCKET_A]), BUCKET_A);
      const perBucket = h.raw
        .prepare(`SELECT bucket_name FROM site_r2_s3_tokens WHERE id='r2'`)
        .get() as { bucket_name: string };
      expect(perBucket.bucket_name).toBe(BUCKET_A);
    } finally {
      h.close();
    }
  });
});
