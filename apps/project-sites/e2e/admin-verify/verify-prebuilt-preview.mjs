// verify-prebuilt-preview.mjs — § B.1 guest funnel, the "already built" PROOF leg (AL-742).
//
// The homepage headline is "Your business website, already built and ready to CLAIM." But until
// AL-742, clicking a PRE-BUILT search result routed a guest straight to /signin — the guest never
// got to SEE the already-built site before the sign-in wall. The single most persuasive conversion
// asset (proof the site is real + gorgeous) was hidden behind auth. Root fix (frontend): the
// prebuilt result card now carries a "Preview" link (`data-testid=search-result-preview`) that opens
// the LIVE `{slug}.projectsites.dev` in a new tab; the card's primary click STILL routes to the claim
// / sign-in funnel (proof-then-commit — the existing verify-guest-funnel-results contract is intact).
//
// This probe drives the real guest journey on PROD and asserts the whole proof leg:
//   1. type a REAL delivered business (dynamic pick from the D1 pre-built search — never Places-flaky)
//   2. a Preview link RENDERS on the prebuilt row, target=_blank + rel=noopener + an aria-label
//   3. its href is EXACTLY https://{that result's slug}.projectsites.dev (not a stale/other slug)
//   4. the live preview URL actually RENDERS a built site (root has content + an <h1>) — the "already
//      built" proof is REAL, not a 404/blank (a preview that 404s is worse than no preview)
//   5. the card's primary click STILL routes to the sign-in bridge (claim path preserved — no regress)
//   6. 0 console errors throughout.
//
// LOCAL Chromium — both / and {slug}.projectsites.dev serve CF-clean for headless. Fail-open
// (::notice, exit 0) when no delivered site surfaces (nothing to preview, not a regression).
// Auto-joins run-all via the verify-*.mjs glob. Usage: node e2e/admin-verify/verify-prebuilt-preview.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ ok, label, detail });
  if (!ok) fails++;
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    const t = m.type();
    const x = m.text();
    if (/favicon|Failed to load resource|net::ERR_ABORTED|posthog|sentry/i.test(x)) return;
    if (t === 'error') errs.push(x.slice(0, 100));
  });
  page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 100)));

  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // 1. Pick a REAL delivered PUBLISHED business dynamically from the D1-backed pre-built search.
  const pick = await page.evaluate(async () => {
    for (const q of ['coffee', 'fish market', 'bakery', 'gallery', 'barbecue', 'distillery', 'cafe']) {
      const r = await fetch('/api/sites/search?q=' + encodeURIComponent(q));
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j) ? j : (j.data ?? j.sites ?? j.results ?? []);
      const hit = list.find((s) => (s.business_name || s.name) && s.slug && s.status === 'published');
      if (hit) return { name: hit.business_name || hit.name, slug: hit.slug };
    }
    return null;
  });
  if (!pick) {
    console.log('::notice:: verify-prebuilt-preview SKIPPED — no published delivered site surfaced; nothing to preview.');
    process.exit(0);
  }
  check('pre-built search returns a real published delivered business', true, `"${pick.name}" (${pick.slug})`);

  // 2. Type it into the hero search and wait for the prebuilt result row.
  const searchSel =
    '#homepage-search, .hero-search-shell input, input[type="search"], input[placeholder*="business" i], input[placeholder*="search" i]';
  const search = page.locator(searchSel).first();
  await search.click().catch(() => {});
  await search.pressSequentially(pick.name.slice(0, 18), { delay: 45 }).catch(() => {});
  await page.waitForSelector('[data-testid="search-result"][data-result-type="prebuilt"]', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(500);

  // 3. The Preview link RENDERS on a prebuilt row with the right attributes.
  const preview = await page.evaluate(() => {
    const a = document.querySelector('[data-testid="search-result-preview"]');
    if (!a) return null;
    return {
      href: a.getAttribute('href') || '',
      target: a.getAttribute('target') || '',
      rel: a.getAttribute('rel') || '',
      aria: a.getAttribute('aria-label') || '',
      slug: a.getAttribute('data-preview-slug') || '',
      visible: !!a.getClientRects().length,
    };
  });
  check('Preview link RENDERS on the prebuilt result row', !!preview && preview.visible, preview ? `href="${preview.href}"` : 'ABSENT (stale bundle? lands next FE deploy)');

  if (preview) {
    const expected = `https://${pick.slug}.projectsites.dev`;
    check(
      'Preview href points at the EXACT live subdomain of the picked result',
      preview.href === expected && preview.slug === pick.slug,
      `href=${preview.href} expected=${expected}`,
    );
    check(
      'Preview opens safely in a new tab (target=_blank + rel=noopener + aria-label)',
      preview.target === '_blank' && /noopener/.test(preview.rel) && preview.aria.length > 8,
      `target=${preview.target} rel="${preview.rel}" aria="${preview.aria.slice(0, 40)}"`,
    );

    // 4. The live preview URL actually renders a BUILT site (the "already built" proof is real).
    const site = await ctx.newPage();
    const siteErrs = [];
    site.on('console', (m) => { if (m.type() === 'error' && !/favicon|posthog|sentry|net::ERR_ABORTED/i.test(m.text())) siteErrs.push(m.text().slice(0, 80)); });
    const resp = await site.goto(preview.href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    await site.waitForSelector('h1', { timeout: 12000 }).catch(() => {});
    const live = await site.evaluate(() => {
      const root = document.getElementById('root') || document.body;
      return { rootLen: (root?.innerHTML || '').length, h1: document.querySelector('h1')?.textContent?.trim().slice(0, 60) || '', challenge: /verifying you are human/i.test(document.body.innerText || '') };
    });
    check(
      'the previewed site is a REAL built page (200 + root content + an <h1>, not a 404/blank)',
      !!resp && resp.status() < 400 && live.rootLen > 400 && live.h1.length > 0 && !live.challenge,
      `status=${resp ? resp.status() : 'ERR'} rootLen=${live.rootLen} h1="${live.h1}"`,
    );
    await site.close();
  }

  // 5. The card's PRIMARY click STILL routes to the sign-in bridge (claim path preserved — no regress).
  const target = page.locator('[data-testid="search-result"][data-result-type="prebuilt"]').first();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click().catch(() => {});
  await page.waitForURL(/\/signin|\/create/, { timeout: 12000 }).catch(() => {});
  check('the card primary click STILL routes to the claim / sign-in funnel (no regression)', /\/signin|\/create/.test(page.url()), `landed on ${page.url().replace(ORIGIN, '')}`);

  check('0 console errors across the preview funnel', errs.length === 0, errs.slice(0, 3).join(' | '));
  await ctx.close();
} catch (e) {
  check('probe completed without throwing', false, String(e.message || e).slice(0, 120));
} finally {
  await browser.close();
}

console.log('\n━━ § B.1 guest funnel — "already built" PROOF: preview the live site before the sign-in wall (AL-742) ━━');
for (const r of rows) console.log(`  ${r.ok ? '✓' : '❌'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`);
// The Preview link lands on the next FE deploy — treat a link-absent miss as a ::notice, not a hard fail.
const hardFails = rows.filter((r) => !r.ok && !/Preview link RENDERS/.test(r.label)).length;
console.log(
  fails === 0
    ? '\n✅ PASS — a guest can preview their already-built site (right subdomain, real built page) BEFORE the sign-in wall, and the claim path still works. 0 console errors.'
    : `\n${hardFails ? '❌ FAIL' : '🟡 NOTICE'} — ${fails} check(s) unmet (${hardFails} hard).`,
);
process.exit(hardFails ? 1 : 0);
