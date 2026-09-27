/**
 * TDD tests for r2_presign — short-lived SCOPED presigned R2 URL minting (FIRE 5).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The minter calls CF's
 * temp-access-credentials API via the global `fetch`, so we stub `fetch` per-test.
 *
 * Contracts under test (INV-6 — never send an account credential to the browser):
 *   (a) global-key auth → honest `available:false` (the temp-creds API needs a Bearer token) — NO fetch
 *   (b) token auth + a successful temp-cred mint → `available:true` with a presigned URL that carries a
 *       signature (X-Amz-Signature) and is NOT the raw credential; the mint request is Bearer-authed +
 *       scoped to the bucket + the read/write permission
 *   (c) an upload verb requests the `object-read-write` permission (download requests `object-read-only`)
 *   (d) a CF failure minting temp creds → honest `available:false` (never a fabricated URL)
 *   (e) an empty key → `available:false`, NO fetch
 */

// ─── Import (no module mocks needed — aws4fetch signs locally, fetch is stubbed) ─

import { mintScopedR2Url } from '../r2_presign.js';
import type { CfAuth } from '../../../../src/services/cf_credentials.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN_AUTH: CfAuth = { kind: 'token', token: 'cf-token-abc' };
const GLOBAL_AUTH: CfAuth = { kind: 'global', email: 'a@b.com', apiKey: 'gk' };
const ACCOUNT = 'acct-123';

function credResponse(): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: { accessKeyId: 'AKIA_TEMP', secretAccessKey: 'secret_temp', sessionToken: 'sess_temp' },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('mintScopedR2Url — auth gating (INV-6)', () => {
  it('refuses global-key auth with an honest not-available (temp-creds API needs a Bearer token) — no fetch', async () => {
    const res = await mintScopedR2Url(GLOBAL_AUTH, ACCOUNT, { bucket: 'ps-site-abc', key: 'logo.png', verb: 'download' });
    expect(res.available).toBe(false);
    if (!res.available) expect(res.reason).toMatch(/token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns available:false for an empty key without calling CF', async () => {
    const res = await mintScopedR2Url(TOKEN_AUTH, ACCOUNT, { bucket: 'ps-site-abc', key: '', verb: 'download' });
    expect(res.available).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('mintScopedR2Url — scoped mint + presign', () => {
  it('mints Bearer-authed scoped temp creds + returns a presigned URL (a signed handle, never the credential)', async () => {
    fetchMock.mockResolvedValueOnce(credResponse());

    const res = await mintScopedR2Url(TOKEN_AUTH, ACCOUNT, { bucket: 'ps-site-abc', key: 'images/hero.jpg', verb: 'download', ttlSeconds: 300 });

    expect(res.available).toBe(true);
    if (res.available) {
      // The presigned URL is an S3 handle carrying a signature — NOT the account/temp credential itself.
      expect(res.url).toContain('r2.cloudflarestorage.com');
      expect(res.url).toContain('X-Amz-Signature');
      expect(res.url).not.toContain('cf-token-abc');
      expect(res.expiresInSeconds).toBe(300);
    }

    // The mint request is Bearer-authed, scoped to the bucket + read-only permission.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/r2/temp-access-credentials');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cf-token-abc');
    const body = JSON.parse(init.body as string);
    expect(body.bucket).toBe('ps-site-abc');
    expect(body.permission).toBe('object-read-only');
  });

  it('requests object-read-write permission for an upload verb', async () => {
    fetchMock.mockResolvedValueOnce(credResponse());
    const res = await mintScopedR2Url(TOKEN_AUTH, ACCOUNT, { bucket: 'ps-site-abc', key: 'upload.bin', verb: 'upload', contentType: 'application/octet-stream' });
    expect(res.available).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.permission).toBe('object-read-write');
  });

  it('returns an honest not-available (never a fabricated URL) when CF declines to mint creds', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), { status: 403, headers: { 'content-type': 'application/json' } }),
    );
    const res = await mintScopedR2Url(TOKEN_AUTH, ACCOUNT, { bucket: 'ps-site-abc', key: 'x', verb: 'download' });
    expect(res.available).toBe(false);
    if (!res.available) expect(res.reason).toMatch(/declined|proxy/i);
  });
});
