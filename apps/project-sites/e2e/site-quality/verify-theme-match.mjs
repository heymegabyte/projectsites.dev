// verify-theme-match.mjs — GENERATED-SITE QUALITY probe: the served theme
// (`data-style`) must SUIT the business vertical. Audits the LIVE product
// (`{slug}.projectsites.dev`) in a REAL headless browser.
//
// WHY: theme personality is gated by two resolvers that can DISAGREE — the worker
// `theme_style.ts` (sets `_brand.json.themeStyle`) and the container's own content-pack
// matcher (`container-server.mjs`), which can OVERRIDE it. Two confirmed live mismatches
// drove this probe: an artisan JEWELER (luna-felix, AL-298) and an independent BOOKSTORE
// (booksweet, AL-322) both shipped `data-style=boutique` — the generic clothing-boutique
// personality — when they should be `luxe` and `scholarly`. See
// [[generated-site-theme-selection-coverage]].
//
// MUST render in a real browser: `data-style` is applied CLIENT-SIDE by the SPA
// (`applyBrand`) AFTER hydration — it is NOT in the fetched static shell, so a fetch-only
// probe would false-report every site as blank ([[generated-site-public-surfing-gotchas]]).
//
// TWO checks:
//   (1) HARD (exit 1) — every categorized site MUST carry a NON-BLANK known preset in the
//       live DOM. A missing/`classic` fallback on a distinctive vertical is the AL-256
//       "undefined→bland classic" render defect.
//   (2) SURFACE (report-only, exit 0 unless --strict) — flag a site whose live theme is a
//       CONFIRMED-INAPPROPRIATE one for its vertical (bookstore/jeweler → `boutique`).
//       Non-blocking per the audit-arc ladder until the root fix (theme_style.ts:185
//       book/library→scholarly + container honor-themeStyle for jewelry) lands + a rebuilt
//       site is prod-verified; then promote with `--strict`. Conservative (prefers
//       false-negatives per validator-precision).
//
// Usage: node e2e/site-quality/verify-theme-match.mjs [--strict]
//        SITES=booksweet-ann-arbor node e2e/site-quality/verify-theme-match.mjs

import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const STRICT = process.argv.includes('--strict');

const CASES = [
  { slug: 'booksweet-ann-arbor', vertical: 'bookstore', bad: ['boutique'], ideal: ['scholarly', 'editorial'] },
  { slug: 'luna-felix-goldsmith-santa-fe', vertical: 'jeweler', bad: ['boutique'], ideal: ['luxe'] },
  { slug: 'savage-law-firm-charleston', vertical: 'law firm', bad: ['boutique', 'rugged'], ideal: ['editorial'] },
  { slug: 'city-hardware-burlington', vertical: 'hardware', bad: ['boutique', 'luxe'], ideal: ['rugged'] },
  { slug: 'weissman-family-dental-boulder', vertical: 'dental', bad: ['boutique', 'rugged'], ideal: ['botanical', 'classic'] },
];

const override = (process.env.SITES || '').split(',').map((s) => s.trim()).filter(Boolean);
const cases = override.length
  ? override.map((slug) => CASES.find((c) => c.slug === slug) ?? { slug, vertical: '?', bad: [], ideal: [] })
  : CASES;

const BLANK = new Set(['', 'classic']); // a distinctive vertical should NOT fall to bland classic

async function servedStyle(browser, slug) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 30000 });
    // `data-style` is applied by the SPA after hydration — wait for it (fallback: settle).
    await page
      .waitForFunction(
        () => !!(document.documentElement.dataset.style || document.body.dataset.style),
        { timeout: 8000 },
      )
      .catch(() => {});
    const got = await page.evaluate(() => ({
      style: document.documentElement.dataset.style || document.body.dataset.style || null,
      theme: document.documentElement.dataset.theme || document.body.dataset.theme || null,
    }));
    return { ok: true, ...got };
  } catch (e) {
    return { ok: false, style: null, theme: null, err: e instanceof Error ? e.message : String(e) };
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ headless: true });
const rows = [];
let hardFail = 0;
let mismatch = 0;

for (const c of cases) {
  const s = await servedStyle(browser, c.slug);
  if (!s.ok) {
    rows.push({ ...c, style: `(${s.err})`, verdict: '— unreachable (skip)' });
    continue;
  }
  const style = s.style;
  if (!style || BLANK.has(style)) {
    hardFail++;
    rows.push({ ...c, style: style || '(none)', verdict: '🔴 BLANK/classic — AL-256 undefined→bland (HARD fail)' });
  } else if (c.bad.includes(style)) {
    mismatch++;
    rows.push({ ...c, style, verdict: `⚠️ MISMATCH — ${style} is wrong for a ${c.vertical} (want ${c.ideal.join('/')})` });
  } else {
    rows.push({ ...c, style, verdict: `✅ ${style}${c.ideal.length && !c.ideal.includes(style) ? ' (acceptable)' : ''}` });
  }
}

await browser.close();

console.log('\n=== GENERATED-SITE theme-match (live data-style suits the vertical) ===');
for (const r of rows) console.log(`  ${r.slug.padEnd(34)} ${String(r.style).padEnd(12)} ${r.verdict} [${r.theme ?? '-'}]`);

const strictFail = hardFail > 0 || (STRICT && mismatch > 0);
const summary =
  `blank/classic=${hardFail} (HARD) · vertical-mismatch=${mismatch} ` +
  `(${STRICT ? 'HARD --strict' : 'report — root-fix pending: theme_style.ts:185 book→scholarly + container honor-themeStyle for jewelry'})`;
console.log(`\nVERDICT: ${strictFail ? '🔴 FAIL' : mismatch > 0 ? '⚠️ REPORT' : '✅ PASS'} — ${summary}`);
process.exit(strictFail ? 1 : 0);
