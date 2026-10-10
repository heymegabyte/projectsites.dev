/**
 * Per-site R2 **S3 token provisioning** (Buckets B5 slice 1). Runs the REAL provisioning SQL + crypto
 * against a real SQLite (node:sqlite) with a MOCKED Cloudflare fetch — so it creates ZERO real tokens.
 * Covers: new site creates a bucket-scoped CF token (fetch called once) + stores an ENCRYPTED secret
 * (secret_enc !== plaintext), idempotent reuse (2nd call → NO second CF create), and the row carrying
 * the site's bucket scope.
 *
 * Mirrors `r2_provisioner.test.ts` EXACTLY: env-with-creds + mocked global fetch + a cfCreated() double.
 * NOTE: `@swc/jest` only hoists `jest.mock(...)` with the GLOBAL `jest` — do NOT import it from
 * `@jest/globals` (see apps/project-sites/CLAUDE.md gotcha #12). This spec uses no jest.mock, but keeps
 * the convention by relying on the injected global `jest` for `jest.fn()`.
 */
import { ensureSiteS3Token } from '../site_r2.js';
import { decrypt } from '../ai_crypto.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Apply the REAL 0660 DDL to the harness (read the migration file — the test is the DDL's contract).
const S3_TOKENS_DDL = readFileSync(
  join(__dirname, '../../../migrations/0660_site_r2_s3_tokens.sql'),
  'utf8',
);

// A valid 32-byte AES-GCM key (base64) so encrypt()/decrypt() round-trip in the test.
const ENC_KEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

function envWithCreds(h: D1SqliteHarness): Env {
  return {
    DB: h.db,
    CF_ACCOUNT_ID: 'acct-1',
    CLOUDFLARE_EMAIL: 'e@x.com',
    CLOUDFLARE_API_KEY: 'gkey',
    MCP_ENCRYPTION_KEY: ENC_KEY_B64,
  } as unknown as Env;
}

const mockFetch = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as unknown as { fetch: jest.Mock }).fetch = mockFetch;
});

/** CF Create-Token success: Access Key ID = token `id`, raw token `value` (secret = SHA-256 of it). */
function cfTokenCreated(id = 'tok-abc', value = 'secret-value-xyz'): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { id, value } }),
  } as unknown as Response);
}

const tokenRow = (h: D1SqliteHarness, siteId: string): Record<string, unknown> | undefined =>
  h.raw
    .prepare("SELECT * FROM site_r2_s3_tokens WHERE site_id = ? AND status = 'active'")
    .get(siteId) as Record<string, unknown> | undefined;

const tokenCount = (h: D1SqliteHarness): number =>
  (h.raw.prepare('SELECT COUNT(*) c FROM site_r2_s3_tokens').get() as { c: number }).c;

describe('ensureSiteS3Token', () => {
  it('creates a bucket-scoped CF token (fetch once) + stores an ENCRYPTED secret row with the bucket scope', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      // Seed the site's OWN bucket allocation so the token can be scoped to real bucket ids.
      h.exec(`CREATE TABLE site_r2_allocations (
        id TEXT PRIMARY KEY, tenant_id TEXT, site_id TEXT, bucket_name TEXT, display_name TEXT,
        environment TEXT, is_default INTEGER, public_access INTEGER, public_base_url TEXT,
        jurisdiction TEXT, status TEXT, created_at TEXT, updated_at TEXT, deleted_at TEXT)`);
      h.raw
        .prepare(
          `INSERT INTO site_r2_allocations (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, public_access, status)
           VALUES ('a1','org1','site1','ps-site-site1-preview','Preview','preview',1,0,'active')`,
        )
        .run();
      mockFetch.mockReturnValueOnce(cfTokenCreated('tok-abc', 'secret-value-xyz'));

      const r = await ensureSiteS3Token(envWithCreds(h), 'site1', 'org1', 'org1');
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.accessKeyId).toBe('tok-abc');
      expect(r.tokenId).toBe('tok-abc');
      expect(typeof r.secret).toBe('string');
      expect(r.secret.length).toBeGreaterThan(0);

      // CF called ONCE with a POST to the account tokens endpoint carrying a bucket-scoped policy.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];
      expect(url).toContain('/accounts/acct-1/tokens');
      expect(opts.method).toBe('POST');
      const body = JSON.parse(opts.body);
      expect(Array.isArray(body.policies)).toBe(true);
      // Policy resource scoped to the SITE's real bucket name (never account-wide, never '*').
      const resources = JSON.stringify(body.policies[0].resources);
      expect(resources).toContain('ps-site-site1-preview');
      // Grants BOTH R2 object permission groups — Read AND Write (there is NO single "Read+Write" group;
      // the slice-1 placeholder id was bogus → would have failed the mint in prod). LIVE-confirmed ids.
      const groupIds = (body.policies[0].permission_groups as Array<{ id: string }>).map((g) => g.id);
      expect(groupIds).toContain('6a018a9f2fc74eb6b293b0c548f38b39'); // Bucket Item Read
      expect(groupIds).toContain('2efd5506f9c8494dacb1fa10a3e7d5b6'); // Bucket Item Write

      // Row stored ENCRYPTED — secret_enc is NOT the plaintext secret, and decrypts back to it.
      const row = tokenRow(h, 'site1')!;
      expect(row).toBeDefined();
      expect(row.access_key_id).toBe('tok-abc');
      expect(row.cf_token_id).toBe('tok-abc');
      expect(row.tenant_id).toBe('org1');
      expect(row.status).toBe('active');
      expect(typeof row.secret_enc).toBe('string');
      expect(row.secret_enc).not.toBe(r.secret); // encrypted at rest, NOT show-once plaintext
      const roundTrip = await decrypt(envWithCreds(h), row.secret_enc as string);
      expect(roundTrip).toBe(r.secret);

      // The row carries the site's bucket scope (JSON array including the real bucket name).
      const scope = JSON.parse(row.scope_bucket_ids as string) as string[];
      expect(scope).toContain('ps-site-site1-preview');
    } finally {
      h.close();
    }
  });

  it('is IDEMPOTENT — a 2nd call reuses the active row, never a 2nd CF create', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      mockFetch.mockReturnValueOnce(cfTokenCreated('tok-abc', 'secret-value-xyz'));
      const first = await ensureSiteS3Token(envWithCreds(h), 'site1', 'org1', 'org1');
      expect(first.ok).toBe(true);

      const second = await ensureSiteS3Token(envWithCreds(h), 'site1', 'org1', 'org1');
      expect(second.ok).toBe(true);
      if (!second.ok) throw new Error('expected ok');
      expect(second.accessKeyId).toBe('tok-abc'); // same token id
      expect(mockFetch).toHaveBeenCalledTimes(1); // NO duplicate CF token on retry
      expect(tokenCount(h)).toBe(1);
    } finally {
      h.close();
    }
  });

  it('no CF credentials → honest failure, no CF call, no row', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      const env = {
        DB: h.db,
        CF_ACCOUNT_ID: 'acct-1',
        MCP_ENCRYPTION_KEY: ENC_KEY_B64,
      } as unknown as Env; // no creds

      const r = await ensureSiteS3Token(env, 'site1', 'org1', null);
      expect(r.ok).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(tokenCount(h)).toBe(0);
    } finally {
      h.close();
    }
  });
});
