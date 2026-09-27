/**
 * TDD tests for the durable_object adapter WRITE slice (DO management — Data & Resource Platform §7, Backend
 * tab): mutate({action:'status_probe'|'reset', objectId, confirm?}).
 *
 * Uses the swc-jest global-jest convention (NO `import { jest }`). `cfAuthHeaders` is mocked (4× ../ reaches
 * `src/` from `libs/features/data_resource_registry/__tests__/`). The adapter NEVER fetches in this slice (there
 * is no per-site DO namespace + no CF arbitrary-instance API), so we assert `fetch` is never called.
 *
 * ⛔ THE LOAD-BEARING WRITE INVARIANT — a NARROW, opt-in management interface, NEVER an arbitrary method call:
 *  - `action` is a CLOSED enum (status_probe | reset). Anything outside it → invalid_action. There is NO
 *    {method, args} passthrough into customer code — THIS is the test that proves the isolation guarantee.
 *  - The addressed object is bound to `scope.resourceId` (the server-resolved namespace) — a caller supplies no
 *    namespace/account, so it can never reach another site's object.
 *  - `reset` (state-changing) is confirm-gated (INV-9/INV-11); `status_probe` (read-only) is not.
 *  - On this deployment there is NO per-site DO namespace + CF exposes no arbitrary-instance API → every op is
 *    an HONEST not_available (available:false) that runs NOTHING — never a fabricated result, never a call into
 *    customer code, never the object's state (stateBrowsable is permanently false).
 *
 * Contracts under test:
 *   (a) supports advertises exactly [status_probe, reset] + the mutate verb
 *   (b) ⛔ NEVER-ARBITRARY-CALL: an action outside the closed set (a "customer method name") → invalid_action, no fetch
 *   (c) missing/empty objectId → invalid_id, no fetch
 *   (d) reset WITHOUT confirm → confirmation_required (WARNS), no fetch, nothing run
 *   (e) reset WITH confirm → honest not_available (available:false) on this deployment; stateBrowsable:false; no fetch
 *   (f) status_probe (no confirm needed) → honest not_available (available:false); stateBrowsable:false; no fetch
 *   (g) the addressed op echoes the server-resolved namespaceId + the named objectId (bound, never widened)
 *   (h) state is NEVER browsable — stateBrowsable is always false, no object storage is ever dumped
 */

// ─── Mocks — declared BEFORE any import that triggers the real modules ──────────

jest.mock('../../../../src/services/cf_credentials.js', () => ({
  cfAuthHeaders: (_auth: unknown) => ({
    'X-Auth-Email': 'test@example.com',
    'X-Auth-Key': 'test-key',
  }),
}));

// ─── Import AFTER mocks ─────────────────────────────────────────────────────────

import { durableObjectAdapter } from '../adapters/durable_object.js';
import type { ResolvedScope } from '../adapter.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The resolved DO namespace id this site owns (server-resolved from the registry row). */
const NAMESPACE_ID = 'ns-aaaa1111';

/** A minimal ResolvedScope for a per-site DO surface — resourceId is the resolved namespace id. */
const scope: ResolvedScope = {
  siteId: 'site-abc-9999',
  orgId: 'org-1',
  environment: 'production',
  resourceId: NAMESPACE_ID,
  accountId: 'acct-84fa0d1b16ff8086dd958c468ce7fd59',
  auth: { email: 'test@example.com', key: 'test-key' } as never,
  accessPolicy: 'read_only',
};

const realFetch = globalThis.fetch;
let fetchMock: jest.Mock;

beforeEach(() => {
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// ─── supports ──────────────────────────────────────────────────────────────────

describe('durableObjectAdapter.supports', () => {
  it('(a) advertises exactly [status_probe, reset] + the mutate verb', () => {
    expect(durableObjectAdapter.supports.verbs).toContain('mutate');
    expect([...durableObjectAdapter.supports.mutations]).toEqual(['status_probe', 'reset']);
  });
});

// ─── ⛔ NEVER an arbitrary method call into customer code ───────────────────────────

describe('durableObjectAdapter.mutate() — the closed-allowlist isolation guarantee', () => {
  it('(b) an action OUTSIDE the closed set (an arbitrary "customer method") → invalid_action, no fetch, no call', async () => {
    // A caller trying to invoke an arbitrary method on the DO by naming it as the action is REJECTED — there is
    // no {method, args} passthrough. This is the structural guarantee that customer code is never called.
    for (const forbidden of ['deleteEverything', 'fetch', '__proto__', 'run', 'admin']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await durableObjectAdapter.mutate(scope, { action: forbidden, objectId: 'obj-1' } as any);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('invalid_action');
      // The error explicitly refuses arbitrary method calls.
      expect(result.error?.message).toMatch(/arbitrary method calls|never permitted/i);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an undefined input → invalid_action, no fetch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await durableObjectAdapter.mutate(scope, undefined as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_action');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(c) missing/empty objectId → invalid_id, no fetch', async () => {
    const result = await durableObjectAdapter.mutate(scope, { action: 'status_probe', objectId: '' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── reset — state-changing, confirm-gated ─────────────────────────────────────────

describe('durableObjectAdapter.mutate({action:"reset"})', () => {
  it('(d) WITHOUT confirm → confirmation_required (WARNS), no fetch, nothing run', async () => {
    const result = await durableObjectAdapter.mutate(scope, { action: 'reset', objectId: 'obj-1' });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_required');
    expect(result.error?.message).toMatch(/confirm:true/i);
    expect(result.error?.message).toMatch(/state-changing|cleared/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('(e)(g)(h) WITH confirm → honest not_available on this deployment; namespace bound; stateBrowsable:false; no fetch', async () => {
    const result = await durableObjectAdapter.mutate(scope, { action: 'reset', objectId: 'obj-1', confirm: true });
    expect(result.ok).toBe(true);
    expect(result.data?.action).toBe('reset');
    expect(result.data?.available).toBe(false); // no per-site DO namespace + no CF arbitrary-instance API
    expect(result.data?.objectId).toBe('obj-1');
    expect(result.data?.namespaceId).toBe(NAMESPACE_ID); // bound to the server-resolved namespace, never widened
    expect(result.data?.stateBrowsable).toBe(false); // ⛔ state is NEVER dumped
    expect(fetchMock).not.toHaveBeenCalled(); // nothing called into customer code
  });
});

// ─── status_probe — read-only, no confirm ──────────────────────────────────────────

describe('durableObjectAdapter.mutate({action:"status_probe"})', () => {
  it('(f)(g)(h) no confirm needed → honest not_available; namespace bound; stateBrowsable:false; no fetch', async () => {
    const result = await durableObjectAdapter.mutate(scope, { action: 'status_probe', objectId: 'obj-42' });
    expect(result.ok).toBe(true);
    expect(result.data?.action).toBe('status_probe');
    expect(result.data?.available).toBe(false);
    expect(result.data?.objectId).toBe('obj-42');
    expect(result.data?.namespaceId).toBe(NAMESPACE_ID);
    expect(result.data?.stateBrowsable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
