/**
 * @module mocks/fixtures
 *
 * @description
 * The fixture REGISTRY — the single map the mock interceptor consults. Each entry
 * keys a route pattern (`"<METHOD> <path>"`, path relative to `/api`, e.g.
 * `"GET /admin/leads"`) to a typed {@link FixtureFactory}. When `?mock=1` is active
 * the interceptor matches an incoming request against this map (method + pathname,
 * origin + query stripped) and serves the factory's body; an UNMATCHED route passes
 * through to the real backend untouched (the mock layer never breaks a real call).
 *
 * @remarks
 * - This is the seam the whole UI-mock-out campaign extends: a new slice adds ONE
 *   fixture module + ONE registry line. Every fixture satisfies the SAME typed
 *   contract the real worker returns, so wiring the real endpoint is a provider SWAP.
 * - Paths are stored WITHOUT the `/api` prefix + WITHOUT query — the interceptor
 *   normalizes the request the same way before lookup, so `GET /api/admin/leads?x=1`
 *   matches the `GET /admin/leads` entry.
 * - `state` lets every fixture expose empty / loading / error / populated variants
 *   via `?mock=1&state=…` so every UI state is demoable from mock data alone.
 */
import { leadsFixture } from './leads.fixture';
import { sitesFixture } from './sites.fixture';
import { subscriptionFixture, entitlementsFixture, walletFixture } from './billing.fixture';
import { domainsSummaryFixture } from './domains-summary.fixture';
import { meFixture } from './admin-me.fixture';

/** The demo-state knob from `?mock=1&state=…`. `populated` is the default. */
export type MockState = 'empty' | 'loading' | 'error' | 'populated';

/** All valid mock states (for parsing/validation in {@link MockModeService}). */
export const MOCK_STATES: readonly MockState[] = ['empty', 'loading', 'error', 'populated'];

/**
 * A fixture factory — builds the response body for a matched route. Receives the
 * active {@link MockState} and the request's parsed query params (so a paginated
 * fixture can honor `offset`/`limit`). Pure + synchronous; the interceptor owns the
 * realistic latency + the `error` short-circuit.
 */
export type FixtureFactory<T = unknown> = (state: MockState, query: URLSearchParams) => T;

/**
 * Registry key: `"<METHOD> <path>"` where `path` is relative to `/api` and carries
 * NO query string, e.g. `"GET /admin/leads"`. Kept as a plain string so a slice can
 * add an entry in one line.
 */
export type RoutePattern = string;

/**
 * The registry. **P0 ships ONE real surface — leads.** Later slices (dashboard,
 * billing, sites, analytics, …) each add their own typed fixture module + a line here.
 */
export const FIXTURES: Readonly<Record<RoutePattern, FixtureFactory>> = {
  'GET /admin/leads': leadsFixture as FixtureFactory,
  'GET /sites': sitesFixture as FixtureFactory,
  'GET /billing/subscription': subscriptionFixture as FixtureFactory,
  'GET /billing/entitlements': entitlementsFixture as FixtureFactory,
  'GET /wallet': walletFixture as FixtureFactory,
  'GET /admin/domains/summary': domainsSummaryFixture as FixtureFactory,
  'GET /auth/me': meFixture as FixtureFactory,
};

/**
 * Normalize a request method + URL to the registry key + its parsed query. Strips
 * the origin, the leading `/api` prefix, a trailing slash, and the query string, so
 * `GET https://host/api/admin/leads?offset=50` → `{ key: 'GET /admin/leads', query }`.
 * Falls back to the raw pathname when there's no `/api` prefix (same-origin SPA asset
 * routes aren't in the registry, so they simply won't match → pass through).
 */
export function toRegistryKey(
  method: string,
  url: string,
): { key: RoutePattern; query: URLSearchParams } {
  // Resolve relative URLs against a dummy base so `new URL` always parses.
  const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  let pathname: string;
  let query: URLSearchParams;
  try {
    const parsed = new URL(url, base);
    pathname = parsed.pathname;
    query = parsed.searchParams;
  } catch {
    // Degenerate URL — treat the whole thing as the path, no query.
    const qIdx = url.indexOf('?');
    pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    query = new URLSearchParams(qIdx === -1 ? '' : url.slice(qIdx + 1));
  }
  // Drop the `/api` prefix the ApiService adds, and any trailing slash.
  let path = pathname.replace(/^\/api(?=\/|$)/, '');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '') path = '/';
  return { key: `${method.toUpperCase()} ${path}`, query };
}

/** Look up a fixture factory for a normalized registry key, or `undefined`. */
export function findFixture(key: RoutePattern): FixtureFactory | undefined {
  return FIXTURES[key];
}
