// verify-build-invariants.mjs — COMPLETION § C.1: do DEPLOYED generated sites actually meet the
// build_validators invariants ON PROD? The validators run in REPORT mode (log to D1, never block),
// so a site can ship with gaps. This audits the LIVE product — the truthful/render-integrity check
// applied to `{slug}.projectsites.dev` (not the admin). Fetch-based (the site HTML is curl-gettable
// with a real UA); no browser needed for HTML + headers.
//
// Mirrors the thresholds in `src/services/build_validators.ts`: title 50-60 · desc 120-156 ·
// JSON-LD ≥4 blocks (WebSite+Organization+WebPage+BreadcrumbList) · exactly 1 H1 · required files
// 200 · sitemap <lastmod> · no banned-slop. Fixes are ROOT-CAUSE in the TEMPLATE / site-gen prompt
// (land next build) — never a one-off patch to one deployed site.
//
// Usage: SITES=vanta-strength-austin,ironhaus-houston node e2e/site-quality/verify-build-invariants.mjs
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Upgrade-Insecure-Requests': '1' };
const SITES = (process.env.SITES || 'vanta-strength-austin,ironhaus-houston').split(',');
const REQUIRED = ['robots.txt', 'llms.txt', 'sitemap.xml', 'site.webmanifest', 'favicon.ico', 'humans.txt', '.well-known/security.txt', 'apple-touch-icon.png'];
const BANNED = /\b(limitless|revolutioniz|cutting-edge|world-class|leverage|best-in-class|game-chang|paradigm|synergy|unparalleled|seamless(ly)?|unlock your)\b/i;

async function get(url) {
  try { const r = await fetch(url, { headers: H, redirect: 'follow', signal: AbortSignal.timeout(20000) }); return { status: r.status, body: r.status === 200 ? await r.text() : '' }; }
  catch (e) { return { status: 0, body: '', err: String(e).slice(0, 60) }; }
}
const textOf = (html, re) => { const m = re.exec(html); return m ? m[1].replace(/\s+/g, ' ').trim() : ''; };

let totalFails = 0;
const perSite = [];
for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const home = await get(`${base}/`);
  const html = home.body;
  const fails = [];
  const flag = (cond, code, detail) => { if (!cond) { fails.push(`${code} — ${detail}`); } };

  // Guard: got the REAL site (challenge pages have no real <title>/<h1>).
  const title = textOf(html, /<title[^>]*>([^<]*)<\/title>/i);
  const isChallenge = /just a moment\b|checking your browser before|cf_chl_opt|turnstile/i.test(html) && !title;
  if (home.status !== 200 || isChallenge || !title) {
    perSite.push({ slug, note: `NOT AUDITABLE — status=${home.status} challenge=${isChallenge} title="${title}"` });
    continue;
  }

  // Meta title + description length.
  flag(title.length >= 50 && title.length <= 60, 'meta.title_length', `title ${title.length} chars ("${title.slice(0, 40)}") — want 50-60`);
  // Extract the description tag (any attribute order), then read `content` with a
  // backreference so the capture respects the value's OWN delimiter. A plain [^"'] class
  // truncates a valid double-quoted value at the first apostrophe (content="Seattle's
  // dependable…" → "Seattle" = a false 7-char FAIL on EVERY possessive business name —
  // the generated meta uses "{City}'s dependable choice for {vertical}"). Mirrors
  // build_validators.ts metaDescText so the probe + the build gate never drift.
  const descTag = /<meta\s+[^>]*\bname=["']description["'][^>]*>/i.exec(html);
  const desc = descTag ? (/\bcontent=(["'])([\s\S]*?)\1/i.exec(descTag[0]) || [])[2]?.trim() || '' : '';
  flag(desc.length >= 120 && desc.length <= 156, 'meta.description_length', `desc ${desc.length} chars — want 120-156`);

  // JSON-LD ≥4 REAL blocks. Count actual <script type="application/ld+json"> tags with
  // non-empty bodies — NOT the bare `application/ld+json` marker, which over-counts: the
  // template's "open-now" widget contains `querySelector('script[type="application/ld+json"]')`,
  // so the marker approach reported 1 when the shell truly had 0 blocks (verified 2026-09-07),
  // masking the real gap. Attribute-order-robust; a curl shell can't see purely client-injected
  // JSON-LD, but crawlers read the shell, so a low shell count is a real SEO/GEO gap regardless.
  const jsonld = (
    html.match(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []
  ).filter((b) => b.replace(/<script\b[^>]*>|<\/script>/gi, '').trim().length > 0).length;
  flag(jsonld >= 4, 'jsonld.count_below_threshold', `${jsonld} blocks — want ≥4 (WebSite+Organization+WebPage+BreadcrumbList)`);

  // Exactly 1 H1 in the shell.
  const h1 = (html.match(/<h1[\s>]/gi) || []).length;
  flag(h1 === 1, 'html.h1_count', `${h1} <h1> — want exactly 1`);

  // color-scheme meta.
  flag(/<meta[^>]+name=["']color-scheme["']/i.test(html), 'meta.color_scheme_missing', 'no <meta name="color-scheme">');

  // Banned slop in visible-ish text.
  const slop = BANNED.exec(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''));
  flag(!slop, 'copy.banned_word', slop ? `found "${slop[0]}"` : '');

  // Required files 200.
  const missing = [];
  for (const f of REQUIRED) { const r = await get(`${base}/${f}`); if (r.status !== 200) missing.push(`${f}(${r.status})`); }
  flag(missing.length === 0, 'manifest.required_file_missing', missing.join(' '));

  // Sitemap lastmod.
  const sm = await get(`${base}/sitemap.xml`);
  if (sm.status === 200) flag(/<lastmod>/i.test(sm.body), 'sitemap.missing_lastmod', 'sitemap.xml has no <lastmod>');

  totalFails += fails.length;
  perSite.push({ slug, title, jsonld, h1, descLen: desc.length, fails });
}

for (const s of perSite) {
  if (s.note) { console.log(`  ·  ${s.slug}  ${s.note}`); continue; }
  console.log(`  ${s.fails.length ? '✗' : '✓'} ${s.slug}  (title=${s.title.length}c jsonld=${s.jsonld} h1=${s.h1} desc=${s.descLen}c)`);
  for (const f of s.fails) console.log(`        ✗ ${f}`);
}
console.log(
  totalFails
    ? `\nVERDICT: ❌ FAIL — ${totalFails} build_validators invariant violation(s) LIVE on deployed generated sites (fix at the TEMPLATE / site-gen root, lands next build).`
    : `\nVERDICT: ✅ PASS — deployed generated sites meet the build_validators invariants on prod.`,
);
process.exit(totalFails ? 1 : 0);
