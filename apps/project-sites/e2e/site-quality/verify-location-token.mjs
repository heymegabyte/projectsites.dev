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
// A bare number after a title SEPARATOR — middot ("… · 1517 · …", sub-page fitMetaTitle) OR
// pipe ("… | 70130", the homepage Home.tsx `{name} | {city}` local-SEO append). Both are the
// street-number/ZIP-as-city leak; the homepage-title pipe variant slipped past a middot-only match.
const NUMERIC_CITY_IN_TITLE = /[·|]\s*\d{3,6}\b/;
// The numeric checks catch a street-number/ZIP leak — but a VERBOSE OSM display_name can also leak
// an ALPHABETIC-but-wrong field as the "city": the COUNTY/administrative level that sits between the
// city and the state ("…, Inglewood, Los Angeles County, California, 90301, …" — the randys-donuts
// delivery). If a consumer's parser dropped one level too few, it would show "Serving Los Angeles
// County & nearby" — grammatically fine, numerically clean, but the WRONG place. cityFromAddress's
// ADMIN loop drops these; this asserts none slipped through into a live SEO surface. A real city is
// a place name, never an administrative container. (AL-749 — motivated by the OSM county wrinkle.)
const CITY_IS_ADMIN = /\b(county|parish|borough|census|township|prefecture|community board)\b/i;

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
    const home = await page.evaluate(() => {
      const m = (document.body.innerText || '').match(/serving\s+([^,\n.]{1,40}?)\s+and the surrounding/i);
      const trust = (document.body.innerText || '').match(/serving\s+(\S{1,30}?)\s+&\s+nearby/i); // TrustBar "Serving {city} & nearby"
      return { serving: m ? m[1].trim() : '', trust: trust ? trust[1].trim() : '', title: document.title };
    });
    check(`${slug} · homepage service-area city is alphabetic`, !NUMERIC_CITY_IN_SERVING.test(`serving ${home.serving} `),
      home.serving ? `serving "${home.serving}"` : '(no service-area line)');
    // …AND is a real place, not the county/administrative level (the OSM verbose-address wrinkle).
    if (home.serving)
      check(`${slug} · homepage service-area city is a place, not a county/admin`, !CITY_IS_ADMIN.test(home.serving),
        CITY_IS_ADMIN.test(home.serving) ? `LEAKED admin name: "${home.serving}"` : `serving "${home.serving}"`);
    // The homepage <title> gets a `| {city}` local-SEO append (Home.tsx) — must not be a ZIP.
    check(`${slug} · homepage <title> city is alphabetic`, !NUMERIC_CITY_IN_TITLE.test(home.title),
      NUMERIC_CITY_IN_TITLE.test(home.title) ? `title="${home.title}"` : 'ok');
    // TrustBar "Serving {city} & nearby" strip — must not be a ZIP nor a county/admin name.
    if (home.trust) {
      check(`${slug} · trust-strip city is alphabetic`, !/^\d{3,6}$/.test(home.trust), `trust="${home.trust}"`);
      check(`${slug} · trust-strip city is a place, not a county/admin`, !CITY_IS_ADMIN.test(home.trust),
        CITY_IS_ADMIN.test(home.trust) ? `LEAKED admin name: "${home.trust}"` : `trust="${home.trust}"`);
    }

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
    await ctx.close().catch(() => {});
  }
} catch (e) {
  check('location-token audit completed', false, 'error: ' + String(e).slice(0, 120));
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(60)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} wrong-city leak(s) — a street-number/ZIP OR a county/admin name — in SEO title/meta/service-area. Root fix (AL-736 cityFromAddress ADMIN-drop) lands on the site's next build.`
    : `\nVERDICT: ✅ PASS — every audited site derives a real city (alphabetic, not a ZIP, not a county/admin container) in its title, meta, and service-area line.`,
);
process.exit(fails ? 1 : 0);
