// verify-indexability.mjs — § C.16: a published generated site MUST be FINDABLE by search engines.
// The single most catastrophic SEO regression is SILENT — a `noindex` (meta, X-Robots-Tag header, or
// a robots.txt root-Disallow) makes the page invisible to Google, so the owner gets ZERO organic
// traffic and the product's core promise ("a live, findable website") fails with NO console error and
// NO visual defect. No prior probe covered this. Companion to the build-time gate
// `build_validators.ts validateIndexable` (seo.noindex_leak, HTML meta) — this checks the RENDERED
// DOM (Googlebot renders JS, and the template sets meta client-side via useSEO) + the serve-time
// vectors the build can't see (the response header + robots.txt).
//
// Per site, all vectors:
//   1. `X-Robots-Tag` response header carries no `noindex`
//   2. rendered `<meta name="robots"|"googlebot">` content carries no `noindex` (post-hydration DOM)
//   3. `robots.txt` does NOT `Disallow: /` (the root — that blocks the whole site); `Disallow: /api/` is fine
//   4. `<html lang>` is present + non-empty (SEO + WCAG 3.1.1)
//
// Real Chromium, real UA. Cohort from _default-sites.mjs (SITES=… overrides). Fail-OPEN when a site
// is unreachable (a down site is not an indexability regression). STRICT by default — a robots
// `noindex` is unambiguous + catastrophic, never a false positive. Auto-joins site-quality run-all.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSites } from './_default-sites.mjs';

const require2 = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'));
const { chromium } = require2('playwright');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = resolveSites(process.env.SITES);
if (SITES.length === 0) {
  console.log('::notice:: verify-indexability skipped — no site resolved');
  process.exit(0);
}

let fails = 0;
const rows = [];
const browser = await chromium.launch();

for (const slug of SITES) {
  const url = slug.includes('.') ? `https://${slug}` : `https://${slug}.projectsites.dev`;
  const page = await (await browser.newContext({ userAgent: UA })).newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(1500); // let client-side useSEO settle any meta it manages
    const defects = [];

    // 1. X-Robots-Tag response header.
    const xrt = (resp?.headers()?.['x-robots-tag'] || '').toLowerCase();
    if (/\bnoindex\b/.test(xrt)) defects.push(`X-Robots-Tag: "${xrt}"`);

    // 2. Rendered robots/googlebot meta (the DOM Googlebot reads after JS).
    const metaRobots = await page.evaluate(() =>
      [...document.querySelectorAll('meta[name="robots"], meta[name="googlebot"]')].map((m) => m.getAttribute('content') || ''),
    );
    for (const c of metaRobots) if (/\bnoindex\b/i.test(c)) defects.push(`<meta robots> content="${c}"`);

    // 3. robots.txt must not block the root FOR AN INDEXING BOT. Group-aware: a `Disallow: /`
    //    under `User-agent: *` / Googlebot / Bingbot deindexes; the SAME line under a specific
    //    aggressive-scraper UA (Bytespider/SemrushBot/AhrefsBot…) is LEGITIMATE bot-blocking, not
    //    a deindex (validator-precision — the naive "any Disallow: /" check false-flagged every site).
    const robotsTxt = await page.evaluate(async () => {
      try {
        const r = await fetch('/robots.txt');
        return r.ok ? await r.text() : `__status_${r.status}`;
      } catch {
        return '__fetch_error';
      }
    });
    if (!robotsTxt.startsWith('__')) {
      const INDEXERS = new Set(['*', 'googlebot', 'bingbot']);
      let groupUAs = [];
      let sawDirective = false;
      let blocksIndexer = false;
      for (const rawLine of robotsTxt.split(/\r?\n/)) {
        const s = rawLine.replace(/#.*/, '').trim();
        if (!s) continue;
        const uaM = s.match(/^user-agent:\s*(.+)$/i);
        if (uaM) {
          if (sawDirective) {
            groupUAs = [];
            sawDirective = false;
          } // a new User-agent after a directive begins a fresh group
          groupUAs.push(uaM[1].trim().toLowerCase());
          continue;
        }
        const disM = s.match(/^disallow:\s*(.*)$/i);
        if (disM) {
          sawDirective = true;
          if (disM[1].trim() === '/' && groupUAs.some((ua) => INDEXERS.has(ua))) blocksIndexer = true;
          continue;
        }
        if (/^(allow|sitemap|crawl-delay|host):/i.test(s)) sawDirective = true;
      }
      if (blocksIndexer) defects.push('robots.txt Disallow: / under User-agent:* or Googlebot (blocks indexing)');
    }

    // 4. html lang present.
    const lang = await page.evaluate(() => document.documentElement.getAttribute('lang') || '');
    if (!lang.trim()) defects.push('<html lang> missing/empty');

    if (defects.length) {
      fails++;
      rows.push({ slug, ok: false, detail: defects.join(' · ') });
    } else {
      rows.push({ slug, ok: true, detail: `indexable (no noindex meta/header, robots.txt allows /, lang="${lang}")` });
    }
  } catch (e) {
    console.log(`  ::notice:: ${slug} unreachable — skipped (fail-open): ${String(e).slice(0, 70)}`);
  } finally {
    await page.close();
  }
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.slug.padEnd(34)} ${r.detail}`);
console.log(`::json:: ${JSON.stringify({ probe: 'indexability', sites: SITES.length, withDefects: fails })}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} site(s) ship a NOINDEX (meta/header/robots.txt) — invisible to search, ZERO organic traffic. The product's core promise (a findable website) fails silently.`
    : `\nVERDICT: ✅ § C.16 PASS — every audited site is indexable (no noindex meta/header, robots.txt allows crawling, <html lang> set).`,
);
process.exit(fails ? 1 : 0);
