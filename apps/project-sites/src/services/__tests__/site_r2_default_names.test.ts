/**
 * B2 — two-default-buckets model (Preview + Production), retire the legacy `uploads`/`production`
 * DEFAULT display names.
 *
 * Runs the REAL migration `0649` SQL + the REAL `ensureDefaultSiteR2` seed against a real SQLite
 * (`node:sqlite`) with CF fetch mocked — so it proves data-preservation + idempotency + collision
 * safety WITHOUT creating any real resource. The rename is display-name-only: the physical
 * `bucket_name` (`ps-site-{siteId}-uploads`) and every object stay put, because `resolveSiteR2Allocation`
 * looks up by the CURRENT `display_name` and uses the stored `bucket_name` for every physical op.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDefaultSiteR2 } from '../site_r2.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

const MIGRATIONS = join(__dirname, '../../../migrations');
const ALLOC_DDL = readFileSync(join(MIGRATIONS, '0645_site_r2_allocations.sql'), 'utf8');
const migration0649 = () =>
  readFileSync(join(MIGRATIONS, '0649_retire_uploads_default_name.sql'), 'utf8');

/** Seed one allocation row directly (bucket_name mirrors the real `ps-site-{id}-{slug}` convention). */
function seedAlloc(
  h: D1SqliteHarness,
  siteId: string,
  displayName: string,
  environment: 'preview' | 'production' = 'preview',
  isDefault = 1,
): void {
  const bucket = `ps-site-${siteId}-${displayName.toLowerCase()}`;
  h.exec(
    `INSERT INTO site_r2_allocations
       (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, status)
     VALUES ('${siteId}-${displayName}', 'org-1', '${siteId}', '${bucket}', '${displayName}', '${environment}', ${isDefault}, 'active')`,
  );
}

describe('B2 migration 0649 — retire uploads/production default display names', () => {
  it('renames uploads→Preview + production→Production, PRESERVING bucket_name', () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      seedAlloc(h, 'site-a', 'uploads', 'preview', 1);
      seedAlloc(h, 'site-a', 'production', 'production', 0);

      h.exec(migration0649());

      const rows = h.raw
        .prepare(`SELECT display_name, bucket_name FROM site_r2_allocations WHERE site_id='site-a'`)
        .all() as Array<{ display_name: string; bucket_name: string }>;

      // Preview default renamed; the PHYSICAL bucket (…-uploads) is untouched.
      const preview = rows.find((r) => r.bucket_name === 'ps-site-site-a-uploads')!;
      expect(preview.display_name).toBe('Preview');
      // Production renamed; physical bucket (…-production) untouched.
      const prod = rows.find((r) => r.bucket_name === 'ps-site-site-a-production')!;
      expect(prod.display_name).toBe('Production');
    } finally {
      h.close();
    }
  });

  it('is idempotent — re-running changes nothing', () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      seedAlloc(h, 'site-b', 'uploads', 'preview', 1);
      h.exec(migration0649());
      h.exec(migration0649()); // second apply must be a no-op

      const row = h.raw
        .prepare(`SELECT display_name FROM site_r2_allocations WHERE site_id='site-b'`)
        .get() as { display_name: string };
      expect(row.display_name).toBe('Preview');
    } finally {
      h.close();
    }
  });

  it('is collision-guarded — never renames into a display_name that already exists for the site', () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      seedAlloc(h, 'site-c', 'uploads', 'preview', 1); // the default
      seedAlloc(h, 'site-c', 'Preview', 'preview', 0); // a custom bucket already named 'Preview'

      h.exec(migration0649());

      // Renaming would create TWO 'Preview' rows for site-c → the by-name resolver would be ambiguous,
      // so the default is left as 'uploads'.
      const def = h.raw
        .prepare(
          `SELECT display_name FROM site_r2_allocations WHERE site_id='site-c' AND is_default=1`,
        )
        .get() as { display_name: string };
      expect(def.display_name).toBe('uploads');

      const count = (
        h.raw
          .prepare(
            `SELECT COUNT(*) c FROM site_r2_allocations WHERE site_id='site-c' AND display_name='Preview'`,
          )
          .get() as { c: number }
      ).c;
      expect(count).toBe(1);
    } finally {
      h.close();
    }
  });

  it('leaves a CUSTOM (non-default) bucket named uploads untouched', () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      seedAlloc(h, 'site-d', 'uploads', 'preview', 0); // custom, NOT the default

      h.exec(migration0649());

      const row = h.raw
        .prepare(`SELECT display_name FROM site_r2_allocations WHERE site_id='site-d'`)
        .get() as { display_name: string };
      expect(row.display_name).toBe('uploads'); // only the is_default preview bucket is retired
    } finally {
      h.close();
    }
  });
});

describe('B2 seed — ensureDefaultSiteR2 names a new default "Preview"', () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: {} }),
    } as unknown as Response);
  });

  it('seeds a NEW site\'s default bucket as display_name "Preview" (not "uploads")', async () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      // orgId=null → resolveCfCredentials uses the bundled global key (no per-org D1 lookup).
      const env = {
        DB: h.db,
        CF_ACCOUNT_ID: 'acct-1',
        CLOUDFLARE_EMAIL: 'e@x.com',
        CLOUDFLARE_API_KEY: 'gkey',
      } as unknown as Env;

      const res = await ensureDefaultSiteR2(env, 'site-new', 'tenant-1', null);
      expect(res.ok).toBe(true);

      const row = h.raw
        .prepare(
          `SELECT display_name, bucket_name, is_default FROM site_r2_allocations WHERE site_id='site-new'`,
        )
        .get() as { display_name: string; bucket_name: string; is_default: number };
      expect(row.display_name).toBe('Preview');
      expect(row.bucket_name).toBe('ps-site-site-new-preview');
      expect(row.is_default).toBe(1);
    } finally {
      h.close();
    }
  });
});
