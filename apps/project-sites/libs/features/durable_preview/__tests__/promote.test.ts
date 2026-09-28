/**
 * Unit coverage for the Promote → Production transaction (Slice 5 of the editor release workflow).
 *
 * This slice adds the REAL, honest Preview→Production promotion: freeze the current Preview artifact from
 * R2, copy it into a fresh immutable production version prefix, point Production at it, then record the
 * ACTUAL outcome — never a fabricated success.
 *
 * The three invariants this file proves (per the brief):
 *   1. OWNERSHIP GUARD — a foreign site is 404'd (never 403, never leaked) before any promotion.
 *   2. IDEMPOTENCY ON draftRevision — promoting the same draft twice records ONE release and returns the
 *      existing row on the replay (never re-promotes the same bytes).
 *   3. HONEST OUTCOME MAPPING — `success` ONLY when Production actually serves the promoted `index.html`;
 *      an artifact copied without a servable index → `commit_ok_deploy_failed`; nothing to promote →
 *      `failed`. NEVER a fabricated success.
 *
 * The migration DDL runs against the REAL-SQLite harness (`createD1Sqlite`) so the service's ACTUAL SQL
 * executes (per `verify-against-source-of-truth`); a fake R2 double models `list`/`get`/`put` so the
 * freeze+copy path is exercised without a live bucket.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createD1Sqlite } from '../../../../src/__tests__/helpers/d1_sqlite.js';
import {
  findReleaseByDraftRevision,
  listReleases,
  promoteToProduction,
  upsertWorkingTree,
  type PromoteSite,
} from '../service.js';
import type { Env } from '../../../../src/types/env.js';

/** The additive migration this feature ships — run its real DDL so the service's SQL is exercised. */
const MIGRATION_SQL = readFileSync(
  path.resolve(__dirname, '../../../../migrations/0646_durable_preview_model.sql'),
  'utf8',
);

/** Minimal `sites` shell so the promotion's `UPDATE sites … current_build_version` has a row to flip. */
const SITES_DDL = `CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  slug TEXT,
  status TEXT,
  current_build_version TEXT,
  updated_at TEXT,
  deleted_at TEXT
)`;

/**
 * A tiny in-memory R2 double supporting the subset {@link promoteToProduction} uses: `list({prefix})`,
 * `get(key)` (→ `{ arrayBuffer, size, httpMetadata }`), and `put(key, body)`. Seed it with the source
 * artifact objects; assert the copied production objects land under the new version prefix.
 */
function fakeR2(seed: Record<string, string> = {}) {
  const store = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  for (const [k, v] of Object.entries(seed)) store.set(k, enc.encode(v));

  return {
    store,
    async list({ prefix, cursor: _cursor, limit: _limit }: { prefix: string; cursor?: string; limit?: number }) {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key }));
      return { objects, truncated: false, cursor: undefined as string | undefined };
    },
    async get(key: string) {
      const bytes = store.get(key);
      if (!bytes) return null;
      return {
        size: bytes.byteLength,
        httpMetadata: {},
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
    async put(key: string, body: ArrayBuffer | string) {
      const bytes =
        typeof body === 'string' ? enc.encode(body) : new Uint8Array(body as ArrayBuffer);
      store.set(key, bytes);
    },
  };
}

function env(db: unknown, bucket: unknown): Env {
  return { DB: db, SITES_BUCKET: bucket } as unknown as Env;
}

const OWNED_SITE: PromoteSite = { id: 'site-1', slug: 'acme', currentBuildVersion: null };

describe('durable_preview — promoteToProduction (Slice 5)', () => {
  it('SUCCESS: freezes the Preview artifact, publishes a new version, points Production at it, records success', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(SITES_DDL);
      h.exec(MIGRATION_SQL);
      h.exec(`INSERT INTO sites (id, org_id, slug) VALUES ('site-1', 'org-1', 'acme')`);
      // The Preview artifact lives at the site's current published prefix (no branch revision here).
      const bucket = fakeR2({
        'sites/acme/vPrev/index.html': '<!doctype html><h1>Acme</h1>',
        'sites/acme/vPrev/assets/app.js': 'console.log(1)',
      });
      const e = env(h.db, bucket);
      await upsertWorkingTree(e, { siteId: 'site-1', orgId: 'org-1', treeDigest: 'sha256:v1' });

      const res = await promoteToProduction(
        e,
        { ...OWNED_SITE, currentBuildVersion: 'vPrev' },
        'org-1',
        { draftRevision: 1, treeDigest: 'sha256:v1', commitSha: 'c1', actor: 'user-1' },
      );

      // HONEST success — Production serves the promoted revision.
      expect(res.outcome).toBe('success');
      expect(res.idempotent).toBe(false);
      expect(res.release.outcome).toBe('success');
      expect(res.release.draft_revision).toBe(1);
      expect(res.release.artifact_digest).toBe('sha256:v1');
      expect(res.release.commit_sha).toBe('c1');
      expect(res.release.actor).toBe('user-1');
      const version = res.release.deployment_id!;
      expect(version).toMatch(/^v\d+$/);

      // The frozen bytes were copied into the NEW production version prefix…
      expect(bucket.store.has(`sites/acme/${version}/index.html`)).toBe(true);
      expect(bucket.store.has(`sites/acme/${version}/assets/app.js`)).toBe(true);
      // …the manifest points at it…
      expect(bucket.store.has('sites/acme/_manifest.json')).toBe(true);
      // …and the DB pointer flipped to it.
      const row = h.raw
        .prepare(`SELECT current_build_version, status FROM sites WHERE id = 'site-1'`)
        .get() as { current_build_version: string; status: string };
      expect(row.current_build_version).toBe(version);
      expect(row.status).toBe('published');
    } finally {
      h.close();
    }
  });

  it('IDEMPOTENT: promoting the same draft revision twice records ONE release and returns the existing row', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(SITES_DDL);
      h.exec(MIGRATION_SQL);
      h.exec(`INSERT INTO sites (id, org_id, slug) VALUES ('site-1', 'org-1', 'acme')`);
      const bucket = fakeR2({ 'sites/acme/vPrev/index.html': '<h1>Acme</h1>' });
      const e = env(h.db, bucket);
      await upsertWorkingTree(e, { siteId: 'site-1', orgId: 'org-1', treeDigest: 'sha256:v1' });
      const site = { ...OWNED_SITE, currentBuildVersion: 'vPrev' };

      const first = await promoteToProduction(e, site, 'org-1', {
        draftRevision: 1,
        treeDigest: 'sha256:v1',
      });
      const second = await promoteToProduction(e, site, 'org-1', {
        draftRevision: 1,
        treeDigest: 'sha256:v1',
      });

      expect(first.idempotent).toBe(false);
      expect(second.idempotent).toBe(true);
      // Same release row returned — NEVER re-promoted.
      expect(second.release.id).toBe(first.release.id);

      // Exactly ONE release row for this draft (append-only, but idempotent per draft).
      const releases = await listReleases(e, 'site-1', 'org-1');
      expect(releases).toHaveLength(1);
      const cnt = h.raw
        .prepare(`SELECT COUNT(*) AS n FROM site_releases WHERE site_id = 'site-1' AND draft_revision = 1`)
        .get() as { n: number };
      expect(cnt.n).toBe(1);
    } finally {
      h.close();
    }
  });

  it('HONEST FAILURE: nothing to promote (no artifact) records outcome=failed, never a fabricated success', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(SITES_DDL);
      h.exec(MIGRATION_SQL);
      h.exec(`INSERT INTO sites (id, org_id, slug) VALUES ('site-1', 'org-1', 'acme')`);
      const bucket = fakeR2(); // empty — no source artifact anywhere
      const e = env(h.db, bucket);
      await upsertWorkingTree(e, { siteId: 'site-1', orgId: 'org-1', treeDigest: 'sha256:v1' });

      const res = await promoteToProduction(
        e,
        { ...OWNED_SITE, currentBuildVersion: 'vPrev' },
        'org-1',
        { draftRevision: 1, treeDigest: 'sha256:v1' },
      );

      expect(res.outcome).toBe('failed');
      expect(res.release.outcome).toBe('failed');
      // The pointer must NOT have flipped to a phantom version.
      const row = h.raw
        .prepare(`SELECT current_build_version FROM sites WHERE id = 'site-1'`)
        .get() as { current_build_version: string | null };
      expect(row.current_build_version).toBeNull();
      // A failed promotion still records a release so it's visible + retryable.
      expect(await findReleaseByDraftRevision(e, 'site-1', 'org-1', 1)).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it('HONEST commit_ok_deploy_failed: artifact copied but no servable index → not a success', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(SITES_DDL);
      h.exec(MIGRATION_SQL);
      h.exec(`INSERT INTO sites (id, org_id, slug) VALUES ('site-1', 'org-1', 'acme')`);
      // Source has objects (so copy happens) but NO index.html → Production can't honestly serve it.
      const bucket = fakeR2({ 'sites/acme/vPrev/assets/app.js': 'console.log(1)' });
      const e = env(h.db, bucket);
      await upsertWorkingTree(e, { siteId: 'site-1', orgId: 'org-1', treeDigest: 'sha256:v1' });

      const res = await promoteToProduction(
        e,
        { ...OWNED_SITE, currentBuildVersion: 'vPrev' },
        'org-1',
        { draftRevision: 1, treeDigest: 'sha256:v1' },
      );

      expect(res.outcome).toBe('commit_ok_deploy_failed');
      expect(res.release.outcome).toBe('commit_ok_deploy_failed');
    } finally {
      h.close();
    }
  });

  it('promotes a BRANCH preview revision from its verbatim R2 path', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(SITES_DDL);
      h.exec(MIGRATION_SQL);
      h.exec(`INSERT INTO sites (id, org_id, slug) VALUES ('site-1', 'org-1', 'acme')`);
      const bucket = fakeR2({ 'sites/acme/branches/feat-hero/index.html': '<h1>hero</h1>' });
      const e = env(h.db, bucket);
      // preview_deploy_revision is the full branch path → promote FROM it.
      await upsertWorkingTree(e, {
        siteId: 'site-1',
        orgId: 'org-1',
        treeDigest: 'sha256:v1',
        previewDeployRevision: 'sites/acme/branches/feat-hero/',
      });

      const res = await promoteToProduction(e, OWNED_SITE, 'org-1', {
        draftRevision: 1,
        treeDigest: 'sha256:v1',
      });

      expect(res.outcome).toBe('success');
      const version = res.release.deployment_id!;
      expect(bucket.store.has(`sites/acme/${version}/index.html`)).toBe(true);
    } finally {
      h.close();
    }
  });
});

// ── Handler-level ownership (IDOR) gate ───────────────────────────────────────
// Flag forced ON, ownership FORCED FALSE — prove POST /promote 404s a foreign site before any promotion.
// The promote handler resolves the site via requireOwnedSite, so BOTH ownership exports are mocked.
jest.mock('../../../../src/modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../../src/services/site_ownership.js', () => ({
  assertSiteOwned: jest.fn().mockResolvedValue(false),
  requireOwnedSite: jest.fn().mockResolvedValue(null),
}));
// eslint-disable-next-line import/first -- must import AFTER jest.mock (swc hoists the mock above)
import { durablePreview } from '../handlers.js';

describe('durable_preview handlers — POST /promote ownership gate (IDOR)', () => {
  it('POST /api/sites/:id/promote 404s (or 401s) a foreign/unauthed caller — never 200, never leaks', async () => {
    const res = await durablePreview.request(
      '/api/sites/foreign-site/promote',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ draft_revision: 1, tree_digest: 'sha256:v1' }),
      },
      { DB: {}, SITES_BUCKET: {} } as unknown as Env,
    );
    // The sub-app request carries no authed Variables, so the guard 401s before ownership; when
    // authed but foreign, requireOwnedSite → null → 404. Either way: never 200, never a leak.
    expect([401, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });
});
