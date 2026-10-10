/**
 * B10 — reversible bucket environment reassignment (`assignBucketEnv`).
 *
 * Runs the REAL `0645_site_r2_allocations` DDL against a real SQLite (`node:sqlite`) + the REAL
 * `assignBucketEnv` service (NO CF fetch — env reassignment is a pure D1 UPDATE, no R2/CF call), and
 * asserts the four invariants the slice promises:
 *   1. a reassignment UPDATEs `environment` + returns the PREVIOUS environment (so the UI can roll back);
 *   2. `rollbackBucketEnv` restores the previous environment (round-trips byte-identical);
 *   3. the 2-default invariant is guarded — reassigning a DEFAULT bucket that would orphan its old
 *      environment's default OR duplicate the target environment's default is REJECTED (409), not
 *      silently corrupted; a NON-default (unassigned/custom) bucket reassigns freely;
 *   4. `updated_at` is bumped on a successful reassignment.
 *
 * Isolation (IDOR) is enforced at the ROUTE via `gateAndBucket` (a foreign bucket resolves to null →
 * 404) — covered in the handler test. The service receives an already-resolved, owned allocation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assignBucketEnv, rollbackBucketEnv, resolveSiteR2Allocation } from '../site_r2.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

const MIGRATIONS = join(__dirname, '../../../migrations');
const ALLOC_DDL = readFileSync(join(MIGRATIONS, '0645_site_r2_allocations.sql'), 'utf8');

/** Seed one allocation row (bucket_name mirrors the real `ps-site-{id}-{slug}` convention). */
function seedAlloc(
  h: D1SqliteHarness,
  siteId: string,
  displayName: string,
  environment: 'preview' | 'production',
  isDefault: 0 | 1,
  updatedAt = '2020-01-01 00:00:00',
): void {
  const bucket = `ps-site-${siteId}-${displayName.toLowerCase()}`;
  h.exec(
    `INSERT INTO site_r2_allocations
       (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, status, created_at, updated_at)
     VALUES ('${siteId}-${displayName}', 'org-1', '${siteId}', '${bucket}', '${displayName}', '${environment}', ${isDefault}, 'active', '2020-01-01 00:00:00', '${updatedAt}')`,
  );
}

const env = (h: D1SqliteHarness): Env => ({ DB: h.db }) as unknown as Env;

describe('B10 assignBucketEnv — reversible env reassignment', () => {
  it('reassigns a NON-default bucket preview→production and returns the previous environment', async () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      seedAlloc(h, 'site-a', 'Preview', 'preview', 1); // the default (untouched)
      seedAlloc(h, 'site-a', 'Media', 'preview', 0); // custom bucket we move

      const alloc = await resolveSiteR2Allocation(env(h), 'site-a', 'Media');
      const res = await assignBucketEnv(env(h), 'site-a', alloc!, 'production');

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('expected ok');
      expect(res.previousEnvironment).toBe('preview');
      expect(res.bucket.environment).toBe('production');

      // Persisted.
      const after = await resolveSiteR2Allocation(env(h), 'site-a', 'Media');
      expect(after!.environment).toBe('production');
    } finally {
      h.close();
    }
  });

  it('rollbackBucketEnv restores the previous environment (round-trip)', async () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      seedAlloc(h, 'site-b', 'Media', 'preview', 0);

      const alloc = await resolveSiteR2Allocation(env(h), 'site-b', 'Media');
      const assigned = await assignBucketEnv(env(h), 'site-b', alloc!, 'production');
      expect(assigned.ok).toBe(true);
      if (!assigned.ok) throw new Error('expected ok');

      // Roll back to where it was.
      const rolled = await rollbackBucketEnv(
        env(h),
        'site-b',
        assigned.bucket,
        assigned.previousEnvironment,
      );
      expect(rolled.ok).toBe(true);
      if (!rolled.ok) throw new Error('expected ok');
      expect(rolled.bucket.environment).toBe('preview');

      const after = await resolveSiteR2Allocation(env(h), 'site-b', 'Media');
      expect(after!.environment).toBe('preview');
    } finally {
      h.close();
    }
  });

  it('bumps updated_at on a successful reassignment', async () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      seedAlloc(h, 'site-c', 'Media', 'preview', 0, '2020-01-01 00:00:00');

      const alloc = await resolveSiteR2Allocation(env(h), 'site-c', 'Media');
      await assignBucketEnv(env(h), 'site-c', alloc!, 'production');

      const row = h.raw
        .prepare(
          `SELECT updated_at FROM site_r2_allocations WHERE site_id='site-c' AND display_name='Media'`,
        )
        .get() as { updated_at: string };
      expect(row.updated_at).not.toBe('2020-01-01 00:00:00');
    } finally {
      h.close();
    }
  });

  it('is a no-op success when the bucket is ALREADY in the target environment (previous === target)', async () => {
    const h = createD1Sqlite();

    try {
      h.exec(ALLOC_DDL);
      seedAlloc(h, 'site-d', 'Media', 'production', 0);

      const alloc = await resolveSiteR2Allocation(env(h), 'site-d', 'Media');
      const res = await assignBucketEnv(env(h), 'site-d', alloc!, 'production');

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('expected ok');
      expect(res.previousEnvironment).toBe('production');
      expect(res.bucket.environment).toBe('production');
    } finally {
      h.close();
    }
  });

  describe('2-default invariant guard', () => {
    it('REJECTS moving the Preview DEFAULT → production (would orphan preview + duplicate production default)', async () => {
      const h = createD1Sqlite();

      try {
        h.exec(ALLOC_DDL);
        seedAlloc(h, 'site-e', 'Preview', 'preview', 1); // preview default
        seedAlloc(h, 'site-e', 'Production', 'production', 1); // production default

        const alloc = await resolveSiteR2Allocation(env(h), 'site-e', 'Preview');
        const res = await assignBucketEnv(env(h), 'site-e', alloc!, 'production');

        expect(res.ok).toBe(false);
        if (res.ok) throw new Error('expected rejection');
        expect(res.reason).toBe('default_invariant');

        // Unchanged — not silently corrupted.
        const after = await resolveSiteR2Allocation(env(h), 'site-e', 'Preview');
        expect(after!.environment).toBe('preview');
      } finally {
        h.close();
      }
    });

    it('REJECTS moving the Production DEFAULT → preview (would duplicate preview default + orphan production)', async () => {
      const h = createD1Sqlite();

      try {
        h.exec(ALLOC_DDL);
        seedAlloc(h, 'site-f', 'Preview', 'preview', 1);
        seedAlloc(h, 'site-f', 'Production', 'production', 1);

        const alloc = await resolveSiteR2Allocation(env(h), 'site-f', 'Production');
        const res = await assignBucketEnv(env(h), 'site-f', alloc!, 'preview');

        expect(res.ok).toBe(false);
        if (res.ok) throw new Error('expected rejection');
        expect(res.reason).toBe('default_invariant');
      } finally {
        h.close();
      }
    });

    it('ALLOWS moving a NON-default custom bucket between environments even when both defaults exist', async () => {
      const h = createD1Sqlite();

      try {
        h.exec(ALLOC_DDL);
        seedAlloc(h, 'site-g', 'Preview', 'preview', 1);
        seedAlloc(h, 'site-g', 'Production', 'production', 1);
        seedAlloc(h, 'site-g', 'Media', 'preview', 0); // custom — free to move

        const alloc = await resolveSiteR2Allocation(env(h), 'site-g', 'Media');
        const res = await assignBucketEnv(env(h), 'site-g', alloc!, 'production');

        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error('expected ok');
        expect(res.bucket.environment).toBe('production');

        // The two defaults are untouched.
        const pv = await resolveSiteR2Allocation(env(h), 'site-g', 'Preview');
        const pd = await resolveSiteR2Allocation(env(h), 'site-g', 'Production');
        expect(pv!.environment).toBe('preview');
        expect(pd!.environment).toBe('production');
      } finally {
        h.close();
      }
    });
  });
});
