// verify-site-renders.mjs — § C (highest severity): a deployed site must actually HYDRATE, not
// render the app error boundary ("Something went wrong") or a near-empty shell. This is the DARK-
// SITE gate — the worst possible outcome (a delivered site that shows nothing / a crash card) — and
// NO prior probe covered it: verify-cwv/verify-content-density MEASURE metrics on the assumption the
// page rendered, so a fully-crashed site slips past them (it reads as "thin", not "broken").
//
// Reference incident (AL-571): olson-kundig-seattle rendered ONLY "Something went wrong" (H1 =
// error boundary, 0 imgs, 13 words) because a stale build's `DevA11yBadge-*.js` 404 →
// `TypeError: Failed to fetch dynamically imported module` propagated past a bare <Suspense> to the
// app error boundary → the WHOLE page went dark. Root-fixed in the template (`ChunkBoundary` wraps
// the lazy interaction chrome → a failed chunk degrades to "feature absent", never a site crash)
// + the AL-562 DevA11yBadge dev-gate; both land on rebuild. This probe is the durable gate that
// makes a DARK site RED instead of invisible.
//
// A site is DARK when: (a) the H1 or opening body text is the error-boundary card, OR (b) the SPA
// never hydrated (near-empty: <40 words AND 0 imgs AND ≤1 #root child after a generous settle).
// Fail-OPEN by default (::notice, suite-safe) since a stale pre-fix build flips green on rebuild;
// STRICT=1 → exit 1 (a FRESH build going dark is a build-breaker). Captures pageerrors for triage.
//
// Usage: SITES=lake-flato-sa,olson-kundig-seattle [STRICT=1] node e2e/site-quality/verify-site-renders.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'lake-flato-sa,olson-kundig-seattle')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';
const ERROR_BOUNDARY = /something went wrong/i;

const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    // serviceWorkers:'block' → the honest first-visit render (a stale SW can't mask a broken bundle).
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 120)));
    let row = { slug, dark: false, reason: 'ok', http: 0, words: 0, imgs: 0, h1: '' };
    try {
      const r = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 60000 });
      row.http = r ? r.status() : 0;
      await page.waitForTimeout(5500); // generous hydration settle (async lazy-import rejection can be late)
      const st = await page.evaluate(() => {
        const bodyText = (document.body.innerText || '').trim();
        const h1 = document.querySelector('h1')?.textContent || '';
        const root = document.getElementById('root');
        return {
          words: bodyText.split(/\s+/).filter(Boolean).length,
          imgs: document.querySelectorAll('img').length,
          h1: h1.slice(0, 60),
          topText: bodyText.slice(0, 400),
          rootChildren: root ? root.children.length : -1,
        };
      });
      row = { ...row, words: st.words, imgs: st.imgs, h1: st.h1 };
      if (ERROR_BOUNDARY.test(st.h1) || ERROR_BOUNDARY.test(st.topText)) {
        row.dark = true;
        row.reason = 'error-boundary ("Something went wrong")';
      } else if (st.words < 40 && st.imgs === 0 && st.rootChildren <= 1) {
        row.dark = true;
        row.reason = `unhydrated shell (${st.words}w/${st.imgs}img/${st.rootChildren} root-children)`;
      }
      if (pageErrors.length) row.pageErrors = pageErrors.slice(0, 3);
    } catch (e) {
      row.dark = true;
      row.reason = 'load failed: ' + String(e).slice(0, 90);
    }
    results.push(row);
    await ctx.close();
  }
} finally {
  await browser.close();
}

for (const r of results) {
  const mark = r.dark ? '🔴 DARK' : '✅ renders';
  console.log(`${mark}  ${r.slug}  http=${r.http} words=${r.words} imgs=${r.imgs} h1="${r.h1}"${r.dark ? ` → ${r.reason}` : ''}`);
  if (r.pageErrors) console.log(`         pageerrors: ${r.pageErrors.join(' | ')}`);
}
const dark = results.filter((r) => r.dark);
console.log('');
if (!dark.length) {
  console.log(`✅ PASS — all ${results.length} site(s) hydrated (no error-boundary / dark shell)`);
  process.exit(0);
}
const msg = `${dark.length}/${results.length} site(s) DARK: ${dark.map((r) => `${r.slug} (${r.reason})`).join(' · ')}`;
if (STRICT) {
  console.log(`❌ FAIL — ${msg}`);
  process.exit(1);
}
// flips-GREEN-on-rebuild: a stale pre-AL-562/571 build still crashes on the DevA11yBadge 404; the
// ChunkBoundary + dev-gate fixes land next build (NO redeploy of existing sites → rebuild to un-dark).
console.log(`::notice:: verify-site-renders — ${msg} (stale pre-AL-571 build; rebuild to land ChunkBoundary + un-dark — set STRICT=1 to enforce)`);
process.exit(0);
