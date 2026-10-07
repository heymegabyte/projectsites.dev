/**
 * @module mocks/mock-fetch
 *
 * @description
 * The MOCK-MODE seam at the NATIVE `window.fetch` boundary — the twin of the
 * {@link import('../interceptors/mock-api.interceptor').mockApiInterceptor} for the
 * services that bypass Angular's `HttpClient`.
 *
 * `OrgApiService` + `AuthApiService` (`pages/auth/*-api.service.ts`) call the worker
 * with the native `fetch` API (so the Better-Auth session cookie + `ps_session`
 * Bearer round-trip). The `HttpInterceptorFn` seam ONLY sees `HttpClient` traffic, so
 * those routes — e.g. `GET /api/auth/organization/get-full-organization`, which the
 * committed {@link import('./fixtures/team.fixture').orgFullOrganizationFixture}
 * covers — are INERT on `?mock=1` without this shim.
 *
 * {@link installMockFetch} wraps `window.fetch` ONLY when {@link MockModeService.enabled}
 * is true (`?mock=1`). The wrapper normalizes the request to the SAME registry key the
 * interceptor uses ({@link toRegistryKey}), looks it up in the SAME registry
 * ({@link findFixture}), and on a MATCH returns a synthetic {@link Response} built from
 * the fixture body. On NO match — or any non-`/api` URL, or a non-GET request — it
 * calls the ORIGINAL `fetch` (pass-through: a real call is NEVER broken by the mock
 * layer). **REAL is the prod default:** with no `?mock=1`, the installer no-ops and
 * `window.fetch` is left byte-for-byte identical.
 *
 * @remarks
 * - Match + state + error semantics MIRROR the interceptor:
 *   - matched + `populated`/`loading`/`empty` → `200` JSON from `fixture(state, query)`;
 *   - matched + `error` → a `500` with the interceptor's RFC7807-ish envelope
 *     (`{ error: { code:'INTERNAL_ERROR', message, request_id:'mock' } }`);
 *   - unmatched / non-`/api` / non-GET → original `fetch` (only GET is fixtured —
 *     mutations always hit the real backend, matching the interceptor's scope).
 * - Matching logic is NOT duplicated — it reuses {@link toRegistryKey} + {@link findFixture}.
 * - No artificial latency here: unlike the interceptor's `timer(MOCK_LATENCY_MS)` (which
 *   makes an Angular loading state visible), the native-fetch callers (`OrgApiService`)
 *   render synchronously off the resolved promise; a delay would add nothing and only
 *   slow the demo. The response still resolves on a microtask (a real `fetch` Promise).
 * - Install ONCE at bootstrap (an `APP_INITIALIZER` in `app.config.ts`). Returns a
 *   disposer that restores the original `fetch` — used by tests to stay hermetic.
 */
import type { MockModeService } from './mock-mode.service';

import { findFixture, toRegistryKey } from './fixtures/index';

/** The native `fetch` signature — what we wrap and fall back to. */
type FetchFn = typeof globalThis.fetch;

/**
 * Resolve the `{ method, url }` from the polymorphic `fetch` args so we can build the
 * registry key. `fetch` accepts a `string`, a `URL`, or a `Request` as its first arg,
 * with an optional `RequestInit` carrying the method (default `GET`). A `Request`
 * instance already carries both its `url` and `method`.
 */
function resolveRequest(input: RequestInfo | URL, init?: RequestInit): { method: string; url: string } {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    // init.method (if present) still wins — fetch(req, { method }) overrides the Request's.
    return { method: (init?.method ?? input.method ?? 'GET').toUpperCase(), url: input.url };
  }
  const url = input instanceof URL ? input.href : String(input);
  return { method: (init?.method ?? 'GET').toUpperCase(), url };
}

/**
 * Build a synthetic error {@link Response} mirroring the interceptor's `error`-state
 * body — a `500` whose JSON matches the worker's RFC7807-ish envelope so a native-fetch
 * caller's error path (e.g. `OrgApiService.extractError`) behaves exactly as in prod.
 */
function mockErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Mock error state (?mock=1&state=error)',
        request_id: 'mock',
      },
    }),
    { headers: { 'content-type': 'application/json' }, status: 500, statusText: 'Mock Error' },
  );
}

/**
 * Install the native-`fetch` mock shim.
 *
 * When {@link MockModeService.enabled} is false (REAL — the prod default) this NO-OPs:
 * `window.fetch` is left untouched and the returned disposer is a no-op. When enabled,
 * it swaps `window.fetch` for a wrapper that serves fixtures for matched GET `/api/*`
 * routes and passes everything else through to the saved original.
 *
 * @param mock - the singleton mode service (read for `enabled()` + `state()`).
 * @returns a disposer that restores the original `fetch` (used by tests).
 * @example
 * // in app.config.ts APP_INITIALIZER:
 * installMockFetch(inject(MockModeService));
 */
export function installMockFetch(mock: MockModeService): () => void {
  // No window (SSR/prerender) or not in mock mode → REAL default, nothing installed.
  if (typeof window === 'undefined' || !mock.enabled()) {
    return () => undefined;
  }

  // Save the ORIGINAL fetch so pass-through (and the disposer) use the real one.
  const originalFetch: FetchFn = window.fetch.bind(window);

  const wrapped: FetchFn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { method, url } = resolveRequest(input, init);

    // Only GET is fixtured — every mutation passes through to the real backend
    // (mirrors the interceptor, which only short-circuits reads).
    if (method !== 'GET') {
      return originalFetch(input, init);
    }

    // Reuse the interceptor's normalization — strips origin/`/api`/trailing-slash/query.
    const { key, query } = toRegistryKey(method, url);
    const fixture = findFixture(key);

    // No fixture (or a non-`/api` path that won't be in the registry) → pass through.
    if (!fixture) {
      return originalFetch(input, init);
    }

    const state = mock.state();

    // `error` state → the matched surface's error path (a realistic 500) so a caller's
    // error/retry UI is demoable from mock data alone — same envelope the interceptor throws.
    if (state === 'error') {
      return Promise.resolve(mockErrorResponse());
    }

    // populated / loading / empty → a 200 JSON Response from the fixture body.
    const body = fixture(state, query);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      }),
    );
  };

  window.fetch = wrapped;
  return () => {
    window.fetch = originalFetch;
  };
}
