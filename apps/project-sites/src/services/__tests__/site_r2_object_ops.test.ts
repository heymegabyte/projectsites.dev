/**
 * Per-site R2 **object-ops credential wiring** (Buckets B5 slice 2). Proves the object ops resolve an
 * S3 config via the PER-SITE scoped token (gated behind the DARK `r2_bucket_manager` flag) instead of a
 * global account-wide key — against a REAL SQLite + a MOCKED Cloudflare/S3 fetch (zero real tokens, zero
 * real S3). Covers: flag-off → honest needs-creds (no network); flag-on → mint + sign the S3 request
 * with the DERIVED token creds; global `R2_S3_*` escape hatch wins WITHOUT minting; `hasObjectOpsForSite`
 * capability matrix; and token-scope INVALIDATION when a new bucket is provisioned (so uploads to the new
 * bucket don't 403 on a stale token).
 *
 * `@swc/jest` only hoists `jest.mock(...)` with the GLOBAL `jest` — do NOT import it (CLAUDE.md gotcha #12).
 */
import {
  getSiteR2Object,
  hasObjectOpsForSite,
  listSiteR2Objects,
  provisionSiteR2,
} from '../site_r2.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The feature flag that gates the per-site object-ops path. Mock it so the test controls on/off.
jest.mock('../../modules/feature_flags/services.js', () => ({ isFlagOn: jest.fn() }));
// eslint-disable-next-line import/first -- must follow jest.mock (swc hoists the mock)
import { isFlagOn } from '../../modules/feature_flags/services.js';
const mockFlag = isFlagOn as unknown as jest.Mock;

const S3_TOKENS_DDL = readFileSync(
  join(__dirname, '../../../migrations/0660_site_r2_s3_tokens.sql'),
  'utf8',
);
const ALLOC_DDL = `CREATE TABLE site_r2_allocations (
  id TEXT PRIMARY KEY, tenant_id TEXT, site_id TEXT, bucket_name TEXT UNIQUE, display_name TEXT,
  environment TEXT, is_default INTEGER, public_access INTEGER, public_base_url TEXT,
  jurisdiction TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`;
const ENC_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function seedPreviewBucket(h: D1SqliteHarness): void {
  h.exec(ALLOC_DDL);
  h.raw
    .prepare(
      `INSERT INTO site_r2_allocations (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, public_access, status)
       VALUES ('a1','org1','site1','ps-site-site1-preview','Preview','preview',1,0,'active')`,
    )
    .run();
}
function envWithCreds(h: D1SqliteHarness): Env {
  return {
    DB: h.db,
    CF_ACCOUNT_ID: 'acct-1',
    CLOUDFLARE_EMAIL: 'e@x.com',
    CLOUDFLARE_API_KEY: 'gkey',
    MCP_ENCRYPTION_KEY: ENC_KEY_B64,
  } as unknown as Env;
}
function envWithGlobalS3(h: D1SqliteHarness): Env {
  return {
    ...envWithCreds(h),
    R2_S3_ACCESS_KEY_ID: 'GLOBALKEY',
    R2_S3_SECRET_ACCESS_KEY: 'GLOBALSECRET',
  } as unknown as Env;
}
const ctx = { orgId: 'org1', siteId: 'site1', tenantId: 'org1' };

// Route the mocked global fetch by URL: CF token-create, CF token-revoke, R2 bucket-create, S3 object API.
const s3Calls: Array<{ url: string; authorization: string }> = [];
function installFetch(): void {
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    (url: string, opts?: { method?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      if (u.includes('/accounts/acct-1/tokens') && opts?.method === 'POST')
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { id: 'tok-abc', value: 'secret-value-xyz' },
          }),
        } as unknown as Response);
      if (u.includes('/accounts/acct-1/tokens/') && opts?.method === 'DELETE')
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true }),
        } as unknown as Response);
      if (u.includes('/r2/buckets'))
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: {} }),
        } as unknown as Response);
      if (u.includes('r2.cloudflarestorage.com')) {
        s3Calls.push({ authorization: opts?.headers?.authorization ?? '', url: u });
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Map([['content-type', 'text/plain']]) as unknown as Headers,
          text: async () =>
            '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>hello.txt</Key><Size>5</Size><LastModified>2026-10-10T00:00:00Z</LastModified></Contents></ListBucketResult>',
          arrayBuffer: async () => new ArrayBuffer(5),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as unknown as Response);
    },
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  s3Calls.length = 0;
  installFetch();
});
const fetchMock = () => globalThis.fetch as unknown as jest.Mock;

describe('resolveSiteS3Config via object ops (B5 slice 2)', () => {
  it('flag OFF → needs_s3_credentials, NO network (object ops stay honestly "being set up")', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      mockFlag.mockResolvedValue(false);
      const r = await listSiteR2Objects(envWithCreds(h), ctx, 'ps-site-site1-preview');
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('needs_s3_credentials');
      expect(fetchMock()).not.toHaveBeenCalled(); // never mints / never hits S3 when the flag is off
    } finally {
      h.close();
    }
  });

  it('flag ON → mints the per-site token and SIGNS the S3 list with the DERIVED token access-key-id', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      mockFlag.mockResolvedValue(true);
      const r = await listSiteR2Objects(envWithCreds(h), ctx, 'ps-site-site1-preview');
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.objects.map((o) => o.key)).toEqual(['hello.txt']);
      // Minted a token (CF POST) then signed an S3 request with that token's access key id.
      const calls = fetchMock().mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/accounts/acct-1/tokens'))).toBe(true);
      expect(s3Calls).toHaveLength(1);
      expect(s3Calls[0]!.url).toContain('acct-1.r2.cloudflarestorage.com');
      expect(s3Calls[0]!.authorization).toContain('Credential=tok-abc/'); // the PER-SITE token, not a global key
      // Row persisted (so the next op reuses it, no re-mint).
      const row = h.raw
        .prepare(
          "SELECT access_key_id FROM site_r2_s3_tokens WHERE site_id='site1' AND status='active'",
        )
        .get() as { access_key_id: string } | undefined;
      expect(row?.access_key_id).toBe('tok-abc');
    } finally {
      h.close();
    }
  });

  it('global R2_S3_* creds WIN as the escape hatch — used WITHOUT minting a per-site token', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      mockFlag.mockResolvedValue(true); // even with the flag on, global creds short-circuit
      const r = await getSiteR2Object(
        envWithGlobalS3(h),
        ctx,
        'ps-site-site1-preview',
        'hello.txt',
      );
      expect(r.ok).toBe(true);
      const calls = fetchMock().mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes('/accounts/acct-1/tokens'))).toBe(false); // NO mint
      expect(s3Calls[0]!.authorization).toContain('Credential=GLOBALKEY/');
      expect(h.raw.prepare('SELECT COUNT(*) c FROM site_r2_s3_tokens').get()).toEqual({ c: 0 });
    } finally {
      h.close();
    }
  });
});

describe('hasObjectOpsForSite capability matrix', () => {
  it('flag off + no global creds → false; flag on + CF creds → true; global creds → true (flag irrelevant)', async () => {
    const h = createD1Sqlite();
    try {
      mockFlag.mockResolvedValue(false);
      expect(await hasObjectOpsForSite(envWithCreds(h), { orgId: 'org1', siteId: 'site1' })).toBe(
        false,
      );
      expect(
        await hasObjectOpsForSite(envWithGlobalS3(h), { orgId: 'org1', siteId: 'site1' }),
      ).toBe(true);
      mockFlag.mockResolvedValue(true);
      expect(await hasObjectOpsForSite(envWithCreds(h), { orgId: 'org1', siteId: 'site1' })).toBe(
        true,
      );
    } finally {
      h.close();
    }
  });
});

describe('token-scope invalidation on new bucket (prevents stale-scope 403s)', () => {
  it("provisioning a NEW bucket supersedes the site's active S3 token so the next op re-mints with the new scope", async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      // An existing active token scoped to only the preview bucket.
      h.raw
        .prepare(
          `INSERT INTO site_r2_s3_tokens (id, tenant_id, site_id, access_key_id, secret_enc, cf_token_id, scope_bucket_ids, status, created_at, updated_at)
           VALUES ('t1','org1','site1','tok-old','enc','tok-old','["ps-site-site1-preview"]','active', datetime('now'), datetime('now'))`,
        )
        .run();
      mockFlag.mockResolvedValue(true);

      const p = await provisionSiteR2(envWithCreds(h), {
        displayName: 'assets',
        orgId: 'org1',
        siteId: 'site1',
        tenantId: 'org1',
      });
      expect(p.ok).toBe(true);
      // The old token is now superseded (not active) → next ensureSiteS3Token re-mints covering 'assets'.
      const old = h.raw.prepare("SELECT status FROM site_r2_s3_tokens WHERE id='t1'").get() as {
        status: string;
      };
      expect(old.status).toBe('superseded');
      const active = h.raw
        .prepare(
          "SELECT COUNT(*) c FROM site_r2_s3_tokens WHERE site_id='site1' AND status='active'",
        )
        .get() as { c: number };
      expect(active.c).toBe(0);
      // Best-effort CF token revoke was attempted.
      const calls = fetchMock().mock.calls.map((c) => ({
        method: (c[1] as { method?: string })?.method,
        url: String(c[0]),
      }));
      expect(
        calls.some(
          (c) => c.method === 'DELETE' && c.url.includes('/accounts/acct-1/tokens/tok-old'),
        ),
      ).toBe(true);
    } finally {
      h.close();
    }
  });
});
