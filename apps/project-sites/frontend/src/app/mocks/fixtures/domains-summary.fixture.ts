/**
 * @module mocks/fixtures/domains-summary
 *
 * @description
 * Mock fixture for the domain-summary read (`GET /api/admin/domains/summary`) — the third
 * read {@link import('../../pages/admin/admin-state.service').AdminStateService} forkJoins
 * in `loadData` (with the sites roster, subscription + `/auth/me`) to hydrate the shell.
 *
 * Typed to the EXACT WORKER WIRE shape — `{ data: { total, by_status: { active, pending,
 * verification_failed }, by_type: { free_subdomain, custom_cname } } }` (see
 * `hostnames/handlers.ts`) — NOT the lossier frontend `DomainSummary` type. The fixture
 * mirrors what the REAL endpoint puts on the wire, so wiring it is a provider SWAP.
 *
 * @remarks
 * - The real handler's schema is "flat-with-nesting" (a top-line `total` + a `by_status`
 *   breakdown grid), so the fixture reproduces both — a consumer can read either.
 * - `populated` keeps the buckets internally consistent: `active + pending +
 *   verification_failed === total` AND `free_subdomain + custom_cname === total`, with a
 *   non-zero in every bucket so the summary grid renders real variety.
 * - `state` variants: `empty` (all-zero — the honest no-domains state), `error`
 *   (interceptor throws a 500 before this runs), `populated`/`loading` → the mix.
 */
import type { FixtureFactory, MockState } from './index';

/** `GET /api/admin/domains/summary` worker-wire envelope. */
export interface DomainsSummaryResponse {
  data: {
    total: number;
    by_status: {
      active: number;
      pending: number;
      verification_failed: number;
    };
    by_type: {
      free_subdomain: number;
      custom_cname: number;
    };
  };
}

/**
 * Domain-summary factory. `empty` → all-zero counts (no domains yet); `error` is handled
 * by the interceptor; `populated`/`loading`/default → a consistent believable mix
 * (6 active + 2 pending + 1 failed = 9 total; 7 free subdomains + 2 custom = 9 total).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const domainsSummaryFixture: FixtureFactory<DomainsSummaryResponse> = (
  state: MockState,
): DomainsSummaryResponse => {
  if (state === 'empty') {
    return {
      data: {
        total: 0,
        by_status: { active: 0, pending: 0, verification_failed: 0 },
        by_type: { free_subdomain: 0, custom_cname: 0 },
      },
    };
  }
  return {
    data: {
      total: 9,
      by_status: { active: 6, pending: 2, verification_failed: 1 },
      by_type: { free_subdomain: 7, custom_cname: 2 },
    },
  };
};
