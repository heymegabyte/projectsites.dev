/**
 * Build-progress /waiting flow — post-create terminal + graceful load-error (REWRITTEN 2026-09-20, AL-827).
 *
 * ── Why rewritten ──────────────────────────────────────────────────────────
 * The prior spec targeted the DELETED vanilla waiting screen (`#screen-waiting`, `navigateTo`,
 * `updateWaitingScreen` globals). The vanilla `public/index.html` was removed 2026-07-31; `/waiting`
 * is now a real Angular route. All 13 tests were prod-RED (dead selectors) — kept false-green only
 * by the stale `sites-staging.megabyte.space` CI shard (the AL-804/826 mock-only-phantom class).
 *
 * ── What this proves + the break it fixed ─────────────────────────────────
 * The build-status poll (`getSite`+`getSiteLogs` every 3s) is auth-gated. Before AL-827 its error
 * handler was a bare retry-only no-op — so a 401 (expired session, or an unauth visitor on a shared
 * `/waiting?id=` link) left the owner staring at a FAKE "Building your website" overlay + a progress
 * bar that never moved, forever, with a 401 in the console and no way out (`/waiting` isn't in
 * ApiService's protected-route 401→/signin list). Root-fixed: after 2 never-loaded ticks the flow
 * degrades to a graceful "We couldn't load your build — sign in" card (`shouldDegradeToLoadError`,
 * unit-tested). This spec proves that live, homepage-adjacent, headless, on prod.
 *
 * Selectors — pages/waiting/waiting.component.html:
 *   [data-testid="waiting-load-error"] · [data-testid="waiting-signin"] · [data-testid="build-overlay"]
 *   [data-testid="waiting-live-url"] (published terminal, authed — out of unauth scope)
 */
import { test, expect, type Page } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
// A real published site id (org-brian-001) — a valid target whose status poll still 401s for an
// UNAUTH caller, exercising the exact expired-session / shared-link degrade path.
const REAL_ID = '300e3992-8c5d-46cf-8751-388f5519dee5';
const REAL_SLUG = 'tree-house-brewing-charlton';

/** The 401 that TRIGGERS the graceful degrade is expected + handled — not an app fault. */
const BENIGN = [/401/, /Failed to load resource/i, /net::ERR_/i, /posthog|sentry|analytics|gtag/i, /favicon/i];
const blocking = (e: string): boolean => !BENIGN.some((re) => re.test(e));
function trackErrors(page: Page): string[] {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e))); // uncaught JS = always blocking
  return errs;
}

test.describe('Build-progress /waiting flow', () => {
  test('no site id → gracefully redirects to the homepage (never a blank/stuck screen)', async ({ page }) => {
    await page.goto(`${PROD_URL}/waiting`, { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(/projectsites\.dev\/?($|\?)/, { timeout: 10_000 });
    await expect(page.locator('[data-testid="hero-headline"]').first()).toBeVisible({ timeout: 20_000 });
  });

  test('unauth visitor on a real /waiting?id= link degrades to the graceful sign-in card (NOT a perpetual fake overlay)', async ({ page }) => {
    const errs = trackErrors(page);
    await page.goto(`${PROD_URL}/waiting?id=${REAL_ID}&slug=${REAL_SLUG}`, { waitUntil: 'domcontentloaded' });

    // Within ~2 failed poll ticks (~6s) the fake overlay is replaced by the graceful card.
    await expect(page.locator('[data-testid="waiting-load-error"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="build-overlay"]')).toHaveCount(0); // the fake overlay is GONE
    await expect(page.locator('[data-testid="waiting-load-error"]')).toContainText(/sign in|couldn.t load/i);

    // No UNCAUGHT JS error crept in (the triggering 401 network error is expected + handled).
    expect(errs.filter(blocking)).toEqual([]);
  });

  test('the load-error card offers a working sign-in path that returns to THIS build', async ({ page }) => {
    await page.goto(`${PROD_URL}/waiting?id=${REAL_ID}&slug=${REAL_SLUG}`, { waitUntil: 'domcontentloaded' });
    const signIn = page.locator('[data-testid="waiting-signin"]');
    await expect(signIn).toBeVisible({ timeout: 20_000 });
    await signIn.click();
    // SPA-routes to /signin carrying a returnUrl back to this waiting build (no full reload).
    await page.waitForURL(/\/signin/, { timeout: 10_000 });
    expect(decodeURIComponent(page.url())).toContain('/waiting?id=' + REAL_ID);
  });

  test('the load-error card "Go home" returns to the homepage', async ({ page }) => {
    await page.goto(`${PROD_URL}/waiting?id=${REAL_ID}&slug=${REAL_SLUG}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="waiting-load-error"]')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /go home/i }).click();
    await expect(page.locator('[data-testid="hero-headline"]').first()).toBeVisible({ timeout: 15_000 });
  });
});
