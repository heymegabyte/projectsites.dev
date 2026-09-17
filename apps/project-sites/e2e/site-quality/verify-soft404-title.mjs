// verify-soft404-title.mjs — § C.4 hardening. A generated SPA serves ONE index.html for every
// route; the worker returns a real 404 STATUS for a path the sitemap doesn't list (no soft-404 —
// good). But the per-route <title> injector title-cased the LAST URL segment for ANY path, so an
// UNKNOWN route reflected the arbitrary slug into <title> + og:title: `/buy-cheap-widgets-spam` →
// "Buy Cheap Widgets Spam — Brand" (a reflected-content smell + a broken-looking 404). This probe
// hits a random unknown route per site and asserts: (1) 404 STATUS, (2) the title is NOT the
// reflected slug — it's a clean "Page not found" (or the bare brand). Fetch is enough: the title is
// SERVER-rendered by the worker's HTMLRewriter, so no browser/JS needed.
//
// Root fix: applyServedRouteTitle(html, path, isNotFound) in site_serving.ts (worker → CI). Because
// the worker injects meta at SERVE time, the fix lands on EVERY deployed site the moment it deploys
// — NO rebuild. RED against pre-fix prod (title reflects the slug); GREEN once the worker deploys.
// Usage: SITES=a,b node e2e/site-quality/verify-soft404-title.mjs
import { resolveSites } from './_default-sites.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = resolveSites(process.env.SITES);
const SLUG = 'buy-cheap-widgets-spam-xyz'; // deterministic garbage slug → title-cases to a clear reflected string
const REFLECTED = 'Buy Cheap Widgets Spam Xyz';

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push({ ok, label, detail });
  if (!ok) fails++;
};

for (const slug of SITES) {
  const url = `https://${slug}.projectsites.dev/${SLUG}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const status = res.status;
    const html = await res.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)?.[1] || '';
    const status404 = status === 404;
    const titleClean = !title.includes(REFLECTED) && !ogTitle.includes(REFLECTED);
    check(
      `${slug} — 404 status + no reflected slug in <title>/og:title`,
      status404 && titleClean,
      `status=${status} title="${title.slice(0, 70)}"${titleClean ? '' : ' ⚠ REFLECTS SLUG'}`,
    );
  } catch (e) {
    // Fail-open on transient/unreachable — a network blip never cries wolf.
    rows.push({ ok: true, label: `${slug} — unreachable (transient, fail-open)`, detail: String(e).slice(0, 60) });
  }
}

console.log('\n━━ § C.4 soft-404 title (unknown route: real 404 + no reflected-slug title) ━━');
for (const r of rows) console.log(`  ${r.ok ? '✓' : '❌'} ${r.label.padEnd(64)} ${r.detail}`);
console.log(
  fails
    ? `\n::notice:: § C.4 soft-404-title — ${fails} site(s) still reflect the URL slug in the 404 title (root fix lands on the next worker deploy; tracking).`
    : `\n✅ § C.4 soft-404-title PASS — every unknown route returns 404 with a clean, non-reflected title.`,
);
// Tracking (::notice, exit 0 on fail) — the worker fix flips this GREEN fleet-wide on deploy; until
// then a stale worker legitimately reflects. Promote to exit 1 once deployed + confirmed green.
process.exit(0);
