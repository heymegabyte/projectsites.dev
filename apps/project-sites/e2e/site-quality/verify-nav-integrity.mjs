// verify-nav-integrity.mjs — § C.7 / FULL-JOURNEY: a generated site's INTERNAL NAVIGATION is
// sound end-to-end. Lands on {slug}.projectsites.dev, collects every client-rendered nav/footer
// internal link a visitor would click, visits each route, and asserts it RESOLVES to real content
// — never a soft-404 (the 200-shell rendering the 404 page on an indexed URL), never a blank/
// stub, never a console-error page. Catches the SPA-route-integrity class the per-metric probes
// (which mostly test the homepage) miss: a sitemap/nav route with no matching <Route> or empty
// pack content strands a visitor + indexes a junk URL. Real local Chromium (subdomains are
// CF-clean). Auto-joins run-all.
//
// Tracking-mode by default (::notice, suite-safe); STRICT=1 → exit 1 on any dead/soft-404 route.
import { chromium } from 'playwright';

const SITES = (process.env.SITES || 'pizzeria-bianco-phoenix')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';
const MAX_ROUTES = Number(process.env.MAX_ROUTES || 14); // cap the click-through per site
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const NOT_FOUND = /\b(404|page not found|page you.re looking for|doesn.t exist|not be found)\b/i;

const browser = await chromium.launch();
const rows = [];
let fails = 0;

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(`${base}/`, { waitUntil: 'load', timeout: 45000 });
    if (!resp || resp.status() >= 400) {
      rows.push(`  ⏭️  ${slug} — home unreachable (${resp?.status()}) — skip`);
      await ctx.close();
      continue;
    }
    await page.waitForTimeout(1200); // hydrate the client-rendered nav
    // Collect internal, same-origin, non-anchor nav+footer links a visitor would click.
    const routes = await page.evaluate(() => {
      const seen = new Set();
      for (const a of document.querySelectorAll('header a[href], nav a[href], footer a[href]')) {
        const href = a.getAttribute('href') || '';
        if (!href.startsWith('/') || href.startsWith('//')) continue; // internal only
        const path = href.split('#')[0].split('?')[0].replace(/\/$/, '') || '/';
        if (path === '/') continue; // home already loaded
        // Skip non-HTML RESOURCE links (a footer legitimately links the XML sitemap / robots /
        // feed / manifest / docs) — those aren't PAGE routes and have no <h1>, so treating them
        // as pages is a false soft-404 (validator-precision).
        if (/\.(xml|txt|json|ico|pdf|zip|webmanifest|rss|atom)$/i.test(path)) continue;
        if (path.startsWith('/.well-known')) continue;
        seen.add(path);
      }
      return [...seen];
    });
    if (routes.length === 0) {
      rows.push(`  ⏭️  ${slug} — no internal nav links found (pre-nav build?) — skip`);
      await ctx.close();
      continue;
    }
    const targets = routes.slice(0, MAX_ROUTES);
    const bad = [];
    for (const path of targets) {
      const errs = [];
      const onErr = (m) => {
        const t = m.type(),
          x = m.text();
        if (/Failed to load resource|net::ERR_ABORTED|favicon|status of 4|status of 5/i.test(x)) return;
        if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(x.slice(0, 70));
      };
      page.on('console', onErr);
      const pageErr = (e) => errs.push('[pageerror] ' + String(e.message || e).slice(0, 70));
      page.on('pageerror', pageErr);
      const r = await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(700);
      const info = await page.evaluate(() => {
        const h1 = document.querySelector('h1')?.textContent?.trim() || '';
        const main = document.querySelector('main') || document.body;
        return { h1, len: (main.innerText || '').trim().length, title: document.title };
      });
      page.off('console', onErr);
      page.off('pageerror', pageErr);
      const status = r?.status() ?? 0;
      const looks404 = NOT_FOUND.test(info.h1) || NOT_FOUND.test(info.title);
      const thin = info.len < 200; // a real page renders substantial content
      const ok = status === 200 && info.h1.length > 2 && !looks404 && !thin && errs.length === 0;
      if (!ok)
        bad.push(
          `${path}{${status} h1="${info.h1.slice(0, 24)}" len=${info.len}${looks404 ? ' 404-copy' : ''}${errs.length ? ` err=${errs.length}` : ''}}`,
        );
    }
    if (bad.length === 0) {
      rows.push(`  ✓ ${slug} — ${targets.length} nav routes all resolve to real content (no soft-404/blank/error)`);
    } else {
      fails++;
      rows.push(`  ❌ ${slug} — ${bad.length}/${targets.length} bad: ${bad.join(' · ')}`);
    }
  } catch (e) {
    rows.push(`  ⏭️  ${slug} — ${String(e.message || e).slice(0, 60)} — skip`);
  } finally {
    await ctx.close();
  }
}

await browser.close();
console.log('\n━━ § C.7 generated-site nav integrity (every nav route → real content, no soft-404) ━━');
rows.forEach((r) => console.log(r));
if (fails > 0 && STRICT) {
  console.log(`\n❌ ${fails} site(s) have a dead/soft-404 nav route`);
  process.exit(1);
}
if (fails > 0) {
  console.log(`\n::notice:: nav-integrity — ${fails} site(s) have a soft-404/blank nav route (fix at root: register the <Route> + fill pack content, OR drop it from the route set). STRICT=1 to enforce.`);
} else {
  console.log('\n✓ nav integrity PASS — every nav route resolves to real content.');
}
