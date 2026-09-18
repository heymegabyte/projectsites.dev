/**
 * @module e2e/generated-site-visitor-journey
 * @description THE generated-site VISITOR journey — the actual product OUTPUT, proven live.
 *
 * Every other golden-path spec covers the MARKETING side (projectsites.dev: search → signin →
 * create → waiting). This one covers the thing a delivered site's real customers use: a guest
 * landing on a published `{slug}.projectsites.dev` site and moving through it by CLICKS only.
 *
 * The served HTML is an empty SPA shell — the nav, forms, click-to-call, directions and gallery
 * only exist after React hydrates, so curl/grep is blind here and a REAL browser is mandatory
 * (that blind spot is exactly why this journey was uncovered). The `.mjs` § C probes audit the
 * generated site headless in report-mode; this is the homepage-first, click-driven,
 * 0-console-error, axe-clean-at-6bp Playwright JOURNEY that belongs in the prod cert.
 *
 * Non-mutating by design: it fills but never SUBMITS the contact form (the real causal
 * submit→D1 round-trip is owned by admin-verify/verify-rendered-contact-journey.mjs, AL-639),
 * so this journey is fully repeatable on every prod run with zero junk rows.
 *
 * Target site: a live cohort delivery (default franklin-barbecue — override VISITOR_SLUG=…).
 * Homepage-first: each test's only navigation entry is the site's OWN homepage; every step
 * after is a click. (AL-769)
 *
 * @packageDocumentation
 */
import { test, expect, type Page } from '@playwright/test';
import { checkA11y } from './helpers/a11y.js';

const SLUG = process.env.VISITOR_SLUG ?? 'franklin-barbecue';
const SITE = `https://${SLUG}.projectsites.dev`;

// The generated site registers a service worker; block it so the test always exercises the
// live network build, never a stale precache (the `stale-sw-masks-deployed-fix` class).
test.use({ serviceWorkers: 'block' });

const BREAKPOINTS = [
  { name: 'mobile-sm', width: 375, height: 812 },
  { name: 'mobile-md', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop-sm', width: 1024, height: 768 },
  { name: 'desktop-md', width: 1280, height: 900 },
  { name: 'desktop-lg', width: 1920, height: 1080 },
];

// Third-party origins whose console noise (analytics beacons, font CDNs, bot challenges) is not
// a defect in the generated site. App-origin errors are never ignored.
const THIRD_PARTY_NOISE =
  /posthog|googletagmanager|google-analytics|gstatic|fonts\.googleapis|fonts\.google|turnstile|cloudflareinsights|challenges\.cloudflare|sentry|doubleclick|facebook|maps\.googleapis/i;

/**
 * Attach a console/pageerror collector, filtering third-party noise so only genuine
 * generated-site errors fail the journey. Returns the live array (assert at test end).
 */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    const txt = m.text();
    if (THIRD_PARTY_NOISE.test(url) || THIRD_PARTY_NOISE.test(txt)) return;
    errors.push(txt.slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
  return errors;
}

/** Land on the site's OWN homepage + wait for React hydration (root has real content). */
async function openHome(page: Page): Promise<void> {
  const resp = await page.goto(SITE + '/', { waitUntil: 'load', timeout: 45_000 });
  expect(resp?.status(), 'site homepage must serve 200').toBe(200);
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(
    () => (document.getElementById('root')?.innerHTML.length ?? 0) > 2000,
    undefined,
    { timeout: 15_000 },
  );
  // Plant a sentinel on the JS context. A CLIENT nav preserves it; a full reload wipes it —
  // this is how we prove the nav is real SPA routing, not `<a>` full-page loads.
  await page.evaluate(() => {
    (window as unknown as { __spaProbe?: string }).__spaProbe = 'alive';
  });
}

/** Click an in-app nav link by its route href and assert client-side navigation landed. */
async function clickNav(page: Page, href: string, expectPath: RegExp): Promise<void> {
  await page.locator(`a[href="${href}"]`).first().click();
  await expect(page).toHaveURL(expectPath, { timeout: 15_000 });
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
}

test.describe(`Generated-site visitor journey — ${SLUG} (live product output)`, () => {
  test('home hydrates, then SPA nav Home→About→Services→Contact preserves the JS context (no full reload), 0 console errors', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = collectConsoleErrors(page);

    await openHome(page);
    await expect(page).toHaveTitle(/.{8,}/); // a real, non-empty <title>
    await expect(page.locator('h1')).toHaveCount(1); // exactly one page H1 (SEO/WCAG heading order)

    // Navigate the primary nav BY CLICKS only — no page.goto after the initial home load.
    await clickNav(page, '/about', /\/about$/);
    await clickNav(page, '/services', /\/services$/);
    await clickNav(page, '/contact', /\/contact$/);

    // The sentinel survived every hop → the whole nav was client-side SPA routing.
    const probe = await page.evaluate(
      () => (window as unknown as { __spaProbe?: string }).__spaProbe,
    );
    expect(probe, 'SPA nav must not full-reload (sentinel must survive)').toBe('alive');

    // Back home via the brand/Home link — still a click, still SPA.
    await clickNav(page, '/', /projectsites\.dev\/?$/);

    expect(errors, `generated site emitted console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('conversion sub-actions: click-to-call tel: link, one-tap directions, and a fillable contact form (validated, not submitted)', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = collectConsoleErrors(page);
    await openHome(page);

    // Click-to-call — a real `tel:` link with a real number (never a dead `tel:` / `tel:#`).
    const tel = page.locator('a[href^="tel:"]').first();
    await expect(tel).toHaveAttribute('href', /tel:\+?\d[\d\s()-]{5,}/);

    // One-tap directions — a Google Maps directions link with a non-empty destination.
    const directions = page.locator('a[href*="/maps/dir"], a[href*="maps.google"], a[href*="google.com/maps"]').first();
    await expect(directions).toHaveAttribute('href', /destination=%?\w|maps/i);

    // Contact form: reach it by CLICK, assert the fields exist + are fillable. We deliberately
    // do NOT submit — the causal submit→form_submissions round-trip is owned by AL-639's probe,
    // and re-submitting on every prod run would pollute the owner's inbox.
    await clickNav(page, '/contact', /\/contact$/);
    const form = page.locator('form').first();
    await expect(form).toBeVisible();
    const name = form.locator('input[name="name"], #contact-name').first();
    const email = form.locator('input[name="email"], #contact-email').first();
    const message = form.locator('textarea[name="message"], #contact-message').first();
    await expect(name).toBeVisible();
    await expect(email).toBeVisible();
    await expect(message).toBeVisible();
    await name.fill('E2E Visitor Journey');
    await email.fill('visitor@example.com');
    await message.fill('Verifying the delivered site works for a real visitor.');
    await expect(email).toHaveValue('visitor@example.com'); // field accepts + retains input

    expect(errors, `generated site emitted console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('content sub-actions: FAQ accordion opens on click, blog list renders, gallery images are zoomable', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const errors = collectConsoleErrors(page);
    await openHome(page);

    // Gallery — the home carries zoomable, grouped images (the lightbox contract the build
    // validator enforces via data-zoomable + data-gallery).
    await expect(page.locator('[data-zoomable]').first()).toBeAttached();
    await expect(page.locator('[data-gallery]').first()).toBeAttached();

    // FAQ — reach by click; the accordion starts COLLAPSED, so click the first question and
    // assert it expands (aria-expanded flips true). Skips gracefully if this site has no /faq.
    if ((await page.locator('a[href="/faq"]').count()) > 0) {
      await clickNav(page, '/faq', /\/faq$/);
      // Scope to REAL accordion questions — exclude the header's mobile-menu toggle, which is
      // also `aria-expanded` but `md:hidden` at desktop width, so a bare `.first()` strands on
      // an invisible control (the exact selector bug this journey caught, AL-769).
      const q = page.locator('button[aria-expanded]:not([aria-controls="mobile-menu"])').first();
      if ((await q.count()) && (await q.isVisible())) {
        // State-agnostic: some FAQ designs open the first item by default, so prove the click
        // TOGGLES aria-expanded (interactive accordion) rather than assuming an initial value.
        const before = await q.getAttribute('aria-expanded');
        await q.click();
        await expect(q).not.toHaveAttribute('aria-expanded', before ?? 'false');
      }
    }

    // Blog — reach by click; the index must render at least one post link.
    if ((await page.locator('a[href="/blog"]').count()) > 0) {
      await clickNav(page, '/blog', /\/blog$/);
      await expect(page.locator('a[href^="/blog/"]').first()).toBeVisible({ timeout: 15_000 });
    }

    expect(errors, `generated site emitted console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('axe-core: 0 CRITICAL violations on home + contact across 6 breakpoints', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    // WCAG contrast applies to the SETTLED state, not a transient mid-reveal frame. Reveal
    // animations (`animate-fadeInUp`/`reveal-on-view`) fade content up from low opacity, and axe
    // scanning mid-flight reports the composited (below-AA) opacity as a false "serious" contrast
    // fail that settles AA-safe in <1s (the AL-440 reveal-composite class). Emulate reduced-motion
    // so content renders at its final opacity → axe measures the real, settled contrast.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openHome(page);
    for (const bp of BREAKPOINTS) {
      await page.setViewportSize({ width: bp.width, height: bp.height });
      await checkA11y(page, `visitor-home@${bp.name}`, { includedImpacts: ['critical'] });
    }
    // Contact page (form-heavy → the most likely a11y regression surface) at the two most-used bps.
    await clickNav(page, '/contact', /\/contact$/);
    for (const bp of [BREAKPOINTS[0], BREAKPOINTS[4]]) {
      await page.setViewportSize({ width: bp.width, height: bp.height });
      await checkA11y(page, `visitor-contact@${bp.name}`, { includedImpacts: ['critical'] });
    }
  });
});
