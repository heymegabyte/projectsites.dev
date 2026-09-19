// verify-route-meta-uniqueness.mjs — per-route metadata UNIQUENESS on DEPLOYED sites (§ C.4).
// A generated MULTI-page site must NOT ship the same <meta description> / og:description / <title>
// on every route — Search Console flags "Duplicate meta descriptions"; it flattens per-route SERP
// relevance + CTR and undercuts BEATING the source. A pure client-rendered site serves ONE index.html
// per route (SPA fallback), so the crawler-visible head is finalized at SERVE time: the worker rewrites
// title/canonical/JSON-LD AND (fix 2026-09-19) `applyServedRouteDescription` — a route-distinct
// <meta description>/og/twitter composed from the business name + city. This probe guards that fleet-wide.
//
// Contract, across each site's core routes (/, /about, /contact, /services):
//   A. every route's <meta name=description> is DISTINCT (no two identical)
//   B. every route's og:description is DISTINCT (social previews differ per route)
//   C. every route's <title> is DISTINCT (HARD on delivered sites; advisory on the gallery-mode demo)
//   D. no description is empty / a raw {TOKEN}; each is in a sane length band
//
// DEFAULT = the delivered-site cohort (_default-sites.mjs) so run-all guards the FLEET, not just the
// demo. Override a single surface with META_BASE (e.g. the template demo) / META_ROUTES. The served
// HTML carries the finalized meta, so a plain fetch (curl-equivalent) sees it — no browser.
import { resolveSites } from './_default-sites.mjs';

const ROUTES = (process.env.META_ROUTES || '/,/about,/contact,/services')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
// META_BASE = a single explicit surface (demo / one site). Else guard the whole delivered cohort.
const BASES = process.env.META_BASE
  ? [process.env.META_BASE.replace(/\/$/, '')]
  : resolveSites(process.env.SITES).map((s) => `https://${s}.projectsites.dev`);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const pick = (html, re) => (html.match(re) || [])[1]?.trim() || '';
const nameDesc = (h) => pick(h, /<meta\s+name=["']description["'][^>]*\scontent=["']([^"']*)["']/i);
const ogDesc = (h) => pick(h, /<meta\s+property=["']og:description["'][^>]*\scontent=["']([^"']*)["']/i);
const titleOf = (h) => pick(h, /<title>([\s\S]*?)<\/title>/i);
const isToken = (s) => !s || /\{[A-Z0-9_]{2,}\}/.test(s);
const hostOf = (base) => base.replace(/^https?:\/\//, '').split('.')[0];

let fails = 0;
const summary = [];
const fail = (m) => { fails++; summary.push(`  🔴 ${m}`); };
const ok = (m) => summary.push(`  ✅ ${m}`);
const advise = (m) => summary.push(`  ⚠️  ${m}`);

async function checkSite(base) {
  const isDemo = base.includes('template.projectsites.dev');
  const host = hostOf(base);
  const rows = [];
  for (const route of ROUTES) {
    try {
      const res = await fetch(base + route, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (res.status !== 200) { advise(`${host}${route}: ${res.status} — skipped`); continue; }
      const html = await res.text();
      rows.push({ route, title: titleOf(html), desc: nameDesc(html), og: ogDesc(html) });
    } catch (e) {
      advise(`${host}${route}: fetch error (${String(e).slice(0, 40)}) — skipped`);
    }
  }
  if (rows.length < 2) { fail(`${host}: only ${rows.length} route(s) reachable — need ≥2`); return; }

  // A/B/C — distinctness. `hard` = a real gate (fail); else advisory (the gallery-mode demo shares
  // one title across sub-pages by design, so title is advisory there but a hard gate on real sites).
  const dupField = (field, label, hard) => {
    const seen = new Map();
    let dup = false;
    for (const r of rows) {
      const v = (r[field] || '').toLowerCase();
      if (!v) continue;
      if (seen.has(v)) {
        const msg = `${host} ${label} DUPLICATE: "${r.route}" == "${seen.get(v)}" (${v.slice(0, 40)}…)`;
        hard ? fail(msg) : advise(`${msg} — advisory (gallery-mode demo)`);
        dup = true;
      } else seen.set(v, r.route);
    }
    if (!dup) ok(`${host}: ${label} distinct across ${rows.length} routes`);
  };
  dupField('desc', 'meta description', true);
  dupField('og', 'og:description', true);
  dupField('title', '<title>', !isDemo);

  // D — no token / empty description, sane length
  for (const r of rows) {
    if (isToken(r.desc)) fail(`${host}${r.route}: description empty or a {TOKEN} ("${r.desc.slice(0, 32)}")`);
    else if (r.desc.length < 80 || r.desc.length > 200) fail(`${host}${r.route}: description length ${r.desc.length} out of band`);
  }
}

console.log(`\nPer-route metadata uniqueness across ${BASES.length} site(s) [${ROUTES.join(', ')}]:`);
for (const base of BASES) {
  console.log(`\n── ${base}`);
  await checkSite(base);
}
for (const l of summary) console.log(l);
console.log(`\nVERDICT: ${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failure(s) across ${BASES.length} site(s)`);
process.exit(fails === 0 ? 0 : 1);
