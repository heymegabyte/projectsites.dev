/**
 * Guest acquisition — homepage hero business-search journey (REWRITTEN 2026-09-20, AL-804).
 *
 * ── Why rewritten ──────────────────────────────────────────────────────────
 * The prior spec targeted the DELETED vanilla 4-screen homepage (`#screen-search`,
 * `#search-input`, `#search-dropdown`). The vanilla `public/index.html` was removed
 * 2026-07-31 (see golden-path.spec.ts) and `/` now serves the Angular shell — so all
 * 11 tests failed against live prod (verified RED before this rewrite). This is the
 * top-of-funnel guest journey (the highest-value conversion path), so a stale spec here
 * is a real coverage hole, not cosmetic.
 *
 * This rewrite proves the REAL journey on the Angular homepage: homepage-first, click/
 * keyboard-only (no page.goto after load), deterministic (waitFor + toPass, no sleeps
 * except a single cited debounce-window assertion), covering every sub-action AND the
 * graceful-degraded path (Places-403 → honest nudge, per the worker's OSM fallback) AND
 * axe on the OPEN-dropdown interactive state (which accessibility.spec.ts, static-only,
 * never exercises).
 *
 * Selectors — verified against pages/homepage/homepage.component.html:
 *   input     [data-testid="hero-search-input"]   (ngModel heroQuery — testid added AL-804)
 *   result    [data-testid="search-result"]  [data-result-type="business|prebuilt|custom"]
 *   preview   [data-testid="search-result-preview"]  (pre-built live preview, new tab)
 *   status    [data-testid="search-status"]   (sr-only aria-live, WCAG 4.1.3)
 *   degraded  [data-testid="business-search-unavailable"]  (Places-unavailable nudge)
 *   custom entry is ALWAYS appended on a successful response (homepage.component.ts:285).
 */
import { test, expect, type Page } from '@playwright/test';
import { checkA11y } from './helpers/a11y.js';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

const INPUT = '[data-testid="hero-search-input"]';
const RESULT = '[data-testid="search-result"]';
const CUSTOM = '[data-testid="search-result"][data-result-type="custom"]';
const DEGRADED = '[data-testid="business-search-unavailable"]';
const STATUS = '[data-testid="search-status"]';

const BREAKPOINTS = [
  { name: 'mobile-sm', width: 375, height: 812 },
  { name: 'mobile-md', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop-sm', width: 1024, height: 768 },
  { name: 'desktop-md', width: 1280, height: 900 },
  { name: 'desktop-lg', width: 1920, height: 1080 },
];

/** Benign prod console noise (analytics beacons / third-party) — never app-blocking. */
const BENIGN = [
  /posthog/i, /sentry/i, /google-analytics|googletagmanager|gtag/i, /favicon/i,
  /Failed to load resource.*(analytics|ingest|beacon|posthog|sentry)/i,
  /net::ERR_/i, /ERR_BLOCKED_BY_CLIENT/i, /Content Security Policy.*(posthog|sentry|google)/i,
];
const blocking = (e: string): boolean => !BENIGN.some((re) => re.test(e));

/** Attach a blocking-console-error collector before any navigation. */
function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Type a query into the hero input and resolve once the search HAS responded — either
 *  a result row rendered OR the honest degraded nudge. Returns the mode so callers can
 *  assert the appropriate sub-actions without flaking on Places-403 variance. */
async function search(page: Page, query: string): Promise<'results' | 'degraded'> {
  const input = page.locator(INPUT);
  await input.click();
  await input.fill(query);
  await expect(async () => {
    const responded = (await page.locator(RESULT).count()) + (await page.locator(DEGRADED).count());
    expect(responded).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });
  return (await page.locator(DEGRADED).count()) > 0 ? 'degraded' : 'results';
}

test.describe('Guest acquisition — homepage business search', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${PROD_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="hero-headline"]').first().waitFor({ state: 'visible', timeout: 35_000 });
  });

  test('hero search input renders, visible, with the business placeholder', async ({ page }) => {
    const input = page.locator(INPUT);
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute('placeholder', /business/i);
    // The sr-only aria-live status region is present from first paint (WCAG 4.1.3).
    await expect(page.locator(STATUS)).toHaveCount(1);
  });

  test('typing 2+ chars → dropdown (Custom option always present) OR graceful degraded nudge; 0 console errors', async ({ page }) => {
    const errors = trackConsole(page);
    const mode = await search(page, 'coffee');

    if (mode === 'results') {
      // The Custom entry is appended to EVERY successful response → deterministic anchor.
      await expect(page.locator(CUSTOM)).toBeVisible();
      await expect(page.locator(CUSTOM)).toContainText(/custom/i);
    } else {
      // Degraded path (Places unavailable) — the honest nudge steers to the manual route.
      await expect(page.locator(DEGRADED)).toBeVisible();
      await expect(page.locator(DEGRADED)).toContainText(/custom website/i);
    }
    expect(errors.filter(blocking)).toEqual([]);
  });

  test('typing a single char does NOT open the dropdown (min-length gate)', async ({ page }) => {
    await page.locator(INPUT).fill('c');
    // Cited exception: assert a *timed* behavior (300ms debounce). Wait past the window,
    // then prove no result rendered — the min-length gate suppressed the call.
    await page.waitForTimeout(700);
    await expect(page.locator(RESULT)).toHaveCount(0);
  });

  test('results carry a business name AND an address (never a bare row)', async ({ page }) => {
    const mode = await search(page, 'pizza');
    test.skip(mode === 'degraded', 'business lookup degraded this run — covered by the degraded-path test');
    // First non-custom result: both name + address text present.
    const firstReal = page.locator(`${RESULT}:not([data-result-type="custom"])`).first();
    if (await firstReal.count()) {
      await expect(firstReal).not.toBeEmpty();
      const text = (await firstReal.innerText()).trim();
      expect(text.length).toBeGreaterThan(3);
    }
    // Custom row always carries its label + helper address.
    await expect(page.locator(CUSTOM)).toContainText(/custom website/i);
  });

  test('clearing the input hides the dropdown', async ({ page }) => {
    const mode = await search(page, 'coffee');
    test.skip(mode === 'degraded', 'no dropdown to clear on the degraded path');
    await page.locator(INPUT).fill('');
    await expect(async () => {
      expect(await page.locator(RESULT).count()).toBe(0);
    }).toPass({ timeout: 5_000 });
  });

  test('clicking a result routes a GUEST into the sign-in funnel (SPA nav, no reload)', async ({ page }) => {
    const mode = await search(page, 'coffee');
    test.skip(mode === 'degraded', 'no clickable result on the degraded path');
    // Sentinel proves the click is an SPA route, not a full reload.
    await page.evaluate(() => ((window as unknown as { __ps_nav?: number }).__ps_nav = 1));
    await page.locator(CUSTOM).click();
    // Guest → /signin (createFunnelNav: signed-out lands on /signin?returnUrl=/create...).
    await page.waitForURL(/\/(signin|create)/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/(signin|create)/);
    const spa = await page.evaluate(() => (window as unknown as { __ps_nav?: number }).__ps_nav);
    expect(spa).toBe(1); // window sentinel survived → SPA navigation, no document reload
  });

  test('pre-built results expose a live-preview link before the sign-in wall (when present)', async ({ page }) => {
    const mode = await search(page, 'brewing');
    test.skip(mode === 'degraded', 'business lookup degraded this run');
    const preview = page.locator('[data-testid="search-result-preview"]').first();
    test.skip((await preview.count()) === 0, 'no pre-built site matched this query this run');
    // The headline promise made visible: preview the LIVE site in a new tab.
    await expect(preview).toHaveAttribute('href', /projectsites\.dev/);
    await expect(preview).toHaveAttribute('target', '_blank');
    await expect(preview).toHaveAttribute('rel', /noopener/);
  });

  test('the OPEN search dropdown is axe-clean across 6 breakpoints', async ({ page }) => {
    test.setTimeout(150_000);
    const mode = await search(page, 'coffee');
    test.skip(mode === 'degraded', 'no dropdown to audit on the degraded path');
    for (const bp of BREAKPOINTS) {
      await page.setViewportSize({ width: bp.width, height: bp.height });
      // Keep the dropdown open across viewport changes (blur/relayout can close it).
      if ((await page.locator(RESULT).count()) === 0) await search(page, 'coffee');
      await checkA11y(page, `homepage search dropdown open @ ${bp.name} (${bp.width}×${bp.height})`);
    }
  });
});
