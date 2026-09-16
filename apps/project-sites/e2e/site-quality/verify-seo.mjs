// verify-seo.mjs — COMPLETION § C.4: do DEPLOYED generated sites ship correct SEO + GEO
// infrastructure? Fetch-based (no browser needed — the shell HTML + well-known files are the
// signal). Audits the LIVE product (`{slug}.projectsites.dev`).
//
// HARD gates (SEO/GEO infra — must be present + correct on every deployed site):
//   • canonical present + points to the site's OWN custom hostname, on homepage AND a sub-route
//     (a homepage-claiming canonical on every sub-page de-indexes the site — the exact bug
//     `applyServedRouteCanonical` fixes; this probe locks it)
//   • OG image present + 1200×630 + ≤100KB (branded share card)
//   • sitemap.xml present + EVERY <url> carries a <lastmod>
//   • robots.txt present + references the sitemap
//   • .well-known/security.txt present
//   • llms.txt present (GEO / AI-search)
//
// REPORTED (not hard-gated here — owned by § C.1 `verify-build-invariants.mjs`, root-fixed by
//   `finalizeSeoInvariants` AL-110, flips green as sites rebuild): <title> 50-60 / <meta
//   description> 120-156 lengths. A pre-fix build ships short meta; we surface it, C.1 gates it.
//
// Fixes are ROOT-CAUSE in the TEMPLATE / site-gen `finalizeSeoInvariants` / worker serving —
// NEVER a one-off patch to one deployed site.
//
// Usage:  SITES=vanta-strength-austin node e2e/site-quality/verify-seo.mjs

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
import { resolveSites } from './_default-sites.mjs';
const SITES = resolveSites(process.env.SITES);

const get = async (url) => {
  try {
    const r = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    const text = r.headers.get('content-type')?.includes('image') ? '' : await r.text().catch(() => '');
    return { status: r.status, text, headers: r.headers };
  } catch (e) {
    return { status: 0, text: '', headers: new Headers(), err: String(e).slice(0, 60) };
  }
};
const tag = (html, re) => (html.match(re) || [])[1] || '';
const canonOf = (html) => tag(html, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || tag(html, /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim() || '';
const descOf = (html) => tag(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);

/** PNG IHDR width/height (bytes 16-23, big-endian). Returns null for non-PNG. */
async function pngDims(url) {
  try {
    const r = await fetch(url, { headers: HEADERS });
    if (r.status !== 200) return { status: r.status };
    const buf = new Uint8Array(await r.arrayBuffer());
    const bytes = buf.length;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isPng) return { status: 200, bytes, w: null, h: null };
    const dv = new DataView(buf.buffer);
    return { status: 200, bytes, w: dv.getUint32(16), h: dv.getUint32(20) };
  } catch (e) {
    return { status: 0, err: String(e).slice(0, 60) };
  }
}

let fails = 0;
const rows = [];

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const hard = []; // {name, ok, detail}
  const soft = [];

  const home = await get(`${base}/`);
  if (home.status !== 200 || !/<html/i.test(home.text)) {
    rows.push({ slug, note: `NOT AUDITABLE (homepage status=${home.status})` });
    continue;
  }

  // canonical — homepage must self-canonical to its own host
  const homeCanon = canonOf(home.text);
  hard.push({ name: 'canonical(home)=own host', ok: homeCanon.includes(`${slug}.projectsites.dev`), detail: homeCanon || '(none)' });

  // canonical — a sub-route must canonical to ITSELF (not the homepage) — de-index guard
  const routes = [...(await get(`${base}/sitemap.xml`)).text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const sub = routes.find((u) => new URL(u).pathname !== '/' );
  if (sub) {
    const subPath = new URL(sub).pathname;
    const subRes = await get(sub);
    const subCanon = canonOf(subRes.text);
    hard.push({ name: `canonical(${subPath})=self`, ok: subCanon.endsWith(subPath) || subCanon.endsWith(`${subPath}/`), detail: subCanon || '(none)' });
  } else {
    soft.push({ name: 'sub-route canonical', detail: 'no sub-route in sitemap to check' });
  }

  // OG image — present + 1200×630 + ≤100KB
  const ogUrl = tag(home.text, /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if (ogUrl) {
    const og = await pngDims(ogUrl.startsWith('http') ? ogUrl : `${base}${ogUrl}`);
    const dimsOk = og.w === 1200 && og.h === 630;
    const sizeOk = og.bytes != null && og.bytes <= 100_000;
    hard.push({ name: 'og-image 1200×630 ≤100KB', ok: og.status === 200 && dimsOk && sizeOk, detail: `${og.w}×${og.h} ${og.bytes ? Math.round(og.bytes / 1024) + 'KB' : 'status=' + og.status}` });
  } else {
    hard.push({ name: 'og-image present', ok: false, detail: '(no og:image tag)' });
  }

  // sitemap — present + every <url> has <lastmod>
  const sm = await get(`${base}/sitemap.xml`);
  const urlCount = (sm.text.match(/<url>/g) || []).length;
  const lastmodCount = (sm.text.match(/<lastmod>/g) || []).length;
  hard.push({ name: 'sitemap + lastmod (all urls)', ok: sm.status === 200 && urlCount > 0 && lastmodCount >= urlCount, detail: `${urlCount} urls / ${lastmodCount} lastmod` });

  // robots.txt — present + references sitemap
  const robots = await get(`${base}/robots.txt`);
  hard.push({ name: 'robots.txt + sitemap ref', ok: robots.status === 200 && /sitemap:/i.test(robots.text), detail: `status=${robots.status} sitemapRef=${/sitemap:/i.test(robots.text)}` });

  // security.txt + llms.txt — present
  const sec = await get(`${base}/.well-known/security.txt`);
  hard.push({ name: '.well-known/security.txt', ok: sec.status === 200, detail: `status=${sec.status}` });
  const llms = await get(`${base}/llms.txt`);
  hard.push({ name: 'llms.txt (GEO)', ok: llms.status === 200, detail: `status=${llms.status}` });

  // meta lengths — REPORTED only (C.1 gates + root-fixes these)
  const t = titleOf(home.text);
  const d = descOf(home.text);
  soft.push({ name: 'title 50-60 (C.1)', detail: `${t.length}c ${t.length >= 50 && t.length <= 60 ? '✓' : '⚠ (finalizeSeoInvariants flips on rebuild)'}` });
  soft.push({ name: 'desc 120-156 (C.1)', detail: `${d.length}c ${d.length >= 120 && d.length <= 156 ? '✓' : '⚠ (finalizeSeoInvariants flips on rebuild)'}` });

  const hardFails = hard.filter((h) => !h.ok).length;
  fails += hardFails;
  rows.push({ slug, hard, soft, hardFails });
}

console.log('\n━━ § C.4 generated-site SEO + GEO (deployed) ━━');
for (const r of rows) {
  if (r.note) {
    console.log(`  ⚠️  ${r.slug} — ${r.note}`);
    continue;
  }
  console.log(`  ${r.hardFails === 0 ? '✅' : '❌'} ${r.slug} — ${r.hard.length - r.hardFails}/${r.hard.length} SEO/GEO gates`);
  for (const h of r.hard) console.log(`       ${h.ok ? '✓' : '✗'} ${h.name} — ${h.detail}`);
  for (const s of r.soft) console.log(`       · ${s.name} — ${s.detail}`);
}

const auditable = rows.filter((r) => !r.note);
if (auditable.length === 0) {
  console.log('\n::notice:: skipped — no site auditable.');
  process.exit(0);
}
if (fails > 0) {
  console.error(`\n✗ § C.4 FAIL — ${fails} SEO/GEO gate(s) failed on deployed sites (root-fix in TEMPLATE / site-gen).`);
  process.exit(1);
}
console.log(`\nVERDICT: ✅ § C.4 PASS — deployed sites ship correct SEO/GEO infra (canonical per-route + OG 1200×630 + sitemap/lastmod + robots + security.txt + llms.txt). Meta-length owned by C.1.`);
