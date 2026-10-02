/**
 * E2E placeholder for the `eager_site_d1` feature flag (fire-72).
 *
 * The flag is DARK (stage=experimental, enabled=0): eager per-site D1 provisioning on
 * site create-from-search is gated OFF in prod, so there is no live behavior to assert
 * yet. This spec is skipped until the flag is promoted; promoting it unskips + fills the
 * steps below. It exists so the `e2e_tests` reference in
 * `src/modules/feature_flags/docs.ts` resolves (interconnectedness — no dangling path).
 */
import { test } from '@playwright/test';

test.describe('eager_site_d1 (dark flag — unskip on promotion)', () => {
  test.skip('create-from-search eagerly provisions the per-site D1 when the flag is on', async () => {
    // On promotion: create a site from search, assert the per-site D1 allocation row
    // exists immediately (before any Data-tab GET), and that create still SUCCEEDS when
    // provisioning throws (fail-soft fallback to lazy provisioning).
  });
});
