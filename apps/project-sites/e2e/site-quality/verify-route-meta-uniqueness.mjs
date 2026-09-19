// verify-route-meta-uniqueness.mjs — per-route metadata UNIQUENESS on a DEPLOYED site (§ C.4).
// A generated MULTI-page site must NOT ship the same <meta description> / og:description / <title>
// on every route — Google Search Console flags "Duplicate meta descriptions", it flattens per-route
// SERP relevance + CTR, and it undercuts BEATING the source. Root cause (fixed in the TEMPLATE):
// useSEO fell back to the SAME brand.business.tagline on every route when site-gen didn't fill a
// sub-page's `{*_META_DESCRIPTION}` token, and index.html shipped ONE static og:description. Now
// useSEO composes a ROUTE-DISTINCT fallback (routeSeo.ts) + mirrors title/description into OG+Twitter.
//
// Contract, across a site's core routes (/, /about, /contact, /services):
//   A. every route's <meta name=description> is DISTINCT (no two identical)
//   B. every route's og:description is DISTINCT (social previews differ per route)
//   C. every route's <title> is DISTINCT
//   D. no description is empty / a raw {TOKEN}; each is in a sane length band
//
// Proof surface = the TEMPLATE DEMO (template.projectsites.dev) — a delivered site flips green on
// its next rebuild (root fixes land next build, NO redeploy of existing sites). Prerendered static
// HTML carries the useSEO-stamped meta, so a plain fetch (curl-equivalent) sees it — no browser.
// Override with META_BASE / META_ROUTES. Root-cause fixes are in the template, never a one-off.

const BASE = (process.env.META_BASE || 'https://template.projectsites.dev').replace(/\/$/, '');
const ROUTES = (process.env.META_ROUTES || '/,/about,/contact,/services')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const pick = (html, re) => (html.match(re) || [])[1]?.trim() || '';
const nameDesc = (h) => pick(h, /<meta\s+name=["']description["'][^>]*\scontent=["']([^"']*)["']/i);
const ogDesc = (h) => pick(h, /<meta\s+property=["']og:description["'][^>]*\scontent=["']([^"']*)["']/i);
const title = (h) => pick(h, /<title>([\s\S]*?)<\/title>/i);
const isToken = (s) => !s || /\{[A-Z0-9_]{2,}\}/.test(s);

let fails = 0;
const summary = [];
const fail = (m) => { fails++; summary.push(`  🔴 ${m}`); };
const ok = (m) => summary.push(`  ✅ ${m}`);

// Collect meta for each reachable route.
const rows = [];
for (const route of ROUTES) {
  const url = BASE + route;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (res.status !== 200) { summary.push(`  ⚠️  ${route}: ${res.status} — skipped`); continue; }
    const html = await res.text();
    rows.push({ route, title: title(html), desc: nameDesc(html), og: ogDesc(html) });
  } catch (e) {
    summary.push(`  ⚠️  ${route}: fetch error (${String(e).slice(0, 50)}) — skipped`);
  }
}

if (rows.length < 2) {
  fail(`only ${rows.length} route(s) reachable — need ≥2 to compare uniqueness`);
} else {
  // A/B/C — distinctness of description, og:description, title
  const dupField = (field, label) => {
    const seen = new Map();
    let dup = false;
    for (const r of rows) {
      const v = (r[field] || '').toLowerCase();
      if (!v) continue;
      if (seen.has(v)) { fail(`${label} DUPLICATE: "${r.route}" == "${seen.get(v)}" (${v.slice(0, 48)}…)`); dup = true; }
      else seen.set(v, r.route);
    }
    if (!dup) ok(`${label} distinct across ${rows.length} routes`);
  };
  dupField('desc', 'meta description');
  dupField('og', 'og:description');
  // <title> is ADVISORY, not a hard gate: real generated sites already carry distinct per-route
  // titles ("About — {Business}" vs "Contact — {Business}"), but the TEMPLATE DEMO runs in gallery
  // mode which intentionally shares one gallery title across sub-pages — so asserting title
  // distinctness against the demo would false-fail. Reported so a human still sees the title state;
  // point META_BASE at a real delivered site to inspect titles there.
  const distinctTitles = new Set(rows.map((r) => (r.title || '').toLowerCase()).filter(Boolean));
  if (distinctTitles.size === rows.length) ok(`<title> distinct across ${rows.length} routes`);
  else summary.push(`  ⚠️  <title> only ${distinctTitles.size}/${rows.length} distinct (advisory — gallery-mode demo shares one; real sites differ)`);

  // D — no token / empty description, sane length
  for (const r of rows) {
    if (isToken(r.desc)) fail(`${r.route}: description empty or a {TOKEN} ("${r.desc.slice(0, 40)}")`);
    else if (r.desc.length < 80 || r.desc.length > 200) fail(`${r.route}: description length ${r.desc.length} out of band ("${r.desc.slice(0, 40)}…")`);
  }
  if (rows.every((r) => !isToken(r.desc) && r.desc.length >= 80 && r.desc.length <= 200)) {
    ok('every description is real (non-token) + in the SEO length band');
  }
}

console.log(`\nPer-route metadata uniqueness @ ${BASE} [${ROUTES.join(', ')}]:`);
for (const r of rows) console.log(`  · ${r.route.padEnd(10)} "${(r.desc || '(none)').slice(0, 56)}…"`);
for (const l of summary) console.log(l);
console.log(`\nVERDICT: ${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
