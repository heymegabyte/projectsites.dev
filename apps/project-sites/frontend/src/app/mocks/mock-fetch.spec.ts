import { installMockFetch } from './mock-fetch';
import { MockModeService } from './mock-mode.service';
import type { MockState } from './fixtures/index';
import type { FullOrganization } from '../pages/auth/org-api.service';

/**
 * installMockFetch — the mock-mode seam at the NATIVE `window.fetch` boundary.
 *
 * Why it exists: the Angular {@link import('../interceptors/mock-api.interceptor').mockApiInterceptor}
 * only sees `HttpClient` traffic. `OrgApiService` + `AuthApiService` call the worker
 * with the native `fetch` API (to round-trip the session cookie), so their routes
 * (e.g. `GET /api/auth/organization/get-full-organization`) are INERT on `?mock=1`
 * until this shim wraps `window.fetch`.
 *
 * Contract mirrors the interceptor exactly:
 * - ONLY wraps when `mock.enabled()` — REAL is the prod default (installer no-ops).
 * - a matched GET `/api/*` route resolves a SYNTHETIC `Response` from the fixture;
 * - an UNMATCHED `/api/*` route — or any non-`/api` URL — passes through to the
 *   ORIGINAL fetch (never breaks a real call);
 * - `state==='error'` → a 500 `Response` with the interceptor's RFC7807-ish body.
 */
describe('installMockFetch (native-fetch seam · REAL-by-default · pass-through-safe)', () => {
  /** A stub MockModeService whose signals we control per test (mirrors the interceptor spec). */
  function mockService(enabled: boolean, state: MockState = 'populated'): MockModeService {
    return {
      enabled: () => enabled,
      state: () => state,
      badgeLabel: () => 'DEMO · mock data',
    } as unknown as MockModeService;
  }

  /** The real fetch — captured once so each test restores it (keeps the suite hermetic). */
  const realFetch = window.fetch;

  afterEach(() => {
    // Restore whatever was there before — the installer swaps window.fetch in place.
    window.fetch = realFetch;
  });

  it('(c) is a NO-OP when mock mode is OFF — window.fetch is left IDENTICAL (zero prod risk)', async () => {
    // A sentinel real fetch — if it's ever replaced OR called-for-a-fixture-route, the
    // installer failed to no-op. Both the identity AND the behavior must be untouched.
    const sentinel = new Response('real', { status: 200 });
    const realSpy = jasmine.createSpy('realFetch').and.resolveTo(sentinel);
    window.fetch = realSpy as unknown as typeof window.fetch;
    const before = window.fetch;

    const dispose = installMockFetch(mockService(false));

    // Identity untouched — no wrapper installed at all (REAL is the prod default).
    expect(window.fetch).toBe(before);
    // Behavior untouched — even a route that HAS a fixture hits the real fetch verbatim.
    const res = await window.fetch('/api/auth/organization/get-full-organization');
    expect(realSpy).toHaveBeenCalledTimes(1);
    expect(res).toBe(sentinel);

    dispose(); // disposer is a no-op when off
    expect(window.fetch).toBe(before);
  });

  it('(c) installs an interception when enabled, then fully RESTORES real behavior on dispose', async () => {
    // Behavioral install/restore (robust to the Karma/zone fetch-identity quirk): when
    // installed, a matched route is served synthetically (real fetch NOT called); after
    // dispose, the SAME matched route falls straight through to the real fetch again.
    const sentinel = new Response('real', { status: 200 });
    const realSpy = jasmine.createSpy('realFetch').and.resolveTo(sentinel);
    window.fetch = realSpy as unknown as typeof window.fetch;

    const dispose = installMockFetch(mockService(true));

    // Installed → synthetic, real fetch untouched.
    const mocked = await window.fetch('/api/auth/organization/get-full-organization');
    expect(realSpy).not.toHaveBeenCalled();
    expect(mocked.status).toBe(200);

    dispose();

    // Restored → the exact same matched route now reaches the real fetch verbatim.
    const real = await window.fetch('/api/auth/organization/get-full-organization');
    expect(realSpy).toHaveBeenCalledTimes(1);
    expect(real).toBe(sentinel);
  });

  it('(a) in mock mode, GET /api/auth/organization/get-full-organization resolves a synthetic Response from the fixture', async () => {
    // A spy that fails the test if the original fetch is ever reached for a matched route.
    const spy = jasmine.createSpy('realFetch');
    window.fetch = spy as unknown as typeof window.fetch;
    const dispose = installMockFetch(mockService(true, 'populated'));

    const res = await window.fetch('/api/auth/organization/get-full-organization');

    expect(spy).not.toHaveBeenCalled(); // short-circuited — never hit the network
    expect(res instanceof Response).toBe(true);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as FullOrganization;
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members.length).toBeGreaterThan(0);
    expect(Array.isArray(body.invitations)).toBe(true);
    dispose();
  });

  it('(a) matches a Request object + an absolute URL (normalizes to the registry key, like the interceptor)', async () => {
    const spy = jasmine.createSpy('realFetch');
    window.fetch = spy as unknown as typeof window.fetch;
    const dispose = installMockFetch(mockService(true, 'populated'));

    // Absolute URL with origin + a Request instance both normalize to the same key.
    const viaAbs = await window.fetch(
      'https://projectsites.dev/api/auth/organization/get-full-organization',
    );
    const viaRequest = await window.fetch(
      new Request('/api/auth/organization/get-full-organization'),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(viaAbs.status).toBe(200);
    expect(viaRequest.status).toBe(200);
    dispose();
  });

  it('(b) passes an UNMATCHED /api/* route through to the ORIGINAL fetch (never breaks a real call)', async () => {
    const sentinel = new Response('real', { status: 200 });
    const spy = jasmine.createSpy('realFetch').and.resolveTo(sentinel);
    window.fetch = spy as unknown as typeof window.fetch;
    const dispose = installMockFetch(mockService(true, 'populated'));

    const res = await window.fetch('/api/sites/abc/workflow'); // no fixture for this

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toBe(sentinel); // the original fetch's response, verbatim
    dispose();
  });

  it('(b) passes a non-/api URL through to the ORIGINAL fetch (SPA assets, third-party)', async () => {
    const sentinel = new Response('asset', { status: 200 });
    const spy = jasmine.createSpy('realFetch').and.resolveTo(sentinel);
    window.fetch = spy as unknown as typeof window.fetch;
    const dispose = installMockFetch(mockService(true, 'populated'));

    const res = await window.fetch('/assets/i18n/en.json');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toBe(sentinel);
    dispose();
  });

  it('(b) passes a non-GET /api/* request (mutation) through to the ORIGINAL fetch (only GET is fixtured)', async () => {
    const sentinel = new Response('{}', { status: 200 });
    const spy = jasmine.createSpy('realFetch').and.resolveTo(sentinel);
    window.fetch = spy as unknown as typeof window.fetch;
    const dispose = installMockFetch(mockService(true, 'populated'));

    // POST to a path that HAS a GET fixture — must still pass through (mutations aren't mocked).
    const res = await window.fetch('/api/auth/organization/invite-member', {
      method: 'POST',
      body: JSON.stringify({ email: 'x@y.test', role: 'member' }),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toBe(sentinel);
    dispose();
  });

  it('(d) state=error → a 500 Response with the interceptor RFC7807-ish error body', async () => {
    const spy = jasmine.createSpy('realFetch');
    window.fetch = spy as unknown as typeof window.fetch;
    const dispose = installMockFetch(mockService(true, 'error'));

    const res = await window.fetch('/api/auth/organization/get-full-organization');

    expect(spy).not.toHaveBeenCalled(); // matched → synthetic error, not a real call
    expect(res instanceof Response).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    // Mirrors the interceptor's envelope: { error: { code, message, request_id } }.
    expect(body.error?.code).toBe('INTERNAL_ERROR');
    expect(typeof body.error?.message).toBe('string');
    dispose();
  });
});
