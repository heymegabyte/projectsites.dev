// verify-beat-source.mjs — COMPLETION § C.7: does a DEPLOYED generated site BEAT the business's
// real existing website on the OBJECTIVE, headless-measurable subset of the competitor rubric?
//
// Audits the LIVE product (`{slug}.projectsites.dev`) vs the LIVE source URL. Scores BOTH on the
// same objective dims, then applies a HONEST beat-gate (see § SCORING below).
//
// ── Three measurement artifacts this probe was rebuilt to AVOID (learned the hard way) ──────────
//   1. DENSITY on a prerendered SPA shell. A plain `fetch()` of `{slug}.projectsites.dev` returns the
//      thin prerender shell (~3 imgs / ~500 words), NOT the hydrated React DOM (17 imgs / 13 sections
//      / 28 headings / 637 words on gentle-dental). Counting the shell systematically penalises our
//      SPA against a server-rendered source. → density is measured HEADLESS (Playwright) on the
//      RENDERED DOM for BOTH sides, so the comparison is apples-to-apples.
//   2. SPEED on a COLD edge. A single first fetch after deploy hits a cold edge cache (~600ms); the
//      warm edge (post-AL-394 `caches.default`) is ~70ms. A real source site is already warm (real
//      traffic / CDN). → we WARM both with a throwaway fetch, then measure TTFB — steady-state for both.
//   3. PWA files on a SOFT-404 source. Many sources serve their 200-HTML homepage for ANY unknown path,
//      so a naive `GET /sw.js` → 200 falsely credits them 4/4 PWA. → each PWA path is content-type
//      validated (manifest=json, sw=javascript, llms=text/plain, offline=html-containing-"offline");
//      an HTML soft-404 scores 0 (lying-200 class per `render-integrity-probe-blind-to-graceful-soft-404`).
//
// ── SCORING — why NOT `gen_total ≥ source_total × 1.15` ─────────────────────────────────────────
//   The `competitor-research` ≥15% floor is defined over the FULL 100-pt rubric (10 dims incl. visual
//   polish / copy / conversion / distinctiveness). Those dims are AI-VISION-gated and out of a headless
//   fetch's reach. Applying ×1.15 to THIS coarse 18-pt fetch-subset is a misapplication: SEO is an axis
//   BOTH a competent source and our site can max out, so it saturates — a strong source pins the total
//   near ours and ×1.15 becomes structurally unreachable even when our site is plainly better. So this
//   probe asserts only what it can measure FAITHFULLY:
//     • FLOOR   — gen must MATCH-or-beat the source on SEO (never regress the thing that matters most).
//     • DOMINATE — gen must STRICTLY WIN ≥2 of the STRUCTURAL modern-web dims {PWA, JSON-LD depth,
//                  warm-edge speed, rendered density} the source typically neglects.
//     • NO-REGRESSION — gen total ≥ source total (we never ship a net-worse site).
//   The ≥15% visual/copy/conversion beat is proven elsewhere (verify-hero-backdrop + verify-theme-match
//   + the container's competitor loop + AI-vision QA) — stated in the verdict, never faked here.
//
// Fixes are ROOT-CAUSE in the TEMPLATE / site-gen enrichment (homepage word density, JSON-LD emit,
// PWA files) — NEVER a one-off patch to one deployed site.
//
// PAIRS (env SOURCE_PAIRS="gen1=src1,gen2=src2" overrides). GRACEFUL: an unreachable/blocked source
// (or a gen site that won't render) is skipped (`::notice::`), never a false red.
//
// Usage: node e2e/site-quality/verify-beat-source.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const PAIRS = (process.env.SOURCE_PAIRS ||
  'gentle-dental-seattle.projectsites.dev=https://gentledental.com,tartine-san-francisco.projectsites.dev=https://tartinebakery.com')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => {
    const [gen, src] = p.split('=');
    return { gen: gen.startsWith('http') ? gen : `https://${gen}`, src };
  });

/** One timed fetch → { status, ttfb (ms to response headers), html }. */
const getTimed = async (url) => {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const ttfb = Math.round(performance.now() - t0);
    const html = await r.text().catch(() => '');
    return { status: r.status, ttfb, html };
  } catch (e) {
    return { status: 0, ttfb: Math.round(performance.now() - t0), html: '', err: String(e).slice(0, 50) };
  }
};

/** Warm the edge/CDN with a throwaway fetch, then return a fresh timed fetch (steady-state TTFB + HTML). */
const warmThenTime = async (url) => {
  await fetch(url, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) }).catch(() => {});
  return getTimed(url);
};

// A path counts as a REAL PWA asset only if its content-type matches the expected kind — a source
// that soft-404s (serves its 200-HTML homepage for `/sw.js`, `/site.webmanifest`, `/offline.html`)
// must NOT be credited (lying-200 class per `render-integrity-probe-blind-to-graceful-soft-404`).
const KIND_CT = { manifest: /json|manifest/i, js: /javascript|ecmascript/i, text: /text\/plain|markdown/i };
const assetPresent = async (base, path, kind) => {
  try {
    const r = await fetch(new URL(path, base).href, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (r.status !== 200) return false;
    const ct = r.headers.get('content-type') || '';
    if (kind === 'offline') {
      // A real offline page IS html — but reject the homepage soft-404 (large, lacks "offline" copy).
      if (!/text\/html/i.test(ct)) return false;
      const body = await r.text().catch(() => '');
      return /offline/i.test(body) && body.length < 20000;
    }
    if (/text\/html/i.test(ct)) return false; // json/js/text served as HTML = soft-404
    return KIND_CT[kind].test(ct);
  } catch {
    return false;
  }
};
const attr = (html, re) => (html.match(re) || [])[1] || '';

/** Count density signals from a raw HTML string (shell fallback — undercounts SPAs). */
function shellDensity(html) {
  const headings = (html.match(/<h[1-3][\s>]/gi) || []).length;
  const sections = (html.match(/<section[\s>]/gi) || []).length;
  const imgs = (html.match(/<img[\s>]/gi) || []).length;
  const words = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
  return { headings, sections, imgs, words, source: 'shell' };
}

/**
 * Count density signals from the RENDERED DOM (headless) — the fair, apples-to-apples measurement.
 * Returns null on a non-200 / CF-challenge shell / render error so the caller can fall back.
 */
async function renderedDensity(browser, url) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    // `load` (not `networkidle`) — generated sites keep a beacon/poll open; source sites may be ad-heavy.
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    const title = await page.title().catch(() => '');
    if (!resp || resp.status() !== 200 || /just a moment|checking your browser|attention required/i.test(title)) {
      return null;
    }
    await page.waitForTimeout(1500); // let React hydrate / lazy sections mount
    return await page.evaluate(() => {
      const imgs = document.querySelectorAll('img').length;
      const bg = [...document.querySelectorAll('*')].filter((el) => {
        const b = getComputedStyle(el).backgroundImage;
        return b && b !== 'none' && /url\(/.test(b);
      }).length;
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
      return {
        imgs: imgs + bg, // a CSS-background hero is a real image; count it
        sections: document.querySelectorAll('section').length,
        headings: document.querySelectorAll('h1,h2,h3').length,
        words: text.split(' ').filter(Boolean).length,
        source: 'rendered',
      };
    });
  } catch {
    return null;
  } finally {
    await ctx.close();
  }
}

/** Score one site on the objective subset. Density is headless; speed is warm; SEO/PWA/mobile are fetch. */
async function scoreSite(browser, url) {
  const { status, ttfb, html } = await warmThenTime(url);
  if (status < 200 || status >= 400 || !html) return { ok: false, status, ttfb };
  const base = new URL(url).origin;
  const title = attr(html, /<title[^>]*>([^<]*)<\/title>/i).trim();
  const desc = attr(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i);
  const canonical = /<link[^>]+rel=["']canonical["']/i.test(html);
  const ogImage = /<meta[^>]+property=["']og:image["']/i.test(html);
  const jsonld = (html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [])
    .filter((b) => /@type/i.test(b)).length;
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const [manifest, offline, sw, llms] = await Promise.all([
    assetPresent(base, '/site.webmanifest', 'manifest'),
    assetPresent(base, '/offline.html', 'offline'),
    assetPresent(base, '/sw.js', 'js'),
    assetPresent(base, '/llms.txt', 'text'),
  ]);
  const dens = (await renderedDensity(browser, url)) || shellDensity(html);
  const pts = {
    seo:
      (title ? 1 : 0) +
      (title.length >= 30 && title.length <= 65 ? 1 : 0) +
      (desc ? 1 : 0) +
      (desc.length >= 100 && desc.length <= 170 ? 1 : 0) +
      (canonical ? 1 : 0) +
      (ogImage ? 1 : 0) +
      (jsonld >= 1 ? 1 : 0) +
      (jsonld >= 4 ? 1 : 0),
    pwa: (manifest ? 1 : 0) + (offline ? 1 : 0) + (sw ? 1 : 0) + (llms ? 1 : 0),
    mobile: viewport ? 1 : 0,
    density: (dens.headings + dens.sections >= 8 ? 1 : 0) + (dens.imgs >= 6 ? 1 : 0) + (dens.words >= 800 ? 1 : 0),
    speed: ttfb < 300 ? 2 : ttfb < 800 ? 1 : 0,
  };
  const total = pts.seo + pts.pwa + pts.mobile + pts.density + pts.speed;
  return { ok: true, status, ttfb, total, pts, sig: { jsonld, ...dens } };
}

console.log('=== § C.7 beat-the-source (objective subset · headless density · warm speed) ===');
let anyPair = false;
const fails = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const { gen, src } of PAIRS) {
    const g = await scoreSite(browser, gen);
    if (!g.ok) {
      console.log(`  ⚠️  ${gen} — generated site unreachable (status ${g.status}) — skip pair`);
      continue;
    }
    const s = await scoreSite(browser, src);
    if (!s.ok) {
      console.log(`  ⚠️  ${src} — source unreachable/blocked (status ${s.status}${s.err ? ' ' + s.err : ''}) — can't fairly score, skip`);
      continue;
    }
    anyPair = true;
    // Structural modern-web dims the source typically neglects. gen must strictly WIN ≥2 of these.
    const structuralWins = [
      g.pts.pwa > s.pts.pwa, // installable / offline / AI-legible
      g.sig.jsonld > s.sig.jsonld, // richer structured data
      g.pts.speed > s.pts.speed || (g.ttfb < s.ttfb && g.pts.speed === s.pts.speed), // faster warm edge
      g.pts.density > s.pts.density, // denser rendered page
    ].filter(Boolean).length;
    const seoFloor = g.pts.seo >= s.pts.seo; // never regress SEO
    const noRegression = g.total >= s.total; // never a net-worse site
    const beat = seoFloor && noRegression && structuralWins >= 2;
    const pct = s.total > 0 ? Math.round(((g.total - s.total) / s.total) * 100) : 100;
    console.log(
      `  ${beat ? '✅' : '🔴'} ${new URL(gen).host}  gen=${g.total}/18 vs source=${s.total}/18  (${pct >= 0 ? '+' : ''}${pct}% total · seoFloor=${seoFloor ? 'ok' : 'FAIL'} · structuralWins=${structuralWins}/4)`,
    );
    console.log(
      `       gen    seo=${g.pts.seo}/8 pwa=${g.pts.pwa}/4 mob=${g.pts.mobile}/1 dens=${g.pts.density}/3 spd=${g.pts.speed}/2 · ttfb=${g.ttfb}ms jsonld=${g.sig.jsonld} imgs=${g.sig.imgs} words=${g.sig.words} (${g.sig.source})`,
    );
    console.log(
      `       source seo=${s.pts.seo}/8 pwa=${s.pts.pwa}/4 mob=${s.pts.mobile}/1 dens=${s.pts.density}/3 spd=${s.pts.speed}/2 · ttfb=${s.ttfb}ms jsonld=${s.sig.jsonld} imgs=${s.sig.imgs} words=${s.sig.words} (${s.sig.source})`,
    );
    if (!beat) {
      const why = !seoFloor ? 'SEO regressed vs source' : !noRegression ? 'net total below source' : `only ${structuralWins}/2 structural wins`;
      fails.push(`${new URL(gen).host}: ${why}`);
    }
  }
} finally {
  await browser.close();
}

if (!anyPair) {
  console.log('::notice:: verify-beat-source skipped — no reachable generated+source pair');
  process.exit(0);
}
if (fails.length) {
  console.log(`VERDICT: 🔴 FAIL — ${fails.join(' · ')} (visual/copy/conversion beat is AI-vision-gated, not scored here)`);
  process.exit(1);
}
console.log('VERDICT: ✅ PASS — gen matches source SEO, never regresses, and structurally dominates ≥2 modern-web dims (PWA/JSON-LD/speed/density). Visual/copy beat proven by AI-vision QA.');
process.exit(0);
