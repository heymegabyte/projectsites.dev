import { test } from '@playwright/test';

/**
 * Whole-Site Crawl — browser E2E home (placeholder, CRAWL-0).
 *
 * CRAWL-0 is the provider-independent FOUNDATION: Zod domain types + a CrawlProvider port +
 * a Cloudflare STUB. There is NO route, UI, or reachable surface yet (flag `site_crawl` is
 * DARK), so there is nothing to drive in a real browser. The domain is unit-covered in
 * `libs/features/site_crawl/__tests__/schemas.spec.ts`.
 *
 * These journeys light up in CRAWL-1..4 when routes/workflow/persistence land:
 *   - start a crawl from the admin UI → poll status → see the coverage report
 *   - dark-flag 404 of every crawl route while `site_crawl` is off (never 403)
 *   - seed a crawled site's normalized pages into a generated build
 */
test.describe.skip('site_crawl — whole-site crawl (routes land in CRAWL-1)', () => {
  test('placeholder — CRAWL-0 is types + provider stub only (no reachable surface)', () => {
    // Intentionally empty: no route exists yet. See the module unit tests for CRAWL-0 coverage.
  });
});
