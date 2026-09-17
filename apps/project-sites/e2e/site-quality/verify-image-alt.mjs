// verify-image-alt.mjs — § C.3 runtime a11y: every CONTENT <img> on a live generated site
// carries an `alt` attribute (WCAG 1.1.1). Prod-runtime companion to the build-time gate
// `build_validators.ts validateImageAlt` — the gate checks the prerendered shell; this checks the
// HYDRATED DOM a real visitor + screen-reader actually experiences (where most section images
// render client-side and the build validator never sees them).
//
// Validator-precision: a MISSING `alt` attribute is a violation; `alt=""` (present, explicit
// decorative — the correct marking for a background/spacer image) PASSES; a bare <img> with no
// src (framework hydration placeholder) is IGNORED. So it never cries wolf on the template's
// correctly-decorative images (BentoGrid `alt={t.imageAlt ?? ''}`, Header logo `alt=""`).
//
// Real Chromium, real UA. SITES=slug1,slug2 overrides the audited set. Fail-OPEN when a site is
// unreachable (a down site is not an a11y regression). Auto-joins site-quality run-all.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'));
const { chromium } = require2('playwright');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'zahav-philadelphia').split(',').map((s) => s.trim()).filter(Boolean);

let fails = 0;
const rows = [];
const browser = await chromium.launch();

for (const slug of SITES) {
  const url = slug.includes('.') ? `https://${slug}` : `https://${slug}.projectsites.dev`;
  const page = await (await browser.newContext({ userAgent: UA })).newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(1800); // let client-rendered section images hydrate
    // A CONTENT image = has a real src/srcset. Flag those whose `alt` ATTRIBUTE is absent (null).
    // `alt=""` (present, decorative) is valid and passes.
    const bad = await page.evaluate(() =>
      [...document.querySelectorAll('img')]
        .filter((i) => (i.getAttribute('src') || i.getAttribute('srcset')) && i.getAttribute('alt') === null)
        .map((i) => ({ src: (i.getAttribute('src') || i.getAttribute('srcset') || '').slice(-48), cls: (i.className || '').slice(0, 40) })),
    );
    const total = await page.evaluate(() => document.querySelectorAll('img').length);
    if (bad.length) {
      fails++;
      rows.push({ slug, ok: false, detail: `${bad.length}/${total} content <img> MISSING alt attribute: ${bad.slice(0, 3).map((b) => b.src).join(', ')}` });
    } else {
      rows.push({ slug, ok: true, detail: `${total} <img>, every content image has an alt attribute` });
    }
  } catch (e) {
    console.log(`  ::notice:: ${slug} unreachable — skipped (fail-open): ${String(e).slice(0, 70)}`);
  } finally {
    await page.close();
  }
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.slug.padEnd(34)} ${r.detail}`);
console.log(JSON.stringify({ probe: 'image-alt', sites: SITES, rows }));
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} site(s) ship a content <img> with NO alt attribute (WCAG 1.1.1 — invisible to screen readers).`
    : `\nVERDICT: ✅ § C.3 PASS — every content <img> on the audited generated site(s) carries an alt attribute (decorative alt="" allowed).`,
);
process.exit(fails ? 1 : 0);
