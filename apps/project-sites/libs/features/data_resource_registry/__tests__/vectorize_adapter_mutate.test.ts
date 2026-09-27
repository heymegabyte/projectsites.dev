/**
 * TDD tests for the vectorize adapter WRITE slice — `mutate({action:'upsert'|'delete'})`.
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). The adapter talks to the CF Vectorize v2
 * REST API via the global `fetch`, so we stub `fetch` per-test and mock `cfAuthHeaders` (4× ../ reaches `src/`
 * from `libs/features/data_resource_registry/__tests__/`).
 *
 * The tenant boundary is the NAMESPACE, derived SERVER-SIDE from siteId (`site-<first8>`) and FORCED — a
 * caller can never write or delete another site's partition.
 *
 * Contracts under test:
 *   (j)  supports declares upsert+delete mutations + the mutate verb
 *   (a)  upsert FORCES the site's derived namespace onto EVERY vector — a caller-supplied namespace is ignored/overwritten
 *   (b)  upsert sends NDJSON to the scope's index /upsert path only (isolation) + returns count + mutationId
 *   (c)  upsert validates: empty vectors → invalid_vectors; bad id → invalid_vector_id; bad values → invalid_vector_values
 *   (d)  upsert clamps the batch to <= 1000 vectors
 *   (e)  delete WITHOUT confirm → confirmation_required, REPORTS the in-namespace count, NEVER calls delete_by_ids
 *   (f)  delete FOREIGN-namespace id is IMPOSSIBLE — only ids confirmed in the site's namespace are deleted; a foreign id is skipped
 *   (g)  delete WITH confirm on in-namespace ids → deletes only those, reports deleted+skipped+mutationId
 *   (h)  delete with NOTHING in-namespace + confirm → honest no-op (deleted:0), NEVER calls delete_by_ids
 *   (i)  delete when the namespace probe is INDETERMINATE (5xx) → fails (never deletes on an ambiguous probe)
 *   (k)  unknown action → invalid_action, no fetch
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { vectorizeAdapter, siteNamespace } from '../adapters/vectorize.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** resourceId is the SHARED index NAME (server-resolved); the namespace derives from siteId. */
const scope: ResolvedScope = {
  siteId: 'site-abc-9999',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'projectsites-rag',
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'site_scoped',
};

/** The namespace the adapter must derive + FORCE (`site-` + first 8 chars of siteId). */
const NS = siteNamespace(scope.siteId); // 'site-site-abc'

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

// ─── (j) supports declaration ────────────────────────────────────────────────────

describe('vectorizeAdapter.supports (write slice)', () => {
  it('(j) declares upsert+delete mutations and the mutate verb', () => {
    expect(vectorizeAdapter.supports.mutations).toEqual(expect.arrayContaining(['upsert', 'delete']));
    expect(vectorizeAdapter.supports.verbs).toContain('mutate');
  });
});

// ─── upsert ─────────────────────────────────────────────────────────────────────

describe('vectorizeAdapter.mutate upsert', () => {
  it('(a)(b) FORCES the site namespace on EVERY vector (ignoring caller-supplied namespace), NDJSON to scope index only', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: { mutationId: 'mut-1' } }));
    const result = await vectorizeAdapter.mutate(scope, {
      action: 'upsert',
      vectors: [
        // A caller tries to smuggle a FOREIGN namespace — it must be stripped + overwritten.
        { id: 'v1', values: [0.1, 0.2], metadata: { t: 'a' }, namespace: 'site-EVIL' } as never,
        { id: 'v2', values: [0.3, 0.4] },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ action: 'upsert', count: 2, namespace: NS, mutationId: 'mut-1' });

    const call = fetchMock.mock.calls[0];
    const url = new URL(String(call[0]));
    // Isolation: the request path targets ONLY the scope's index /upsert — no other index.
    expect(url.pathname).toContain(`/vectorize/v2/indexes/${scope.resourceId}/upsert`);
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['content-type']).toBe('application/x-ndjson');
    // Body is NDJSON (one JSON object per line); EVERY line carries the FORCED namespace, never 'site-EVIL'.
    const lines = String(call[1].body).split('\n');
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.every((v) => v.namespace === NS)).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain('site-EVIL');
    expect(parsed[0].id).toBe('v1');
    expect(parsed[0].values).toEqual([0.1, 0.2]);
  });

  it('(c) empty vectors → invalid_vectors; bad id → invalid_vector_id; bad values → invalid_vector_values (no fetch)', async () => {
    const empty = await vectorizeAdapter.mutate(scope, { action: 'upsert', vectors: [] });
    expect(empty.error?.code).toBe('invalid_vectors');

    const badId = await vectorizeAdapter.mutate(scope, {
      action: 'upsert',
      vectors: [{ id: '  ', values: [0.1] }],
    });
    expect(badId.error?.code).toBe('invalid_vector_id');

    const badValues = await vectorizeAdapter.mutate(scope, {
      action: 'upsert',
      vectors: [{ id: 'v1', values: [] }],
    });
    expect(badValues.error?.code).toBe('invalid_vector_values');

    const nanValues = await vectorizeAdapter.mutate(scope, {
      action: 'upsert',
      vectors: [{ id: 'v1', values: [Number.NaN] as never }],
    });
    expect(nanValues.error?.code).toBe('invalid_vector_values');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(d) clamps the batch to <= 1000 vectors before the upsert', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: { mutationId: 'mut-x' } }));
    const many = Array.from({ length: 1500 }, (_v, i) => ({ id: `id-${i}`, values: [i] }));
    const result = await vectorizeAdapter.mutate(scope, { action: 'upsert', vectors: many });
    expect(result.ok).toBe(true);
    expect((result.data as { count: number }).count).toBe(1000);
    const lines = String(fetchMock.mock.calls[0][1].body).split('\n');
    expect(lines).toHaveLength(1000);
  });

  it('maps a CF 5xx on upsert to a retryable error (never a fake success)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false }));
    const result = await vectorizeAdapter.mutate(scope, { action: 'upsert', vectors: [{ id: 'v1', values: [0.1] }] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_server_error');
    expect(result.error?.retryable).toBe(true);
  });
});

// ─── delete ─────────────────────────────────────────────────────────────────────

describe('vectorizeAdapter.mutate delete', () => {
  it('(e) WITHOUT confirm → confirmation_required, REPORTS the in-namespace count, NEVER calls delete_by_ids', async () => {
    // The single fetch is the NAMESPACE-SCOPED get_by_ids probe: both ids are in the site's namespace.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        result: [
          { id: 'v1', namespace: NS },
          { id: 'v2', namespace: NS },
        ],
      }),
    );
    const result = await vectorizeAdapter.mutate(scope, { action: 'delete', ids: ['v1', 'v2'] });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    // REPORTS how many WOULD be removed.
    expect(result.error?.message).toMatch(/2 of 2/);
    expect(result.error?.message).toMatch(/confirm:true/i);
    // ONLY the probe ran — NO delete_by_ids.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/get_by_ids');
  });

  it('(f)(g) FOREIGN-namespace delete is IMPOSSIBLE — only in-namespace ids are deleted; foreign is skipped', async () => {
    fetchMock
      // Probe: CF (namespace-filtered) returns only the in-namespace id; the foreign id is absent.
      .mockResolvedValueOnce(jsonResponse(200, { result: [{ id: 'mine', namespace: NS }] }))
      // delete_by_ids success.
      .mockResolvedValueOnce(jsonResponse(200, { result: { mutationId: 'mut-del' } }));
    const result = await vectorizeAdapter.mutate(scope, {
      action: 'delete',
      ids: ['mine', 'foreign-other-site'],
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ action: 'delete', deleted: 1, skipped: 1, namespace: NS, mutationId: 'mut-del' });
    // The delete_by_ids body carries ONLY the confirmed in-namespace id — the foreign id was never sent to CF.
    const del = fetchMock.mock.calls[1];
    expect(String(del[0])).toContain(`/vectorize/v2/indexes/${scope.resourceId}/delete_by_ids`);
    const body = JSON.parse(del[1].body as string);
    expect(body.ids).toEqual(['mine']);
    expect(JSON.stringify(body)).not.toContain('foreign-other-site');
  });

  it('(h) NOTHING in-namespace + confirm → honest no-op (deleted:0), NEVER calls delete_by_ids', async () => {
    // Probe returns empty — none of the requested ids are in the site's namespace.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: [] }));
    const result = await vectorizeAdapter.mutate(scope, {
      action: 'delete',
      ids: ['not-mine-1', 'not-mine-2'],
      confirm: true,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ action: 'delete', deleted: 0, skipped: 2, namespace: NS });
    // Only the probe ran — no delete_by_ids for a set with nothing in-namespace.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('(i) an INDETERMINATE namespace probe (5xx) fails — NEVER deletes on an ambiguous probe', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false }));
    const result = await vectorizeAdapter.mutate(scope, { action: 'delete', ids: ['v1'], confirm: true });
    expect(result.ok).toBe(false);
    // No delete_by_ids after an ambiguous probe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/get_by_ids');
  });

  it('empty ids → invalid_ids, no fetch', async () => {
    const result = await vectorizeAdapter.mutate(scope, { action: 'delete', ids: [], confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_ids');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── (k) unknown action ───────────────────────────────────────────────────────────

describe('vectorizeAdapter.mutate (invalid)', () => {
  it('(k) unknown action → invalid_action, no fetch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await vectorizeAdapter.mutate(scope, { action: 'nuke', ids: ['x'] } as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_action');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
