/**
 * TDD tests for the kv adapter BULK slice — `mutate({action:'bulk_delete'})` + the `bulkGet` read companion.
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF KV REST
 * API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches `src/`
 * from `libs/features/data_resource_registry/__tests__/`).
 *
 * Contracts under test:
 *   bulk_delete
 *     (a) WITHOUT confirm → code 'confirmation_required', REPORTS the count, NO delete fetch
 *     (b) WITH confirm → issues ONE DELETE .../bulk with the JSON key array; reports requested count
 *     (c) over the 10,000-key CF cap → 'bulk_limit_exceeded' (REJECTED, never truncated), NO fetch
 *     (d) empty / all-blank keys → 'no_keys', NO fetch
 *     (e) duplicate keys collapse to one op (count reflects UNIQUE keys)
 *     (f) isolation: the DELETE only ever hits scope.resourceId's namespace /bulk path
 *     (g) a CF 5xx on the bulk delete → retryable error (never a fake success)
 *   bulk_get
 *     (h) returns an honest per-key result — found:true+value / found:false miss
 *     (i) clamps an over-cap keys[] to 10,000 and REPORTS clampedOff (a read, so no rejection)
 *     (j) empty keys → empty result, no fetch
 *     (k) isolation: targets ONLY scope.resourceId's /bulk/get path
 *   supports
 *     (l) supports.mutations includes bulk_delete
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

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── (l) supports declaration ─────────────────────────────────────────────────────

describe('kvAdapter.supports (bulk slice)', () => {
  it('(l) declares the bulk_delete mutation', () => {
    expect(kvAdapter.supports.mutations).toEqual(expect.arrayContaining(['bulk_delete']));
  });
});

// ─── bulk_delete ────────────────────────────────────────────────────────────────

describe('kvAdapter.mutate bulk_delete', () => {
  it('(a) WITHOUT confirm → confirmation_required, REPORTS the count, NEVER deletes', async () => {
    const result = await kvAdapter.mutate(scope, {
      action: 'bulk_delete',
      keys: ['a', 'b', 'c'],
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    // REPORTS what would change — the count.
    expect(result.error?.message).toMatch(/3/);
    expect(result.error?.message).toMatch(/confirm:true/i);
    // NO fetch at all — nothing was deleted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(b) WITH confirm → issues ONE DELETE .../bulk with the key array; reports requested count', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const result = await kvAdapter.mutate(scope, {
      action: 'bulk_delete',
      keys: ['a', 'b', 'c'],
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ action: 'bulk_delete', requested: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe('DELETE');
    // Body is the JSON array of keys.
    expect(JSON.parse(call[1].body as string)).toEqual(['a', 'b', 'c']);
  });

  it('(c) over the 10,000-key CF cap → bulk_limit_exceeded (REJECTED, never truncated), NO fetch', async () => {
    const keys = Array.from({ length: 10_001 }, (_, i) => `k${i}`);
    const result = await kvAdapter.mutate(scope, { action: 'bulk_delete', keys, confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('bulk_limit_exceeded');
    expect(result.error?.message).toMatch(/10000|10,000/);
    // A destructive op is REJECTED, never partially executed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(d) empty / all-blank keys → no_keys, NO fetch', async () => {
    const empty = await kvAdapter.mutate(scope, { action: 'bulk_delete', keys: [], confirm: true });
    expect(empty.error?.code).toBe('no_keys');
    const blank = await kvAdapter.mutate(scope, {
      action: 'bulk_delete',
      keys: ['', '', ''],
      confirm: true,
    });
    expect(blank.error?.code).toBe('no_keys');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(e) duplicate keys collapse to one op (count reflects UNIQUE keys)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    const result = await kvAdapter.mutate(scope, {
      action: 'bulk_delete',
      keys: ['a', 'a', 'b', 'b', 'b'],
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ action: 'bulk_delete', requested: 2 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).sort()).toEqual(['a', 'b']);
  });

  it('(f) isolation — the DELETE only ever names scope.resourceId /bulk path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    await kvAdapter.mutate(scope, { action: 'bulk_delete', keys: ['a'], confirm: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/storage/kv/namespaces/${scope.resourceId}/bulk`,
    );
  });

  it('(g) a CF 5xx on the bulk delete → retryable error (never a fake success)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false, errors: [{ code: 1 }] }));
    const result = await kvAdapter.mutate(scope, { action: 'bulk_delete', keys: ['a'], confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.code).toBe('cf_server_error');
  });
});

// ─── bulk_get ─────────────────────────────────────────────────────────────────────

describe('kvAdapter.bulkGet()', () => {
  it('(h) returns an honest per-key result — found+value / miss', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: { values: { a: 'va', c: 'vc' } } }),
    );
    const result = await kvAdapter.bulkGet(scope, { keys: ['a', 'b', 'c'] });
    expect(result.ok).toBe(true);
    expect(result.data?.found).toBe(2);
    expect(result.data?.missing).toBe(1);
    expect(result.data?.values).toEqual([
      { found: true, key: 'a', value: 'va' },
      { found: false, key: 'b' },
      { found: true, key: 'c', value: 'vc' },
    ]);
  });

  it('handles the object-shaped { value } entry form', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, result: { values: { a: { value: 'va', metadata: { x: 1 } } } } }),
    );
    const result = await kvAdapter.bulkGet(scope, { keys: ['a'] });
    expect(result.data?.values[0]).toEqual({ found: true, key: 'a', value: 'va' });
  });

  it('(i) clamps an over-cap keys[] to 10,000 and REPORTS clampedOff (a read — no rejection)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { values: {} } }));
    const keys = Array.from({ length: 10_005 }, (_, i) => `k${i}`);
    const result = await kvAdapter.bulkGet(scope, { keys });
    expect(result.ok).toBe(true);
    expect(result.data?.clampedOff).toBe(5);
    // The submitted request carried exactly 10,000 keys.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).keys).toHaveLength(10_000);
  });

  it('(j) empty keys → empty result, no fetch', async () => {
    const result = await kvAdapter.bulkGet(scope, { keys: [] });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ clampedOff: 0, found: 0, missing: 0, values: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(k) isolation — targets ONLY scope.resourceId /bulk/get path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, result: { values: {} } }));
    await kvAdapter.bulkGet(scope, { keys: ['a'] });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/storage/kv/namespaces/${scope.resourceId}/bulk/get`,
    );
  });

  it('maps a CF 5xx on bulk get to a retryable error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false, errors: [{ code: 1 }] }));
    const result = await kvAdapter.bulkGet(scope, { keys: ['a'] });
    expect(result.ok).toBe(false);
    expect(result.error?.retryable).toBe(true);
  });
});
