/**
 * @module services/hero_image
 * @description Curated per-SUB-VERTICAL hero image seed for the fast-path site-generation build.
 *
 * WHY (AL-485 — C.7 hero-image-vertical, the ONE documented-open § C dimension): the template
 * content pack keys `HERO_IMAGE_URL` off ~14 BROAD verticals (medical/dental/…/retail/restaurant),
 * so a plant shop / record store / cocktail lounge collapses to the generic bucket — "retail" ships
 * "cozy independent shop interior shelves", a cocktail bar ships the "restaurant" cafe interior. The
 * #1 visual element (the LCP hero) then shows the WRONG vertical: perennials-brooklyn (plant) +
 * the-secret-society-portland (cocktail bar) were BOTH flagged live by `verify-hero-image-vertical`.
 * The buildPrompt "pick the vertical-specific `_assets.json` image" instruction is INERT on the
 * ~150s fast path (AL-409, the fast-path-renders-seeded-tokens law). Root fix (the prescribed lever,
 * per `_APP_COMPLETION.md` § C AL-480): SEED a vertical-specific `HERO_IMAGE_URL` at delivery time
 * from this curated map, on the SAME existing-wins `_content.json` seam as `HERO_HEADLINE` — the
 * worker value wins over the pack default, so it lands on the fast path (deterministic, no rebuild
 * of the container needed; the `authoritative-signal-immutable-against-unreliable-generator` pattern).
 *
 * Each URL is a REAL `images.unsplash.com` CDN link (already in `build_validators` external-host
 * allowlist), sourced via the Unsplash search API (2026-09-13) for its vertical so BOTH hold:
 *   (a) the PIXELS are on-vertical — each was picked by requiring the vertical noun in the photo's
 *       own `alt_description` (tags are noisy; alt is the reliable signal);
 *   (b) the `ixid` query param base64-decodes to a query containing the vertical noun — exactly what
 *       `verify-hero-image-vertical.mjs` decodes to score the hero, so the probe flips green.
 *
 * Covers the sub-verticals that measurably collapse to a generic pack bucket. A business with no
 * curated match returns `null` → the caller omits the seed → the pack's broad-vertical default still
 * applies (no regression). Pure; never throws.
 */

/** A curated hero image: the Unsplash CDN URL + a clean, vertical-descriptive alt (a11y + SEO). */
export interface HeroImage {
  readonly url: string;
  readonly alt: string;
}

// Sourced 2026-09-13 (Unsplash search API, alt-verified on-vertical). `w=1080` landscape, allowlisted host.
const PLANT: HeroImage = {
  url: 'https://images.unsplash.com/photo-1758524056772-0b2f42ca8174?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHw3fHxwbGFudCUyMHNob3AlMjBpbnRlcmlvciUyMHBsYW50c3xlbnwxfDB8fHwxNzg5MzE1NjQxfDA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Lush greenery filling a bright, welcoming plant shop',
};
const FLORIST: HeroImage = {
  url: 'https://images.unsplash.com/photo-1487070183336-b863922373d4?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwyfHxmbG93ZXIlMjBzaG9wJTIwZmxvcmlzdCUyMGludGVyaW9yfGVufDF8MHx8fDE3ODkzMTU2NDF8MA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Fresh seasonal bouquets arranged in a flower shop',
};
const COCKTAIL: HeroImage = {
  url: 'https://images.unsplash.com/photo-1763771757330-3212b518e31c?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHw0fHxjb2NrdGFpbCUyMGJhciUyMGludGVyaW9yfGVufDF8MHx8fDE3ODkzMTU2NDF8MA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'A bartender crafting cocktails behind a dimly lit bar',
};
const RECORD: HeroImage = {
  url: 'https://images.unsplash.com/photo-1582730147924-d92f4da00252?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwyfHxyZWNvcmQlMjBzdG9yZSUyMHZpbnlsJTIwcmVjb3Jkc3xlbnwxfDB8fHwxNzg5MzE1NjQxfDA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Vinyl records lined up in a record store',
};
const BOOKSTORE: HeroImage = {
  url: 'https://images.unsplash.com/photo-1620388639945-990753377b58?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwzfHxib29rc3RvcmUlMjBib29rc2hlbHZlcyUyMGludGVyaW9yfGVufDF8MHx8fDE3ODkzMTU2NDJ8MA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Wooden shelves lined with books in a cozy bookstore',
};
const BREWERY: HeroImage = {
  url: 'https://images.unsplash.com/photo-1546622891-02c72c1537b6?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwxfHxicmV3ZXJ5JTIwYmVlciUyMHRhcHMlMjBiYXJ8ZW58MXwwfHx8MTc4OTMxNTY0Mnww&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'A fresh beer poured from the taps at a craft brewery',
};
// DISTILLERY (this fire): a craft distillery is a HOSPITALITY tasting-room vertical (AL-549) with a
// distinct visual identity — copper pot stills — but "distillery" had NO curated hero, so
// koval-distillery-chicago fell to the pack's generic hero (a gift-shop/gallery interior, the exact
// pre-AL-656 fallback), vision-caught live. Route distiller* to a real copper-stills hero. Sourced
// via Unsplash search API 2026-09-16 ("distillery copper still spirits"), alt-verified on-vertical,
// URL prod-200 (120KB); ixid base64-decodes to "distillery …" so verify-hero-image-vertical reads it
// green off the H1/title "distillery" noun. Beer/brewery stays BREWERY above; wine/cider get their
// own hero when delivered.
const DISTILLERY: HeroImage = {
  url: 'https://images.unsplash.com/photo-1765989506097-e8f1a3e03844?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwzfHxkaXN0aWxsZXJ5JTIwY29wcGVyJTIwc3RpbGwlMjBzcGlyaXRzfGVufDB8MHx8fDE3ODk1NTA4Mzl8MA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Gleaming copper pot stills in a craft distillery',
};
const JEWELRY: HeroImage = {
  url: 'https://images.unsplash.com/photo-1631560230221-faff391fd241?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwxMXx8amV3ZWxyeSUyMG5lY2tsYWNlJTIwcmluZyUyMGRpc3BsYXl8ZW58MXwwfHx8MTc4OTMxNTY0Mnww&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'A fine necklace on display in a jewelry store',
};
const TATTOO: HeroImage = {
  url: 'https://images.unsplash.com/photo-1760877611905-0f885a3ce551?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwxfHx0YXR0b28lMjBzdHVkaW8lMjBpbnRlcmlvcnxlbnwxfDB8fHwxNzg5MzE1NjQyfDA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'The inviting interior of a modern tattoo studio',
};
// FINANCE CLUSTER (AL-507): one hero for the whole financial-services domain — wealth mgmt,
// financial advisory, investment, insurance, accounting, bookkeeping, tax, CPA. WHY a cluster
// (not one-hero-per-noun like the retail verticals above): these sub-verticals share ONE visual
// domain — a professional financial office — exactly like the food cluster shares a cafe interior.
// The pack collapsed all of them to a LAW-flavored "professional" bucket (scales-of-justice icon
// + "law office interior" hero + "legal counsel" meta-desc — the AL-504 wealth→legal defect). This
// seeds a real finance hero; the probe's FINANCE_LEXICON bridge (verify-hero-image-vertical) accepts
// this one hero for any finance-domain noun, so "wealth"/"insurance"/"accounting" all match without a
// per-noun image. Sourced via Unsplash search API 2026-09-13 ("financial advisor office meeting").
const FINANCE: HeroImage = {
  url: 'https://images.unsplash.com/photo-1713461983836-de0a45009424?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwxfHxmaW5hbmNpYWwlMjBhZHZpc29yJTIwb2ZmaWNlJTIwbWVldGluZ3xlbnwwfDB8fHwxNzg5MzQzMTcyfDA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'A financial advisor reviewing figures at a desk',
};
// CREATIVE CLUSTER (AL-544): one hero for the whole creative-services domain — design studio,
// graphic design, creative/branding/ad agency, photography/photo studio, videography, art studio/
// gallery, production studio/house, animation, record label. WHY a cluster (like FINANCE): these
// share ONE visual domain — a design/creative WORKSPACE. brutalist (the preset for `design studio|
// creative|photography|agency|…` per theme_style.ts CATEGORY_RULES) had NO curated hero, so a
// design studio (pentagram-nyc) fell to the pack's generic "creative agency team meeting" (a cafe-
// ish team photo) — flagged live by verify-hero-image-vertical. Seeds a real design-studio desk;
// the probe's CREATIVE_LEXICON bridge accepts this one hero for any creative-domain noun. Sourced
// via Unsplash search API 2026-09-14 ("graphic design studio workspace"), alt-verified on-vertical.
const CREATIVE: HeroImage = {
  url: 'https://images.unsplash.com/photo-1765758014805-a7a6cc272982?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHw0fHxncmFwaGljJTIwZGVzaWduJTIwc3R1ZGlvJTIwd29ya3NwYWNlfGVufDB8MHx8fDE3ODkzOTQ2MTB8MA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: "A designer's desk with a computer and creative work in a studio",
};
// GALLERY (AL-641): a fine-art GALLERY is NOT a creative WORKSPACE — the CREATIVE cluster's
// messy designer's desk (above) is a misfit (live: jackson-fine-art-atlanta shipped that desk).
// A gallery's hero is its curated INTERIOR — framed works on clean walls. Carved out of CREATIVE
// (which keeps design/photo/art-STUDIOS); an art gallery/dealer gets this refined interior instead.
// Pairs with the luxe theme remap (theme_style.ts AL-641). Sourced via Unsplash search API
// 2026-09-15 ("art gallery interior paintings walls"), alt-verified on-vertical, URL prod-200 (107KB).
const GALLERY: HeroImage = {
  url: 'https://images.unsplash.com/photo-1606819717115-9159c900370b?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwxfHxhcnQlMjBnYWxsZXJ5JTIwaW50ZXJpb3IlMjBwYWludGluZ3MlMjB3YWxsc3xlbnwwfDB8fHwxNzg5NTIzNTMyfDA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Framed artworks on the walls of a fine-art gallery',
};
// SPECIALTY-FOOD + ACTIVE-GEAR (AL-597): the verticals delivered AL-583/588/594 (bike / cheese /
// butcher) had NO curated hero → the pack's generic "retail" bucket shipped "cozy independent shop
// interior shelves" as the LCP hero (flagged live by verify-hero-image-vertical on murrays-cheese +
// the-meat-hook). Route each to a real on-vertical Unsplash hero (sourced 2026-09-15 via the search
// API, alt-verified; the ixid base64-decodes to the vertical noun so the probe flips green). Pairs
// with the AL-589 theme_style remap (cheese/butcher→artisan, bike→rugged) — theme = VOICE+scene,
// this = the HERO IMAGE.
const BUTCHER: HeroImage = {
  url: 'https://images.unsplash.com/photo-1762088208244-dde4e8b10047?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwzfHxidXRjaGVyJTIwc2hvcCUyMG1lYXQlMjBoYW5naW5nfGVufDB8MHx8fDE3ODk0NjY1OTF8MA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Fresh cuts on display in a traditional butcher shop',
};
const CHEESE: HeroImage = {
  url: 'https://images.unsplash.com/photo-1769317047898-77997c1451c4?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHw0fHxjaGVlc2UlMjBzaG9wJTIwY291bnRlciUyMGRpc3BsYXl8ZW58MHwwfHx8MTc4OTQ2NjYxMnww&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'A cheese shop counter stacked with wheels of cheese',
};
// DELI (this fire): a delicatessen (sandwich / cured-meat counter) is its OWN vertical, visually
// distinct from a cheese shop — but the CHEESE rule used to also match `delicatessen|\bdeli\b`, so
// zingermans-ann-arbor-2 (a deli) shipped the cheese-shop hero (flagged live by
// verify-hero-image-vertical). Route deli/delicatessen to a real deli-counter hero + narrow CHEESE
// to cheese-only. Sourced via Unsplash search API 2026-09-15 ("delicatessen deli counter sandwiches",
// alt-verified; ixid base64-decodes to "delicatessen" so the probe reads it green off the H1 noun).
const DELI: HeroImage = {
  url: 'https://images.unsplash.com/photo-1705647405231-c481e117e609?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwxfHxkZWxpY2F0ZXNzZW4lMjBkZWxpJTIwY291bnRlciUyMHNhbmR3aWNoZXN8ZW58MHwwfHx8MTc4OTUxNTg3OXww&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'A deli counter display case filled with fresh sandwiches',
};
const BIKE: HeroImage = {
  url: 'https://images.unsplash.com/photo-1750341472956-e69e84cc71a9?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHw2fHxiaWN5Y2xlJTIwc2hvcCUyMGJpa2VzJTIwcmVwYWlyfGVufDB8MHx8fDE3ODk0NjY1OTF8MA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Bicycles lined up in a neighborhood bike shop',
};
// OUTDOOR / SKI / MOUNTAINEERING (AL-614): the outdoor-outfitter vertical (outdoor gear / ski shop /
// mountaineering / climbing / snowboard / backcountry / camping) had NO curated hero → the pack's
// generic "retail" bucket shipped a gift-shop/home-goods interior as the LCP hero (vision-caught live
// on alpenglow-sports-tahoe-city, a Tahoe outdoor & ski outfitter). Route to a real climbing/
// mountaineering-gear Unsplash hero (sourced 2026-09-15 via the search API, alt-verified; the ixid
// base64-decodes to "mountaineering equipment store" so the probe's OUTDOOR_LEXICON bridge matches an
// "outdoor gear" business against it). Pairs with the theme_style rugged→terrain scene (theme = VOICE +
// scene; this = the HERO IMAGE).
const OUTDOOR: HeroImage = {
  url: 'https://images.unsplash.com/photo-1573763769528-b9a21a45ce2a?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHw1fHxtb3VudGFpbmVlcmluZyUyMGVxdWlwbWVudCUyMHN0b3JlfGVufDB8MHx8fDE3ODk0OTE2MzJ8MA&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Climbing and mountaineering gear in an outdoor outfitter',
};
// STEAKHOUSE (AL-647): a steakhouse / chophouse is a DINING restaurant with a distinct upscale
// dining-room identity — but "restaurant" is a broad pack bucket with NO curated hero, so
// st-elmo-steak-house-indy shipped the generic "cozy warm neighborhood cafe interior" hero (flagged
// live by verify-hero-image-vertical). Route steakhouse/chophouse to a real plated dining-room hero.
// Sourced via Unsplash search API 2026-09-15 ("steakhouse restaurant dining room"), alt-verified,
// URL prod-200 (140KB); ixid base64-decodes to "steakhouse …" so the probe reads it green off the H1.
const STEAKHOUSE: HeroImage = {
  url: 'https://images.unsplash.com/photo-1776993298422-5b7df704c2c1?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwyfHxzdGVha2hvdXNlJTIwcmVzdGF1cmFudCUyMGRpbmluZyUyMHJvb218ZW58MHwwfHx8MTc4OTUzMDUzMnww&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'An elegant steakhouse dining room with set tables and warm lighting',
};
// HARDWARE (AL-647): a hardware store / home-improvement / paint / lumber shop had NO curated hero →
// the pack's generic "retail" bucket shipped "cozy independent shop interior shelves" as the LCP hero
// (flagged live on cole-hardware-sf). Route to a real hardware-shelf image (paint tins + tools).
// Sourced via Unsplash search API 2026-09-15 ("hardware store tools"), alt-verified, URL prod-200
// (77KB); ixid base64-decodes to "hardware store tools" so the probe reads it green off the H1 noun.
const HARDWARE: HeroImage = {
  url: 'https://images.unsplash.com/photo-1510016290251-68aaad49723e?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwyfHxoYXJkd2FyZSUyMHN0b3JlJTIwdG9vbHN8ZW58MHwwfHx8MTc4OTUzMDUzMnww&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Shelves of paint tins and tools in a neighborhood hardware store',
};
// GROCERY / MARKET (this fire): a neighborhood grocery / supermarket / greengrocer / bodega had NO
// curated hero → the pack's generic "retail" bucket shipped a gift-shop/gallery-looking interior as
// the LCP hero (vision-caught live on bi-rite-market-sf — an art-gallery interior on a grocery). Route
// to a real well-stocked grocery-aisle hero. Sourced via Unsplash search API 2026-09-16 ("grocery
// store produce market interior"), alt-verified on-vertical, URL prod-200 (281KB); the ixid base64-
// decodes to "grocery store produce market interior" so verify-hero-image-vertical reads it green off
// the H1 "grocery"/"market" noun. Pairs with the commerceModeFor grocery→quickserve fix (theme_style.ts,
// this fire) — a market is a walk-in FOOD seller, not a mail-order retail store.
const GROCERY: HeroImage = {
  url: 'https://images.unsplash.com/photo-1770234849035-4cd18beb4202?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwzfHxncm9jZXJ5JTIwc3RvcmUlMjBwcm9kdWNlJTIwbWFya2V0JTIwaW50ZXJpb3J8ZW58MHwwfHx8MTc4OTU0NDMwNHww&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'Fresh produce and full shelves in a well-stocked neighborhood grocery',
};
// AL-669 CERAMICS / pottery studio — a ceramics studio / pottery shop is a craft-retail vertical
// with a distinct maker identity; the broad "retail" bucket shipped the generic "cozy independent
// shop interior shelves" hero (vision-caught live on heath-ceramics-sausalito). ixid decodes to
// "ceramics pottery studio" so verify-hero-image-vertical reads the "ceramics" noun as a match.
const CERAMICS: HeroImage = {
  url: 'https://images.unsplash.com/photo-1595351298020-038700609878?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=M3w5MTc1ODN8MHwxfHNlYXJjaHwxfHxjZXJhbWljcyUyMHBvdHRlcnklMjBzdHVkaW98ZW58MHwwfHx8MTc4OTU2NjMxMHww&ixlib=rb-4.1.0&q=80&w=1080',
  alt: 'A potter shaping clay on a spinning wheel in a ceramics studio',
};

/**
 * Ordered [sub-vertical pattern → curated hero]. FIRST match wins. Scanned against the derived
 * category phrase (`categoryPhrase(...)` output). Deliberately NARROW: only the sub-verticals a
 * broad pack bucket gets visibly WRONG. No bare `\bbar\b` (would catch "barber"); no bare `record`
 * (paired with store/shop/vinyl). Each pattern's noun is the same one the probe reads from the H1.
 * The FINANCE row is a CLUSTER (one hero for the whole financial-services domain, paired with the
 * probe's FINANCE_LEXICON bridge) — `invest(ment|ing|or)` never matches "investigator"; `\btax\b`
 * never matches "taxi"; no bare `bank` (would catch food/blood bank).
 */
const RULES: ReadonlyArray<readonly [RegExp, HeroImage]> = [
  [
    /\b(plant\s?(shop|store|nursery)?|garden\s?cent\w*|nursery|greenhouse|succulent|houseplant)\b/,
    PLANT,
  ],
  [/\b(florist|flower\s?(shop|store)?|floral)\b/, FLORIST],
  [
    /\b(cocktail|speakeas\w*|night\s?club|nightclub|whisk\w*\s?bar|jazz\s?(bar|club|lounge)|piano\s?bar|cocktail\s?lounge)\b/,
    COCKTAIL,
  ],
  [/\b(record\s?(store|shop)|vinyl)\b/, RECORD],
  [/\b(book\s?stor\w*|bookshop\w*|booksell\w*|\bbooks\b)\b/, BOOKSTORE],
  [/\b(brewery|breweries|brewpub|taproom|beer\s?(hall|garden))\b/, BREWERY],
  // DISTILLERY — a craft distillery/distiller (copper pot stills). `distiller\w*` covers
  // distillery/distiller/distilleries/distilling; nothing else starts "distiller" (no false-match).
  [/\bdistiller\w*\b/, DISTILLERY],
  [/\b(jewel\w*|goldsmith\w*|watch\s?(shop|store|maker))\b/, JEWELRY],
  [/\b(tattoo\w*)\b/, TATTOO],
  // AL-597 specialty-food + active-gear — precise nouns; `meat` paired with shop/market/counter (no
  // bare `meat` → never a restaurant); `\bdeli\b` never matches "delivery"/"delicatessen" (own token).
  [/\b(butcher\w*|meat\s?(shop|market|counter)|charcuterie|salumeria)\b/, BUTCHER],
  // DELI before CHEESE: a delicatessen gets a deli-counter hero, NOT the cheese-shop one. `deli` is a
  // whole word (never matches "delivery"/"delish"); `delicatessen` is its own token.
  [/\b(delicatessen|deli)\b/, DELI],
  [/\b(cheese\s?(shop|monger\w*)?|cheesemong\w*|fromager\w*|creamer(?:y|ies))\b/, CHEESE],
  // GROCERY / MARKET — a neighborhood grocery / supermarket / greengrocer / bodega. Precise food-
  // grocery nouns only (NO bare `\bmarket\b` → "flea/art/night market" never false-match); `meat
  // market` is already caught by BUTCHER above, "food market" is a grocer. Pairs with the
  // commerceModeFor grocery→quickserve fix (a walk-in food seller, not mail-order retail).
  [
    /\b(grocer\w*|supermarket|greengrocer\w*|green\s?grocer\w*|food\s?market|farm\s?stand|produce\s?market|\bbodega\b|corner\s?(store|grocer\w*)|mini\s?mart|convenience\s?store|fishmonger\w*|fish\s?market\w*|seafood\s?(?:market|shop|store|counter))\b/,
    GROCERY,
  ],
  [/\b(bicycle\w*|\bbike\w*|cycling|cyclery|cyclist\w*)\b/, BIKE],
  // AL-614 outdoor/ski/mountaineering outfitter — precise: bare `outdoor` needs a gear/shop suffix
  // (so "outdoor dining" never matches) + `\bskis\b`/`ski shop` not bare "ski" (so "skincare" never
  // matches). Distinct from BIKE (cycling) above and from `precision` (motorsports).
  [
    /\b(outdoor\s?(gear|outfitter\w*|equipment|apparel|clothing|shop|store)|outfitter\w*|ski\s?(shop|store|rental|resort|gear|&?\s?snowboard)|\bskis\b|snowboard\s?(shop|store|gear)?|mountaineer\w*|\bclimbing\b|backcountry|camping\s?(gear|store|shop)|\bkayak\w*|paddleboard\w*)\b/,
    OUTDOOR,
  ],
  // AL-647 STEAKHOUSE — a steakhouse/chophouse is a dining restaurant with its own upscale
  // dining-room identity; "restaurant" alone has no curated hero (broad bucket). `steak\s?house`
  // matches "steakhouse"+"steak house"; no bare `steak` (never a butcher/grocery "steak" counter).
  [/\b(steak\s?house|chop\s?house|chophouse|prime\s?steak\w*)\b/, STEAKHOUSE],
  // AL-647 HARDWARE — hardware / home-improvement / paint / lumber retail. In a local-business hero
  // context "hardware" is overwhelmingly a hardware store; the softer nouns carry a shop/store/yard
  // suffix so "paint studio"(art) / bare "tool" never false-match.
  [
    /\b(hardware|home\s?improvement|tool\s?(shop|store)|lumber\s?(yard|\s?&?\s?supply)|paint\s?(shop|store)|ace\s?hardware|true\s?value)\b/,
    HARDWARE,
  ],
  // AL-669 CERAMICS / pottery — a ceramics studio / pottery shop. `ceramic\w*` covers
  // ceramics/ceramic; pottery + potter's-studio/shop; clay studio/works; stoneware/earthenware.
  // No bare `potter` (never "Harry Potter") / no bare `clay` (never a person's name).
  [
    /\b(ceramic\w*|pottery|potter(?:'s)?\s?(studio|shop|workshop)|clay\s?(studio|works)|stonewar\w*|earthenwar\w*)\b/,
    CERAMICS,
  ],
  [
    /\b(wealth|financ\w*|invest(ment|ing|or)\w*|asset\s?manage\w*|retirement\s?plan\w*|insuranc\w*|accounting|accountan\w*|bookkeep\w*|cpa|tax(es)?)\b/,
    FINANCE,
  ],
  // GALLERY — BEFORE creative so an art gallery/dealer gets the curated gallery INTERIOR, not the
  // creative-workspace desk (`art studio` stays creative below). Mirrors the luxe theme remap (AL-641).
  [/\b(art\s?galler\w*|fine\s?art\s?galler\w*|\bgaller(?:y|ies)\b|art\s?dealer\w*)\b/, GALLERY],
  // CREATIVE cluster — AFTER finance so "insurance agency"/"real estate agency" hit their own rules
  // first (this row never uses a bare `agency`). Precise creative-services nouns only, so a yoga/
  // dance/pilates "studio" (fitness) never matches (no bare `\bstudio\b`), and tattoo is caught above.
  [
    /\b(design\s?studio|graphic\s?design|creative\s?(studio|agency|shop|services)|design\s?(agency|firm)|branding|brand\s?studio|art\s?studio|photograph\w*|photo\s?studio|videograph\w*|production\s?(studio|house|company)|advertis\w*|animation\s?studio|record\s?label)\b/,
    CREATIVE,
  ],
];

/**
 * Return a curated hero image for a business's sub-vertical, or `null` when none applies (the caller
 * then omits the `HERO_IMAGE_URL`/`HERO_IMAGE_ALT` seed and the pack's broad default stands).
 *
 * @param catPhrase - The derived category noun phrase (`categoryPhrase(...)` output, e.g.
 *   `'plant shop'`, `'cocktail bar'`, `'record store'`); any non-string yields `null`.
 * @returns The matching {@link HeroImage}, or `null`. Never throws.
 *
 * @example
 * heroImageForVertical('plant shop')?.alt      // → 'Lush greenery filling a bright, welcoming plant shop'
 * heroImageForVertical('cocktail bar')?.url    // → 'https://images.unsplash.com/photo-1763771757330-…'
 * heroImageForVertical('wealth management')?.alt // → 'A financial advisor reviewing figures at a desk'
 * heroImageForVertical('grocery store')?.alt   // → 'Fresh produce and full shelves in a well-stocked neighborhood grocery'
 * heroImageForVertical('distillery')?.alt      // → 'Gleaming copper pot stills in a craft distillery'
 * heroImageForVertical('plumbing')             // → null  (broad pack default is correct)
 * heroImageForVertical('')                     // → null
 */
export function heroImageForVertical(catPhrase?: string | null): HeroImage | null {
  const s = typeof catPhrase === 'string' ? catPhrase.toLowerCase().trim() : '';
  if (!s) return null;
  for (const [re, img] of RULES) if (re.test(s)) return img;
  return null;
}
