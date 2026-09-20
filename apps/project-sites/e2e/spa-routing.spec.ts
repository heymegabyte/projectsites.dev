/**
 * SPA routing — platform legal/marketing routes + footer SPA-nav (REWRITTEN 2026-09-20, AL-830).
 *
 * ── Why rewritten ──────────────────────────────────────────────────────────
 * The prior spec targeted the DELETED vanilla homepage (`#screen-search .active`, `.footer-bottom`,
 * `#contact-section`/`#contact-form`) and described the routes as "Astro-generated" — both wrong
 * since the 2026-07-31 Angular migration. Its route checks were also soft-404-BLIND (`status < 500`
 * passes a 200 SPA-shell served for a non-route). Kept false-green only by the stale
 * `sites-staging.megabyte.space` CI shard (the AL-804/826/827 mock-only-phantom class).
 *
 * This rewrite proves the REAL platform routing on the Angular shell: homepage-first, footer legal
 * links SPA-navigate (no full reload), each legal/marketing route renders its real H1, and — the gap
 * the old spec missed — a bogus route returns a real 404 STATUS (soft-404 doctrine), not a 200 shell.
 *
 * Selectors verified live: footer `a[href="/privacy|/terms|/content"]`; route H1s
 * "Privacy Policy" / "Terms of Service" / "Content Policy"; worker soft-404 → 404 on unknown paths.
 */
import { test, expect, type Page } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

const BENIGN = [/posthog|sentry|analytics|gtag/i, /favicon/i, /Failed to load resource.*(analytics|ingest|beacon)/i, /net::ERR_/i, /ERR_BLOCKED_BY_CLIENT/i];
const blocking = (e: string): boolean => !BENIGN.some((re) => re.test(e));
function trackConsole(page: Page): string[] {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + String(e)));
  return errs;
}

const LEGAL = [
  { href: '/privacy', h1: /privacy policy/i, text: /Privacy Policy/i },
  { href: '/terms', h1: /terms of service/i, text: /Terms of Service/i },
  { href: '/content', h1: /content policy/i, text: /Content Policy/i },
];

test.describe('SPA routing — footer legal links navigate (homepage-first, no reload)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${PROD_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="hero-headline"]').first().waitFor({ state: 'visible', timeout: 35_000 });
  });

  for (const { href, h1, text } of LEGAL) {
    test(`footer "${text.source}" link → SPA-navigates to ${href} + renders its H1 (no full reload)`, async ({ page }) => {
      const errs = trackConsole(page);
      const link = page.locator(`footer a[href="${href}"]`).first();
      await expect(link).toBeVisible();
      // Sentinel proves the click is an SPA route, not a document reload.
      await page.evaluate(() => ((window as unknown as { __ps?: number }).__ps = 1));
      await link.scrollIntoViewIfNeeded();
      await link.click();
      await page.waitForURL(new RegExp(`${href}$`), { timeout: 10_000 });
      await expect(page.locator('h1').filter({ hasText: h1 }).first()).toBeVisible({ timeout: 20_000 });
      expect(await page.evaluate(() => (window as unknown as { __ps?: number }).__ps)).toBe(1); // no reload
      expect(errs.filter(blocking)).toEqual([]);
    });
  }
});

test.describe('SPA routing — direct-URL routes + soft-404 doctrine', () => {
  for (const { href, h1 } of LEGAL) {
    test(`direct GET ${href} → 200 + real H1 (not a soft-404 shell)`, async ({ page }) => {
      const res = await page.goto(`${PROD_URL}${href}`, { waitUntil: 'domcontentloaded' });
      expect(res?.status()).toBe(200);
      await expect(page.locator('h1').filter({ hasText: h1 }).first()).toBeVisible({ timeout: 25_000 });
    });
  }

  test('an unknown HTML path returns a REAL 404 status (soft-404 gate the old status<500 check missed)', async ({ page }) => {
    const res = await page.goto(`${PROD_URL}/this-is-definitely-not-a-route-al830`, { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBe(404); // NOT a 200 SPA-shell soft-404
  });

  test('a real known route still 200s (the soft-404 gate never false-404s a real page)', async ({ page }) => {
    const res = await page.goto(`${PROD_URL}/pricing`, { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBe(200);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 25_000 });
  });
});
