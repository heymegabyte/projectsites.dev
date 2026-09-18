// verify-location-token.mjs — § C.4 (SEO/GEO): does a deployed generated site leak a NON-CITY
// token (a street number or ZIP) where the CITY belongs, in SEO-critical surfaces? This closes a
// blind spot the length-based SEO gate can't see: `verify-seo.mjs` asserts <title> is 50-60 chars
// and <meta description> 120-156 — but a garbage-but-right-length value passes. Live example that
// slipped through (swan-oyster-depot, 2026-09-18): the AL-729 OSM/Nominatim fallback returns a
// verbose `display_name` ("Swan Oyster Depot, 1517, Polk Street, …, San Francisco, California,
// 94109, United States"), and THREE naive parsers pulled the wrong comma-field as the "city" —
//   • template placeholders.ts `split(',')[1]`  → the STREET NUMBER "1517"
//       → <title>Blog — Swan Oyster Depot · 1517 · get in touch to learn more</title>
//       → <meta>… Proudly serving 1517 and the surrounding area</meta>
//   • worker site-generation.ts + template LocationMap.tsx `parts[length-2]` → the ZIP "94109"
//       → homepage "Proudly serving 94109 and the surrounding area"
// AL-733/733b fixed the H1's cityFromAddress but MISSED these consumers (the `audit EVERY consumer
// of the changed shape` lesson). AL-736 ports the robust cityFromAddress to all three. A real city
// is ALPHABETIC — never a bare 3-6 digit number — so this gate asserts no numeric-city leak in the
// homepage service-area line, and each sub-page's <title> + <meta description>.
//
// ROOT-CAUSE (never a per-site patch): template `src/lib/placeholders.ts` cityFromAddress +
// `LocationMap.tsx`, worker `site-generation.ts` finalize ctx.city. Fix lands on the next build;
// this probe flips GREEN as OSM-sourced sites rebuild (Places-sourced sites were already clean).
//
// Local Chromium ({slug}.projectsites.dev is CF-clean). Auto-joins run-all via the verify-*.mjs glob.
// Usage: node e2e/site-quality/verify-location-token.mjs   [SITES=slug,slug overrides the cohort]
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolveSites } from './_default-sites.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const SITES = resolveSites(process.env.SITES);
if (SITES.length === 0) {
  console.log('::notice:: verify-location-token skipped — no site resolved');
  process.exit(0);
}
const SUBROUTES = ['/blog', '/privacy', '/faq'];
// A bare 3-6 digit run = a street number / ZIP masquerading as a city. A real city is alphabetic.
const NUMERIC_CITY_IN_SERVING = /serving\s+\d{3,6}\b/i; // "Proudly serving 94109 …"
const NUMERIC_CITY_IN_TITLE = /·\s*\d{3,6}\b/; // "… · 1517 · get in touch"

const browser = await chromium.launch();
const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ label, ok, detail });
  if (!ok) fails++;
};

try {
  for (const slug of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();

    // Homepage service-area line (LocationMap "Proudly serving {city} …").
    await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(600);
    const homeServing = await page.evaluate(() => {
      const m = (document.body.innerText || '').match(/serving\s+([^,\n.]{1,40}?)\s+and the surrounding/i);
      return m ? m[1].trim() : '';
    });
    check(`${slug} · homepage service-area city is alphabetic`, !NUMERIC_CITY_IN_SERVING.test(`serving ${homeServing} `),
      homeServing ? `serving "${homeServing}"` : '(no service-area line)');

    // Each sub-page: <title> + <meta description> must not carry a numeric "city".
    for (const path of SUBROUTES) {
      const resp = await page.goto(`https://${slug}.projectsites.dev${path}`, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => null);
      if (!resp || resp.status() >= 400) { check(`${slug}${path} · reachable`, false, `status=${resp ? resp.status() : 'ERR'}`); continue; }
      await page.waitForTimeout(400);
      const seo = await page.evaluate(() => ({
        title: document.title,
        desc: (document.querySelector('meta[name=description]') || {}).content || '',
      }));
      const titleBad = NUMERIC_CITY_IN_TITLE.test(seo.title);
      const descBad = NUMERIC_CITY_IN_SERVING.test(seo.desc);
      check(`${slug}${path} · title has no numeric-city leak`, !titleBad, titleBad ? `title="${seo.title}"` : 'ok');
      check(`${slug}${path} · meta desc has no numeric-city leak`, !descBad, descBad ? `desc="…${(seo.desc.match(/serving\s+\d{3,6}[^.]*/i) || [''])[0]}…"` : 'ok');
    }
    await ctx.close();
  }
} catch (e) {
  check('location-token audit completed', false, 'error: ' + String(e).slice(0, 120));
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(60)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} numeric-city (street-number/ZIP) leak(s) in SEO title/meta/service-area. Root fix (AL-736 cityFromAddress) lands on the site's next build.`
    : `\nVERDICT: ✅ PASS — every audited site derives a real ALPHABETIC city (no street-number/ZIP leak) in its title, meta, and service-area line.`,
);
process.exit(fails ? 1 : 0);
