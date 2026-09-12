/**
 * @module services/hero_copy
 * @description Pure derivations for the fast-path site-generation seed's hero copy —
 * the business-category noun phrase and the `<h1>` headline options that get written
 * into `_content.json` (HERO_HEADLINE) when a build carries no AI-authored hero.
 *
 * WHY (AL-361, 2026-09-11 — root cause of a defect confirmed on 2 live deliveries):
 * the inline derivation stripped `store`/`shop` from the category, so "Record Store"
 * collapsed to the bare singular "record" and the service-oriented `<h1>` frames
 * rendered broken copy — Apollon Music and Arts shipped **"Quality record Portland
 * counts on"** (and the frames read awkwardly for product/retail/food verticals in
 * general). `validateHeroNotPackDefault` only denylists the OLD static pack defaults,
 * so these dynamic-but-broken headlines passed. Fixing the derivation to keep the
 * natural retail/venue noun phrase ("record store", "book shop", "steak house") + using
 * frames that read cleanly for BOTH service and product verticals fixes every downstream
 * seeded string (about paragraphs, services intro, hero sub, and the H1), not just the H1.
 *
 * Pure. Never throw. Extracted so the derivation is unit-testable (the inline version
 * lived deep inside the workflow `run()` and had zero coverage).
 */

/**
 * Redundant corporate/legal suffixes that do NOT belong in running prose — stripped so
 * "Plumbing Services" → "plumbing", "Smith & Co LLC" → "smith &". Descriptive
 * retail/venue nouns (store, shop, house, studio, salon, center, parlor, clinic) are
 * DELIBERATELY kept — they ARE the vertical and reading "record store" / "steak house" is
 * correct where "record" / "steak" is broken.
 */
const REDUNDANT_SUFFIX =
  /\b(services?|company|co|llc|inc|corp|corporation|group|enterprises?|practice|agency|firm)\b/g;

/**
 * Adjectival / thin single-word categories that read awkwardly bare in the hero frames
 * ("Quality dental Seattle counts on") → expanded to their natural noun phrase. Keyed on
 * the EXACT post-suffix-strip phrase, so declared nouns ("dental clinic", "record store")
 * and non-thin verticals ("insurance", "plumbing") are left untouched. Note REDUNDANT_SUFFIX
 * strips "practice"/"firm", so "Dental Practice" → "dental" → re-expands here to "dental
 * practice", and "Law Firm" → "law" → "law firm" (idempotent round-trip).
 *
 * WHY (AL-389, 2026-09-12 — live on Gentle Dental): create-from-search now sometimes carries
 * a declared businessCategory ("Dental"), which bypasses the nicer {@link categoryFromName}
 * map and left `categoryPhrase` returning the bare adjective — the same thin-noun defect class
 * as AL-361's "record".
 */
const CATEGORY_NORMALIZE: Readonly<Record<string, string>> = {
  dental: 'dental practice',
  dentist: 'dental practice',
  dentistry: 'dental practice',
  orthodontist: 'orthodontic practice',
  orthodontics: 'orthodontic practice',
  chiropractic: 'chiropractic clinic',
  chiropractor: 'chiropractic clinic',
  medical: 'medical practice',
  law: 'law firm',
  legal: 'law firm',
};

/**
 * Derive a natural, prose-ready noun phrase from a declared business category.
 *
 * @param category - The declared vertical (e.g. `"Record Store"`, `"Plumbing Services"`,
 *   `"Steakhouse"`); any type (non-strings yield the fallback).
 * @returns A lowercased noun phrase safe to drop into copy, or `'local business'` when
 *   the category is blank/unusable. Retail/venue nouns are preserved.
 *
 * @example
 * categoryPhrase('Record Store')        // → 'record store'  (was the broken 'record')
 * categoryPhrase('Plumbing Services')   // → 'plumbing'
 * categoryPhrase('Steakhouse')          // → 'steakhouse'
 * categoryPhrase('Coffee Shop')         // → 'coffee shop'
 * categoryPhrase('Dental')              // → 'dental practice'  (AL-389: thin adjective expanded)
 * categoryPhrase('')                    // → 'local business'
 */
export function categoryPhrase(category?: unknown): string {
  const raw = typeof category === 'string' ? category : '';
  const phrase = raw
    .toLowerCase()
    .replace(REDUNDANT_SUFFIX, '')
    .replace(/[&/]+\s*$/, '') // a trailing "&"/"/" left by a stripped suffix ("smith &")
    .replace(/\s{2,}/g, ' ')
    .trim();
  return CATEGORY_NORMALIZE[phrase] || phrase || 'local business';
}

/**
 * Ordered [pattern → natural category phrase] map for deriving a vertical from a
 * business NAME when no category was declared. Most local businesses carry their
 * vertical in the name ("McGuckin Hardware", "Sunrise Bakery", "Elm Street Dental").
 * Word-boundary-anchored so "Lawson" ≠ law and "Autograph" ≠ auto; first match wins,
 * so more-specific patterns lead.
 */
const NAME_CATEGORY: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bhardware\b/, 'hardware store'],
  [/\bbake(?:ry|house)\b/, 'bakery'],
  [/\bpizz(?:eria|a)\b/, 'pizzeria'],
  [/\bbrew(?:ery|ing)\b/, 'brewery'],
  [/\bsteak\s?house\b/, 'steakhouse'],
  [/\b(?:coffee|espresso|roasters?)\b/, 'coffee shop'],
  [/\bcaf[eé]\b/, 'cafe'],
  [/\b(?:deli|delicatessen)\b/, 'deli'],
  [/\brestaurant\b/, 'restaurant'],
  [/\b(?:bookstore|booksellers?|books)\b/, 'bookstore'],
  [/\b(?:records?|vinyl)\b/, 'record store'],
  [/\bmusic\b/, 'music shop'],
  [/\b(?:florist|floral|flowers)\b/, 'florist'],
  [/\b(?:plumbing|plumbers?)\b/, 'plumbing'],
  [/\broof(?:ing|ers?)\b/, 'roofing'],
  [/\b(?:hvac|heating|cooling)\b/, 'HVAC service'],
  [/\belectric(?:al|ian)?\b/, 'electrical service'],
  [/\b(?:landscap(?:ing|e|ers?)|lawn\s?care)\b/, 'landscaping'],
  [/\bbarber(?:shop)?\b/, 'barbershop'],
  [/\bsalon\b/, 'salon'],
  [/\bspa\b/, 'spa'],
  [/\bmassage\b/, 'massage therapy'],
  [/\bchiropract(?:ic|or)\b/, 'chiropractic clinic'],
  [/\byoga\b/, 'yoga studio'],
  [/\bpilates\b/, 'pilates studio'],
  [/\b(?:fitness|crossfit|gym)\b/, 'gym'],
  [/\b(?:dental|dentist(?:ry)?|orthodont(?:ics|ist))\b/, 'dental practice'],
  [/\b(?:attorneys?|law|legal)\b/, 'law firm'],
  [/\b(?:accounting|accountants?|cpa)\b/, 'accounting firm'],
  [/\binsurance\b/, 'insurance agency'],
  [/\b(?:realty|realtors?|real\s?estate)\b/, 'real estate agency'],
  [/\b(?:automotive|mechanic|auto)\b/, 'auto shop'],
  [/\b(?:veterinary|animal\s?hospital|vet)\b/, 'veterinary clinic'],
  [/\bpharmacy\b/, 'pharmacy'],
  [/\b(?:jewelers?|jewelry|jewellery)\b/, 'jewelry store'],
  [/\bboutique\b/, 'boutique'],
  [/\b(?:nursery|garden\s?center)\b/, 'garden center'],
  [/\b(?:winery|vineyard)\b/, 'winery'],
  [/\bcatering\b/, 'catering service'],
  [/\bphotograph(?:y|ers?)\b/, 'photography studio'],
  [/\b(?:cleaners?|cleaning)\b/, 'cleaning service'],
];

/**
 * Derive a category noun phrase from a business NAME, for the fast-path seed when
 * `create-from-search` carried no declared category (else the hero copy falls to the
 * generic "local business" — McGuckin Hardware shipped **"Quality local business
 * Boulder counts on"** live, 2026-09-11). Feeds {@link categoryPhrase} as a fallback.
 *
 * @param name - The business name (e.g. `"McGuckin Hardware"`); any type.
 * @returns A category phrase when the name contains a recognized vertical noun, else
 *   `''` (so `params.businessCategory || categoryFromName(name)` cleanly falls through
 *   to `categoryPhrase('')` → `'local business'` — no regression on unrecognizable names).
 *
 * @example
 * categoryFromName('McGuckin Hardware')  // → 'hardware store'
 * categoryFromName('Sunrise Bakery')     // → 'bakery'
 * categoryFromName('Elm Street Dental')  // → 'dental practice'
 * categoryFromName('Harvest & Vine')     // → ''  (no vertical noun → caller falls back)
 */
export function categoryFromName(name?: unknown): string {
  const raw = typeof name === 'string' ? name.toLowerCase() : '';
  if (!raw) return '';
  for (const [re, phrase] of NAME_CATEGORY) if (re.test(raw)) return phrase;
  return '';
}

/**
 * Hero `<h1>` headline options for a category phrase + city, worded to read naturally
 * for BOTH service and product/retail/food verticals (the old frames were
 * service-only). Identity-woven with the city so headlines never collide across
 * businesses/cities and never trip `validateHeroNotPackDefault`. The caller picks one.
 *
 * @param catPhrase - A phrase from {@link categoryPhrase} (e.g. `'record store'`).
 * @param cityPhrase - The city/community (e.g. `'Portland'`, or `'your community'`).
 * @returns Non-empty list of grammatical, slop-free headline candidates.
 *
 * @example
 * heroHeadlineOptions('record store', 'Portland')
 * // → ["Portland's record store", "Portland's trusted record store",
 * //    "Your Portland record store", "Quality record store Portland counts on"]
 */
export function heroHeadlineOptions(catPhrase: string, cityPhrase: string): readonly string[] {
  const cat = (catPhrase || 'local business').trim();
  const city = (cityPhrase || 'your community').trim();
  return [
    `${city}'s ${cat}`,
    `${city}'s trusted ${cat}`,
    `Your ${city} ${cat}`,
    `Quality ${cat} ${city} counts on`,
  ];
}

/**
 * `<title>` SEO_TAGLINE options (AL-369) — the value-prop title suffix in
 * `<title>{BUSINESS_NAME} — {SEO_TAGLINE}</title>` (the template's Home.tsx appends
 * `| {city}` itself, so these are CITY-FREE). The fast-path build left this as the
 * per-industry content-pack default, so every restaurant shipped the IDENTICAL,
 * colliding "Fresh, Local, Made From Scratch" (confirmed live on Ember + Cafe Dim Sum).
 * These are VERTICAL-specific + keyword-bearing (good local SEO), capital-start
 * (title-cased), slop-free, and DISTINCT from {@link heroHeadlineOptions} so the
 * `<title>` and the `<h1>` don't read as duplicates. Short so `{name} — {tagline}`
 * + the appended `| {city}` stays near the 50-60 char sweet spot (finalizeSeoInvariants
 * clamps anyway). Caller picks one via the same `pick()` as HERO_HEADLINE.
 *
 * @param catPhrase - A phrase from {@link categoryPhrase} (e.g. `'record store'`).
 * @returns Non-empty list of grammatical, city-free title-suffix candidates.
 *
 * @example
 * seoTaglineOptions('record store')
 * // → ['Trusted local record store', 'Your neighborhood record store', 'Local record store you can trust']
 */
export function seoTaglineOptions(catPhrase: string): readonly string[] {
  const cat = (catPhrase || 'local business').trim();
  return [`Trusted local ${cat}`, `Your neighborhood ${cat}`, `Local ${cat} you can trust`];
}
