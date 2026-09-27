/**
 * TDD tests for the r2 adapter's two READ-ONLY polish surfaces:
 *   bucketConfig() — read the bucket's CORS / lifecycle / public-access / custom-domain settings, each with an
 *                    HONEST requiresPlatformAdmin marker (owner-manageable vs platform-administered), never a
 *                    fake CRUD control; honest available:false when a CF read fails transiently.
 *   previewUrl()   — a SHORT-LIVED SCOPED preview/download URL for one object — NEVER account credentials;
 *                    honest found:false for a miss; honest available:false + approach when minting isn't wired.
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF R2 REST API via
 * the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches `src/` from
 * `libs/features/data_resource_registry/__tests__/`).
 *
 * Contracts under test:
 *   (a) bucketConfig marks public_access + custom_domains requiresPlatformAdmin:true (with a reason), and
 *       cors + lifecycle requiresPlatformAdmin:false
 *   (b) bucketConfig returns the readable value for owner-manageable settings (CORS rules) as `value`
 *   (c) bucketConfig: a transient sub-resource read failure → that setting available:false (NOT "off"/"empty")
 *   (d) bucketConfig: a 404 on the BUCKET → exists:false (drift), never a fabricated config
 *   (e) bucketConfig: isolation — every CF call targets ONLY scope.resourceId's bucket path
 *   (f) previewUrl: an empty key → invalid_key, no fetch
 *   (g) previewUrl: a missing object → found:false + available:false, NEVER a fabricated URL
 *   (h) previewUrl: a found object → available:false + approach (minting not wired) AND NEVER leaks a
 *       credential / account key / creds-bearing url (explicit assertion)
 *   (i) previewUrl: classifies content-type (image→image, application/pdf→pdf) and isolates to scope.resourceId
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'SUPER-SECRET-ACCOUNT-KEY',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { r2Adapter } from '../adapters/r2.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A minimal ResolvedScope for a per-site R2 bucket (R2 identity is the NAME, not a uuid). */
const scope: ResolvedScope = {
  siteId: 'site-1',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'ps-site-abc-123', // the site's own R2 bucket name
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'SUPER-SECRET-ACCOUNT-KEY' } as never,
  accessPolicy: 'site_scoped',
};

/** Build a fake Response with a JSON body. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

/** Route the 5 GETs bucketConfig makes (bucket + /cors + /lifecycle + /domains/managed + /domains/custom). */
function routeBucketConfig(handlers: {
  bucket?: () => Response;
  cors?: () => Response;
  lifecycle?: () => Response;
  managed?: () => Response;
  custom?: () => Response;
}) {
  fetchMock.mockImplementation((url: string) => {
    if (url.endsWith('/cors')) return Promise.resolve((handlers.cors ?? (() => jsonResponse(200, { success: true, result: [] })))());
    if (url.endsWith('/lifecycle')) return Promise.resolve((handlers.lifecycle ?? (() => jsonResponse(200, { success: true, result: [] })))());
    if (url.endsWith('/domains/managed')) return Promise.resolve((handlers.managed ?? (() => jsonResponse(200, { success: true, result: { enabled: false } })))());
    if (url.endsWith('/domains/custom')) return Promise.resolve((handlers.custom ?? (() => jsonResponse(200, { success: true, result: [] })))());
    // The bucket-existence probe (base URL, no sub-path).
    return Promise.resolve((handlers.bucket ?? (() => jsonResponse(200, { success: true, result: { name: scope.resourceId } })))());
  });
}

// ─── (a)(b)(e) bucketConfig() — requiresPlatformAdmin honesty, readable value, isolation ──

describe('r2Adapter.bucketConfig()', () => {
  it('(a)(b)(e) reports platform-admin honesty per setting, reads owner-manageable values, isolates to the bucket', async () => {
    routeBucketConfig({
      cors: () => jsonResponse(200, { success: true, result: [{ allowed: { origins: ['https://x.com'] } }] }),
      lifecycle: () => jsonResponse(200, { success: true, result: { rules: [] } }),
    });
    const result = await r2Adapter.bucketConfig(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(true);
    const byKey = Object.fromEntries((result.data?.settings ?? []).map((s) => [s.key, s]));

    // (a) CORS + lifecycle are owner-manageable; public-access + custom-domains are platform-administered w/ reason.
    expect(byKey['cors'].requiresPlatformAdmin).toBe(false);
    expect(byKey['lifecycle'].requiresPlatformAdmin).toBe(false);
    expect(byKey['public_access'].requiresPlatformAdmin).toBe(true);
    expect(byKey['public_access'].reason).toBeTruthy();
    expect(byKey['custom_domains'].requiresPlatformAdmin).toBe(true);
    expect(byKey['custom_domains'].reason).toBeTruthy();

    // (b) the readable value round-trips for an owner-manageable setting.
    expect(byKey['cors'].available).toBe(true);
    expect(byKey['cors'].value).toEqual([{ allowed: { origins: ['https://x.com'] } }]);

    // (e) isolation: EVERY call targets only this bucket's path.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain(`/r2/buckets/${scope.resourceId}`);
    }
  });

  it('(c) a transient sub-resource read failure → that setting available:false (never "off")', async () => {
    routeBucketConfig({
      cors: () => jsonResponse(500, { success: false }), // CORS read blips
    });
    const result = await r2Adapter.bucketConfig(scope);
    expect(result.ok).toBe(true);
    const cors = (result.data?.settings ?? []).find((s) => s.key === 'cors');
    // Honest: the read failed → available:false, NOT an empty/"no CORS" claim.
    expect(cors?.available).toBe(false);
    expect(cors?.value).toBeUndefined();
  });

  it('(d) a 404 on the BUCKET → exists:false (drift), never a fabricated config', async () => {
    routeBucketConfig({ bucket: () => jsonResponse(404, { success: false }) });
    const result = await r2Adapter.bucketConfig(scope);
    expect(result.ok).toBe(true);
    expect(result.data?.exists).toBe(false);
    expect(result.data?.settings).toHaveLength(0);
  });

  it('(c) a 404 on a sub-resource is an honest empty (available:true, value:null), not a failure', async () => {
    routeBucketConfig({ lifecycle: () => jsonResponse(404, { success: false }) });
    const result = await r2Adapter.bucketConfig(scope);
    const lifecycle = (result.data?.settings ?? []).find((s) => s.key === 'lifecycle');
    expect(lifecycle?.available).toBe(true);
    expect(lifecycle?.value).toBeNull();
  });

  it('maps a 5xx on the bucket probe to a retryable error (never "gone")', async () => {
    routeBucketConfig({ bucket: () => jsonResponse(503, { success: false }) });
    const result = await r2Adapter.bucketConfig(scope);
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('NEVER leaks the account credential anywhere in the bucketConfig envelope', async () => {
    routeBucketConfig({});
    const result = await r2Adapter.bucketConfig(scope);
    expect(JSON.stringify(result)).not.toContain('SUPER-SECRET-ACCOUNT-KEY');
  });
});

// ─── (f)(g)(h)(i) previewUrl() — invalid key, honest miss, NEVER leaks creds, classification, isolation ──

describe('r2Adapter.previewUrl()', () => {
  it('(f) an empty key → invalid_key, no fetch', async () => {
    const result = await r2Adapter.previewUrl(scope, { key: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(g) a missing object → found:false + available:false, NEVER a fabricated URL', async () => {
    // The metadata probe (get) 404s → honest miss.
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { success: false }));
    const result = await r2Adapter.previewUrl(scope, { key: 'missing.txt' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(false);
    expect(result.data?.available).toBe(false);
    expect(result.data?.url).toBeUndefined();
  });

  it('(h) a found object → available:false + approach, and NEVER leaks a credential / account key / creds URL', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: { key: 'doc.pdf', size: 1024, http_metadata: { contentType: 'application/pdf' } },
      }),
    );
    const result = await r2Adapter.previewUrl(scope, { key: 'doc.pdf' });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(true);
    // Minting isn't wired → honest not-available + an approach describing the scoped path.
    expect(result.data?.available).toBe(false);
    expect(result.data?.url).toBeUndefined();
    expect(result.data?.approach).toBeTruthy();

    // EXPLICIT credential-safety assertion — the whole serialized envelope must not carry the account key,
    // any creds-bearing URL, or S3 signature params (INV-6).
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SUPER-SECRET-ACCOUNT-KEY');
    expect(serialized).not.toMatch(/X-Amz-(Credential|Signature|Security-Token)/i);
    expect(serialized).not.toMatch(/AccessKeyId|secretAccessKey|X-Auth-Key/i);
  });

  it('(i) classifies content-type (image→image) AND isolates the metadata probe to scope.resourceId', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: { key: 'photo.jpg', size: 2048, http_metadata: { contentType: 'image/jpeg' } },
      }),
    );
    const result = await r2Adapter.previewUrl(scope, { key: 'photo.jpg' });
    expect(result.data?.kind).toBe('image');
    expect(result.data?.contentType).toBe('image/jpeg');
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toContain(`/r2/buckets/${scope.resourceId}/objects/photo.jpg`);
  });

  it('(i) a large/binary object → approach describes a streamed scoped proxy (never inline bytes)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        success: true,
        result: { key: 'big.zip', size: 50 * 1024 * 1024, http_metadata: { contentType: 'application/zip' } },
      }),
    );
    const result = await r2Adapter.previewUrl(scope, { key: 'big.zip' });
    expect(result.data?.kind).toBe('binary');
    expect(result.data?.available).toBe(false);
    expect(result.data?.approach).toMatch(/stream|proxy/i);
  });

  it('a transient metadata read failure surfaces as a retryable error (never a fabricated URL)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false }));
    const result = await r2Adapter.previewUrl(scope, { key: 'k' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect((result.data as { url?: string } | undefined)?.url).toBeUndefined();
  });
});
