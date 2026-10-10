/**
 * Per-site R2 **copy / move / rename object ops** (Buckets B8). Proves the same-bucket object ops build the
 * right S3 request against a REAL SQLite + a MOCKED Cloudflare/S3 fetch (zero real tokens, zero real S3):
 *   • `copySiteR2Object` → an S3 CopyObject: PUT the DEST key with `x-amz-copy-source: /{bucket}/{srcKey}`
 *     (each segment URI-encoded) + the `x-amz-copy-source` header is SigV4-SIGNED (SignedHeaders lists it);
 *   • the collision guard HEADs the destination and refuses (`destination_exists`) unless `overwrite`;
 *   • `renameSiteR2Object` = copy THEN delete the source (never deletes before a confirmed copy);
 *   • `moveSiteR2Prefix` lists the source prefix + copy+deletes each key, rewriting only the prefix;
 *   • every op signs with the PER-SITE scoped token (not a global key) — the isolation credential path.
 *
 * `@swc/jest` only hoists `jest.mock(...)` with the GLOBAL `jest` — do NOT import it (CLAUDE.md gotcha #12).
 */
import {
  copySiteR2Object,
  moveSiteR2Prefix,
  renameSiteR2Object,
} from '../site_r2.js';
import { createD1Sqlite, type D1SqliteHarness } from '../../__tests__/helpers/d1_sqlite.js';
import type { Env } from '../../types/env.js';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
const BUCKET = 'ps-site-site1-preview';

function seedPreviewBucket(h: D1SqliteHarness): void {
  h.exec(ALLOC_DDL);
  h.raw
    .prepare(
      `INSERT INTO site_r2_allocations (id, tenant_id, site_id, bucket_name, display_name, environment, is_default, public_access, status)
       VALUES ('a1','org1','site1','${BUCKET}','Preview','preview',1,0,'active')`,
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
const ctx = { orgId: 'org1', siteId: 'site1', tenantId: 'org1' };

/** Captured S3 calls (method + url + copy-source header + the signed-headers list) for assertions. */
interface S3Call {
  method: string;
  url: string;
  copySource: string | undefined;
  signedHeaders: string;
}
const s3Calls: S3Call[] = [];
/** Keys that should answer HEAD → 200 (i.e. "exist") in the mocked S3; everything else 404s on HEAD. */
let existingKeys = new Set<string>();
/** Optional per-method override list used by the "list" mock to return a page of objects for a prefix. */
let listContents: string[] = [];

function installFetch(): void {
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn(
    (url: string, opts?: { method?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      const method = opts?.method ?? 'GET';
      // CF token mint / revoke + R2 bucket REST — succeed generically (object ops only need the mint).
      if (u.includes('/accounts/acct-1/tokens') && method === 'POST')
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { id: 'tok-abc', value: 'secret-value-xyz' } }),
        } as unknown as Response);
      if (u.includes('/accounts/acct-1/tokens/') && method === 'DELETE')
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) } as unknown as Response);
      if (u.includes('/r2/buckets'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, result: {} }) } as unknown as Response);

      if (u.includes('r2.cloudflarestorage.com')) {
        const authorization = opts?.headers?.authorization ?? '';
        const signedHeaders = /SignedHeaders=([^,]+)/.exec(authorization)?.[1] ?? '';
        s3Calls.push({
          copySource: opts?.headers?.['x-amz-copy-source'],
          method,
          signedHeaders,
          url: u,
        });
        // A LIST (ListObjectsV2) — carries `?list-type=2`.
        if (method === 'GET' && u.includes('list-type=2')) {
          const contents = listContents
            .map(
              (k) =>
                `<Contents><Key>${k}</Key><Size>3</Size><LastModified>2026-10-10T00:00:00Z</LastModified></Contents>`,
            )
            .join('');
          return Promise.resolve({
            ok: true,
            status: 200,
            text: async () => `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
          } as unknown as Response);
        }
        // A HEAD (collision check) — 200 when the key is in `existingKeys`, else 404.
        if (method === 'HEAD') {
          const key = decodeURIComponent(new URL(u).pathname.replace(`/${BUCKET}/`, ''));
          const exists = existingKeys.has(key);
          return Promise.resolve({ ok: exists, status: exists ? 200 : 404 } as unknown as Response);
        }
        // PUT (copy) + DELETE — succeed.
        return Promise.resolve({ ok: true, status: method === 'DELETE' ? 204 : 200 } as unknown as Response);
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' } as unknown as Response);
    },
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  s3Calls.length = 0;
  existingKeys = new Set<string>();
  listContents = [];
  mockFlag.mockResolvedValue(true); // per-site object-ops path on for every copy test
  installFetch();
});

describe('copySiteR2Object — builds an S3 CopyObject (same-bucket)', () => {
  it('PUTs the DEST key with a SIGNED x-amz-copy-source header pointing at the source', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      const r = await copySiteR2Object(envWithCreds(h), ctx, BUCKET, 'a/old.txt', 'a/new.txt');
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.key).toBe('a/new.txt');

      // One HEAD (collision check) then one PUT (the copy).
      const put = s3Calls.find((c) => c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(put!.url).toContain(`/${BUCKET}/a/new.txt`); // destination key is the request path
      expect(put!.copySource).toBe(`/${BUCKET}/a/old.txt`); // copy-source = /{bucket}/{srcKey}
      // The copy-source header MUST be part of the SigV4 signed headers (R2 rejects an unsigned one).
      expect(put!.signedHeaders).toContain('x-amz-copy-source');
      // And it signs with the PER-SITE token, not a global key.
      expect(put!.url).toContain('acct-1.r2.cloudflarestorage.com');
    } finally {
      h.close();
    }
  });

  it('URI-encodes each copy-source path segment (spaces / unicode never break the header)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      const r = await copySiteR2Object(envWithCreds(h), ctx, BUCKET, 'my folder/a b.png', 'my folder/c d.png');
      expect(r.ok).toBe(true);
      const put = s3Calls.find((c) => c.method === 'PUT')!;
      expect(put.copySource).toBe(`/${BUCKET}/my%20folder/a%20b.png`); // encoded, `/` preserved
    } finally {
      h.close();
    }
  });

  it('refuses to clobber an existing destination (destination_exists) — no PUT fires', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      existingKeys.add('taken.txt'); // HEAD taken.txt → 200
      const r = await copySiteR2Object(envWithCreds(h), ctx, BUCKET, 'src.txt', 'taken.txt');
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected failure');
      expect(r.reason).toBe('destination_exists');
      expect(s3Calls.some((c) => c.method === 'PUT')).toBe(false); // never copied over the existing object
    } finally {
      h.close();
    }
  });

  it('overwrite:true skips the collision guard and copies anyway', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      existingKeys.add('taken.txt');
      const r = await copySiteR2Object(envWithCreds(h), ctx, BUCKET, 'src.txt', 'taken.txt', { overwrite: true });
      expect(r.ok).toBe(true);
      expect(s3Calls.some((c) => c.method === 'HEAD')).toBe(false); // guard skipped
      expect(s3Calls.some((c) => c.method === 'PUT')).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('renameSiteR2Object — copy THEN delete the source', () => {
  it('copies to the destination, then DELETEs the source key (order matters — never delete-first)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      const r = await renameSiteR2Object(envWithCreds(h), ctx, BUCKET, 'old.txt', 'new.txt');
      expect(r.ok).toBe(true);
      const put = s3Calls.find((c) => c.method === 'PUT');
      const del = s3Calls.find((c) => c.method === 'DELETE');
      expect(put?.url).toContain('/new.txt');
      expect(del?.url).toContain('/old.txt'); // the SOURCE is deleted, not the destination
      // Copy precedes delete in the call order.
      expect(s3Calls.indexOf(put!)).toBeLessThan(s3Calls.indexOf(del!));
    } finally {
      h.close();
    }
  });

  it('does NOT delete the source when the copy fails (no data loss on collision)', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      existingKeys.add('new.txt'); // destination exists → copy refused
      const r = await renameSiteR2Object(envWithCreds(h), ctx, BUCKET, 'old.txt', 'new.txt');
      expect(r.ok).toBe(false);
      expect(s3Calls.some((c) => c.method === 'DELETE')).toBe(false); // source untouched
    } finally {
      h.close();
    }
  });
});

describe('moveSiteR2Prefix — rename a "folder" (list + copy+delete each key)', () => {
  it('rewrites only the prefix of every object under the source prefix', async () => {
    const h = createD1Sqlite();
    try {
      h.exec(S3_TOKENS_DDL);
      seedPreviewBucket(h);
      listContents = ['old/a.txt', 'old/sub/b.png'];
      const r = await moveSiteR2Prefix(envWithCreds(h), ctx, BUCKET, 'old/', 'new/');
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('expected ok');
      expect(r.moved).toBe(2);
      const puts = s3Calls.filter((c) => c.method === 'PUT').map((c) => c.url);
      expect(puts.some((u) => u.includes('/new/a.txt'))).toBe(true);
      expect(puts.some((u) => u.includes('/new/sub/b.png'))).toBe(true); // sub-folder preserved
      // Each moved object's source copy-source points at the OLD prefix.
      const copySources = s3Calls.filter((c) => c.method === 'PUT').map((c) => c.copySource);
      expect(copySources).toContain(`/${BUCKET}/old/a.txt`);
      // And the sources are deleted (move = copy + delete).
      expect(s3Calls.filter((c) => c.method === 'DELETE').length).toBe(2);
    } finally {
      h.close();
    }
  });
});
