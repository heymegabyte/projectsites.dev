/**
 * Per-object public + revoke-safe signed shares (Buckets B9) — the SECURITY heart, tested against a REAL
 * SQLite (`object_visibility` migration 0663 + `site_r2_allocations`). Proves the invariants a share link
 * MUST hold, with zero real R2:
 *   • setObjectPublic mints an UNGUESSABLE slug (≥128-bit, URL-safe, unique per call) + optional expiry.
 *   • resolvePublicObject DENIES (null) a revoked / expired / private / unknown slug — fails CLOSED.
 *   • revoke is IMMEDIATE (resolve denies the instant revoked_at is set).
 *   • expiry is enforced SERVER-SIDE (a past expires_at denies).
 *   • PUBLIC-BUCKET INHERITANCE — a bucket with public_access=1 resolves its objects public even when the
 *     per-object row is private; flipping the bucket private re-privatizes instantly.
 *   • the slug is the ONLY handle (resolve takes no bucket/key) → no enumeration, no IDOR.
 *
 * `@swc/jest` only hoists `jest.mock(...)` with the GLOBAL `jest` — do NOT import it (CLAUDE.md gotcha #12).
 */
import {
  generatePublicSlug,
  getObjectVisibility,
  resolvePublicObject,
  revokeObjectPublic,
  setObjectPublic,
  type SiteR2Allocation,
} from '../site_r2.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const VIS_DDL = readFileSync(
  join(__dirname, '../../../migrations/0663_object_visibility.sql'),
  'utf8',
);
const ALLOC_DDL = `CREATE TABLE site_r2_allocations (
  id TEXT PRIMARY KEY, tenant_id TEXT, site_id TEXT, bucket_name TEXT UNIQUE, display_name TEXT,
  environment TEXT, is_default INTEGER, public_access INTEGER, public_base_url TEXT,
  jurisdiction TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`;

const BUCKET = 'ps-site-site1-preview';
const KEY = 'docs/report.pdf';
const ctx = { orgId: 'org1', siteId: 'site1', tenantId: 'org1' };

const allocation: SiteR2Allocation = {
  bucketName: BUCKET,
  createdAt: '2026-10-10T00:00:00.000Z',
  displayName: 'Preview',
  environment: 'preview',
  id: 'alloc1',
  isDefault: true,
  publicAccess: false,
  publicBaseUrl: null,
};

/** Seed the owning allocation row (optionally bucket-public). */
function seedAlloc(
  h: D1SqliteHarness,
  opts: { publicAccess?: boolean; status?: string } = {},
): void {
  h.raw
    .prepare(
      `INSERT INTO site_r2_allocations (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, public_access, status)
       VALUES ('alloc1','org1','site1',?, 'Preview','preview',1,?, ?)`,
    )
    .run(BUCKET, opts.publicAccess ? 1 : 0, opts.status ?? 'active');
}

function env(h: D1SqliteHarness): Env {
  return { DB: h.db, PUBLIC_BASE_URL: 'https://projectsites.dev' } as unknown as Env;
}

function setup(allocOpts: { publicAccess?: boolean; status?: string } = {}): D1SqliteHarness {
  const h = createD1Sqlite();
  h.exec(VIS_DDL);
  h.exec(ALLOC_DDL);
  seedAlloc(h, allocOpts);
  return h;
}

describe('generatePublicSlug — unguessable, URL-safe, unique', () => {
  it('produces a ≥128-bit (≥22 base64url char) slug with only URL-safe chars, distinct each call', () => {
    const a = generatePublicSlug();
    const b = generatePublicSlug();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(22); // 128 bits / 6 bits-per-char ≈ 22
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no +/=, path-safe
  });
});

describe('setObjectPublic → resolvePublicObject (the happy share path)', () => {
  it('mints a live share that resolves to the EXACT bucket+key+tenant; the URL is the gateway path', async () => {
    const h = setup();
    try {
      const r = await setObjectPublic(env(h), ctx, allocation, KEY);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.publicSlug).toMatch(/^[A-Za-z0-9_-]{22,}$/);
      expect(r.url).toBe(
        `https://projectsites.dev/api/r2/public/${encodeURIComponent(r.publicSlug)}`,
      );
      expect(r.expiresAt).toBeNull();

      const resolved = await resolvePublicObject(env(h), r.publicSlug);
      expect(resolved).not.toBeNull();
      expect(resolved).toMatchObject({
        bucketName: BUCKET,
        objectKey: KEY,
        orgId: 'org1',
        siteId: 'site1',
        tenantId: 'org1',
      });
    } finally {
      h.close();
    }
  });

  it('re-sharing the same object ROTATES the slug (old slug is dead, new one resolves)', async () => {
    const h = setup();
    try {
      const first = await setObjectPublic(env(h), ctx, allocation, KEY);
      const second = await setObjectPublic(env(h), ctx, allocation, KEY);
      if (!first.ok || !second.ok) throw new Error('expected ok');
      expect(second.publicSlug).not.toBe(first.publicSlug);
      // Only ONE row for the object (upsert, not duplicate).
      const count = h.raw.prepare('SELECT COUNT(*) c FROM object_visibility').get() as {
        c: number;
      };
      expect(count.c).toBe(1);
      // The OLD slug no longer resolves; the NEW one does.
      expect(await resolvePublicObject(env(h), first.publicSlug)).toBeNull();
      expect(await resolvePublicObject(env(h), second.publicSlug)).not.toBeNull();
    } finally {
      h.close();
    }
  });
});

describe('resolvePublicObject — DENY (fails closed) for every non-live state', () => {
  it('DENIES an unknown slug (null)', async () => {
    const h = setup();
    try {
      expect(await resolvePublicObject(env(h), 'totally-made-up-slug')).toBeNull();
      expect(await resolvePublicObject(env(h), '')).toBeNull();
    } finally {
      h.close();
    }
  });

  it('DENIES immediately after revoke (revoke is instant)', async () => {
    const h = setup();
    try {
      const r = await setObjectPublic(env(h), ctx, allocation, KEY);
      if (!r.ok) throw new Error('expected ok');
      expect(await resolvePublicObject(env(h), r.publicSlug)).not.toBeNull(); // live first
      const rev = await revokeObjectPublic(env(h), ctx, allocation, KEY);
      expect(rev.ok && rev.revoked).toBe(true);
      expect(await resolvePublicObject(env(h), r.publicSlug)).toBeNull(); // dead the moment it's revoked
    } finally {
      h.close();
    }
  });

  it('DENIES a share whose expiry has passed (server-enforced expiry)', async () => {
    const h = setup();
    try {
      const r = await setObjectPublic(env(h), ctx, allocation, KEY, { expiresInSeconds: 3600 });
      if (!r.ok) throw new Error('expected ok');
      expect(r.expiresAt).not.toBeNull();
      // Live while in-window.
      expect(await resolvePublicObject(env(h), r.publicSlug)).not.toBeNull();
      // Force the expiry into the past → DENY (the client cannot bypass this; it's a server check).
      h.raw
        .prepare(`UPDATE object_visibility SET expires_at = ? WHERE public_slug = ?`)
        .run(new Date(Date.now() - 1000).toISOString(), r.publicSlug);
      expect(await resolvePublicObject(env(h), r.publicSlug)).toBeNull();
    } finally {
      h.close();
    }
  });

  it('DENIES when the owning allocation is deleted/inactive after sharing', async () => {
    const h = setup();
    try {
      const r = await setObjectPublic(env(h), ctx, allocation, KEY);
      if (!r.ok) throw new Error('expected ok');
      h.raw
        .prepare(`UPDATE site_r2_allocations SET deleted_at = datetime('now') WHERE id='alloc1'`)
        .run();
      expect(await resolvePublicObject(env(h), r.publicSlug)).toBeNull();
    } finally {
      h.close();
    }
  });
});

describe('public-bucket inheritance (bucket public ⇒ all objects public)', () => {
  it('a bucket-PUBLIC allocation resolves an object whose per-object row is PRIVATE/revoked', async () => {
    const h = setup({ publicAccess: true });
    try {
      // Share then revoke → per-object row is private+revoked, BUT the bucket is public → still serves.
      const r = await setObjectPublic(env(h), ctx, allocation, KEY);
      if (!r.ok) throw new Error('expected ok');
      await revokeObjectPublic(env(h), ctx, allocation, KEY);
      const resolved = await resolvePublicObject(env(h), r.publicSlug);
      expect(resolved).not.toBeNull(); // inheritance wins while the bucket is public
      expect(resolved).toMatchObject({ bucketName: BUCKET, objectKey: KEY });
    } finally {
      h.close();
    }
  });

  it('flipping the bucket back to PRIVATE re-privatizes the (revoked) object instantly', async () => {
    const h = setup({ publicAccess: true });
    try {
      const r = await setObjectPublic(env(h), ctx, allocation, KEY);
      if (!r.ok) throw new Error('expected ok');
      await revokeObjectPublic(env(h), ctx, allocation, KEY);
      expect(await resolvePublicObject(env(h), r.publicSlug)).not.toBeNull(); // public via bucket
      h.raw.prepare(`UPDATE site_r2_allocations SET public_access = 0 WHERE id='alloc1'`).run();
      expect(await resolvePublicObject(env(h), r.publicSlug)).toBeNull(); // bucket private + object revoked → DENY
    } finally {
      h.close();
    }
  });
});

describe('revokeObjectPublic — idempotent honest no-op', () => {
  it('revoking a never-shared object succeeds with revoked:false (nothing live to kill)', async () => {
    const h = setup();
    try {
      const rev = await revokeObjectPublic(env(h), ctx, allocation, 'never/shared.png');
      expect(rev.ok).toBe(true);
      if (!rev.ok) throw new Error('expected ok');
      expect(rev.revoked).toBe(false);
    } finally {
      h.close();
    }
  });

  it('double-revoke is a no-op the second time', async () => {
    const h = setup();
    try {
      await setObjectPublic(env(h), ctx, allocation, KEY);
      const first = await revokeObjectPublic(env(h), ctx, allocation, KEY);
      const second = await revokeObjectPublic(env(h), ctx, allocation, KEY);
      expect(first.ok && first.revoked).toBe(true);
      expect(second.ok && (second as { revoked: boolean }).revoked).toBe(false);
    } finally {
      h.close();
    }
  });
});

describe('getObjectVisibility — honest owner-facing state', () => {
  it('null when never shared; live view after share; revoked view after revoke', async () => {
    const h = setup();
    try {
      expect(await getObjectVisibility(env(h), ctx, allocation, KEY)).toBeNull();

      const r = await setObjectPublic(env(h), ctx, allocation, KEY, { expiresInSeconds: 600 });
      if (!r.ok) throw new Error('expected ok');
      const live = await getObjectVisibility(env(h), ctx, allocation, KEY);
      expect(live).toMatchObject({ visibility: 'public', revoked: false });
      expect(live?.publicSlug).toBe(r.publicSlug);
      expect(live?.url).toContain('/api/r2/public/');
      expect(live?.expiresAt).not.toBeNull();

      await revokeObjectPublic(env(h), ctx, allocation, KEY);
      const revokedView = await getObjectVisibility(env(h), ctx, allocation, KEY);
      expect(revokedView).toMatchObject({
        visibility: 'private',
        revoked: true,
        publicSlug: null,
        url: null,
      });
    } finally {
      h.close();
    }
  });
});
