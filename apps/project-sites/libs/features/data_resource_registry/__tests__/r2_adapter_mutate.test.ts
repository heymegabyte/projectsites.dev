/**
 * TDD tests for the r2 adapter WRITE slice — `mutate({action:'put'|'delete'})`.
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF R2 REST
 * API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches `src/`
 * from `libs/features/data_resource_registry/__tests__/`). Mirrors kv_adapter_mutate.test.ts exactly.
 *
 * Contracts under test:
 *   (a) delete WITHOUT confirm → code 'confirmation_required', REPORTS the key + that it exists, NO delete fetch
 *   (b) delete WITH confirm → issues the DELETE + reports existed:true when the object was present
 *   (c) delete of an absent object WITH confirm → idempotent existed:false success (404 is not an error)
 *   (d) put over an EXISTING object WITHOUT confirm → 'confirmation_required', REPORTS the key, NO put fetch
 *   (e) put of a NEW object (no prior object) WITHOUT confirm → succeeds (a fresh object needs no confirm)
 *   (f) put over an existing object WITH confirm → overwritten:true; content-type + custom metadata ride headers
 *   (g) an indeterminate existence probe fails CLOSED — an unconfirmed put over an ambiguous key is blocked
 *   (h) put validates body (invalid_body) + empty key (invalid_key)
 *   (i) site-isolation: every write only ever hits scope.resourceId's bucket path
 *   (j) supports declares put+delete mutations + the mutate verb
 *   (k) a LARGE body is NOT embedded — code 'object_too_large', message notes a signed upload URL, NO put fetch
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
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
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'site_scoped',
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
function textResponse(status: number, text: string): Response {
  return new Response(text, { status });
}
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

// ─── (j) supports declaration ────────────────────────────────────────────────────

describe('r2Adapter.supports (write slice)', () => {
  it('(j) declares put+delete mutations and the mutate verb', () => {
    expect(r2Adapter.supports.mutations).toEqual(expect.arrayContaining(['put', 'delete']));
    expect(r2Adapter.supports.verbs).toContain('mutate');
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe('r2Adapter.mutate delete', () => {
  it('(a) WITHOUT confirm → confirmation_required, reports the key exists, NEVER deletes', async () => {
    // The single fetch is the existence HEAD probe (object present).
    fetchMock.mockResolvedValueOnce(emptyResponse(200));
    const result = await r2Adapter.mutate(scope, { action: 'delete', key: 'uploads/a.txt' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    // REPORTS what would change — the key + that it exists.
    expect(result.error?.message).toContain('uploads/a.txt');
    expect(result.error?.message).toMatch(/exists/i);
    // Only the probe ran — NO DELETE was issued.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD');
  });

  it('(b) WITH confirm → issues DELETE and reports existed:true when the object was present', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(200)) // pre-delete existence probe → exists
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // the DELETE
    const result = await r2Adapter.mutate(scope, { action: 'delete', key: 'uploads/a.txt', confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ action: 'delete', existed: true, key: 'uploads/a.txt' });
    const del = fetchMock.mock.calls[1];
    expect(del[1].method).toBe('DELETE');
    // (i) isolation — the DELETE path only ever names scope.resourceId + the URL-encoded key.
    expect(String(del[0])).toContain(`/r2/buckets/${scope.resourceId}/objects/uploads%2Fa.txt`);
  });

  it('(c) WITH confirm on an ABSENT object → idempotent existed:false (404 is not an error)', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(404)) // probe → absent
      .mockResolvedValueOnce(textResponse(404, 'not found')); // DELETE 404 = already gone
    const result = await r2Adapter.mutate(scope, { action: 'delete', key: 'gone', confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ action: 'delete', existed: false, key: 'gone' });
  });

  it('empty key → invalid_key, no fetch', async () => {
    const result = await r2Adapter.mutate(scope, { action: 'delete', key: '', confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── put ────────────────────────────────────────────────────────────────────────

describe('r2Adapter.mutate put', () => {
  it('(d) OVERWRITE (existing object) WITHOUT confirm → confirmation_required, reports the key, NEVER writes', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(200)); // probe → object exists
    const result = await r2Adapter.mutate(scope, { action: 'put', key: 'config.json', body: 'new' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toContain('config.json');
    expect(result.error?.message).toMatch(/overwrite/i);
    // Only the probe ran — NO PUT.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD');
  });

  it('(e) NEW object (no prior object) WITHOUT confirm → succeeds; a fresh object needs no confirm', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(404)) // probe → object absent
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // the PUT
    const result = await r2Adapter.mutate(scope, { action: 'put', key: 'fresh.txt', body: 'v' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      action: 'put',
      key: 'fresh.txt',
      overwritten: false,
      metadataStored: false,
      contentType: 'application/octet-stream',
    });
    const put = fetchMock.mock.calls[1];
    expect(put[1].method).toBe('PUT');
    expect(put[1].body).toBe('v'); // raw-body PUT (the object bytes)
    // (i) isolation
    expect(String(put[0])).toContain(`/r2/buckets/${scope.resourceId}/objects/fresh.txt`);
  });

  it('(f) OVERWRITE WITH confirm → overwritten:true; content-type + custom metadata ride request headers', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(200)) // probe → exists
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // the PUT
    const result = await r2Adapter.mutate(scope, {
      action: 'put',
      key: 'config.json',
      body: '{"a":1}',
      contentType: 'application/json',
      customMetadata: { owner: 'me' },
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      action: 'put',
      key: 'config.json',
      overwritten: true,
      metadataStored: true,
      contentType: 'application/json',
    });
    const put = fetchMock.mock.calls[1];
    expect(put[1].headers['content-type']).toBe('application/json');
    // custom metadata rides as x-amz-meta-* headers on the R2 REST data plane.
    expect(put[1].headers['x-amz-meta-owner']).toBe('me');
    expect(put[1].body).toBe('{"a":1}');
  });

  it('(g) an INDETERMINATE existence probe fails CLOSED — unconfirmed put is blocked', async () => {
    // A 500 on the probe is indeterminate (not "absent") — the confirm gate must still fire.
    fetchMock.mockResolvedValueOnce(emptyResponse(500));
    const result = await r2Adapter.mutate(scope, { action: 'put', key: 'maybe', body: 'v' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    // No PUT was attempted after the ambiguous probe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('(h) invalid body → invalid_body; empty key → invalid_key (no writes)', async () => {
    const badBody = await r2Adapter.mutate(scope, {
      action: 'put',
      key: 'k',
      body: undefined as never,
      confirm: true,
    });
    expect(badBody.error?.code).toBe('invalid_body');

    const badKey = await r2Adapter.mutate(scope, { action: 'put', key: '', body: 'v', confirm: true });
    expect(badKey.error?.code).toBe('invalid_key');

    // None of the invalid inputs touched CF.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(k) a LARGE body is NOT embedded — object_too_large, notes a signed upload URL, NO fetch', async () => {
    // A body over the 25 MiB inline cap. Build it cheaply via repeat (one char = one byte in ASCII).
    const huge = 'x'.repeat(25 * 1024 * 1024 + 1);
    const result = await r2Adapter.mutate(scope, { action: 'put', key: 'big.bin', body: huge, confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('object_too_large');
    // The message steers the caller to a short-lived scoped/signed upload URL — never inline bytes.
    expect(result.error?.message).toMatch(/upload url|signed/i);
    // The adapter never even probed or PUT — no bytes were sent to CF.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a CF 5xx on the PUT to a retryable error (never a fake success)', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(404)) // new object
      .mockResolvedValueOnce(jsonResponse(503, { success: false, errors: [{ code: 1 }] }));
    const result = await r2Adapter.mutate(scope, { action: 'put', key: 'fresh.txt', body: 'v' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('unknown action → invalid_action, no fetch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await r2Adapter.mutate(scope, { action: 'nuke', key: 'k' } as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_action');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
