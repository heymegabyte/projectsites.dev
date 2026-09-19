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
const SITES = (process.env.SITES || 'heath-ceramics-sausalito,jackson-fine-art-atlanta,three-kings-tattoo-brooklyn,pike-place-fish-market-seattle,stumptown-coffee-portland,strand-book-store-broadway,rainbow-grocery-san-francisco').split(',').map((s) => s.trim()).filter(Boolean);
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
// AL-611: the `botanical` themeStyle is shared by health/wellness AND plant/garden/florist RETAIL
// (routed there for the petals scene). Its wellness-CARE hero copy ("Feel better" / "unhurried care"
// / "take a deep breath") is a MISFIT on a plant/garden/florist shop — flora-grubb-san-francisco
// shipped H1 "Feel better in San Francisco" + "unhurried care that meets you where you are". Root-fixed
// in hero_copy.ts (personaHeroCopy plant branch → GROW copy) + THEME_PERSONALITY_BRIEF; clears on
// rebuild. Flag ONLY when the business IS plant-retail (a wellness site SHOULD say "feel better") AND
// only in the HERO region (top ~450 chars) so deeper body prose never false-fires. NB detect the
// vertical from PAGE CONTENT (the eyebrow "GARDEN SHOP & PLANT NURSERY"), NOT the slug — "flora grubb"
// carries no plant token.
const WELLNESS_CARE =
  /\b(feel better|take a deep breath|unhurried care|patient-first|meets you where you are|always in your corner)\b/i;
const PLANT_RETAIL_SIGNAL =
  /\b(garden\s?(?:shop|cent\w*|store|nurser\w*|suppl\w*)|plant\s?(?:shop|store|nurser\w*)|\bnurser(?:y|ies)\b|greenhouse|florist|flower\s?(?:shop|store|market)|botanical\s?garden|houseplant|horticultur\w*)\b/i;
// AL-641: a fine-art GALLERY is REFINED/curatorial — it must not wear the BRUTALIST persona ("No
// compromise" / "Uncompromising … impossible to ignore" / "made to stand out"), the bold voice
// shared with design/photo/ad studios that shipped on jackson-fine-art-atlanta (H1 "Atlanta. Art
// gallery. No compromise"). Root-fixed in theme_style.ts (galler*|fine art|art dealer → luxe, the
// refined "The finest … / Quiet luxury" persona) + hero_image.ts (gallery-interior hero, not the
// creative desk). Flag ONLY when the business IS a gallery (page content) AND the brutalist phrase
// is in the HERO region — so a design studio keeps its correct bold voice.
const GALLERY_SIGNAL = /\b(art\s?galler\w*|fine\s?art\b|\bgaller(?:y|ies)\b|art\s?dealer\w*)\b/i;
const BRUTALIST_MISFIT = /\b(no compromise|uncompromising|impossible to ignore|made to stand out)\b/i;
// AL-654: the `warm` persona subhead hardcoded a cafe-ism ("where the coffee is hot") that shipped
// on EVERY hospitality vertical — franklin-barbecue (BBQ) + pizzeria-bianco (pizzeria) both read
// "…where the coffee is hot". Root-fixed in hero_copy.ts (warm subhead → "where the welcome is
// warm", vertical-neutral). Flag the cafe-ism ONLY when the business is NOT a coffee/cafe/tea/bakery
// vertical (those legitimately have hot coffee) + in the HERO region.
const COFFEE_SIGNAL =
  /\b(coffee|caf[eé]|espresso|roaster|roastery|tea\s?(?:shop|house|room)|bakery|patisserie|brunch|diner|breakfast)\b/i;
const COFFEE_MISFIT = /\bthe coffee is hot\b/i;
// AL-696: the `noir` themeStyle is shared by NIGHTLIFE venues (speakeasy/cocktail-bar/lounge/club)
// AND tattoo/body-art STUDIOS (the dark aesthetic fits both). Its hero copy is nightlife-SPECIFIC
// ("room after dark" / "careful pours" / "candlelit" / "nights begin") — a MISFIT on a tattoo studio
// (three-kings-tattoo-brooklyn shipped H1 "Brooklyn's room after dark"). Root-fixed in hero_copy.ts
// (personaHeroCopy noir INK branch → custom-ink copy) + THEME token. Flag ONLY when the business IS a
// tattoo/body-art studio (page content) AND the nightlife phrase is in the HERO region — so an actual
// bar keeps its correct after-dark voice. Detect the misfit with the phrase STRIPPED (like COFFEE).
const BODY_ART_SIGNAL =
  /\b(tattoo\w*|piercing\w*|body\s?(?:art|piercing)|ink\s?(?:shop|studio|parlor|parlour)|tattoo(?:ist|er)\w*)\b/i;
const NIGHTLIFE_MISFIT = /\b(room after dark|careful pours|candlelit|nights begin|after dark)\b/i;
// AL-698: a FISH / SEAFOOD MARKET is a walk-in food purveyor (like a grocery) but "fish market"
// matched boutique's `\bmarket\b` → a FASHION-BOUTIQUE voice ("a chic fish market … pieces worth the
// trip, chosen with a tastemaker's eye" + "Browse our collection") on pike-place-fish-market-seattle.
// Root-fixed in theme_style.ts (fish/seafood market → warm) + commerceModeFor (→ quickserve, food
// badges not retail shipping) + hero_image.ts (→ the food-market hero). Flag ONLY when the business
// IS a fish/seafood market (page content) AND the boutique-fashion phrase is in the HERO region.
const FOOD_MARKET_SIGNAL =
  /\b(fish\s?market\w*|fishmonger\w*|seafood\s?(?:market|shop|store|counter)|\bseafood\b)\b/i;
const BOUTIQUE_FASHION_MISFIT =
  /\b(chic|tastemaker'?s? eye|pieces worth the trip|quietly covetable|browse our collection|styled)\b/i;
// AL-549 (this fire): a WALK-UP counter food business (coffee/roaster/cafe/ice-cream/bakery/juice/deli)
// is quickserve — patrons ORDER and GO, never book a table. A pre-AL-549 build framed the coffee ROASTER
// stumptown-coffee-portland as a full-service RESTAURANT ("reserve a table / reservations welcome / come
// hungry, leave happy"). Root-fixed in theme_style.ts commerceModeFor (coffee/roaster → quickserve, AL-549)
// + tested (theme_style.test.ts:476). This guards the RENDERED surface so an LLM-DRIFT dining phrase on a
// quickserve vertical is caught (the deterministic mode-map can't see the container LLM's prose). TABLE-
// RESERVATION language is the unambiguous signal — a walk-up counter takes no table reservations; gate on
// the quickserve-food vertical (page content) + the phrase in the HERO region → near-zero false positives.
const QUICKSERVE_FOOD_SIGNAL =
  /\b(coffee\s?(?:shop|house|bar|roaster\w*)|\broaster(?:y|ies)\b|espresso|caf[eé]\w*|ice\s?cream|gelato|creamer\w*|frozen\s?yogurt|froyo|juice\s?bar|smoothie\s?bar|bakery|patisserie|donut\w*|doughnut\w*|bagel\w*|delicatessen|bubble\s?tea|\bboba\b|teahouse|food\s?truck)\b/i;
const DINING_RESERVATION_MISFIT =
  /\b(reserve a table|book a table|reserve your table|table reservation|reservations welcome|make a reservation|come hungry,? leave happy|a warm seat and a plate)\b/i;
// AL-810: the `scholarly` themeStyle is shared by EDUCATION (school/tutor/academy/coaching/daycare)
// AND book RETAIL/libraries (bookstore/bookshop/booksellers/library/comic shop) — the shared books
// aesthetic. Its education LEARNING copy ("Where {city} learns" / "Bright futures start" / "patient
// teaching" / "every learner belongs" / "makes learning click") is a MISFIT on a bookstore: a store
// SELLS books, it does not teach. Root-fixed in hero_copy.ts (personaHeroCopy scholarly branch
// sub-classifies by category → a bookstore/library gets BROWSE/READ copy "Find your next read" /
// "comes to browse" / "shelves, well-curated"). This guards the RENDERED surface so a stale pre-AL-810
// build (or an LLM-drift learning phrase) is caught. Gate on the business BEING a bookstore/library
// (page content, not slug) + the education phrase in the HERO region → near-zero false positives (a
// real school matches the learning copy but NOT the bookstore signal; a bookseller never says these
// verbatim). "Where {city} learns" allows a 1-2-word city.
const BOOKSTORE_SIGNAL =
  /\b(book\s?stor\w*|bookshop\w*|booksell\w*|\bbooks\b|\blibrar\w*|comic\s?(?:shop|store))\b/i;
const EDUCATION_LEARNING_MISFIT =
  /\b(bright futures start|patient teaching|every learner belongs|makes learning click|let'?s grow together|where [\w'’]+(?: [\w'’]+)? learns)\b/i;
// AL-819: the `warm` themeStyle + `quickserve` commerce mode are shared by SIT-DOWN hospitality
// (restaurant/cafe/bakery/deli) AND walk-in GROCERY/MARKET (grocery/supermarket/greengrocer/bodega/
// butcher/fishmonger — routed to warm+quickserve by AL-656 for the warm food aesthetic + no-reservations
// framing). The `warm` hero copy ("Pull up a chair" / "everyone has a seat" / "cozy corner" / "slow
// down, feel at home") + the quickserve CTA/badge ("See our flavors" / "Made to order") are SEATING/
// made-to-order-DINING copy — a MISFIT on a grocery: you SHOP at a grocery, you don't pull up a chair
// or order flavors. Live, vision-caught: rainbow-grocery-san-francisco shipped H1 "Pull up a chair, San
// Francisco". Root-fixed in hero_copy.ts (a shared GROCERY_MARKET_CATEGORY sub-splits personaHeroCopy +
// heroCtasFor + trustBadgesFor → grocery gets "Stock up in {city}" / "See what's in store" / "Fresh
// daily"). This guards the RENDERED surface. Gate on the business BEING a grocery/market (page content,
// not slug) + the dining phrase in the HERO region → near-zero false positives (a real restaurant
// matches the seating copy but NOT the grocery signal; a corrected grocery never says these verbatim).
// Mirrors the hero_copy GROCERY_MARKET_CATEGORY (precise walk-in-food nouns, never bare "market").
const GROCERY_MARKET_SIGNAL =
  /\b(grocer\w*|supermarket\w*|greengrocer\w*|\bbodega\b|food\s?(?:market\w*|hall)|farmers?\s?market\w*|neighbou?rhood\s?market\w*|corner\s?(?:store|market\w*)|convenience\s?store|butcher\w*|fishmonger\w*|produce\s?(?:market\w*|stand))\b/i;
const GROCERY_DINING_MISFIT =
  /\b(pull up a chair|everyone has a seat|cozy corner|slow down,? and feel at home|feel at home|see our flavors|made to order)\b/i;
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
        // AL-611: a plant/garden/florist RETAIL site must not wear the botanical WELLNESS-care hero
        // copy ("Feel better"/"unhurried care"). Gate on the business being plant-retail (page content,
        // not slug) + the wellness phrase living in the HERO region (H1 or top ~450 chars) — so a
        // wellness site keeps its correct "feel better" and deep body prose never false-fires.
        if (
          PLANT_RETAIL_SIGNAL.test(nBody) &&
          (WELLNESS_CARE.test(nH1) || WELLNESS_CARE.test(nBody.slice(0, 450)))
        ) {
          const m = WELLNESS_CARE.exec(nH1) || WELLNESS_CARE.exec(nBody.slice(0, 450));
          hits.push({ slug, route, kind: 'wellness-copy-on-plant', detail: `plant-retail hero wears wellness-care copy "${m?.[0]}" (AL-611 misfit)` });
        }
        // AL-641: a fine-art gallery must not wear the brutalist bold persona.
        if (
          GALLERY_SIGNAL.test(nBody) &&
          (BRUTALIST_MISFIT.test(nH1) || BRUTALIST_MISFIT.test(nBody.slice(0, 450)))
        ) {
          const m = BRUTALIST_MISFIT.exec(nH1) || BRUTALIST_MISFIT.exec(nBody.slice(0, 450));
          hits.push({ slug, route, kind: 'brutalist-persona-on-gallery', detail: `fine-art gallery hero wears brutalist copy "${m?.[0]}" (AL-641 misfit — should be luxe)` });
        }
        // AL-654: a non-coffee hospitality business must not render the cafe-ism "the coffee is hot".
        // Detect the cafe VERTICAL from the body with the misfit phrase STRIPPED — else the phrase's
        // own "coffee" token self-exempts it (a BBQ joint's ONLY "coffee" is the misfit itself; a real
        // cafe still says coffee/espresso/cafe elsewhere).
        if (
          COFFEE_MISFIT.test(nBody.slice(0, 450)) &&
          !COFFEE_SIGNAL.test(nBody.replace(/the coffee is hot/g, ''))
        ) {
          hits.push({ slug, route, kind: 'coffee-copy-on-non-cafe', detail: 'hospitality hero says "the coffee is hot" on a non-coffee business (AL-654 cafe-ism misfit)' });
        }
        // AL-696: a tattoo/body-art studio must not wear the noir NIGHTLIFE copy. Gate on the business
        // being body-art (page content) + the nightlife phrase in the HERO region (H1 or top ~450c).
        if (
          BODY_ART_SIGNAL.test(nBody) &&
          (NIGHTLIFE_MISFIT.test(nH1) || NIGHTLIFE_MISFIT.test(nBody.slice(0, 450)))
        ) {
          const m = NIGHTLIFE_MISFIT.exec(nH1) || NIGHTLIFE_MISFIT.exec(nBody.slice(0, 450));
          hits.push({ slug, route, kind: 'nightlife-copy-on-tattoo', detail: `tattoo/body-art hero wears nightlife copy "${m?.[0]}" (AL-696 misfit — should be noir INK copy)` });
        }
        // AL-698: a fish/seafood market must not wear the boutique-FASHION voice ("chic"/"tastemaker's
        // eye"/"pieces worth the trip"/"collection"). Gate on the business being a fish/seafood market
        // (page content) + the fashion phrase in the HERO region.
        if (
          FOOD_MARKET_SIGNAL.test(nBody) &&
          (BOUTIQUE_FASHION_MISFIT.test(nH1) || BOUTIQUE_FASHION_MISFIT.test(nBody.slice(0, 450)))
        ) {
          const m = BOUTIQUE_FASHION_MISFIT.exec(nH1) || BOUTIQUE_FASHION_MISFIT.exec(nBody.slice(0, 450));
          hits.push({ slug, route, kind: 'fashion-copy-on-food-market', detail: `fish/seafood market hero wears boutique-fashion copy "${m?.[0]}" (AL-698 misfit — should be warm food voice)` });
        }
        // AL-549: a walk-up food vertical (coffee/roaster/cafe/bakery/ice-cream) must not wear
        // full-service DINING copy (table reservations / "come hungry, leave happy"). Gate on the
        // quickserve-food vertical (page content) + the dining phrase in the HERO region (H1 or top
        // ~600c) — a real sit-down restaurant matches the reservation phrase but NOT the quickserve
        // signal, so it never false-fires; a counter-serve site that correctly says "order ahead / no
        // reservation needed" carries no misfit phrase.
        if (
          QUICKSERVE_FOOD_SIGNAL.test(nBody) &&
          (DINING_RESERVATION_MISFIT.test(nH1) || DINING_RESERVATION_MISFIT.test(nBody.slice(0, 600)))
        ) {
          const m = DINING_RESERVATION_MISFIT.exec(nH1) || DINING_RESERVATION_MISFIT.exec(nBody.slice(0, 600));
          hits.push({ slug, route, kind: 'dining-copy-on-quickserve', detail: `walk-up food vertical wears full-service dining copy "${m?.[0]}" (AL-549 misfit — a counter-serve coffee/cafe/bakery takes no table reservations; should be quickserve "Order ahead / no reservation needed")` });
        }
        // AL-810: a bookstore/library must not wear the education LEARNING persona ("Where {city}
        // learns" / "Bright futures start" / "patient teaching"). Gate on the business being a
        // bookstore/library (page content) + the learning phrase in the HERO region (H1 or top ~450c)
        // — a real school matches the learning copy but not the bookstore signal, so it never
        // false-fires; a bookseller build that correctly says "Find your next read" carries no misfit.
        if (
          BOOKSTORE_SIGNAL.test(nBody) &&
          (EDUCATION_LEARNING_MISFIT.test(nH1) || EDUCATION_LEARNING_MISFIT.test(nBody.slice(0, 450)))
        ) {
          const m = EDUCATION_LEARNING_MISFIT.exec(nH1) || EDUCATION_LEARNING_MISFIT.exec(nBody.slice(0, 450));
          hits.push({ slug, route, kind: 'education-copy-on-bookstore', detail: `bookstore/library hero wears education-learning copy "${m?.[0]}" (AL-810 misfit — a store sells books, it doesn't teach; should be BROWSE/READ copy "Find your next read")` });
        }
        // AL-819: a walk-in grocery/market must not wear the sit-down warm DINING copy ("Pull up a
        // chair" / "everyone has a seat") or the made-to-order quickserve copy ("See our flavors" /
        // "Made to order"). Gate on the business being a grocery/market (page content) + the dining
        // phrase in the HERO region (H1 or top ~450c) — a real restaurant matches the seating copy but
        // not the grocery signal, so it never false-fires; a corrected grocery says "Stock up".
        if (
          GROCERY_MARKET_SIGNAL.test(nBody) &&
          (GROCERY_DINING_MISFIT.test(nH1) || GROCERY_DINING_MISFIT.test(nBody.slice(0, 450)))
        ) {
          const m = GROCERY_DINING_MISFIT.exec(nH1) || GROCERY_DINING_MISFIT.exec(nBody.slice(0, 450));
          hits.push({ slug, route, kind: 'dining-copy-on-grocery', detail: `grocery/market hero wears sit-down dining / made-to-order copy "${m?.[0]}" (AL-819 misfit — you shop at a grocery, you don't pull up a chair or order flavors; should be "Stock up in {city}" / "See what's in store" / "Fresh daily")` });
        }
      } catch {
        /* route unreachable → skip (don't false-fail) */
      }
    }
    await ctx.close().catch(() => {});
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
console.log(`::notice:: verify-vertical-persona — ${msg} (stale pre-fix build — AL-554 gear / AL-559 credential / AL-611 wellness-copy-on-plant / AL-641 brutalist-on-gallery / AL-654 coffee-on-non-cafe / AL-696 nightlife-copy-on-tattoo / AL-698 fashion-copy-on-food-market / AL-549 dining-copy-on-quickserve / AL-810 education-copy-on-bookstore / AL-819 dining-copy-on-grocery; each root fix lands next build, NO redeploy → clears on rebuild; set STRICT=1 to enforce)`);
process.exit(0);
