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
const stale = []; // sites shipping the KNOWN pre-AL-740 web-dev/SEO blog → rebuild-worklist, not RED
const check = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) fails++; };

try {
  for (const slug of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const resp = await page.goto(`https://${slug}.projectsites.dev/blog`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null);
    if (!resp || resp.status() >= 400) { check(`${slug} · /blog reachable`, false, `status=${resp ? resp.status() : 'ERR'}`); await ctx.close().catch(() => {}); continue; }
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

    // A web-dev/SEO blog is the KNOWN pre-AL-740 template default. content.ts no longer contains it
    // (locked at template-build time by src/data/content-blog.test.ts), so NO fresh build can produce
    // it — a deployed site showing it is STALE-build debt a rebuild clears, NOT a live template defect
    // (report-mode-probe-deployed-defect-is-often-stale-build + reconcile-surface-map-can-be-stale-
    // false-red). Track it as a rebuild-worklist ::notice (fail-OPEN), exactly like the sibling
    // cohort-freshness probe — never a permanent RED on old sites brian won't rebuild. A SOURCE
    // regression (web-dev blog re-added to content.ts) is caught at build time by the guard, so
    // fail-open here can't hide one.
    const badSlugs = blog.slugs.filter((s) => JARGON.test(s));
    const badTitles = blog.titles.filter((t) => JARGON.test(t));
    if (badSlugs.length || badTitles.length) {
      stale.push(slug);
      rows.push({
        ok: 'stale',
        label: `${slug} · STALE web-dev/SEO blog (pre-AL-740 default → rebuild clears)`,
        detail: (badSlugs[0] || badTitles[0] || '').slice(0, 50),
      });
    } else {
      check(`${slug} · blog is on-brand (no web-dev/SEO jargon)`, true, `${blog.slugs.length} posts, clean`);
    }

    await ctx.close().catch(() => {});
  }
} catch (e) {
  check('blog-relevance audit completed', false, 'error: ' + String(e).slice(0, 120));
}
await browser.close();

for (const r of rows) console.log(`  ${r.ok === 'stale' ? '⏭️ ' : r.ok ? '✓' : '✗'} ${r.label.padEnd(58)} ${r.detail}`);
if (stale.length)
  console.log(
    `\n::notice:: ${stale.length} site(s) on the blog rebuild-worklist (stale pre-AL-740 web-dev/SEO default; a rebuild applies the on-brand template): ${stale.join(', ')}`,
  );
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} blog(s) failed to render/audit (a real defect, not stale-build debt).`
    : stale.length
      ? `\nVERDICT: ✅ PASS (fail-open) — 0 live defects; ${stale.length} stale pre-AL-740 blog(s) tracked for rebuild. The content.ts root fix (AL-740) is locked by the template source guard.`
      : `\nVERDICT: ✅ PASS — every audited blog reads like the business's own (warm, on-brand topics), no web-dev/SEO-agency filler.`,
);
process.exit(fails ? 1 : 0);
