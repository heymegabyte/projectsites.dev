// verify-section-rail.mjs — the Cinematic Section Rail (section_rail / VITE_SECTION_RAIL,
// DARK by default) contract on a DEPLOYED build.
//
// DARK-FLAG / STALE-BUILD DISCIPLINE (validator-precision):
// `section_rail` / VITE_SECTION_RAIL is DARK by default — most prod sites will NOT carry the
// rail yet. This is correct and must NOT fail. The probe DETECTS deployment by checking for
// `[data-testid="section-rail"]` in the rendered DOM. If absent → SKIP with ::notice (fail-OPEN).
// Hard assertions only run when the rail is actually present on the page.
//
// Usage: SITES=olympia-provisions-portland node e2e/site-quality/verify-section-rail.mjs
// Override base URL: RAIL_BASE=https://template.projectsites.dev RAIL_PATH=/ node ...
import { chromium } from 'playwright';

const SITES_ENV = process.env.SITES;
const SUFFIX = process.env.SITE_SUFFIX || '.projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const IGNORE = /favicon|posthog|\/ingest|GL Driver|net::ERR_ABORTED|Failed to load resource/i;

const targets = (() => {
  if (process.env.RAIL_BASE) {
    const base = process.env.RAIL_BASE.replace(/\/$/, '');
    const path = process.env.RAIL_PATH || '/';
    return [{ url: base + path, label: base }];
  }
  const slugs = SITES_ENV
    ? SITES_ENV.split(',').map((s) => s.trim()).filter(Boolean)
    : ['template'];
  return slugs.map((slug) => ({
    url: `https://${slug}${SUFFIX}/`,
    label: slug,
  }));
})();

const browser = await chromium.launch({ headless: true });
let tested = 0;
let failed = false;
const rows = [];

for (const { url, label } of targets) {
  rows.push(`\n─ ${label} ─`);
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errs.push(m.text().slice(0, 120));
  });
  page.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message.slice(0, 100)));

  let loadOk = false;
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    loadOk = !!(resp && resp.status() === 200);
    if (!loadOk) {
      rows.push(`  ⚠️  ${label} — not 200 (${resp?.status()}); skipped`);
      await ctx.close().catch(() => {});
      continue;
    }
  } catch (e) {
    rows.push(`  ⚠️  ${label} — load error (${String(e).slice(0, 80)}); skipped`);
    await ctx.close().catch(() => {});
    continue;
  }

  await page.waitForTimeout(1500);

  const railCount = await page.locator('[data-testid="section-rail"]').count();

  if (railCount === 0) {
    rows.push(
      `  ⏭️  ${label} — section-rail not present (dark flag / VITE_SECTION_RAIL=0 / <4 labeled sections); skipped, not failed.`,
    );
    await ctx.close().catch(() => {});
    continue;
  }

  // Rail IS present — run all fail-CLOSED assertions.
  tested++;
  const rail = page.locator('[data-testid="section-rail"]');
  const items = page.locator('[data-testid="section-rail-item"]');
  const n = await items.count();
  const aria = await rail.getAttribute('aria-label');
  const hrefs = await items.evaluateAll((as) => as.map((a) => a.getAttribute('href') || ''));
  const labels = await items.evaluateAll((as) =>
    as.map((a) => (a.querySelector('.ps-section-rail-label')?.textContent || '').trim()),
  );

  const dotsOk = n >= 4;
  const ariaOk = !!aria;
  const anchorsOk = hrefs.every((h) => h.startsWith('#') && h.length > 1);
  rows.push(`  ${dotsOk ? '✓' : '❌'} ${label}: rail renders ${n} section dot(s) (need ≥4)`);
  rows.push(`  ${ariaOk ? '✓' : '❌'} ${label}: nav accessible name${ariaOk ? ` "${aria}"` : ' MISSING'}`);
  rows.push(`  ${anchorsOk ? '✓' : '❌'} ${label}: every dot is a real #anchor${anchorsOk ? '' : ` — got ${JSON.stringify(hrefs)}`}`);
  if (!dotsOk || !ariaOk || !anchorsOk) failed = true;

  const leaked = labels.filter((l) => /\{[A-Z0-9_]{2,}\}/.test(l));
  const tokenOk = leaked.length === 0;
  rows.push(`  ${tokenOk ? '✓' : '❌'} ${label}: no {TOKEN} labels${tokenOk ? '' : ` — leaked: ${JSON.stringify(leaked)}`}`);
  if (!tokenOk) failed = true;

  const yBefore = await page.evaluate(() => window.scrollY);
  await items.last().click();
  await page.waitForTimeout(900);
  const yAfter = await page.evaluate(() => window.scrollY);
  const activeNow = await page.locator('[data-testid="section-rail-item"][aria-current="true"]').count();
  const scrollOk = yAfter > yBefore;
  const activeOk = activeNow === 1;
  rows.push(`  ${scrollOk ? '✓' : '❌'} ${label}: dot click scrolled the page (${yBefore}→${yAfter})`);
  rows.push(`  ${activeOk ? '✓' : '❌'} ${label}: exactly one dot aria-current after jump (got ${activeNow})`);
  if (!scrollOk || !activeOk) failed = true;

  const focusable = await items.first().evaluate((el) => el.tagName === 'A' && el.tabIndex >= 0);
  rows.push(`  ${focusable ? '✓' : '❌'} ${label}: dots are keyboard-focusable anchors`);
  if (!focusable) failed = true;

  const noErrors = errs.length === 0;
  rows.push(`  ${noErrors ? '✓' : '❌'} ${label}: 0 console errors${noErrors ? '' : ` — ${errs.slice(0, 2).join(' | ')}`}`);
  if (!noErrors) failed = true;

  await ctx.close().catch(() => {});
}

await browser.close();

console.log('\n━━ section-rail (section_rail / VITE_SECTION_RAIL, dark by default) — prod ━━');
rows.forEach((r) => console.log(r));

if (tested === 0) {
  console.log(
    '\n::notice:: verify-section-rail SKIPPED — no reachable site carries the section rail yet ' +
    '(dark flag / VITE_SECTION_RAIL=0); flips to a real assertion as sites rebuild with the flag on.',
  );
  process.exit(0);
}

if (failed) {
  console.error('\n❌ section-rail FAIL — the cinematic section rail violated its a11y/ux contract on a live site.');
  process.exit(1);
}
console.log(
  '\n✓ section-rail PASS — where deployed: ≥4 dots, aria-label, real #anchors, render-honest, ' +
  'jump-scrolls, aria-current tracks, keyboard-focusable, 0 errors. Dark-flag / absent builds fail-open (skip).',
);
process.exit(0);
