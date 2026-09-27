/**
 * TDD tests for the r2 adapter MULTIPART lifecycle —
 *   mutate({action:'create_multipart_upload'|'upload_part'|'complete_multipart_upload'|'abort_multipart_upload'}).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to CF via the global
 * `fetch`; we stub `fetch` + mock `cfAuthHeaders` (4× ../ reaches `src/` from
 * `libs/features/data_resource_registry/__tests__/`). Mirrors r2_adapter_mutate.test.ts exactly.
 *
 * The honest CF reality: a per-site bucket is reached via the CF REST management API, which does NOT expose
 * the multipart lifecycle; the S3-compatible multipart API needs R2 S3 credentials INV-6 keeps out of the
 * Worker + off the client. So a VALID multipart request reports a typed `multipart_not_available` (never a
 * fabricated uploadId/etag/credential). An INVALID request is refused with its precise typed error BEFORE
 * the not-available check — so the CF part-size/count limits + the overwrite gate are REAL + testable now.
 *
 * Contracts under test:
 *   (a) create (valid key) → multipart_not_available, message names the server-side proxy, NO fetch
 *   (b) create with empty key → invalid_key (never not_available), NO fetch
 *   (c) upload_part below the 5 MiB non-final floor → part_size_invalid, NO fetch
 *   (d) upload_part isFinalPart:true below 5 MiB → passes the size gate → multipart_not_available
 *   (e) upload_part over the 5 GiB max → part_size_invalid (checked by declared length, no giant buffer)
 *   (f) upload_part partNumber 0 / >10000 → part_number_invalid
 *   (g) upload_part missing uploadId → invalid_upload_id
 *   (h) complete with empty parts[] → part_count_invalid
 *   (i) complete with non-ascending parts[] → part_order_invalid
 *   (j) complete over an EXISTING object WITHOUT confirm → confirmation_required (probe ran, nothing assembled)
 *   (k) complete of a NEW key (probe 404) → passes the gate → multipart_not_available
 *   (l) complete WITH confirm over existing → passes the gate → multipart_not_available (no fake success)
 *   (m) abort (valid) → multipart_not_available (idempotent-cleanup shape), no confirm needed
 *   (n) supports declares all four multipart mutations + the mutate verb
 *   (o) isolation: the only fetch a multipart verb ever makes (complete's existence probe) hits scope.resourceId
 *   (p) the not_available envelope NEVER leaks a credential
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'SUPER_SECRET_ACCOUNT_KEY',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { r2Adapter } from '../adapters/r2.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const scope: ResolvedScope = {
  siteId: 'site-1',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'ps-site-abc-123', // the site's own R2 bucket name (R2 identity IS the name)
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'site_scoped',
};

/** A HEAD probe response has no body — status carries the answer. */
function emptyResponse(status: number): Response {
  return new Response(null, { status });
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

// ─── (n) supports declaration ─────────────────────────────────────────────────────

describe('r2Adapter.supports (multipart)', () => {
  it('(n) declares the four multipart mutations and the mutate verb', () => {
    expect(r2Adapter.supports.mutations).toEqual(
      expect.arrayContaining([
        'create_multipart_upload',
        'upload_part',
        'complete_multipart_upload',
        'abort_multipart_upload',
      ]),
    );
    expect(r2Adapter.supports.verbs).toContain('mutate');
  });
});

// ─── create_multipart_upload ───────────────────────────────────────────────────────

describe('r2Adapter.mutate create_multipart_upload', () => {
  it('(a) valid key → multipart_not_available, names the server-side proxy, NEVER fetches', async () => {
    const result = await r2Adapter.mutate(scope, {
      action: 'create_multipart_upload',
      key: 'uploads/big.bin',
      contentType: 'application/octet-stream',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('multipart_not_available');
    // Honest approach — a server-side proxy under a scoped token, never inline bytes / a credential.
    expect(result.error?.message).toMatch(/server-side proxy|scoped/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(b) empty key → invalid_key (never not_available), NO fetch', async () => {
    const result = await r2Adapter.mutate(scope, { action: 'create_multipart_upload', key: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── upload_part ────────────────────────────────────────────────────────────────

describe('r2Adapter.mutate upload_part', () => {
  it('(g) missing uploadId → invalid_upload_id, NO fetch', async () => {
    const result = await r2Adapter.mutate(scope, {
      action: 'upload_part',
      key: 'k',
      uploadId: '',
      partNumber: 1,
      body: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_upload_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(f) partNumber 0 → part_number_invalid; partNumber 10001 → part_number_invalid', async () => {
    const zero = await r2Adapter.mutate(scope, {
      action: 'upload_part',
      key: 'k',
      uploadId: 'u1',
      partNumber: 0,
      body: 'x'.repeat(5 * 1024 * 1024),
    });
    expect(zero.error?.code).toBe('part_number_invalid');
    const over = await r2Adapter.mutate(scope, {
      action: 'upload_part',
      key: 'k',
      uploadId: 'u1',
      partNumber: 10001,
      body: 'x'.repeat(5 * 1024 * 1024),
    });
    expect(over.error?.code).toBe('part_number_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(c) a NON-final part below the 5 MiB floor → part_size_invalid, NO fetch', async () => {
    const result = await r2Adapter.mutate(scope, {
      action: 'upload_part',
      key: 'k',
      uploadId: 'u1',
      partNumber: 1,
      body: 'tiny', // well under 5 MiB, not marked final
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('part_size_invalid');
    expect(result.error?.message).toMatch(/5 MiB|isFinalPart/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(d) the FINAL part below 5 MiB passes the size gate → multipart_not_available', async () => {
    const result = await r2Adapter.mutate(scope, {
      action: 'upload_part',
      key: 'k',
      uploadId: 'u1',
      partNumber: 3,
      body: 'last-small-part',
      isFinalPart: true,
    });
    // The floor is waived for the final part, so it clears validation and reaches the honest boundary.
    expect(result.error?.code).toBe('multipart_not_available');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(e) a part over the 5 GiB max → part_size_invalid (measured by declared length, no giant buffer)', async () => {
    // A real 5 GiB body can't be allocated; monkeypatch TextEncoder to report an over-max length for the
    // specific huge-body sentinel ONLY (the key + every other string keeps its real length so the earlier
    // key-length gate is unaffected), then restore it.
    const HUGE = 'pretend-huge';
    const RealTextEncoder = globalThis.TextEncoder;
    const realEncode = new RealTextEncoder();
    class SelectiveEncoder {
      encode(s: string): Uint8Array {
        if (s === HUGE) return { length: 5 * 1024 * 1024 * 1024 + 1 } as unknown as Uint8Array;
        return realEncode.encode(s);
      }
    }
    globalThis.TextEncoder = SelectiveEncoder as unknown as typeof TextEncoder;
    try {
      const result = await r2Adapter.mutate(scope, {
        action: 'upload_part',
        key: 'k',
        uploadId: 'u1',
        partNumber: 1,
        body: HUGE,
      });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('part_size_invalid');
      expect(result.error?.message).toMatch(/GiB/);
    } finally {
      globalThis.TextEncoder = RealTextEncoder;
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── complete_multipart_upload ─────────────────────────────────────────────────────

describe('r2Adapter.mutate complete_multipart_upload', () => {
  it('(h) empty parts[] → part_count_invalid, NO fetch', async () => {
    const result = await r2Adapter.mutate(scope, {
      action: 'complete_multipart_upload',
      key: 'k',
      uploadId: 'u1',
      parts: [],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('part_count_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(i) non-ascending parts[] → part_order_invalid, NO fetch', async () => {
    const result = await r2Adapter.mutate(scope, {
      action: 'complete_multipart_upload',
      key: 'k',
      uploadId: 'u1',
      parts: [
        { partNumber: 2, etag: 'e2' },
        { partNumber: 1, etag: 'e1' }, // out of order
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('part_order_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a part with an empty etag → part_invalid, NO fetch', async () => {
    const result = await r2Adapter.mutate(scope, {
      action: 'complete_multipart_upload',
      key: 'k',
      uploadId: 'u1',
      parts: [{ partNumber: 1, etag: '' }],
    });
    expect(result.error?.code).toBe('part_invalid');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(j) OVERWRITE (existing object) WITHOUT confirm → confirmation_required; probe ran, nothing assembled', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(200)); // existence probe → object exists
    const result = await r2Adapter.mutate(scope, {
      action: 'complete_multipart_upload',
      key: 'config.json',
      uploadId: 'u1',
      parts: [{ partNumber: 1, etag: 'e1' }],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toContain('config.json');
    expect(result.error?.message).toMatch(/overwrite/i);
    // Only the existence probe ran — completion was NOT attempted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD');
    // (o) isolation — the probe only ever names scope.resourceId's bucket.
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/r2/buckets/${scope.resourceId}/objects/`);
  });

  it('(k) a NEW key (probe 404) passes the overwrite gate → multipart_not_available', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(404)); // probe → absent
    const result = await r2Adapter.mutate(scope, {
      action: 'complete_multipart_upload',
      key: 'fresh-big.bin',
      uploadId: 'u1',
      parts: [{ partNumber: 1, etag: 'e1' }],
    });
    expect(result.error?.code).toBe('multipart_not_available');
    // The probe ran (to check overwrite), but no assembly fetch followed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('(l) WITH confirm over an existing object passes the gate → multipart_not_available (no fake success)', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(200)); // probe → exists
    const result = await r2Adapter.mutate(scope, {
      action: 'complete_multipart_upload',
      key: 'config.json',
      uploadId: 'u1',
      parts: [{ partNumber: 1, etag: 'e1' }],
      confirm: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('multipart_not_available');
  });

  it('an INDETERMINATE existence probe fails CLOSED — unconfirmed complete is blocked', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(500)); // indeterminate, NOT "absent"
    const result = await r2Adapter.mutate(scope, {
      action: 'complete_multipart_upload',
      key: 'maybe',
      uploadId: 'u1',
      parts: [{ partNumber: 1, etag: 'e1' }],
    });
    expect(result.error?.code).toBe('confirmation_required');
  });
});

// ─── abort_multipart_upload ───────────────────────────────────────────────────────

describe('r2Adapter.mutate abort_multipart_upload', () => {
  it('(m) valid abort → multipart_not_available, no confirm needed, NO fetch', async () => {
    const result = await r2Adapter.mutate(scope, {
      action: 'abort_multipart_upload',
      key: 'k',
      uploadId: 'u1',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('multipart_not_available');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing uploadId → invalid_upload_id, NO fetch', async () => {
    const result = await r2Adapter.mutate(scope, { action: 'abort_multipart_upload', key: 'k', uploadId: '' });
    expect(result.error?.code).toBe('invalid_upload_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (p) credential safety ─────────────────────────────────────────────────────────

describe('multipart credential safety', () => {
  it('(p) the multipart_not_available envelope NEVER contains a credential', async () => {
    const result = await r2Adapter.mutate(scope, { action: 'create_multipart_upload', key: 'k' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SUPER_SECRET_ACCOUNT_KEY');
    expect(serialized).not.toMatch(/X-Auth-Key|apiKey/i);
  });
});
