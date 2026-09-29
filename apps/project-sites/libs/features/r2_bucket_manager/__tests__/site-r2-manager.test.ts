/**
 * Slice-1 foundation tests for the R2 Bucket Manager service layer (`src/services/site_r2_manager.ts`).
 *
 * Runs against a REAL SQLite (`createD1Sqlite`) so `resolveSiteBuckets` executes its ACTUAL catalog SQL
 * and reconciles what it RETURNS against ground truth seeded in `site_r2_buckets` (the
 * `verify-against-source-of-truth` discipline) — a mock double would never run the SQL.
 *
 * Journey A (authoritative, site-scoped list):
 *   - the isogit project bucket ALWAYS appears as a distinct PROTECTED `is_system` "Project code · Preview"
 *     entry (synthesized — needs no catalog row);
 *   - a site's OWN custom buckets appear as mutable entries;
 *   - ANOTHER site's buckets NEVER appear (structural `WHERE site_id=?`);
 *   - `assertSiteOwned` gates the list (foreign/missing site → typed ownership failure).
 * Plus the two HARD-THROW service guards (`assertBucketMutable`, `assertBucketOwnedBySite`) and
 * create-name validation.
 */
import {
  assertBucketMutable,
  assertBucketOwnedBySite,
  BucketOwnershipError,
  isValidNewBucketName,
  resolveSiteBuckets,
  SYSTEM_BUCKET_ID,
  SystemBucketProtectedError,
  type SiteR2ManagerBucket,
} from '../../../../src/services/site_r2_manager.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../../../src/__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../../../src/types/env.js';

// ── Schema the manager reads (mirrors migrations 0647 catalog + the `sites` ownership table) ────────
const SITES_DDL = `CREATE TABLE sites (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT NOT NULL, deleted_at TEXT
)`;
const CATALOG_DDL = `CREATE TABLE site_r2_buckets (
  id TEXT NOT NULL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  bucket_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom',
  is_system INTEGER NOT NULL DEFAULT 0,
  jurisdiction TEXT,
  provision_state TEXT NOT NULL DEFAULT 'active',
  credential_ref TEXT,
  account_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
)`;

function seedSite(h: D1SqliteHarness, id: string, orgId: string, slug: string): void {
  h.raw.prepare('INSERT INTO sites (id, org_id, slug) VALUES (?, ?, ?)').run(id, orgId, slug);
}

/** Seed one CUSTOM (mutable) catalog row for a site. */
function seedCustomBucket(h: D1SqliteHarness, siteId: string, orgId: string, name: string): void {
  h.raw
    .prepare(
      `INSERT INTO site_r2_buckets
        (id, tenant_id, site_id, bucket_name, display_name, kind, is_system, provision_state, account_id)
       VALUES (?, ?, ?, ?, ?, 'custom', 0, 'active', 'acct-1')`,
    )
    .run(`row-${siteId}-${name}`, orgId, siteId, `ps-site-${siteId}-${name}`, name);
}

function env(h: D1SqliteHarness): Env {
  return { DB: h.db, CF_ACCOUNT_ID: 'acct-1' } as unknown as Env;
}

const OWNED_SITE = 'site-owned';
const OTHER_SITE = 'site-other';
const ORG = 'org-1';
const OTHER_ORG = 'org-2';

function harness(): D1SqliteHarness {
  const h = createD1Sqlite();
  h.exec(SITES_DDL);
  h.exec(CATALOG_DDL);
  seedSite(h, OWNED_SITE, ORG, 'vitos-salon');
  seedSite(h, OTHER_SITE, OTHER_ORG, 'other-biz');
  return h;
}

describe('resolveSiteBuckets — Journey A (authoritative, site-scoped)', () => {
  it('ALWAYS includes the protected isogit "Project code · Preview" system bucket as a distinct entry', async () => {
    const h = harness();
    try {
      const res = await resolveSiteBuckets(env(h), OWNED_SITE, ORG);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const system = res.buckets.filter((b) => b.isSystem);
      expect(system).toHaveLength(1);
      expect(system[0]!.id).toBe(SYSTEM_BUCKET_ID);
      expect(system[0]!.displayName).toMatch(/project code/i);
      // The system bucket is NEVER mutable.
      expect(system[0]!.mutable).toBe(false);
    } finally {
      h.close();
    }
  });

  it('lists the SITE\'S OWN custom buckets alongside the system bucket', async () => {
    const h = harness();
    try {
      seedCustomBucket(h, OWNED_SITE, ORG, 'uploads');
      seedCustomBucket(h, OWNED_SITE, ORG, 'assets');
      const res = await resolveSiteBuckets(env(h), OWNED_SITE, ORG);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const names = res.buckets.map((b) => b.displayName);
      expect(names).toContain('uploads');
      expect(names).toContain('assets');
      // system + 2 custom
      expect(res.buckets).toHaveLength(3);
      // custom buckets are mutable
      const uploads = res.buckets.find((b) => b.displayName === 'uploads')!;
      expect(uploads.isSystem).toBe(false);
      expect(uploads.mutable).toBe(true);
    } finally {
      h.close();
    }
  });

  it('NEVER returns another site\'s buckets (structural site scoping)', async () => {
    const h = harness();
    try {
      seedCustomBucket(h, OTHER_SITE, OTHER_ORG, 'secret-bucket');
      const res = await resolveSiteBuckets(env(h), OWNED_SITE, ORG);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Only the synthesized system bucket — none of the OTHER site's rows leak in.
      expect(res.buckets.every((b) => b.displayName !== 'secret-bucket')).toBe(true);
      expect(res.buckets.filter((b) => !b.isSystem)).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it('fails with an ownership reason when the caller does NOT own the site (never leaks buckets)', async () => {
    const h = harness();
    try {
      // ORG asks for OTHER_SITE (owned by OTHER_ORG) → not owned.
      const res = await resolveSiteBuckets(env(h), OTHER_SITE, ORG);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('not_owned');
    } finally {
      h.close();
    }
  });

  it('fails with an ownership reason for a missing site', async () => {
    const h = harness();
    try {
      const res = await resolveSiteBuckets(env(h), 'no-such-site', ORG);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe('not_owned');
    } finally {
      h.close();
    }
  });

  it('returns a cursor page shape (paginated, authoritative)', async () => {
    const h = harness();
    try {
      seedCustomBucket(h, OWNED_SITE, ORG, 'uploads');
      const res = await resolveSiteBuckets(env(h), OWNED_SITE, ORG, { limit: 50 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // cursor field present (null when no more pages).
      expect(res).toHaveProperty('cursor');
    } finally {
      h.close();
    }
  });
});

describe('assertBucketMutable — SERVICE-layer system-bucket protection (HARD THROW)', () => {
  const systemBucket: SiteR2ManagerBucket = {
    id: SYSTEM_BUCKET_ID,
    siteId: OWNED_SITE,
    bucketName: 'project-sites-assets',
    displayName: 'Project code · Preview',
    isSystem: true,
    mutable: false,
    kind: 'system',
    jurisdiction: null,
    provisionState: 'active',
    accountId: 'acct-1',
  };
  const customBucket: SiteR2ManagerBucket = {
    id: 'row-1',
    siteId: OWNED_SITE,
    bucketName: 'ps-site-x-uploads',
    displayName: 'uploads',
    isSystem: false,
    mutable: true,
    kind: 'custom',
    jurisdiction: null,
    provisionState: 'active',
    accountId: 'acct-1',
  };

  it('THROWS SystemBucketProtectedError for config/reset/empty/delete on the system bucket', () => {
    for (const op of ['config', 'reset', 'empty', 'delete'] as const) {
      expect(() => assertBucketMutable(systemBucket, op)).toThrow(SystemBucketProtectedError);
    }
  });

  it('does NOT throw for a mutable custom bucket', () => {
    expect(() => assertBucketMutable(customBucket, 'delete')).not.toThrow();
  });
});

describe('assertBucketOwnedBySite — cross-site guard (HARD THROW, defense-in-depth)', () => {
  const bucket: SiteR2ManagerBucket = {
    id: 'row-1',
    siteId: OWNED_SITE,
    bucketName: 'ps-site-owned-uploads',
    displayName: 'uploads',
    isSystem: false,
    mutable: true,
    kind: 'custom',
    jurisdiction: null,
    provisionState: 'active',
    accountId: 'acct-1',
  };

  it('THROWS BucketOwnershipError when the bucket belongs to a different site', () => {
    expect(() => assertBucketOwnedBySite(bucket, OTHER_SITE)).toThrow(BucketOwnershipError);
  });

  it('does NOT throw when the bucket belongs to the site', () => {
    expect(() => assertBucketOwnedBySite(bucket, OWNED_SITE)).not.toThrow();
  });
});

describe('isValidNewBucketName — create-name validation', () => {
  it('accepts a legal short display name', () => {
    expect(isValidNewBucketName('uploads')).toBe(true);
    expect(isValidNewBucketName('My Assets 2')).toBe(true);
    expect(isValidNewBucketName('brand-kit_v2')).toBe(true);
  });

  it('rejects empty, oversized, hostile, or wrong-charset names', () => {
    expect(isValidNewBucketName('')).toBe(false);
    expect(isValidNewBucketName('   ')).toBe(false);
    expect(isValidNewBucketName('!!!')).toBe(false);
    expect(isValidNewBucketName('a'.repeat(40))).toBe(false); // > 30
    expect(isValidNewBucketName('bad/slash')).toBe(false); // '/' is not in the charset
    expect(isValidNewBucketName(42 as unknown as string)).toBe(false);
  });

  it('trims surrounding whitespace before validating (a stray leading/trailing space is sanitized, not rejected)', () => {
    // Matches site_r2.isValidBucketDisplayName + NewBucketNameSchema (both .trim() first) — a user
    // typing a leading space should succeed with the trimmed name, never be hard-rejected.
    expect(isValidNewBucketName(' uploads ')).toBe(true);
  });
});
