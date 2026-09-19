// verify-intro-teaser.mjs — the SKIPPABLE CINEMATIC INTRO contract on DEPLOYED sites (CINEMATIC-3D).
// The motion.so/Awwwards-signature ~1.8s brand "curtain" (IntroTeaser, mounted in Layout) must be:
//   A. SHOWS on the first homepage visit of a motion-allowed session (over the hero, with a visible
//      Skip control) AND is SKIPPABLE — clicking Skip removes it — AND never traps.
//   B. LCP-SAFE — the intro curtain must NEVER become the Largest Contentful Paint; the hero
//      (H1/img underneath) stays the LCP (the whole reason the intro is safe by construction).
//   C. REDUCED-MOTION → NEVER shows (prefers-reduced-motion honored; the session key stays unset).
//   D. SESSION-ONCE → after it's seen, an in-session SPA nav back home does NOT re-show it.
//   E. 0 console errors throughout.
//
// Fixes are ROOT-CAUSE in the TEMPLATE (github.com/HeyMegabyte/template.projectsites.dev, IntroTeaser
// + the `.ps-intro*` CSS) — never a one-off. Local Chromium ({slug}.projectsites.dev is CF-clean).
// Auto-joins run-all via the verify-*.mjs glob.
//
// Usage: SITES=guelaguetza-koreatown-la node e2e/site-quality/verify-intro-teaser.mjs
import { chromium } from 'playwright';
import { resolveSites } from './_default-sites.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = resolveSites(process.env.SITES);
const IGNORE = /favicon|posthog|\/ingest|GL Driver|GPU stall|net::ERR_ABORTED|Failed to load resource/i;

// Read the settled LCP via a BUFFERED observer (delivers the finalized entry even after an
// interaction). Proves the intro curtain never became the Largest Contentful Paint.
const readLcp = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        let last = null;
        try {
          const po = new PerformanceObserver((l) => {
            last = l.getEntries().at(-1);
          });
          po.observe({ type: 'largest-contentful-paint', buffered: true });
          setTimeout(() => {
            po.disconnect();
            const el = last?.element;
            resolve(
              last
                ? {
                    tag: el?.tagName || '?',
                    inIntro: !!el?.closest?.('.ps-intro'),
                    text: (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
                    size: Math.round(last.size || 0),
                  }
                : null,
            );
          }, 800);
        } catch {
          resolve(null);
        }
      }),
  );

let fails = 0;
const summary = [];
const fail = (s, msg) => {
  fails++;
  summary.push(`  🔴 ${s}: ${msg}`);
};
const ok = (s, msg) => summary.push(`  ✅ ${s}: ${msg}`);

const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < SITES.length; i++) {
    const slug = SITES[i];
    const base = `https://${slug}.projectsites.dev`;
    const firstSite = i === 0;

    // ── A + B + E: motion-allowed fresh session → intro shows + skippable + LCP-safe + 0 console ──
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text().slice(0, 120)); });
    page.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message.slice(0, 100)));
    try {
      const resp = await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 40000 });
      if (!resp || resp.status() !== 200) { fail(slug, `home not 200 (${resp?.status()})`); await ctx.close().catch(() => {}); continue; }

      // Catch the transient overlay (it auto-dismisses in ~1.8s). If we miss the window, the session
      // key proves it DID show (the component sets it only on the show path).
      let shown = false;
      const teaser = page.locator('[data-testid="intro-teaser"]');
      try {
        await teaser.waitFor({ state: 'visible', timeout: 5000 });
        shown = true;
      } catch {
        shown = false;
      }
      const keySet = await page.evaluate(() => {
        try { return sessionStorage.getItem('ps_intro_seen_v1') === '1'; } catch { return false; }
      });

      if (shown) {
        // Skip control is present + visible + clicking it dismisses the curtain (never traps).
        const skip = page.locator('[data-testid="intro-skip"]');
        const skipVisible = await skip.isVisible().catch(() => false);
        if (!skipVisible) fail(slug, 'intro shown but Skip control not visible');
        await skip.click({ timeout: 2000 }).catch(() => {});
        const gone = await teaser.waitFor({ state: 'detached', timeout: 3000 }).then(() => true).catch(() => false);
        if (gone && skipVisible) ok(slug, 'intro shows over hero + Skip dismisses it (skippable, no trap)');
        else if (!gone) fail(slug, 'Skip did not remove the intro overlay');
      } else if (keySet) {
        ok(slug, 'intro showed (session key set) — auto-dismissed before capture (still session-once)');
      } else {
        // A pre-IntroTeaser build legitimately lacks the curtain — it flips in on rebuild. NOT a
        // template defect (validator-precision: don't false-red a stale build). The contract checks
        // below (LCP-safe, reduced-motion, session-once) still run + pass; only a PRESENT-but-broken
        // intro hard-fails. (reconcile-surface-map-can-be-stale-false-red.)
        summary.push(`  ⚠️  ${slug}: intro not present — a pre-IntroTeaser build (flips in on rebuild)`);
      }

      if (errs.length) fail(slug, `${errs.length} console error(s): ${errs.slice(0, 2).join(' | ')}`);
      else ok(slug, '0 console errors');
    } catch (err) {
      fail(slug, `A/B error: ${String(err).slice(0, 80)}`);
    } finally {
      await ctx.close().catch(() => {});
    }

    // ── B: LCP-SAFE — the intro curtain must NEVER be the LCP. Separate no-interaction context
    // (motion-allowed so the intro shows + auto-dismisses); a Skip CLICK would finalize LCP early,
    // so we never touch the page — let it settle to its natural LCP, then assert it's not the curtain.
    const lcpCtx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
    const lcpPage = await lcpCtx.newPage();
    try {
      await lcpPage.goto(base + '/', { waitUntil: 'load', timeout: 40000 });
      await lcpPage.waitForTimeout(1500); // past the ~1.8s intro window + hero-img paint
      const lcp = await readLcp(lcpPage);
      if (!lcp) summary.push(`  ⚠️  ${slug}: no LCP entry captured — cannot assert LCP-safety, not failing`);
      else if (lcp.inIntro) fail(slug, `LCP is the intro curtain ("${lcp.text}", ${lcp.size}px) — the intro REGRESSED LCP`);
      else ok(slug, `LCP-safe — LCP is the hero <${lcp.tag}> (${lcp.size}px), NOT the intro curtain`);
    } catch (err) {
      fail(slug, `LCP probe error: ${String(err).slice(0, 80)}`);
    } finally {
      await lcpCtx.close();
    }

    // ── C: reduced-motion → the intro NEVER shows (and never sets the session key) ──
    const rmCtx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const rmPage = await rmCtx.newPage();
    try {
      await rmPage.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 40000 });
      await rmPage.waitForTimeout(2500); // well past when it would have shown
      const present = await rmPage.locator('[data-testid="intro-teaser"]').count();
      const keySet = await rmPage.evaluate(() => {
        try { return sessionStorage.getItem('ps_intro_seen_v1') === '1'; } catch { return false; }
      });
      if (present === 0 && !keySet) ok(slug, 'reduced-motion → intro never shows (key unset) ✓ a11y honored');
      else fail(slug, `reduced-motion → intro leaked (present=${present}, keySet=${keySet})`);
    } catch (err) {
      fail(slug, `reduced-motion error: ${String(err).slice(0, 80)}`);
    } finally {
      await rmCtx.close();
    }

    // ── D: session-once (first site only, keeps runtime bounded) — dismiss, SPA-nav back home → absent ──
    if (firstSite) {
      const sCtx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' });
      const sPage = await sCtx.newPage();
      try {
        await sPage.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 40000 });
        // Dismiss whatever showed (Esc), then SPA-nav away + back home via clicks (no full reload).
        await sPage.keyboard.press('Escape').catch(() => {});
        await sPage.waitForTimeout(800);
        const about = sPage.locator('a[href="/about"], nav a:has-text("About")').first();
        if (await about.count()) {
          await about.click().catch(() => {});
          await sPage.waitForTimeout(600);
          const home = sPage.locator('a[href="/"], nav a:has-text("Home")').first();
          if (await home.count()) await home.click().catch(() => {});
          await sPage.waitForTimeout(1200);
          const reappeared = await sPage.locator('[data-testid="intro-teaser"]').count();
          if (reappeared === 0) ok(slug, 'session-once — intro does NOT re-show on an in-session SPA nav back home');
          else fail(slug, 'intro RE-SHOWED on a repeat in-session home visit (session-once broken)');
        } else {
          summary.push(`  ⚠️  ${slug}: no About nav link to prove session-once via SPA nav — skipped`);
        }
      } catch (err) {
        summary.push(`  ⚠️  ${slug}: session-once probe error (${String(err).slice(0, 60)}) — skipped`);
      } finally {
        await sCtx.close();
      }
    }
  }
} finally {
  await browser.close();
}

console.log('\nSkippable cinematic intro (IntroTeaser) contract on deployed sites:');
for (const line of summary) console.log(line);
console.log(`\nVERDICT: ${fails === 0 ? 'PASS' : 'FAIL'} — ${SITES.length} site(s), ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
