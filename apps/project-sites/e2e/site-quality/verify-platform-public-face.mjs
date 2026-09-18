// verify-platform-public-face.mjs — § D: the PLATFORM's own public face (projectsites.dev), gated.
//
// § D.1/D.2/D.3 were VERIFIED once (AL-197/198) but never had a DURABLE probe — so a regression on
// projectsites.dev's OWN marketing SEO / public routes / 404 status (a Worker HTMLRewriter break, a
// soft-404, a duplicate-title drift) would ship unnoticed while the generated-site (§ C) probes stay
// green. This closes that: it re-asserts the platform public face every run-all pass.
//
//   D.1/D.2 CONTENT routes (/, /blog, /changelog, /privacy, /terms, /pricing, /integrations,
//           /developers, /press) — HTTP 200 + server-injected <title> + <meta name=description> +
//           <link rel=canonical> + ≥1 JSON-LD; titles DISTINCT. (AL-776 added the 4 conversion/
//           developer/press marketing routes — real indexable pages with full SEO that were
//           previously UNGUARDED, so a meta-clobber / canonical drift there would ship unnoticed.)
//   /contact — an INTENTIONAL 301 → /search#contact-section (the funnel's contact surface); follow it
//           and assert the landing is 200 + full SEO (NOT a dead redirect).
//   /status — a system-status page, now SEO-ENRICHED (title + self-canonical + 120-156c description
//           shipped since AL-197). Public status pages ARE legit-indexable (cf. status.stripe.com),
//           so it's HARD-GATED on that full meta (below) — a regression stripping it goes RED, no
//           longer a soft ::notice.
//   D.3     — a bogus path returns a REAL 404 (not a soft-404 200); a real route returns 200.
//
// Fetch-based (the Worker injects SEO into the shell HTML, so curl sees it) → cheap + fast + durable.
// Auto-joins site-quality run-all via the verify-*.mjs glob. Hard-gates the content routes + /contact
// landing + 404 (the platform is OURS — those regressions are real bugs to fix now).
const BASE = process.env.PROD_URL || 'https://projectsites.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const CONTENT = ['/', '/blog', '/changelog', '/privacy', '/terms', '/pricing', '/integrations', '/developers', '/press'];

async function get(path, redirect = 'follow') {
  const res = await fetch(`${BASE}${path}`, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect });
  const html = res.status < 400 && res.status >= 200 ? await res.text() : '';
  return { status: res.status, html };
}
// apostrophe-safe extractors (delimiter backreference — a possessive must not truncate the capture).
const title = (h) => (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
const metaDesc = (h) => (h.match(/<meta[^>]+name=["']description["'][^>]*content=(["'])([\s\S]*?)\1/i)?.[2] || h.match(/<meta[^>]+content=(["'])([\s\S]*?)\1[^>]*name=["']description["']/i)?.[2] || '').trim();
const canonical = (h) => (h.match(/<link[^>]+rel=["']canonical["'][^>]*href=(["'])([\s\S]*?)\1/i)?.[2] || '').trim();
const jsonldCount = (h) => (h.match(/application\/ld\+json/gi) || []).length;

const rows = [];
let fails = 0;
const notices = [];
const check = (label, ok, detail) => { rows.push({ label, ok, detail }); if (!ok) fails++; };
const titles = [];

// CONTENT routes — full server-injected SEO.
for (const path of CONTENT) {
  const { status, html } = await get(path);
  if (status !== 200) { check(`${path} → 200`, false, `status ${status}`); continue; }
  const t = title(html), d = metaDesc(html), c = canonical(html), j = jsonldCount(html);
  titles.push({ path, t });
  check(`${path} — 200 + full SEO head`, t.length > 0 && d.length > 0 && c.length > 0 && j >= 1,
    `title=${t.length}c desc=${d.length}c canonical=${c ? '✓' : '✗'} jsonld=${j}`);
}
const dupes = titles.filter((r, i) => titles.findIndex((x) => x.t === r.t) !== i && r.t);
check('every CONTENT route has a DISTINCT <title> (no SEO collision)', dupes.length === 0,
  dupes.length ? `dupes: ${dupes.map((d) => d.path).join(',')}` : `${titles.length} distinct`);

// /contact — intentional redirect to the funnel's contact surface; follow → 200 + real SEO.
const contact = await get('/contact', 'follow');
check('/contact bridges (follow-redirect) to a live 200 + JSON-LD surface', contact.status === 200 && jsonldCount(contact.html) >= 1,
  `final=${contact.status} jsonld=${jsonldCount(contact.html)}`);

// /status — utility route, now SEO-ENRICHED (was a tracked ::notice; the enrichment shipped):
// a public system-status page is a legit-indexable target (cf. status.stripe.com), so hard-gate
// 200 + title + a self-referential canonical + a real meta-description. A regression that strips
// the status page's server meta now goes RED instead of a soft notice.
const status = await get('/status', 'follow');
const sTitle = title(status.html);
const sCanon = canonical(status.html);
const sDesc = metaDesc(status.html);
check('/status — 200 + renders a title (utility page)', status.status === 200 && sTitle.length > 0, `status=${status.status} title="${sTitle}"`);
check('/status — self-referential <link rel=canonical> (SEO-enriched)', /\/status$/.test(sCanon), `canonical="${sCanon}"`);
check('/status — <meta name=description> present, 120-156c', sDesc.length >= 120 && sDesc.length <= 156, `desc=${sDesc.length}c`);

// D.3 — real 404 status (not a soft-404 200), and a real route stays 200.
const bogus = await get(`/this-does-not-exist-xyz-${Date.now()}`, 'manual');
check('bogus path returns a REAL 404 (no soft-404 200)', bogus.status === 404, `bogus → ${bogus.status}`);
check('a real route stays 200 (no false-404)', (await get('/')).status === 200, 'homepage 200');

for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(52)} ${r.detail}`);
for (const n of notices) console.log(`  ::notice:: ${n}`);
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} platform-public-face break(s) on projectsites.dev (§ D regression).`
    : `\nVERDICT: ✅ PASS — platform public face solid: ${CONTENT.length} content routes 200 + distinct SEO + JSON-LD, /contact bridges live, real 404 status.${notices.length ? ' (see ::notice for /status SEO enrichment)' : ''}`,
);
process.exit(fails ? 1 : 0);
