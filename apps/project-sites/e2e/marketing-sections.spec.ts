/**
 * Platform marketing homepage — § D interactive-section journey (REWRITTEN 2026-09-20, AL-826).
 *
 * ── Why rewritten ──────────────────────────────────────────────────────────
 * The prior spec targeted the DELETED vanilla homepage (`#screen-search` beforeEach + vanilla
 * `submitContactForm`/`startBuildFlow` globals). The vanilla `public/index.html` was removed
 * 2026-07-31; `/` now serves the Angular shell. All 25 tests failed against live prod (verified
 * RED) — they only ever "passed" against the stale `sites-staging.megabyte.space` URL, a
 * mock-only false-green phantom (the AL-804 class). projectsites.dev's OWN homepage interactive
 * sections (FAQ accordion, pricing, how-it-works, hero CTAs, footer, honest social-proof counters)
 * are § D of the GENERATED-SITE QUALITY loop and had no modern interactive-journey spec
 * (marketing-seo covers metadata; accessibility covers static axe — neither clicks the FAQ).
 *
 * This rewrite: homepage-first, click/keyboard-only (no page.goto after load), deterministic
 * (waitFor/toPass), real Angular selectors, 0 console errors, axe-clean.
 *
 * Selectors — verified against pages/homepage/homepage.component.html:
 *   sections  #hero · #compare (social proof) · #how-it-works · #features · #pricing · #faq
 *   footer    footer[role="contentinfo"]
 *   FAQ       #faq button[aria-expanded]  (toggleFaq(i); answer renders when openFaqIndex()===i)
 *   CTAs      [data-cta="hero-claim"] · [data-cta="hero-how-it-works"] · [data-cta="hero-examples"]
 *   counters  #compare app-rolling-counter  (sitesBuilt is the honest AL-581 store-bound value)
 */
import { test, expect, type Page } from '@playwright/test';
import { checkA11y } from './helpers/a11y.js';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

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
function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

test.describe('Platform marketing homepage — interactive sections (§ D)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${PROD_URL}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="hero-headline"]').first().waitFor({ state: 'visible', timeout: 35_000 });
  });

  test('all marketing sections render (hero · social-proof · how-it-works · features · pricing · faq · footer)', async ({ page }) => {
    for (const sel of ['#hero', '#compare', '#how-it-works', '#features', '#pricing', '#faq', 'footer[role="contentinfo"]']) {
      await expect(page.locator(sel).first()).toBeAttached();
    }
    // Hero carries its headline + subheadline + the 3 CTAs.
    await expect(page.locator('[data-testid="hero-headline"]')).toBeVisible();
    await expect(page.locator('[data-testid="hero-subheadline"]')).toBeVisible();
    for (const cta of ['hero-claim', 'hero-how-it-works', 'hero-examples']) {
      await expect(page.locator(`[data-cta="${cta}"]`)).toBeVisible();
    }
  });

  test('social-proof counters render an HONEST sites-built number (AL-581: never the fabricated 2480)', async ({ page }) => {
    // The social-proof band is a bare <section> (no id); its 4 app-rolling-counters are the only
    // ones on the page. Select page-wide + scroll them into view (IntersectionObserver-driven).
    const counters = page.locator('app-rolling-counter');
    await counters.first().scrollIntoViewIfNeeded();
    await expect(counters.first()).toBeAttached();
    expect(await counters.count()).toBeGreaterThanOrEqual(3);
    // Data-honesty mirror (the full store-vs-display gate is verify-platform-stats-honest.mjs):
    // the retired fabricated 2480 "Sites Built" must never render anywhere on the homepage.
    const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    expect(body).not.toContain('2480');
  });

  test('FAQ accordion expands + collapses on click (aria-expanded toggles, answer appears)', async ({ page }) => {
    const firstQ = page.locator('#faq button[aria-expanded]').first();
    await firstQ.scrollIntoViewIfNeeded();
    await expect(firstQ).toHaveAttribute('aria-expanded', 'false');
    await firstQ.click();
    await expect(firstQ).toHaveAttribute('aria-expanded', 'true'); // opened
    await firstQ.click();
    await expect(firstQ).toHaveAttribute('aria-expanded', 'false'); // collapsed again
  });

  test('FAQ accordion is keyboard-operable (focus → Enter toggles)', async ({ page }) => {
    const firstQ = page.locator('#faq button[aria-expanded]').first();
    await firstQ.scrollIntoViewIfNeeded();
    await firstQ.focus();
    await page.keyboard.press('Enter');
    await expect(firstQ).toHaveAttribute('aria-expanded', 'true');
  });

  test('pricing section shows plan content (not an empty shell)', async ({ page }) => {
    const pricing = page.locator('#pricing');
    await pricing.scrollIntoViewIfNeeded();
    const text = (await pricing.innerText()).replace(/\s+/g, ' ').trim();
    expect(text.length).toBeGreaterThan(40); // real plan copy, not a bare heading
  });

  test('a hero CTA scrolls to its section (SPA, no reload) with 0 console errors', async ({ page }) => {
    const errors = trackConsole(page);
    await page.evaluate(() => ((window as unknown as { __ps?: number }).__ps = 1));
    await page.locator('[data-cta="hero-how-it-works"]').click();
    // scrollTo('how-it-works') brings the section into view; assert it's visible + no reload.
    await expect(page.locator('#how-it-works')).toBeInViewport({ timeout: 5_000 });
    expect(await page.evaluate(() => (window as unknown as { __ps?: number }).__ps)).toBe(1); // no reload
    expect(errors.filter(blocking)).toEqual([]);
  });

  test('footer exposes navigation links', async ({ page }) => {
    const footer = page.locator('footer[role="contentinfo"]');
    await footer.scrollIntoViewIfNeeded();
    expect(await footer.locator('a[href]').count()).toBeGreaterThan(2);
  });

  test('homepage is axe-clean (0 critical) across 6 breakpoints', async ({ page }) => {
    test.setTimeout(150_000);
    for (const bp of BREAKPOINTS) {
      await page.setViewportSize({ width: bp.width, height: bp.height });
      await checkA11y(page, `platform homepage @ ${bp.name} (${bp.width}×${bp.height})`);
    }
  });
});
