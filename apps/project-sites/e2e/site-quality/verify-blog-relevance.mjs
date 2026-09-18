// verify-blog-relevance.mjs — § C.7 (beat-the-source / on-brand content): a generated site's BLOG
// must read like the BUSINESS's own blog, NOT the platform's web-marketing content. Live defect
// (AL-740): every recent delivery — a Southern brunch spot, a fine-dining restaurant, an ART GALLERY
// — shipped the SAME 6 hardcoded posts about "Website speed & Core Web Vitals", "the local SEO
// checklist", "Google Business Profile optimization", "Google AI Overviews SEO". A restaurant blogging
// about web performance is off-brand filler that fails the beat-the-source bar (a real restaurant's
// blog is about food, not SEO). Root-fixed in the TEMPLATE `src/data/content.ts` — the default posts
// are now warm, universal, CUSTOMER-facing local-business topics (craft, people, community, welcome,
// neighborhood, seasons) that read naturally on ANY vertical.
//
// This gate asserts the deployed blog carries NO web-dev / SEO-jargon post titles or slugs — the
// class that keeps a customer's blog from sounding like a web agency's. RED before the fix lands
// (a pre-AL-740 build still ships the SEO posts) → GREEN once a site rebuilds with the template.
//
// Local Chromium ({slug}.projectsites.dev is CF-clean). Auto-joins run-all via the verify-*.mjs glob.
// Usage: SITES=<slug> node e2e/site-quality/verify-blog-relevance.mjs
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
  console.log('::notice:: verify-blog-relevance skipped — no site resolved');
  process.exit(0);
}
// The web-dev / SEO / search-marketing jargon that has no business on a local business's OWN blog.
const JARGON =
  /core web vitals|core-web-vitals|\bseo\b|local-seo|search engine optimi|google business profile|ai overview|answer engine|generative engine|largest contentful paint|\bLCP\b|\bINP\b|\bCLS\b|schema markup|backlink|serp|keyword ranking|page ?speed/i;

const browser = await chromium.launch();
const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) fails++; };

try {
  for (const slug of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const resp = await page.goto(`https://${slug}.projectsites.dev/blog`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    if (!resp || resp.status() >= 400) { check(`${slug} · /blog reachable`, false, `status=${resp ? resp.status() : 'ERR'}`); await ctx.close(); continue; }
    // /blog is an SPA route — the post links hydrate client-side. Wait for a real post link to
    // render (a bare waitForTimeout raced hydration → 0 posts → a false PASS). A blog with genuinely
    // 0 posts still fails this wait, which is itself a signal worth catching.
    const postsRendered = await page.waitForSelector('a[href*="/blog/"]', { timeout: 15000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(600);
    check(`${slug} · /blog renders post links`, postsRendered, postsRendered ? '' : 'no /blog/ links after 15s');

    const blog = await page.evaluate(() => {
      const titles = [...document.querySelectorAll('h1, h2, h3, a')].map((e) => (e.textContent || '').trim()).filter((t) => t.length > 8);
      const slugs = [...document.querySelectorAll('a[href]')]
        .map((a) => { try { return new URL(a.href, location.origin).pathname; } catch { return ''; } })
        .filter((p) => /^\/blog\/.+/.test(p));
      return { titles, slugs: [...new Set(slugs)] };
    });

    // No jargon in any post slug.
    const badSlugs = blog.slugs.filter((s) => JARGON.test(s));
    check(`${slug} · blog slugs are on-brand (no web-dev/SEO jargon)`, badSlugs.length === 0,
      badSlugs.length ? `bad: ${badSlugs.slice(0, 3).join(', ')}` : `${blog.slugs.length} posts, clean`);

    // No jargon in any visible heading/link text on the blog index.
    const badTitles = blog.titles.filter((t) => JARGON.test(t));
    check(`${slug} · blog titles read like the business, not a web agency`, badTitles.length === 0,
      badTitles.length ? `bad: "${badTitles[0].slice(0, 50)}"` : 'clean');

    await ctx.close();
  }
} catch (e) {
  check('blog-relevance audit completed', false, 'error: ' + String(e).slice(0, 120));
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(58)} ${r.detail}`);
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} blog(s) ship off-brand web-dev/SEO content instead of the business's own voice. Root: template content.ts (AL-740) lands next build.`
    : `\nVERDICT: ✅ PASS — every audited blog reads like the business's own (warm, on-brand topics), no web-dev/SEO-agency filler.`,
);
process.exit(fails ? 1 : 0);
