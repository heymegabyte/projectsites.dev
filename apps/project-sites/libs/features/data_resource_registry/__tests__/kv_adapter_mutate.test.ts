/**
 * TDD tests for the kv adapter WRITE slice — `mutate({action:'put'|'delete'})`.
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF KV REST
 * API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches `src/`
 * from `libs/features/data_resource_registry/__tests__/`).
 *
 * Contracts under test:
 *   (a) delete WITHOUT confirm → code 'confirmation_required', REPORTS the key + that it exists, NO delete fetch
 *   (b) delete WITH confirm → issues the DELETE + reports existed:true when the key was present
 *   (c) delete of an absent key WITH confirm → idempotent existed:false success (404 is not an error)
 *   (d) put over an EXISTING key WITHOUT confirm → 'confirmation_required', REPORTS the key, NO put fetch
 *   (e) put of a NEW key (no prior value) WITHOUT confirm → succeeds (a fresh key needs no confirm)
 *   (f) put over an existing key WITH confirm → overwritten:true; TTL rides the query param; metadata → multipart
 *   (g) an indeterminate existence probe fails CLOSED — an unconfirmed put over an ambiguous key is blocked
 *   (h) put validates value (invalid_value) + TTL (invalid_ttl below 60) + empty key (invalid_key)
 *   (i) site-isolation: every write only ever hits scope.resourceId's namespace path
 *   (j) supports declares put+delete mutations + the mutate verb
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { kvAdapter } from '../adapters/kv.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const scope: ResolvedScope = {
  siteId: 'site-1',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'kvns-00000000000000000000000000000001',
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

describe('kvAdapter.supports (write slice)', () => {
  it('(j) declares put+delete mutations and the mutate verb', () => {
    expect(kvAdapter.supports.mutations).toEqual(expect.arrayContaining(['put', 'delete']));
    expect(kvAdapter.supports.verbs).toContain('mutate');
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe('kvAdapter.mutate delete', () => {
  it('(a) WITHOUT confirm → confirmation_required, reports the key exists, NEVER deletes', async () => {
    // The single fetch is the existence HEAD probe (key present).
    fetchMock.mockResolvedValueOnce(emptyResponse(200));
    const result = await kvAdapter.mutate(scope, { action: 'delete', key: 'session:1' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    // REPORTS what would change — the key + that it exists.
    expect(result.error?.message).toContain('session:1');
    expect(result.error?.message).toMatch(/exists/i);
    // Only the probe ran — NO DELETE was issued.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD');
  });

  it('(b) WITH confirm → issues DELETE and reports existed:true when the key was present', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(200)) // pre-delete existence probe → exists
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // the DELETE
    const result = await kvAdapter.mutate(scope, { action: 'delete', key: 'session:1', confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ action: 'delete', existed: true, key: 'session:1' });
    const del = fetchMock.mock.calls[1];
    expect(del[1].method).toBe('DELETE');
    // (i) isolation — the DELETE path only ever names scope.resourceId.
    expect(String(del[0])).toContain(`/storage/kv/namespaces/${scope.resourceId}/values/session%3A1`);
  });

  it('(c) WITH confirm on an ABSENT key → idempotent existed:false (404 is not an error)', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(404)) // probe → absent
      .mockResolvedValueOnce(textResponse(404, 'not found')); // DELETE 404 = already gone
    const result = await kvAdapter.mutate(scope, { action: 'delete', key: 'gone', confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ action: 'delete', existed: false, key: 'gone' });
  });

  it('empty key → invalid_key, no fetch', async () => {
    const result = await kvAdapter.mutate(scope, { action: 'delete', key: '', confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── put ────────────────────────────────────────────────────────────────────────

describe('kvAdapter.mutate put', () => {
  it('(d) OVERWRITE (existing key) WITHOUT confirm → confirmation_required, reports the key, NEVER writes', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(200)); // probe → key exists
    const result = await kvAdapter.mutate(scope, { action: 'put', key: 'config', value: 'new' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toContain('config');
    expect(result.error?.message).toMatch(/overwrite/i);
    // Only the probe ran — NO PUT.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD');
  });

  it('(e) NEW key (no prior value) WITHOUT confirm → succeeds; a fresh key needs no confirm', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(404)) // probe → key absent
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // the PUT
    const result = await kvAdapter.mutate(scope, { action: 'put', key: 'fresh', value: 'v' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ action: 'put', key: 'fresh', overwritten: false, metadataStored: false });
    const put = fetchMock.mock.calls[1];
    expect(put[1].method).toBe('PUT');
    expect(put[1].body).toBe('v'); // plain raw-body PUT (no metadata)
    // (i) isolation
    expect(String(put[0])).toContain(`/storage/kv/namespaces/${scope.resourceId}/values/fresh`);
  });

  it('(f) OVERWRITE WITH confirm → overwritten:true; TTL rides the query param; metadata → multipart', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(200)) // probe → exists
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // the PUT
    const result = await kvAdapter.mutate(scope, {
      action: 'put',
      key: 'config',
      value: 'v2',
      expirationTtl: 3600,
      metadata: { owner: 'me' },
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      action: 'put',
      key: 'config',
      overwritten: true,
      metadataStored: true,
      expirationTtl: 3600,
    });
    const put = fetchMock.mock.calls[1];
    const url = new URL(String(put[0]));
    expect(url.searchParams.get('expiration_ttl')).toBe('3600');
    // metadata present → multipart form body (FormData), not a raw string.
    expect(put[1].body).toBeInstanceOf(FormData);
    expect((put[1].body as FormData).get('metadata')).toBe(JSON.stringify({ owner: 'me' }));
    expect((put[1].body as FormData).get('value')).toBe('v2');
  });

  it('(g) an INDETERMINATE existence probe fails CLOSED — unconfirmed put is blocked', async () => {
    // A 500 on the probe is indeterminate (not "absent") — the confirm gate must still fire.
    fetchMock.mockResolvedValueOnce(emptyResponse(500));
    const result = await kvAdapter.mutate(scope, { action: 'put', key: 'maybe', value: 'v' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    // No PUT was attempted after the ambiguous probe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('(h) invalid value → invalid_value; TTL below 60 → invalid_ttl; empty key → invalid_key (no writes)', async () => {
    const badValue = await kvAdapter.mutate(scope, {
      action: 'put',
      key: 'k',
      value: undefined as never,
      confirm: true,
    });
    expect(badValue.error?.code).toBe('invalid_value');

    const badTtl = await kvAdapter.mutate(scope, {
      action: 'put',
      key: 'k',
      value: 'v',
      expirationTtl: 30,
      confirm: true,
    });
    expect(badTtl.error?.code).toBe('invalid_ttl');

    const badKey = await kvAdapter.mutate(scope, { action: 'put', key: '', value: 'v', confirm: true });
    expect(badKey.error?.code).toBe('invalid_key');

    // None of the invalid inputs touched CF.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a CF 5xx on the PUT to a retryable error (never a fake success)', async () => {
    fetchMock
      .mockResolvedValueOnce(emptyResponse(404)) // new key
      .mockResolvedValueOnce(jsonResponse(503, { success: false, errors: [{ code: 1 }] }));
    const result = await kvAdapter.mutate(scope, { action: 'put', key: 'fresh', value: 'v' });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });

  it('unknown action → invalid_action, no fetch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await kvAdapter.mutate(scope, { action: 'nuke', key: 'k' } as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_action');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
