// cohort-freshness.mjs — separate STALE-BUILD debt from GENUINE generator gaps across deployed sites.
//
// The per-site probes (verify-build-invariants, a11y, pwa, hero-backdrop, …) flag a DEPLOYED site RED
// whether the generator is broken OR the site is simply an OLD build that predates a root fix. That
// ambiguity wastes loop fires: an engineer re-diagnoses a generator "bug" that was already fixed —
// the site just never rebuilt (see the `report-mode-probe-deployed-defect-is-often-stale-build-debt`
// doctrine: "check a FRESH build → rebuild the cohort, don't re-fix the generator").
//
// This probe applies that differential mechanically. It measures the same prerendered-shell
// invariants (title 50–60, meta-desc 120–156, ≥4 JSON-LD blocks, exactly 1 H1) on a KNOWN-FRESH
// CONTROL site and on each cohort site, then classifies every cohort site:
//   • CURRENT          — passes all invariants (beating the source; nothing to do)
//   • STALE-REBUILD    — fails ONLY invariants the fresh control PASSES → the fix already landed;
//                        REBUILD the site (a fast-path reset re-emits from the current template).
//   • GENUINE-ROOTFIX  — fails an invariant the fresh control ALSO fails → a real generator gap;
//                        fix at ROOT in the template / build_validators.
//
// Output is a rebuild worklist + a root-fix worklist — so the loop rebuilds stale sites in a batch
// and only spends a code fire on genuine gaps. No Chromium (the invariants live in the served HTML)
// → fast + headless-fair.
//
// Usage: CONTROL=bario-neal-philadelphia SITES=vanta-strength-austin,ironhaus-houston [STRICT=1] \
//        node e2e/site-quality/cohort-freshness.mjs
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const CONTROL = (process.env.CONTROL || 'bario-neal-philadelphia').trim();
const SITES = (process.env.SITES || 'vanta-strength-austin,ironhaus-houston,vantage-digital-studio-portland')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((s) => s !== CONTROL);
const STRICT = process.env.STRICT === '1';

/** Fetch a deployed site's served HTML shell + measure the four prerendered SEO invariants. */
async function measure(slug) {
  const url = `https://${slug}.projectsites.dev/`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { slug, ok: false, status: r.status, reason: `HTTP ${r.status}` };
    const html = await r.text();
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim();
    const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["']/i)?.[1] ?? '').trim();
    const jsonld = (html.match(/<script[^>]+application\/ld\+json/gi) ?? []).length;
    const h1 = (html.match(/<h1[\s>]/gi) ?? []).length;
    // The failing-invariant set (the checks build_validators enforces).
    const fails = new Set();
    if (title.length < 50 || title.length > 60) fails.add('title');
    if (desc.length < 120 || desc.length > 156) fails.add('desc');
    if (jsonld < 4) fails.add('jsonld');
    if (h1 !== 1) fails.add('h1');
    // VERTICAL-MISFIT staleness (AL-712) — the 4 meta-invariants can ALL pass on a build that is
    // still STALE on its VERTICAL: a food/market business (fish market / seafood / grocery / butcher
    // / deli) built BEFORE the AL-698 classifier fix wears the boutique-FASHION persona (hero + copy
    // like "a chic fish market … chosen with a tastemaker's eye" / "pieces worth the trip") instead of
    // the warm walk-in-food voice. Meta-fresh but vertical-stale → previously classified CURRENT →
    // MISSED from the rebuild worklist (vision-caught on pike-place-fish-market-seattle). The fix is
    // landed + unit-tested (theme_style/hero_image, ba3015cb4) so this is ALWAYS stale-build debt →
    // rebuild clears it. Precise: fires ONLY when a FOOD/MARKET vertical noun co-occurs with an
    // unambiguous boutique-FASHION persona marker (a correct quickserve food build never carries these).
    const titleH1 = (title + ' ' + (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '')).toLowerCase();
    const bodyLc = html.toLowerCase();
    const isFoodMarket =
      /\b(fish\s?market|seafood|fishmonger|grocer\w*|supermarket|greengrocer|bodega|\bbutcher\w*|delicatessen|farm\s?stand|produce\s?market|food\s?market)\b/.test(
        titleH1,
      );
    const boutiqueMisfit =
      /tastemaker|pieces worth the trip|a chic\b|chosen with a tastemaker'?s eye/.test(bodyLc);
    if (isFoodMarket && boutiqueMisfit) fails.add('vertical');
    return { slug, ok: true, title: title.length, desc: desc.length, jsonld, h1, fails };
  } catch (e) {
    return { slug, ok: false, reason: String(e).slice(0, 60) };
  }
}

const control = await measure(CONTROL);
if (!control.ok) {
  console.log(`::notice:: cohort-freshness — control ${CONTROL} unreachable (${control.reason}); cannot compute differential`);
  process.exit(0);
}
const controlFails = control.fails; // invariants even the fresh build fails = genuine baseline gaps

const rows = [];
const rebuild = [];
const rootfix = [];
for (const slug of SITES) {
  const m = await measure(slug);
  if (!m.ok) {
    rows.push(`  ⏭️  ${slug} — ${m.reason} (skip)`);
    continue;
  }
  if (m.fails.size === 0) {
    rows.push(`  ✓ ${slug} — CURRENT (title ${m.title} · desc ${m.desc} · jsonld ${m.jsonld} · h1 ${m.h1})`);
    continue;
  }
  const stale = [...m.fails].filter((f) => !controlFails.has(f)); // control passes → fix landed → rebuild
  const genuine = [...m.fails].filter((f) => controlFails.has(f)); // control ALSO fails → real gap
  if (genuine.length) rootfix.push({ slug, genuine });
  if (stale.length) rebuild.push({ slug, stale });
  const tag = genuine.length ? '🔴 GENUINE-ROOTFIX' : '🟠 STALE-REBUILD';
  rows.push(
    `  ${tag} ${slug} — fails [${[...m.fails].join(', ')}]` +
      (stale.length ? ` · stale→rebuild: [${stale.join(', ')}]` : '') +
      (genuine.length ? ` · genuine→root-fix: [${genuine.join(', ')}]` : ''),
  );
}

console.log(`\n━━ cohort build-freshness (control=${CONTROL}: fails [${[...controlFails].join(', ') || 'none'}]) ━━`);
rows.forEach((r) => console.log(r));
console.log(
  `\nRebuild worklist (${rebuild.length}): ${rebuild.map((x) => x.slug).join(', ') || 'none'}` +
    `\nRoot-fix worklist (${rootfix.length}): ${rootfix.map((x) => `${x.slug}[${x.genuine.join(',')}]`).join(', ') || 'none'}`,
);

// A GENUINE gap (fresh control fails it too) is the only thing that warrants a code fire — that's the
// hard signal. Stale-rebuild sites are a rebuild worklist, not a code failure.
if (rootfix.length && STRICT) {
  console.log(`\nVERDICT: ❌ FAIL — ${rootfix.length} genuine generator gap(s): fix at ROOT in the template / build_validators.`);
  process.exit(1);
}
if (rootfix.length) {
  console.log(`\n::notice:: cohort-freshness — ${rootfix.length} GENUINE gap(s) need a root fix; ${rebuild.length} stale site(s) just need a rebuild. (STRICT=1 to enforce genuine gaps.)`);
} else {
  console.log(`\nVERDICT: ✅ cohort-freshness PASS — 0 genuine gaps; ${rebuild.length} stale site(s) on the rebuild worklist (rebuild, not a code fix).`);
}
process.exit(0);
