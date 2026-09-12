// verify-edge-cache.mjs — COMPLETION § C.2 (CWV cold-TTFB): does the AL-394 serve-path edge
// cache actually serve DEPLOYED generated HTML from `caches.default` on repeat visits, and does
// it stay CORRECT (per-host canonical, real 200)? Fetch-based (the `x-ps-edge` response header +
// the served canonical are the signal — no browser needed). Audits the LIVE product.
//
// Root cause it locks (AL-394): cold TTFB was ~1.3s (vanta) because a cold browser re-ran the
// full KV/D1/R2 + injection pipeline; the response's `s-maxage=3600` is advisory-only for a
// Worker-built body. `serveSiteFromR2` now stores the finished HTML in `caches.default` keyed by
// HOST + VERSION + path + paid-flag, so a repeat visitor is served at edge speed. Fix is in the
// WORKER serve path (not a rebuild) → fixes all deployed sites the moment CI deploys.
//
// HARD gates (once the feature is live):
//   • the repeat fetch is served from the edge cache (`x-ps-edge: hit`)
//   • the cached response still carries the site's OWN-host canonical (host-key prevents a
//     cross-host canonical clobber — the exact correctness risk of caching the injected HTML)
//   • the served page is a real 200
// GRACEFUL SKIP: if `x-ps-edge` is absent on every site, the fix hasn't deployed yet → notice +
//   exit 0 (never red during the CI deploy window), so run-all stays green until it lands.
//
// Usage:  SITES=vanta-strength-austin node e2e/site-quality/verify-edge-cache.mjs
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const SITES = (process.env.SITES || 'vanta-strength-austin,ironhaus-houston')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const hitFetch = async (url) => {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    const ttfb = Math.round(performance.now() - t0);
    const edge = r.headers.get('x-ps-edge') || '';
    const html = await r.text().catch(() => '');
    const canon = (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1] || '';
    return { status: r.status, edge, ttfb, canon };
  } catch (e) {
    return { status: 0, edge: '', ttfb: Math.round(performance.now() - t0), canon: '', err: String(e).slice(0, 60) };
  }
};

let anyFeature = false;
const fails = [];
console.log('=== § C.2 edge-cache (AL-394): repeat HTML served from caches.default? ===');
for (const slug of SITES) {
  const host = `${slug}.projectsites.dev`;
  const url = `https://${host}/`;
  // Sequential fetches from one PoP: warm the edge, then expect a hit on the repeat visit.
  const a = await hitFetch(url);
  const b = await hitFetch(url);
  const c = await hitFetch(url);
  const edges = [a.edge, b.edge, c.edge];
  const present = edges.some((e) => e === 'hit' || e === 'miss');
  if (!present) {
    console.log(`  ⚠️  ${slug} — no x-ps-edge header (AL-394 not deployed yet)`);
    continue;
  }
  anyFeature = true;
  const gotHit = edges.includes('hit');
  const canonOk = c.canon.includes(host); // must still be the site's OWN host (no cross-host clobber)
  const hitTtfb = c.edge === 'hit' ? c.ttfb : Math.min(a.ttfb, b.ttfb, c.ttfb);
  const ok = gotHit && canonOk && c.status === 200;
  console.log(
    `  ${ok ? '✅' : '🔴'} ${slug} edges=[${edges.join(',')}] hitTTFB=${hitTtfb}ms canon=${
      canonOk ? 'own-host' : `WRONG(${c.canon || 'empty'})`
    } status=${c.status}`,
  );
  if (!ok) fails.push(`${slug}: hit=${gotHit} canonOwnHost=${canonOk} status=${c.status}`);
}

if (!anyFeature) {
  console.log('::notice:: verify-edge-cache skipped — x-ps-edge absent on all sites (AL-394 not deployed yet)');
  process.exit(0);
}
if (fails.length) {
  console.log(`VERDICT: 🔴 FAIL — ${fails.join(' · ')}`);
  process.exit(1);
}
console.log('VERDICT: ✅ PASS — repeat HTML served from caches.default (x-ps-edge:hit), canonical host-correct, 200');
process.exit(0);
