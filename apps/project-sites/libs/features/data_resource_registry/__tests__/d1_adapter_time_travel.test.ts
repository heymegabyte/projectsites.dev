/**
 * TDD tests for the d1 adapter Time Travel actions —
 *   mutate({action:'time_travel_info', timestamp?})  → READ the live bookmark + 30-day PITR window
 *   mutate({action:'restore', bookmark?|timestamp?, confirm}) → DESTRUCTIVE whole-DB point-in-time restore
 *
 * Time Travel IS exposed by the CF D1 REST API (verified against CF docs):
 *   GET  …/d1/database/{id}/time_travel/bookmark[?timestamp=ISO]  → { result:{ bookmark } }
 *   POST …/d1/database/{id}/time_travel/restore?bookmark=…|timestamp=… → { result:{ bookmark, previous_bookmark, message } }
 * So these run for REAL through global fetch (like `head`), NOT the /query executor. We mock global fetch +
 * cfAuthHeaders (4× ../ reaches `src/` from libs/features/data_resource_registry/__tests__/). swc-jest global-jest
 * convention (NO `import { jest }`).
 *
 * Contracts under test:
 *   time_travel_info
 *     (a) current bookmark → available:true + bookmark + retentionDays:30; hits GET …/time_travel/bookmark
 *     (b) with timestamp → nearest-at-or-before lookup: ?timestamp= appended + asOf echoed
 *     (c) CF failure → typed retryable error (never a fabricated bookmark)
 *     (d) isolation: shared-platform id refused → no fetch
 *   restore
 *     (e) WITHOUT confirm → confirmation_required warning (whole-DB + 30-day), NO fetch (nothing runs)
 *     (f) neither bookmark nor timestamp → invalid_restore_target, NO fetch
 *     (g) BOTH bookmark and timestamp → invalid_restore_target, NO fetch (mutually exclusive)
 *     (h) confirm + bookmark → real POST …/time_travel/restore?bookmark=…; returns restored + previous_bookmark (undo)
 *     (i) confirm + timestamp → real POST …?timestamp=…
 *     (j) CF failure → typed retryable error (never a fabricated success)
 *     (k) isolation: shared-platform id refused → no fetch
 *   supports
 *     (l) declares time_travel_info + restore mutations
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

const mockQuery = jest.fn();
const mockMakeExecutor = jest.fn(() => ({ query: mockQuery }));

jest.mock('../../../../src/services/site_data_db.js', () => ({
  makeSiteDataExecutor: (...a: unknown[]) => mockMakeExecutor(...a),
  isSafeIdent: (s: unknown): s is string =>
    typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s),
  quoteIdent: (s: string) => `"${s.replace(/"/g, '""')}"`,
  FORBIDDEN_DB_IDS: new Set(['ea3e839a-c641-4861-ae30-dfc63bff8032']),
}));

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { d1Adapter } from '../adapters/d1.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const scope: ResolvedScope = {
  siteId: 'site-1',
  orgId: 'org-1',
  environment: 'production',
  resourceId: 'db-00000000-0000-4000-a000-000000000001', // NOT in FORBIDDEN_DB_IDS
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'no_direct' as never,
};

const forbiddenScope: ResolvedScope = {
  ...scope,
  resourceId: 'ea3e839a-c641-4861-ae30-dfc63bff8032',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;
const fetchMock = jest.fn();

beforeEach(() => {
  mockMakeExecutor.mockReset();
  mockQuery.mockReset();
  mockMakeExecutor.mockReturnValue({ query: mockQuery });
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── (l) supports declaration ────────────────────────────────────────────────────

describe('d1Adapter.supports (Time Travel)', () => {
  it('(l) declares the time_travel_info + restore mutations', () => {
    expect(d1Adapter.supports.mutations).toEqual(
      expect.arrayContaining(['time_travel_info', 'restore']),
    );
  });
});

// ─── time_travel_info ─────────────────────────────────────────────────────────────

describe('d1Adapter.mutate time_travel_info', () => {
  it('(a) current bookmark → available:true + bookmark + retentionDays 30; GET …/time_travel/bookmark', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: { bookmark: 'bk-current-abc' } }));
    const result = await d1Adapter.mutate(scope, { action: 'time_travel_info' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      action: 'time_travel_info',
      available: true,
      bookmark: 'bk-current-abc',
      retentionDays: 30,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`/d1/database/${scope.resourceId}/time_travel/bookmark`);
    expect(url).not.toContain('timestamp=');
    expect((fetchMock.mock.calls[0][1] as { method: string }).method).toBe('GET');
  });

  it('(b) with timestamp → nearest-at-or-before: ?timestamp= appended + asOf echoed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { result: { bookmark: 'bk-as-of' } }));
    const result = await d1Adapter.mutate(scope, {
      action: 'time_travel_info',
      timestamp: '2026-09-01T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ bookmark: 'bk-as-of', asOf: '2026-09-01T00:00:00Z' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('timestamp=2026-09-01T00%3A00%3A00Z');
  });

  it('(c) a CF failure → typed retryable error (never a fabricated bookmark)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false }));
    const result = await d1Adapter.mutate(scope, { action: 'time_travel_info' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_server_error');
    expect(result.error?.retryable).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it('(d) refuses the shared-platform id — never fetches', async () => {
    const result = await d1Adapter.mutate(forbiddenScope, { action: 'time_travel_info' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('forbidden_shared');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── restore ──────────────────────────────────────────────────────────────────────

describe('d1Adapter.mutate restore', () => {
  it('(e) WITHOUT confirm → confirmation_required (whole-DB + 30-day), NOTHING runs', async () => {
    const result = await d1Adapter.mutate(scope, { action: 'restore', bookmark: 'bk-1' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toMatch(/whole-database/i);
    expect(result.error?.message).toMatch(/30/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(f) neither bookmark nor timestamp (even WITH confirm) → invalid_restore_target, no fetch', async () => {
    const result = await d1Adapter.mutate(scope, { action: 'restore', confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_restore_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(g) BOTH bookmark and timestamp → invalid_restore_target (mutually exclusive), no fetch', async () => {
    const result = await d1Adapter.mutate(scope, {
      action: 'restore',
      confirm: true,
      bookmark: 'bk-1',
      timestamp: '2026-09-01T00:00:00Z',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_restore_target');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(h) confirm + bookmark → real POST …/time_travel/restore?bookmark=; returns restored + previous_bookmark (undo)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        result: { bookmark: 'bk-after', previous_bookmark: 'bk-before', message: 'Restored to bk-1' },
      }),
    );
    const result = await d1Adapter.mutate(scope, {
      action: 'restore',
      confirm: true,
      bookmark: 'bk-1',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      action: 'restore',
      restored: true,
      bookmark: 'bk-after',
      previousBookmark: 'bk-before',
      message: 'Restored to bk-1',
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`/d1/database/${scope.resourceId}/time_travel/restore`);
    expect(url).toContain('bookmark=bk-1');
    expect(url).not.toContain('timestamp=');
    expect((fetchMock.mock.calls[0][1] as { method: string }).method).toBe('POST');
  });

  it('(i) confirm + timestamp → real POST …?timestamp=', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { result: { bookmark: 'bk-after', previous_bookmark: 'bk-before' } }),
    );
    const result = await d1Adapter.mutate(scope, {
      action: 'restore',
      confirm: true,
      timestamp: '2026-09-01T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ restored: true, bookmark: 'bk-after' });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('timestamp=2026-09-01T00%3A00%3A00Z');
    expect(url).not.toContain('bookmark=');
  });

  it('(j) a CF failure → typed retryable error (never a fabricated success)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false }));
    const result = await d1Adapter.mutate(scope, {
      action: 'restore',
      confirm: true,
      bookmark: 'bk-1',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cf_server_error');
    expect(result.error?.retryable).toBe(true);
    expect(result.data).toBeUndefined();
  });

  it('(k) refuses the shared-platform id — never fetches (even with confirm + target)', async () => {
    const result = await d1Adapter.mutate(forbiddenScope, {
      action: 'restore',
      confirm: true,
      bookmark: 'bk-1',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('forbidden_shared');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
