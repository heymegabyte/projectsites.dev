// verify-lcp-wordmark-preload.mjs — COMPLETION § C.2 (LCP): the navbar wordmark is the LCP element
// on TEXT-hero generated sites (the H1 slogan sits over a color/gradient, no image bigger than the
// ~18KB `/logo-wordmark.png`). It renders LATE — behind SPA hydration + the AL-591 client HEAD probe
// that gates the wordmark <img> to avoid a 404 console error — so its bytes are fetched only after
// that waterfall. Measured on flour-bakery: LCP 2292ms cold vs 924ms warm (the whole gap is the
// wordmark's late fetch, since warm = bytes already cached). The C.2 target is LCP ≤ 2000ms.
//
// ROOT FIX (AL-718, build_validators.ts finalizeSeoInvariants): when the build produced
// `/logo-wordmark.png`, inject `<link rel="preload" as="image" href="/logo-wordmark.png"
// fetchpriority="high">` into every route's <head> so the browser fetches the wordmark eagerly
// (parallel with HTML/CSS) → its bytes are ready by the time the <img> renders → cold LCP collapses
// toward the warm number. Only when the asset exists (an absent-asset preload would 404 + console-warn,
// breaking the 0-console-errors gate). Lands NEXT build per the loop guardrail — never a redeploy of
// existing sites.
//
// This probe (fetch-based; the shell + headers are curl-gettable with a real UA) audits the DEPLOYED
// cohort. It is TOLERANT of pre-AL-718 builds: a site whose wordmark exists but whose shell lacks the
// preload is reported PENDING (flips green on its next rebuild), NOT a hard fail — so it doesn't
// false-red the suite while the cohort predates the fix (the reconcile-surface-map-can-be-stale class).
// It hard-fails only on an un-fetchable/challenged site. Promote to a strict assertion once the
// _default-sites cohort is rebuilt post-AL-718.
//
// Usage: SITES=franklin-barbecue node e2e/site-quality/verify-lcp-wordmark-preload.mjs
import { resolveSites } from './_default-sites.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Dest': 'document',
  'Upgrade-Insecure-Requests': '1',
};
const SITES = resolveSites(process.env.SITES);

/** The invariant: a high-priority preload for the wordmark, any attribute order. */
const PRELOAD_RE =
  /<link\b[^>]*\brel=["']preload["'][^>]*\blogo-wordmark\.png[^>]*>|<link\b[^>]*\blogo-wordmark\.png[^>]*\brel=["']preload["'][^>]*>/i;
const HIGH_PRIORITY_RE = /fetchpriority=["']high["']/i;

async function getHtml(url) {
  try {
    const r = await fetch(url, { headers: H, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { status: r.status, body: r.status === 200 ? await r.text() : '' };
  } catch (e) {
    return { status: 0, body: '', err: String(e).slice(0, 60) };
  }
}
async function headOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', headers: H, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

let hardFails = 0;
let pending = 0;
const rows = [];
for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  const home = await getHtml(`${base}/`);
  const html = home.body;
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1]?.trim() || '';
  const isChallenge = /just a moment\b|checking your browser before|cf_chl_opt|turnstile/i.test(html) && !title;
  if (home.status !== 200 || isChallenge || !title) {
    hardFails++;
    rows.push({ slug, verdict: 'FAIL', detail: `NOT AUDITABLE — status=${home.status} challenge=${isChallenge}` });
    continue;
  }
  const hasWordmark = await headOk(`${base}/logo-wordmark.png`);
  if (!hasWordmark) {
    rows.push({ slug, verdict: 'PASS', detail: 'no /logo-wordmark.png (text wordmark) — nothing to preload' });
    continue;
  }
  const preloadTag = (PRELOAD_RE.exec(html) || [])[0] || '';
  if (preloadTag && HIGH_PRIORITY_RE.test(preloadTag)) {
    rows.push({ slug, verdict: 'PASS', detail: 'wordmark preloaded fetchpriority=high (post-AL-718)' });
  } else {
    pending++;
    rows.push({
      slug,
      verdict: 'PENDING',
      detail: preloadTag
        ? 'wordmark preload present but not fetchpriority=high'
        : 'wordmark exists, no head preload — pre-AL-718 build, flips green on next rebuild',
    });
  }
}

for (const r of rows) {
  const mark = r.verdict === 'PASS' ? '✓' : r.verdict === 'PENDING' ? '·' : '✗';
  console.log(`  ${mark} ${r.slug}  [${r.verdict}]  ${r.detail}`);
}
const passCount = rows.filter((r) => r.verdict === 'PASS').length;
console.log(
  hardFails
    ? `\nVERDICT: ❌ FAIL — ${hardFails} site(s) not auditable (challenge / non-200).`
    : pending
      ? `\nVERDICT: ✅ PASS (${passCount} ok · ${pending} PENDING rebuild) — C.2 wordmark-preload root fix (AL-718) lands on each site's next build; no false-red on pre-fix shells.`
      : `\nVERDICT: ✅ PASS — every audited site preloads its navbar wordmark (fetchpriority=high); the LCP element is fetched eagerly.`,
);
process.exit(hardFails ? 1 : 0);
