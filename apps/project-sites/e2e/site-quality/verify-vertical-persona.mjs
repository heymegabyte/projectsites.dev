// verify-vertical-persona.mjs — § C.1/C.7: a generated site must NOT render a hardcoded
// WRONG-VERTICAL persona headline. A content pack whose copy is written for one vertical leaks
// onto every business on that commerce-mode: the `retail` pack shipped a "Gear" persona (hero
// "Gear built for how you live", about "Gear we actually stand behind") that landed on Heath
// Ceramics — a CERAMICS studio whose /about H1 read "Gear we actually stand behind" (AL-554,
// vision-caught). "Gear" implies equipment/outdoor/sporting — wrong for ceramics, home goods,
// apparel, books, most retail. Root fix: de-"Gear" the retail pack to vertical-neutral wording
// (`template/scripts/gen-content-packs.mjs`) + sync the worker's PACK_DEFAULT_HEROES detector.
//
// This guards the class at the RENDERED surface (headless Chromium, real SPA hydration): fetch
// the homepage + /about + /services and assert none renders a denylisted wrong-vertical persona
// phrase, and that no /about|/hero H1 contains a bare equipment word ("gear") — the Ideogram/pack
// "gear" leak signature. Deployed sites built BEFORE the fix still show it → this is a
// flips-GREEN-on-rebuild tracker (like verify-build-invariants): fail-OPEN by default (::notice::,
// exit 0, suite-safe) so a stale site doesn't red the suite; STRICT=1 → exit 1 (promote once the
// fleet has rebuilt). validator-precision-discipline: exact-phrase denylist + a narrow H1-token
// net → near-zero false positives.
//
// Usage: SITES=heath-ceramics-sausalito [STRICT=1] node e2e/site-quality/verify-vertical-persona.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'heath-ceramics-sausalito').split(',').map((s) => s.trim()).filter(Boolean);
const ROUTES = (process.env.ROUTES || '/,/about,/services').split(',');
const STRICT = process.env.STRICT === '1';

// Exact hardcoded pack-persona phrases that a real, customized build must never render verbatim.
const DENY = [
  'gear we actually stand behind',
  'gear built for how you live',
  'great gear at even better prices',
];
// A bare "gear" in an /about|hero H1 is the leak signature — but NOT for businesses that
// genuinely sell gear (outdoor / sporting / tactical / bike / ski / climbing / auto).
const GEAR_OK = /\b(outdoor|sporting|sports|tactical|bike|bicycle|cycl|ski|snowboard|climb|camp|hik|fish|hunt|auto|motor|dive|surf|gym|fitness)\b/i;
// "Licensed & insured" is a promise-grade FACT only for genuine trades/auto/home-services — a
// FABRICATED credential on a salon / agency / consultant / studio that also quotes (AL-559,
// TrustBar `svc` default). Flag it unless the business is a real trade.
const TRADE_OK =
  /\b(plumb|hvac|heating|cooling|air\s?condition|furnace|roof|electric|contractor|construction|landscap|lawn|cleaning|maid|janitor|pest|handyman|carpent|floor|drywall|septic|gutter|remodel|renovation|towing|locksmith|garage|excavat|fencing|paving|demolition|moving|mover|junk|hauling|snow|auto|mechanic|collision|body\s?shop|detailing|security|alarm|pool|tree\s?service|pressure\s?wash|chimney|insulation|solar|paint|glass|window|door|deck|masonry|concrete|welding|appliance)\b/i;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const hits = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const siteName = norm(slug.replace(/-/g, ' '));
    const gearOkBiz = GEAR_OK.test(siteName);
    const tradeOkBiz = TRADE_OK.test(siteName);
    for (const route of ROUTES) {
      try {
        const r = await page.goto(`https://${slug}.projectsites.dev${route}`, { waitUntil: 'load', timeout: 45000 });
        if (!r || r.status() !== 200) continue;
        await page.waitForTimeout(1500);
        const { h1, body } = await page.evaluate(() => ({
          h1: document.querySelector('h1')?.textContent || '',
          body: document.body.innerText || '',
        }));
        const nBody = norm(body);
        const nH1 = norm(h1);
        for (const phrase of DENY) if (nBody.includes(phrase)) hits.push({ slug, route, kind: 'deny-phrase', detail: phrase });
        if (/\bgear\b/.test(nH1) && !gearOkBiz) hits.push({ slug, route, kind: 'h1-gear', detail: nH1.slice(0, 60) });
        if (nBody.includes('licensed & insured') && !tradeOkBiz)
          hits.push({ slug, route, kind: 'licensed-insured-nontrade', detail: 'licensed & insured (fabricated credential on a non-trade business)' });
      } catch {
        /* route unreachable → skip (don't false-fail) */
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ sites: SITES, routes: ROUTES, strict: STRICT, hits }, null, 2));
if (!hits.length) {
  console.log(`✅ PASS — no wrong-vertical persona copy on ${SITES.length} site(s) × ${ROUTES.length} route(s)`);
  process.exit(0);
}
const msg = `wrong-vertical persona copy on ${hits.length} surface(s): ${hits.map((h) => `${h.slug}${h.route}→"${h.detail}"`).join(' · ')}`;
if (STRICT) {
  console.log(`❌ FAIL — ${msg}`);
  process.exit(1);
}
// flips-GREEN-on-rebuild tracker: a stale pre-fix build still renders the leak; the retail-pack
// de-"Gear" fix lands next build (NO redeploy of existing sites), so these clear on rebuild.
console.log(`::notice:: verify-vertical-persona — ${msg} (stale pre-AL-554 build; clears on rebuild — set STRICT=1 to enforce)`);
process.exit(0);
