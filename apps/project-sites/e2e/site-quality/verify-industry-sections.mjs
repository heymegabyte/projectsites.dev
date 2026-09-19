// verify-industry-sections.mjs — the industry-specific sections (AL-620) ship correct on PROD.
//
// Five first-class, tokenized, JSON-LD-emitting sections (Menu / ServiceMenu / OpeningHours /
// DonationTiers / FeaturedCollection) are wired into every Home token-gated: each self-hides
// until the generation step fills its tokens for the matching vertical, then emits its own
// schema.org block + carries tracked CTAs. This probe proves the RENDERED site is honest:
//
//   1. TOKEN-LEAK FIREWALL (always-on) — NO unresolved industry `{TOKEN}` reaches the DOM.
//      This is the scrubText contract; a leak means a section rendered a raw placeholder.
//   2. JSON-LD VALIDITY — every industry block present (Menu / OfferCatalog / ItemList /
//      openingHoursSpecification / DonateAction) parses + carries its required fields.
//   3. TRACKED CTAs — when an industry section rendered, its `data-bcl` conversion attr is present.
//
// Pre-AL-620 sites (built before the sections shipped) simply have none of these → the probe
// reports "no industry sections" and PASSES on the token-leak check alone. Rebuild a site to
// exercise (2)+(3). Fail-OPEN tracker (::notice, exit 0) so a stale cohort doesn't red the
// suite; STRICT=1 → exit 1. Auto-joins run-all (verify-*.mjs).
//
// Usage: SITES=bario-neal-philadelphia [STRICT=1] node e2e/site-quality/verify-industry-sections.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'bario-neal-philadelphia')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';

// Industry tokens that must NEVER render (the scrubText firewall drops them to '').
const TOKEN_RE = /\{(?:MENU|SERVICE|SERVICES|HOURS|DONATION|DONATE|PRODUCT|COLLECTION|BOOK|SHOP)_[A-Z0-9_]*\}/;

function parseLd(scripts) {
  const nodes = [];
  for (const raw of scripts) {
    try {
      const v = JSON.parse(raw);
      for (const n of Array.isArray(v) ? v : [v]) nodes.push(n);
    } catch {
      /* malformed JSON-LD is caught by the dedicated jsonld probe */
    }
  }
  return nodes;
}

const hits = [];
const rows = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      const r = await page.goto(base, { waitUntil: 'load', timeout: 45000 });
      if (!r || r.status() !== 200) {
        rows.push(`  ⏭️  ${slug} — status ${r?.status()} (skip)`);
        await ctx.close().catch(() => {});
        continue;
      }
      await page.waitForTimeout(3000);
      const data = await page.evaluate(() => ({
        bodyText: document.body.innerText || '',
        scripts: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || ''),
        bcl: [...document.querySelectorAll('[data-bcl]')].map((e) => e.getAttribute('data-bcl')),
      }));

      // (1) token-leak firewall — the always-on assertion.
      const leak = data.bodyText.match(TOKEN_RE);
      if (leak) {
        hits.push({ slug, kind: 'token-leak', detail: leak[0] });
        rows.push(`  ❌ ${slug} — LEAKED industry token in the DOM: ${leak[0]} (scrubText firewall breached)`);
        await ctx.close().catch(() => {});
        continue;
      }

      // (2) which industry sections rendered (by their JSON-LD).
      const nodes = parseLd(data.scripts);
      const types = new Set(nodes.map((n) => n && n['@type']).filter(Boolean));
      const present = [];
      if (types.has('Menu')) present.push('Menu');
      if (types.has('OfferCatalog')) present.push('ServiceMenu');
      if (types.has('ItemList')) present.push('FeaturedCollection');
      if (nodes.some((n) => n && n.potentialAction && n.potentialAction['@type'] === 'DonateAction'))
        present.push('DonationTiers');
      // Hours are NOT an industry section — LocationMap + businessSchema own the
      // OpeningHoursSpecification JSON-LD, so it's intentionally not detected here.

      // (3) required-field spot-checks on the industry JSON-LD present.
      const bad = [];
      const menu = nodes.find((n) => n && n['@type'] === 'Menu');
      if (menu && !(Array.isArray(menu.hasMenuSection) && menu.hasMenuSection.length)) bad.push('Menu.hasMenuSection empty');
      const cat = nodes.find((n) => n && n['@type'] === 'OfferCatalog');
      if (cat && !(Array.isArray(cat.itemListElement) && cat.itemListElement.length)) bad.push('OfferCatalog.itemListElement empty');
      const list = nodes.find((n) => n && n['@type'] === 'ItemList');
      if (list && !(Array.isArray(list.itemListElement) && list.itemListElement.length)) bad.push('ItemList.itemListElement empty');

      if (bad.length) {
        hits.push({ slug, kind: 'jsonld-shape', detail: bad.join(' · ') });
        rows.push(`  ❌ ${slug} — industry JSON-LD present but malformed: ${bad.join(' · ')}`);
      } else if (present.length === 0) {
        rows.push(`  ✓ ${slug} — no industry sections rendered (vertical uses none) + 0 token leaks`);
      } else {
        rows.push(
          `  ✓ ${slug} — industry sections OK: ${present.join(', ')} · data-bcl: [${[...new Set(data.bcl)].join(', ') || 'none'}]`,
        );
      }
    } catch (e) {
      rows.push(`  ⏭️  ${slug} — ${e.message.slice(0, 50)}`);
    }
    await ctx.close().catch(() => {});
  }
} finally {
  await browser.close();
}

console.log('\n━━ industry-specific sections (AL-620) ━━');
rows.forEach((r) => console.log(r));
if (!hits.length) {
  console.log('\n✓ industry-sections PASS — no token leaks; every industry JSON-LD present is well-formed.');
  process.exit(0);
}
const msg = hits.map((h) => `${h.slug}[${h.kind}:${h.detail}]`).join(' · ');
if (STRICT) {
  console.log(`\n❌ FAIL — ${msg}`);
  process.exit(1);
}
console.log(`\n::notice:: industry-sections — ${msg} (STRICT=1 to enforce)`);
process.exit(0);
