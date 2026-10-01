import { resilientGet } from './helpers/api-request.js';
import { test, expect } from '@playwright/test';

/**
 * Build Metrics (`build_metrics` flag) — super-admin generation speed + cost
 * rollup contract. Request-level checks against the config baseURL (local mock
 * `scripts/e2e_server.cjs` or prod).
 *
 * The endpoint is triple-gated: auth required (401) → `build_metrics` flag
 * (404, never 403 — no existence leak) → super-admin (403). This spec proves
 * the PUBLIC contract: an anonymous caller is NEVER served the metrics rollup
 * (no auth → no data), and a bogus path under the namespace does not soft-200.
 * The 404-when-flag-off + 200-for-super-admin + aggregation math are locked by
 * the worker Jest suite (`src/__tests__/admin_build_metrics_route.test.ts`),
 * which runs the real percentile SQL against SQLite.
 */
const ENDPOINT = '/api/admin/build-metrics/summary';

test.describe('Build Metrics — summary endpoint gate', () => {
  test('never serves the rollup to an unauthenticated caller', async ({ request }) => {
    const res = await resilientGet(request, ENDPOINT);
    // Auth runs first → 401. (A flag-off or non-admin origin returns 404/403;
    // the one status that must NEVER appear anonymously is 200 with metrics.)
    expect([401, 403, 404]).toContain(res.status());
    expect(res.status()).not.toBe(200);
  });

  test('an invalid days window is rejected or gated — never a 200 with bad input', async ({
    request,
  }) => {
    const res = await resilientGet(request, `${ENDPOINT}?days=abc`);
    // Without a super-admin session the gate (401/404/403) short-circuits
    // before validation; with one it would be a 400. Either way: not a 200.
    expect([400, 401, 403, 404]).toContain(res.status());
    expect(res.status()).not.toBe(200);
  });
});
