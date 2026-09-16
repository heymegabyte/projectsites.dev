// verify-guest-funnel.mjs — B.1 GUEST ACQUISITION FUNNEL, headless PROD (COMPLETION map § B.1).
//
// The pre-auth funnel a real prospect walks BEFORE sign-in: land on the marketing homepage →
// click the hero CTA (which focuses the search) → search their business → results render (or a
// graceful "lookup unavailable" when Places 403s —
// both are HONEST) → the `/create` entry renders. This is the top of the golden path; if it's
// broken (blank homepage, dead search, console errors, a non-rendering /create) no customer ever
// reaches create→build. The authed continuation (create→build→publish) is the FULL JOURNEY loop;
// the sign-in bridge itself is B.7 (can't complete headless — magic link).
//
// Runs on LOCAL Chromium (verified: `/` + `/create` render with NO CF challenge — they serve the
// SPA shell). Fail-open (E2E_API_KEY not strictly needed — the funnel is unauth — but kept for
// parity + the run-all gate convention). Usage: node e2e/admin-verify/verify-guest-funnel.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// CF challenge + 3rd-party beacon + Places-403 (graceful) noise are not funnel defects.
const IGNORE = /analytics|posthog|ingest|cf-|challenge|beacon|gtm|doubleclick|sentry|clarity|hotjar|places|Failed to load resource.*(analytics|ingest|posthog|maps|places)/i;

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text().slice(0, 110)); });
page.on('pageerror', (e) => { if (!IGNORE.test(String(e))) errs.push('pageerror: ' + String(e).slice(0, 110)); });

const rows = [];
let fails = 0;
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };

try {
  // 1. HOMEPAGE renders (real marketing page, not blank / not a challenge).
  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const home = await page.evaluate(() => {
    const t = document.body.innerText || '';
    const challenge = /just a moment|checking your browser|verify you are human/i.test(t);
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    const searchEl = document.querySelector('#homepage-search, .hero-search-shell input, input[type="search"], input[placeholder*="business" i], input[placeholder*="search" i]');
    return { len: t.length, challenge, h1: h1.slice(0, 60), hasSearch: !!searchEl };
  });
  check('homepage renders', !home.challenge && home.len > 500 && home.h1.length > 0, `h1="${home.h1}" len=${home.len}`);
  check('homepage has a business-search entry', home.hasSearch, home.hasSearch ? 'search input present' : 'NO search input');

  // 1b. The PRIMARY hero CTA a real prospect clicks ("Claim Your Site" → goGetStarted()) must be
  // WIRED. Its contract is to focus the business-search input so the prospect starts the funnel (the
  // guest hero CTA intentionally routes to SEARCH, not straight to /create). The probe used to jump
  // straight to the search box, so a dead primary CTA (handler throws / the #heroSearch ViewChild is
  // null / the button lost its (click)) would strand every prospect on the biggest button on the page
  // while every other check stayed green — a lying-green exactly like the AL-402 degraded-path gap.
  // Click it like a prospect + assert the search receives focus (homepage-first doctrine: click, not goto).
  const heroCta = page.locator('[data-cta="hero-claim"]').first();
  const ctaVisible = await heroCta.isVisible().catch(() => false);
  if (ctaVisible) await heroCta.click().catch(() => {});
  await page.waitForTimeout(500); // focus + (reduced-motion-aware) scroll settle
  const ctaFocusedSearch = await page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a.tagName !== 'INPUT') return false;
    const meta = `${a.getAttribute('placeholder') || ''} ${a.getAttribute('aria-label') || ''}`;
    return /business|search/i.test(meta) || !!a.closest('.hero-search-shell');
  });
  check('primary hero CTA is wired (click "Claim Your Site" → focuses the business-search, not a dead button)',
    ctaVisible && ctaFocusedSearch,
    !ctaVisible ? 'NO [data-cta="hero-claim"] button visible'
      : ctaFocusedSearch ? 'clicked → search focused (funnel entry live)' : 'clicked but search NOT focused (CTA handler dead)');

  // 2. SEARCH is operable — type a business, results render OR a graceful "unavailable" (both honest).
  if (home.hasSearch) {
    const search = page.locator('#homepage-search, .hero-search-shell input, input[type="search"], input[placeholder*="business" i], input[placeholder*="search" i]').first();
    await search.click().catch(() => {});
    // A GUARANTEED-no-match business → deterministically exercises the degraded path (thin/empty
    // results — also the live reality when Places 403s), so the forward-path floor is tested every run.
    await search.fill('Zzqx').catch(() => {});
    await search.pressSequentially(' Nonexistent Test Biz 90210', { delay: 40 }).catch(() => {});
    // CONDITION-BASED wait (NOT a blind timeout — a fixed `waitForTimeout` raced the Places/OSM
    // round-trip, so on a slow lookup the probe read BEFORE the dropdown opened → a flaky FALSE
    // funnel RED; per AL-624 + validator-precision, a flaky funnel signal is worse than none). The
    // search ALWAYS resolves to a forward path — the dropdown's always-present "Build a custom
    // website" row (homepage.component pushes it on every completed search) OR the degraded
    // "unavailable" nudge. Wait for WHICHEVER lands (≤12s); a genuine no-forward-path still falls
    // through to the assertion below and RED's correctly.
    await page
      .waitForFunction(
        () => {
          const hasBuildCta = [...document.querySelectorAll('a,button')].some(
            (e) =>
              e.offsetParent &&
              /build a custom website|enter your (business )?details manually/i.test(e.textContent || ''),
          );
          const unavail =
            /lookup .{0,24}unavailable|temporarily unavailable|enter your (business )?details manually/i.test(
              document.body.innerText || '',
            );
          return hasBuildCta || unavail;
        },
        { timeout: 12000 },
      )
      .catch(() => {});
    const res = await page.evaluate(() => {
      const items = document.querySelectorAll(
        '[role="listbox"] [role="option"], [data-testid*="result"], [data-testid*="business"], .search-result, li[role="option"], div[class*="top-full"] button',
      );
      const bodyTxt = document.body.innerText || '';
      // Match the ACTUAL live degraded copy ("Business lookup is temporarily unavailable — choose
      // 'Build a custom website' below to enter your details manually"), not a stale guess.
      const unavailable = /lookup .{0,24}unavailable|temporarily unavailable|couldn.t (search|reach)|try again|enter your (business )?details manually/i.test(bodyTxt);
      // The forward path is the funnel's OWN manual-build CTA — NOT the ever-present nav "Get Started"
      // (matching the nav would false-green a broken fallback → a real prospect dead-ends). Exclude <nav>.
      const nav = document.querySelector('nav');
      const manualBuildCta = [...document.querySelectorAll('a,button')].some((e) => {
        if (!e.offsetParent || (nav && nav.contains(e))) return false;
        return /build a custom website|enter your (business )?details manually|build (it |from |a custom)|create (a )?(custom |new )?(site|website)|start fresh/i.test(e.textContent || '');
      });
      const searchStatus = (document.querySelector('[data-testid="search-status"]')?.textContent || '').trim();
      return { count: items.length, unavailable, manualBuildCta, searchStatus };
    });
    // Conversion floor: a prospect whose business isn't found MUST get a real path forward — either
    // live results OR the in-funnel manual-build CTA. The nav "Get Started" alone is NOT that path.
    check('degraded search offers a REAL forward path (results OR in-funnel manual-build CTA, not just nav)',
      res.count > 0 || res.manualBuildCta,
      `results=${res.count} unavailable=${res.unavailable} manualBuildCta=${res.manualBuildCta}`);
    // WCAG 4.1.3 (Status Messages, AA): the live-search dropdown populates WITHOUT focus
    // moving into it, so a screen-reader user needs an aria-live status announcing the result
    // count. The success path was silent (only the degraded nudge had an announcement) — this
    // asserts the role="status" region announces "N result(s) found" whenever the dropdown is open.
    check('search results announced to screen readers (WCAG 4.1.3 aria-live status)',
      /\d+\s+results?\s+found/i.test(res.searchStatus),
      res.searchStatus ? `status="${res.searchStatus}"` : 'NO aria-live result-count status (SR gets no feedback results appeared)');
  }

  // 2b. Homepage TRUST-STATS must resolve to REAL non-zero values. A broken data-binding (or a stuck
  // rolling-counter) that ships "0+ Sites Built / 0.00% Uptime / 0 Edge Locations" silently guts the
  // marketing homepage's credibility (a prospect reads it as a dead product) while every functional
  // gate (H1 / search / console) still passes. Phantom-zero aware: <app-rolling-counter> starts at 0
  // and only rolls to its target on IntersectionObserver (+ a 2500ms below-fold fallback), so SCROLL
  // the band into view + wait past the fallback BEFORE reading (memory: rolling-counter-fullpage-
  // capture-shows-phantom-zero — a naive read false-fails on the pre-roll 0).
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('section')].find((e) => /Sites Built|Uptime|Edge Location/i.test(e.innerText || ''));
    s?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(3200); // past the 2500ms rolling-counter fallback + the roll animation
  const stats = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('section')].find((e) => /Sites Built|Uptime|Edge Location/i.test(e.innerText || ''));
    const txt = (sec?.innerText || '').replace(/\s+/g, ' ');
    // the numeric magnitude immediately before each label (strip commas). A stuck/broken counter reads 0.
    const near = (label) => {
      const m = new RegExp('([\\d.,]+)\\s*[%+]?\\s*' + label, 'i').exec(txt);
      return m ? parseFloat(m[1].replace(/,/g, '')) : NaN;
    };
    return { raw: txt.slice(0, 110), sites: near('Sites Built'), uptime: near('Uptime'), edge: near('Edge Location') };
  });
  check('homepage trust-stats resolve to REAL non-zero values (not a phantom-0 / broken binding)',
    stats.sites > 0 && stats.uptime > 0 && stats.edge > 0,
    `sites=${stats.sites} uptime=${stats.uptime} edge=${stats.edge}`);

  // 3. The /create ENTRY renders (the funnel's destination; sign-in bridges here for signed-out users).
  await page.goto(`${ORIGIN}/create`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  const create = await page.evaluate(() => {
    const root = document.getElementById('root') || document.body;
    const h1 = document.querySelector('h1')?.textContent?.trim() || '';
    return { len: (root.innerHTML || '').length, h1: h1.slice(0, 60) };
  });
  check('/create wizard renders', create.len > 500 && create.h1.length > 0, `h1="${create.h1}" len=${create.len}`);

  check('0 console errors across the funnel', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : 'clean');
} catch (e) {
  check('funnel walk completed', false, 'error: ' + String(e).slice(0, 100));
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(46)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} guest-funnel break(s) (a prospect can't get from homepage → create).`
    : `\nVERDICT: ✅ PASS — guest acquisition funnel operable end-to-end (homepage → hero CTA → search → /create), 0 console errors.`,
);
process.exit(fails ? 1 : 0);
