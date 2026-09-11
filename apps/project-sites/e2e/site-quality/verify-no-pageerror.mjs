// verify-no-pageerror.mjs — GENERATED-SITE QUALITY gate: a deployed site must not throw
// an UNCAUGHT exception (`pageerror`) during load/hydration.
//
// WHY (the gap this closes — AL-329/AL-331): a generated site can return HTTP 200 with a
// real prerendered H1 (so a status/render/H1 check passes) YET crash the SPA during
// hydration — e.g. `RangeError: Maximum call stack size exceeded` from a recursive template
// walker hitting a circular data shape in the generated content. When that happens the
// client enhancement dies silently: the theme never applies (`data-style` stays null →
// bland classic instead of the vertical preset), interactivity is degraded, and the crash
// ships to the business's real visitors. The delivery/site-quality checks were BLIND to it
// because they trusted 200 + H1. A `pageerror` is an unambiguous app crash — gate on it.
//
// Distinct from verify-a11y (axe) + verify-cwv (perf): those need a working page; THIS runs
// first-principles — "did the page's own JS throw an uncaught exception?". One viewport is
// enough (a hydration crash reproduces at any width). Fixes are ROOT-CAUSE in the TEMPLATE
// (a cycle-guard / depth-limit on the recursive walker) — never a one-off.
//
// Usage:
//   node e2e/site-quality/verify-no-pageerror.mjs
//   SITES=studio-q-fitness-fort-collins node e2e/site-quality/verify-no-pageerror.mjs
//   node e2e/site-quality/verify-no-pageerror.mjs --strict   # console errors also hard-fail

import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const STRICT = process.argv.includes('--strict');

// A representative set of REAL deployed sites (override with SITES=…). Mixes known-clean
// verticals with any recently-delivered site so a regression surfaces on the next run.
const SITES = (
  process.env.SITES ||
  'booksweet-ann-arbor,city-hardware-burlington,savage-law-firm-charleston,weissman-family-dental-boulder,studio-q-fitness-fort-collins'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Third-party / analytics noise that isn't the SITE's own bug — never fail on it. An app
// recursion (RangeError from the site bundle) has none of these markers → it's a real crash.
const IGNORE =
  /posthog|sentry|google-analytics|googletagmanager|gtag|beacon|doubleclick|hotjar|clarity|cloudflareinsights|challenges\.cloudflare|favicon|net::ERR_|Failed to load resource|ResizeObserver loop/i;

async function auditSite(browser, slug) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => {
    const t = e?.stack || String(e);
    if (!IGNORE.test(t)) pageErrors.push(t.split('\n')[0].slice(0, 140));
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!IGNORE.test(t)) consoleErrors.push(t.slice(0, 140));
  });
  try {
    const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 30000 });
    // Guard: a CF challenge / non-200 shell isn't the real site — don't report a phantom pass OR fail.
    const title = await page.title().catch(() => '');
    if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
      await ctx.close();
      return { slug, auditable: false, status: resp?.status() ?? 0 };
    }
    await page.waitForTimeout(3500); // let deferred hydration/applyBrand run (that's where the crash lives)
    const style = await page
      .evaluate(() => document.documentElement.dataset.style || document.body.dataset.style || null)
      .catch(() => null);
    return { slug, auditable: true, pageErrors, consoleErrors, style };
  } catch (e) {
    return { slug, auditable: false, status: 0, gotoError: String(e).slice(0, 80) };
  } finally {
    await ctx.close();
  }
}

const browser = await chromium.launch({ headless: true });
const rows = [];
for (const slug of SITES) rows.push(await auditSite(browser, slug));
await browser.close();

let hardFail = 0;
let consoleFail = 0;
console.log('\n━━ GENERATED-SITE no-pageerror gate (uncaught exceptions crash real visitors) ━━');
for (const r of rows) {
  if (!r.auditable) {
    console.log(`  ⚠️  ${r.slug.padEnd(34)} NOT AUDITABLE (status=${r.status}${r.gotoError ? ' ' + r.gotoError : ''}) — skip`);
    continue;
  }
  const pe = r.pageErrors.length;
  const ce = r.consoleErrors.length;
  if (pe > 0) {
    hardFail++;
    console.log(`  ❌ ${r.slug.padEnd(34)} ${pe} pageerror · data-style=${r.style} → ${r.pageErrors[0]}`);
  } else if (ce > 0) {
    consoleFail++;
    console.log(`  ${STRICT ? '❌' : '⚠️ '} ${r.slug.padEnd(34)} 0 pageerror · ${ce} console err → ${r.consoleErrors[0]}`);
  } else {
    console.log(`  ✅ ${r.slug.padEnd(34)} 0 pageerror · 0 console err · data-style=${r.style}`);
  }
}

const fail = hardFail + (STRICT ? consoleFail : 0);
console.log(
  `\nVERDICT: ${fail ? '🔴 FAIL' : consoleFail ? '⚠️ REPORT' : '✅ PASS'} — pageerror(hard)=${hardFail} · console(${STRICT ? 'hard' : 'report'})=${consoleFail} of ${rows.length} sites`,
);
if (fail) console.error('   ↳ an uncaught exception crashes hydration (theme/interactivity die at http 200) — root-fix in the TEMPLATE (cycle-guard the recursive walker).');
process.exit(fail ? 1 : 0);
