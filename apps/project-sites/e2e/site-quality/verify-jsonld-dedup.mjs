// verify-jsonld-dedup.mjs — COMPLETION § C.5 (hardening): a DEPLOYED generated site must ship
// each site-level JSON-LD entity ONCE, not twice. Companion to verify-jsonld.mjs (which asserts
// ≥4 core blocks are PRESENT); this asserts they are UNIQUE.
//
// TWO surfaces, two severities (validator-precision — hard-gate what's crawler-critical + always
// true; TRACK the client migration that flips clean over rebuilds):
//
//   HARD gate — SERVED HTML (what every crawler, incl. no-JS, reads first): each singleton
//   site-level @type (WebSite / WebPage / BreadcrumbList / Organization) appears AT MOST ONCE.
//   The worker shell injector (build_validators) emits exactly one of each, so this is green today
//   AND guards a future regression that double-injects.
//
//   ::notice — RENDERED DOM (post-hydration, what Google's renderer sees): count the client-side
//   duplicates. Pre-AL-522 the template's buildSiteJsonLd RE-EMITTED WebSite/WebPage/BreadcrumbList
//   that the server already injects, and because the server blocks carry NO @id while the client
//   copies did, Google couldn't merge them → duplicate entities per page. AL-522 (template
//   `9f227bb`) makes buildSiteJsonLd emit ONLY the rich business entity; this count flips to 0 as
//   each site rebuilds. NON-fatal so run-all stays green while the fleet migrates (fixes are
//   root-cause in the template, never a one-off patch to a deployed site).
//
// Usage:  SITES=vanta-strength-austin node e2e/site-quality/verify-jsonld-dedup.mjs

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const H = { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' };
const SITES = (process.env.SITES || 'vanta-strength-austin,ironhaus-houston,vantage-digital-studio-portland')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Singleton site-level entities — at most one per page. (Organization is singleton too; the rich
// LocalBusiness subtype like ExerciseGym is a DIFFERENT @type, so a generic Organization + a
// specific subtype is NOT counted as a dup here.)
const SINGLETON = ['WebSite', 'WebPage', 'BreadcrumbList', 'Organization'];

const get = async (url) => {
  try { const r = await fetch(url, { headers: H }); return { status: r.status, text: await r.text().catch(() => '') }; }
  catch { return { status: 0, text: '' }; }
};

/** @type counts across every parsed ld+json block in an HTML string. */
function typeCounts(html) {
  const tags = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  const counts = {};
  for (const t of tags) {
    const body = t.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
    if (!body) continue;
    try {
      const j = JSON.parse(body);
      for (const b of Array.isArray(j) ? j : [j]) {
        const ty = b && b['@type'];
        if (typeof ty === 'string') counts[ty] = (counts[ty] || 0) + 1;
      }
    } catch { /* malformed → ignored (verify-jsonld flags low counts) */ }
  }
  return counts;
}

const dupsIn = (counts) => SINGLETON.filter((t) => (counts[t] || 0) > 1).map((t) => `${t}×${counts[t]}`);

// ── HARD gate: served-HTML uniqueness (fetch-only, no browser) ────────────────────────────────
let fails = 0;
const served = [];
for (const slug of SITES) {
  const res = await get(`https://${slug}.projectsites.dev/`);
  if (res.status !== 200) { served.push({ slug, ok: false, detail: `status=${res.status}` }); fails++; continue; }
  const dups = dupsIn(typeCounts(res.text));
  const ok = dups.length === 0;
  if (!ok) fails++;
  served.push({ slug, ok, detail: ok ? 'unique' : `DUP ${dups.join(', ')}` });
}

console.log('\n━━ § C.5 JSON-LD dedup — SERVED HTML (hard gate: each site-level entity once) ━━');
for (const r of served) console.log(`  ${r.ok ? '✅' : '❌'} ${r.slug} — ${r.detail}`);

// ── ::notice: rendered-DOM client-dup migration tracker (browser; fail-open) ──────────────────
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* no browser in this env */ }
if (!chromium) {
  console.log('\n::notice:: rendered-DOM client-dup tracker skipped (playwright unavailable) — served-HTML gate above still ran');
} else {
  const b = await chromium.launch();
  const rendered = [];
  for (const slug of SITES) {
    const p = await b.newPage();
    try {
      await p.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await p.waitForTimeout(2500);
      const counts = await p.evaluate(() =>
        [...document.querySelectorAll('script[type="application/ld+json"]')].reduce((acc, s) => {
          try { const j = JSON.parse(s.textContent); for (const b of Array.isArray(j) ? j : [j]) { const t = b && b['@type']; if (typeof t === 'string') acc[t] = (acc[t] || 0) + 1; } } catch {}
          return acc;
        }, {}),
      );
      rendered.push({ slug, dups: SINGLETON.filter((t) => (counts[t] || 0) > 1).map((t) => `${t}×${counts[t]}`) });
    } catch (e) { rendered.push({ slug, dups: null, err: e.message }); }
    await p.close();
  }
  await b.close();
  const stillDup = rendered.filter((r) => r.dups && r.dups.length > 0);
  console.log('\n━━ rendered DOM — client-dup migration (AL-522, flips to 0 as the fleet rebuilds) ━━');
  for (const r of rendered) {
    if (r.dups === null) console.log(`  ⚠️  ${r.slug} — render error: ${r.err}`);
    else if (r.dups.length === 0) console.log(`  ✅ ${r.slug} — no client dup (AL-522 landed)`);
    else console.log(`  ⏳ ${r.slug} — client dup: ${r.dups.join(', ')} (pre-rebuild)`);
  }
  if (stillDup.length > 0) {
    console.log(`\n::notice:: ${stillDup.length}/${rendered.length} audited site(s) still show the pre-AL-522 client JSON-LD dup — flips clean on rebuild (template ${'9f227bb'}); NOT a live regression.`);
  } else {
    console.log(`\n✅ rendered-DOM: 0 client dups across ${rendered.length} sites — AL-522 fully landed on the audited fleet.`);
  }
}

if (fails > 0) {
  console.error(`\n✗ § C.5 dedup FAIL — ${fails} site(s) DOUBLE-inject a site-level JSON-LD entity in the SERVED HTML (root-fix in the worker shell injector).`);
  process.exit(1);
}
console.log('\nVERDICT: ✅ § C.5 dedup PASS — served HTML ships each site-level entity exactly once (client migration tracked above).');
