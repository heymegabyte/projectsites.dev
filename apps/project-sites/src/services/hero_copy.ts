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
  // Google-Places snake_case types that reach categoryPhrase via create-from-search
  // (business_category is seeded from types[0]). AL-410: "veterinary_care" leaked the
  // raw token into a live H1 ("Your Bend veterinary_care"). The `_`→space normalize in
  // categoryPhrase turns these into readable phrases; these entries upgrade the thin
  // ones to their natural business noun.
  veterinary: 'veterinary clinic',
  veterinarian: 'veterinary clinic',
  'veterinary care': 'veterinary clinic',
  'point of interest': 'local business',
  establishment: 'local business',
  'car repair': 'auto shop',
  'car dealer': 'car dealership',
  'beauty salon': 'salon',
  'hair care': 'salon',
  // Professional-services DISCIPLINE nouns — bare, these read as an abstract FIELD, not a
  // business: "Seattle's trusted architecture" / "Your neighborhood accounting" (both live on
  // prod — olson-kundig-seattle + ben-badgley-cpa, AL-565). Suffix to the business noun so the
  // H1 + SEO title + about/services copy (all woven from this one phrase) stay grammatical.
  // Mirrors the NAME_CATEGORY forms for the DECLARED-category path (which strips "firm"/"agency"
  // via REDUNDANT_SUFFIX then re-expands here, idempotent) + adds disciplines NAME_CATEGORY lacked.
  accounting: 'accounting firm',
  accountant: 'accounting firm',
  cpa: 'accounting firm',
  architecture: 'architecture firm',
  architect: 'architecture firm',
  architectural: 'architecture firm',
  consulting: 'consulting firm',
  consultant: 'consulting firm',
  engineering: 'engineering firm',
  marketing: 'marketing agency',
  advertising: 'advertising agency',
  insurance: 'insurance agency',
  'real estate': 'real estate agency',
  realty: 'real estate agency',
  realtor: 'real estate agency',
  design: 'design studio',
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
 * categoryPhrase('veterinary_care')     // → 'veterinary clinic'  (AL-410: snake_case Places type normalized)
 * categoryPhrase('')                    // → 'local business'
 */
export function categoryPhrase(category?: unknown): string {
  const raw = typeof category === 'string' ? category : '';
  const phrase = raw
    .toLowerCase()
    .replace(/[_]+/g, ' ') // AL-410: normalize snake_case Places types ("veterinary_care" → "veterinary care") BEFORE anything else — a raw type-token in the H1 is a machine-copy defect
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
  [/\barchitect(?:s|ure|ural)?\b/, 'architecture firm'],
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
 * //    "Your Portland record store", "The record store Portland counts on"]
 */
/**
 * The correct English indefinite article for a noun phrase — `'an'` before a vowel-initial word,
 * else `'a'`. Sufficient for business CATEGORY nouns (bookstore→a, art gallery→an, ice cream shop→an);
 * it does NOT handle silent-h / vowel-sound-consonant edge cases (no business category needs them).
 * Keeps a hero subheadline grammatical when a category noun follows a preposition (`for ${art} ${cat}`)
 * instead of a bare "for bookstore that…" (AL-501 — the 2×-confirmed persona-subhead grammar defect).
 * Also drives the heritage headline's leading article on the CITY (`An Asheville …` / `A Boston …`,
 * AL-508) — proper-noun cities carry the same low edge-case risk as category nouns.
 *
 * @example indefiniteArticle('bookstore')    // 'a'
 * @example indefiniteArticle('art gallery')  // 'an'
 * @example indefiniteArticle('Asheville')    // 'an'  (heritage headline city slot)
 */
export function indefiniteArticle(noun: string): 'a' | 'an' {
  return /^[aeiou]/i.test((noun || '').trim()) ? 'an' : 'a';
}

export function heroHeadlineOptions(catPhrase: string, cityPhrase: string): readonly string[] {
  const cat = (catPhrase || 'local business').trim();
  const city = (cityPhrase || 'your community').trim();
  return [
    `${city}'s ${cat}`,
    `${city}'s trusted ${cat}`,
    `Your ${city} ${cat}`,
    // AL-576: was `Quality ${cat} ${city} counts on` — the weakest of the four (a generic
    // "Quality" lead + a clunky dropped-relative-pronoun) shipped live on 6 neutral-personality
    // sites (secret-society/perennials/verve/gruhn/jenis/laughing-lotus via the `pick()` selector).
    // A clean relative-clause frame keeps the cat+city SEO keywords + the trust sentiment without
    // the generic opener: "The cocktail bar Portland counts on".
    `The ${cat} ${city} counts on`,
  ];
}

/**
 * Lead the hero H1 with the BUSINESS NAME so a seeded headline reads as THIS business, not a shared
 * city/category/persona phrase. The persona/generic headline is city+category-woven for SEO +
 * anti-collision, but it is NOT business-specific — so every "warm" diner in Minneapolis otherwise
 * ships the identical H1 `Minneapolis's cozy corner` (the #1 "recolored template" tell, and a
 * within-city collision). The `<title>` + `<meta description>` are already business-specific; the
 * seeded H1 was the last generic surface (`generated-site-hero-h1-is-industry-pack-default`).
 *
 * Prepends the cleaned business name + em-dash to the picked headline, keeping the city+category SEO
 * + persona voice after the dash: `Al's Breakfast — Minneapolis's cozy corner`. Returns the headline
 * UNCHANGED when the name is absent / the generic `Business` fallback / already leads the headline /
 * the combined string would exceed a sane hero bound — so it never double-names nor ships `Business —`.
 *
 * Pure + deterministic — lands on the same existing-wins `_content.json` seam as HERO_HEADLINE
 * (`authoritative-signal-immutable-against-unreliable-generator`), so it holds regardless of build
 * budget (an AI-authored hero, when the build-LLM is funded, still overrides via existing-wins).
 *
 * @param businessName - The real business name (`params.businessName`), or the `Business` fallback.
 * @param headline - The picked persona/generic headline (city+category-woven).
 * @returns The business-name-led H1, or `headline` unchanged when a guard trips.
 *
 * @example
 * leadWithBusinessName("Al's Breakfast", "Minneapolis's cozy corner")
 * // → "Al's Breakfast — Minneapolis's cozy corner"
 * leadWithBusinessName("Business", "Denver's trusted plumber") // → "Denver's trusted plumber"
 * leadWithBusinessName("Perennials LLC", "The finest florist in Portland")
 * // → "Perennials — The finest florist in Portland"  (legal suffix stripped)
 */
export function leadWithBusinessName(
  businessName: string | null | undefined,
  headline: string,
): string {
  const h = (headline || '').trim();
  if (!h) return h;
  // Strip trailing legal suffixes (LLC / Inc / Co / Ltd / …) + surrounding punctuation, collapse
  // whitespace, and clamp to a hero-sane length so a verbose registered name never bloats the H1.
  const name = (businessName || '')
    .replace(
      /[,\s]+(?:llc|l\.l\.c\.|inc\.?|incorporated|co\.?|corp\.?|ltd\.?|company|pllc|lp|llp)\.?$/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 42)
    .trim();
  // Guards: no real name / the generic `Business` fallback → keep the headline; the name already
  // leads the headline (case-insensitive) → keep (never double-name).
  if (name.length < 2 || /^business$/i.test(name)) return h;
  if (h.toLowerCase().startsWith(name.toLowerCase())) return h;
  const combined = `${name} — ${h}`;
  // Keep the plain headline if leading with the name would blow past a sane H1 length.
  return combined.length > 72 ? h : combined;
}

/**
 * Derive the CITY from a business address, robust to BOTH shapes the create flow feeds it: a compact
 * Google Places `formattedAddress` (`"179 E Houston St, New York, NY 10002, USA"`) AND the verbose
 * OSM/Nominatim `display_name` the AL-729 search fallback returns (`"Russ & Daughters, 179, East
 * Houston Street, …, New York, 10002, United States"`).
 *
 * The old "second-to-last comma field" heuristic works for a 3-part Places address (`…, Minneapolis,
 * MN 55414` → `Minneapolis`) but grabs the **ZIP** from the 9-part OSM string (`…, New York, 10002,
 * United States` → `10002`), so an OSM-sourced delivery shipped a hero/title/desc reading "10002's
 * deli" / "10002-made" (live on russ-and-daughters). This works from the END: drop trailing country
 * + postcode + a bare state code + administrative-area names ("… County" / "Community Board …"), then
 * take the last CITY-like field. Falls back to the old second-to-last field, then `your community`.
 *
 * Pure; never throws.
 *
 * @example cityFromAddress("Russ & Daughters, 179, …, New York County, New York, 10002, United States")
 *   // → "New York"   (was "10002")
 * @example cityFromAddress("413 14th Ave SE, Minneapolis, MN 55414") // → "Minneapolis"
 * @example cityFromAddress("179 E Houston St, New York, NY 10002, USA") // → "New York"
 */
export function cityFromAddress(address: string | null | undefined): string {
  const parts = (address || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return 'your community';
  const COUNTRY =
    /^(united states(?: of america)?|usa|u\.?s\.?a?\.?|canada|united kingdom|uk|australia|england|scotland|wales)$/i;
  // ZIP / ZIP+4 / "NY 10002" (state+ZIP) / Canadian "A1A 1A1" / UK-ish alnum postcodes.
  const POSTCODE = /^(?:[A-Za-z]{2}\s+)?\d{4,6}(?:-\d{4})?$|^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/;
  const ADMIN =
    /\b(county|community board|borough|district|province|parish|census|metropolitan|greater|region|township|prefecture)\b/i;
  // Full US state / DC / common CA-province names — OSM display_names spell the state out
  // ("…, San Francisco, California, 94110, …"), so the ZIP-only drop left "California" as the city.
  const STATE =
    /^(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia|ontario|quebec|british columbia|alberta|manitoba|saskatchewan|nova scotia|new brunswick)$/i;
  // A street line (house number / road suffix) — the field BEFORE a candidate state in a COMPACT
  // "179 E Houston St, New York, NY 10002" address, where "New York" is the CITY not the state.
  const STREETISH =
    /\d|\b(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|ct|court|pl|place|hwy|highway|pkwy|suite|ste|fl|floor|unit)\b/i;
  let i = parts.length - 1;
  // Drop trailing country + postcode.
  while (i >= 0 && (COUNTRY.test(parts[i]!) || POSTCODE.test(parts[i]!))) i--;
  // Drop a trailing full-state / bare-2-letter-state — but ONLY when the field before it is another
  // locality (not the street line): a verbose "…, San Francisco, California, …" drops the STATE to
  // reveal "San Francisco", while a compact "…St, New York, NY 10002" KEEPS the CITY "New York"
  // (its predecessor is the street, so "New York" here is the city, not the state).
  if (
    i >= 1 &&
    (STATE.test(parts[i]!) || /^[A-Za-z]{2}$/.test(parts[i]!)) &&
    !STREETISH.test(parts[i - 1]!)
  )
    i--;
  // Drop administrative-area names between the state and the city ("Travis County", "New York County").
  while (i >= 1 && ADMIN.test(parts[i]!)) i--;
  const city = i >= 0 ? parts[i]! : '';
  if (city && /[A-Za-z]{2,}/.test(city) && !/^\d+$/.test(city)) return city;
  return parts[parts.length - 2] || 'your community';
}

/** Voice-matched hero copy for one visual personality: headline + subheadline candidates. */
export interface PersonaHeroCopy {
  readonly headlines: readonly string[];
  readonly subheadlines: readonly string[];
}

/**
 * Personality-aware hero copy — the "elaborate themes" lever (AL-483).
 *
 * WHY (confirmed live on `the-secret-society-portland`, a noir cocktail lounge that shipped
 * the plumber-voice H1 "Quality cocktail bar Portland counts on" + title "Local cocktail bar
 * you can trust"): the generic {@link heroHeadlineOptions} + inline hero-sub frames are
 * personality-FLAT. {@link commerceModeFor} already varies CTAs + FAQ by how a business is
 * patronized, and the template stamps each personality's CSS (fonts/color/motion/`data-style`),
 * but the seeded hero VOICE ignored `themeStyle` entirely — so a noir speakeasy read like a
 * rugged trade even though its dark CSS landed. That is the #1 "recolored template" tell: the
 * look is on-theme, the words are not. This maps the DISTINCTIVE personalities to a voice-matched
 * headline + subheadline set (noir → after-dark/evocative, luxe → refined restraint, warm →
 * inviting second-person, bold → imperative, artisan → craft-proud, retro → nostalgic, boutique →
 * tastemaker, heritage → legacy/trust, botanical → calm/reassuring, scholarly → encouraging,
 * precision → exacting, brutalist → declarative). Lands on the SAME proven fast-path
 * `_content.json` existing-wins seam as HERO_HEADLINE — deterministic regardless of the
 * container's build budget (the `authoritative-signal-immutable-against-unreliable-generator`
 * pattern), so the delivered hero READS like its theme instead of a template.
 *
 * Returns `null` for the neutral personalities (classic / editorial / futuristic / warm's
 * absence) whose generic frames already fit — the caller then keeps {@link heroHeadlineOptions}
 * + its inline sub. Every string is city/category-woven (anti-collision + keyword/SEO), slop-free
 * (no `build_validators` BANNED_WORDS), and grammatical for its personality's vertical family.
 * Pure; never throws.
 *
 * @param themeStyle - The resolved `themeStyle` (a `ThemeStyleName` or any value); non-distinctive
 *   / unknown values yield `null`.
 * @param catPhrase - A phrase from {@link categoryPhrase} (e.g. `'cocktail bar'`).
 * @param cityPhrase - The city/community (e.g. `'Portland'`, or `'your community'`).
 * @returns A {@link PersonaHeroCopy} for a distinctive personality, else `null`.
 *
 * @example
 * personaHeroCopy('noir', 'cocktail bar', 'Portland')?.headlines[0]
 * // → 'After dark, Portland comes alive'
 * personaHeroCopy('classic', 'plumbing', 'Denver')
 * // → null  (generic frames already fit)
 */
export function personaHeroCopy(
  themeStyle: string | null | undefined,
  catPhrase: string,
  cityPhrase: string,
): PersonaHeroCopy | null {
  const cat = (catPhrase || 'local business').trim();
  const city = (cityPhrase || 'your community').trim();
  const art = indefiniteArticle(cat); // grammatical article for the category noun in preposition slots
  // Sentence-initial category (a headline fragment that FOLLOWS a period) must be capitalized —
  // `cat` is lowercase ("design studio"), so `${city}. ${cat}.` shipped "New York. design studio.
  // No compromise" (cap/lower/cap — reads as a bug). Cap only the first letter (keeps multi-word
  // phrases like "design studio" → "Design studio", never "Design Studio"). AL-542.
  const catCap = cat.charAt(0).toUpperCase() + cat.slice(1);
  const key = typeof themeStyle === 'string' ? themeStyle.trim().toLowerCase() : '';
  // AL-611: `botanical` is a SHARED visual personality (calm/fresh/green + the petals scene) worn by
  // TWO verticals — health/wellness AND plant/garden/florist RETAIL (routed here by theme_style.ts
  // AL-610). The wellness hero copy below ("Feel better", "take a deep breath", "unhurried care") is a
  // MISFIT on a garden shop (live: flora-grubb-san-francisco shipped H1 "Feel better in San Francisco").
  // Sub-classify by category — a plant/garden/florist business gets GROW copy, wellness keeps CARE copy.
  // Same pattern as `heroCtasFor`'s APPOINTMENT_CATEGORY branch. Gated by themeStyle===botanical, so a
  // wellness category (spa/dental/yoga) never matches these plant nouns → the two never cross-fire.
  const isPlantRetail =
    /\b(plant\s?(?:shop|store|nurser\w*)|garden\s?(?:cent\w*|shop|store|nurser\w*|suppl\w*)|nurser(?:y|ies)|greenhouse\w*|florist\w*|flower\s?(?:shop|store|market)|houseplant\w*|botanic(?:al)?\s?garden|horticultur\w*|\bplant\w*)\b/i.test(
      cat,
    );

  // AL-696: `noir` is a SHARED dark/edgy personality worn by TWO vertical families — actual NIGHTLIFE
  // venues (speakeasy/cocktail-bar/lounge/nightclub/jazz-bar/cigar-bar/burlesque) AND tattoo/body-art
  // STUDIOS (both routed to noir by theme_style.ts — the dark aesthetic genuinely fits a tattoo shop).
  // But the noir hero copy below is nightlife-SPECIFIC ("careful pours", "candlelit", "room after dark",
  // "nights begin") — a MISFIT on a tattoo studio (live: three-kings-tattoo-brooklyn shipped H1
  // "Brooklyn's room after dark" + a "careful pours" subhead). Sub-classify by category — a tattoo/
  // piercing/body-art studio gets INK/CRAFT copy; actual nightlife keeps the after-dark/pours copy.
  // Same pattern as `isPlantRetail` (AL-612) + `heroCtasFor`'s APPOINTMENT_CATEGORY branch. Gated by
  // themeStyle===noir, so a cocktail bar never matches these ink nouns → the two never cross-fire.
  const isBodyArt =
    /\b(tattoo\w*|piercing\w*|body\s?(?:art|piercing)|ink\s?(?:shop|studio|parlor|parlour)|tattoo(?:ist|er)\w*)\b/i.test(
      cat,
    );

  // AL-810: `scholarly` is a SHARED books/learning personality worn by TWO vertical families — actual
  // EDUCATION (school/tutor/academy/coaching/daycare) AND book RETAIL/libraries (bookstore/bookshop/
  // bookseller/library/comic-shop — routed to scholarly by theme_style.ts for the books/reading
  // aesthetic). The scholarly hero copy below is EDUCATION-specific ("Where {city} learns", "Bright
  // futures start in {city}", "patient teaching", "every learner belongs") — a MISFIT on a bookstore
  // (live: strand-book-store-broadway shipped H1 "Bright futures start in New York"; The Strand sells
  // books, it does not teach). Sub-classify by category — a bookstore/library gets BROWSE/READ copy;
  // actual education keeps the learning copy. Same pattern as `isPlantRetail` (AL-612) + `isBodyArt`
  // (AL-696). Gated by themeStyle===scholarly (the ternary lives inside the map's `scholarly` entry),
  // so a tutoring center never matches these book nouns → the two never cross-fire.
  const isBookstore =
    /\b(book\s?stor\w*|bookshop\w*|booksell\w*|\bbooks\b|\blibrar\w*|comic\s?(?:shop|store))\b/i.test(cat);

  const map: Readonly<Record<string, PersonaHeroCopy>> = {
    noir: isBodyArt
      ? {
          // INK copy for a tattoo/body-art studio (AL-696) — the shared noir dark/edgy aesthetic, but a
          // studio voice about custom work + clean lines + artists, never the nightlife "careful pours"/
          // "candlelit"/"room after dark" misfit. `cat` here is tattoo/piercing/body-art (gated above).
          headlines: [
            `Custom ink in ${city}`,
            `${city}, wear your story`,
            `Where ${city} gets inked`,
          ],
          subheadlines: [
            `A ${cat} in ${city} for original, custom work — clean lines, careful artists, and ink built to last.`,
            `${city}'s ${cat} for work that lasts — bold, personal, and done right the first time.`,
          ],
        }
      : {
          // NIGHTLIFE copy — actual bars/lounges/speakeasies/clubs (the original noir reading).
          headlines: [
            `After dark, ${city} comes alive`,
            `${city}'s room after dark`,
            `Where ${city} nights begin`,
          ],
          subheadlines: [
            `An intimate ${cat} in the heart of ${city} — low light, careful pours, and a night worth lingering over.`,
            `${city}'s after-dark ${cat}: candlelit, unhurried, and made for the kind of evening you remember.`,
          ],
        },
    luxe: {
      headlines: [
        `The finest ${cat} in ${city}`,
        `${city}'s ${cat}, refined`,
        `Quiet luxury in ${city}`,
      ],
      subheadlines: [
        `A refined ${cat} for ${city} — considered, unhurried, and finished down to the last detail.`,
        `${city} comes to us for ${art} ${cat} done with restraint, taste, and quiet confidence.`,
      ],
    },
    warm: {
      headlines: [
        `Pull up a chair, ${city}`,
        `Your ${city} ${cat}, always welcoming`,
        `${city}'s cozy corner`,
      ],
      subheadlines: [
        `A neighborhood ${cat} in ${city} where the welcome is warm, the faces are friendly, and everyone has a seat.`,
        `Come in, slow down, and feel at home — ${art} ${cat} made with heart for ${city}.`,
      ],
    },
    bold: {
      headlines: [
        `${city}, let's get to work`,
        `Train harder in ${city}`,
        `Your strongest self starts in ${city}`,
      ],
      subheadlines: [
        `High-energy ${cat} for ${city} — real coaching, real sweat, and results you can feel.`,
        `Real ${cat} energy in ${city} — show up, push, and we will get you there.`,
      ],
    },
    artisan: {
      headlines: [
        `Made by hand in ${city}`,
        `${city}'s ${cat}, crafted slow`,
        `Small-batch, ${city}-made`,
      ],
      subheadlines: [
        `Handcrafted ${cat} in ${city} — made in small batches, the honest way, one at a time.`,
        `Small-batch ${cat} from ${city} — real materials, patient hands, and work we stand behind.`,
      ],
    },
    retro: {
      headlines: [
        `${city}'s favorite throwback`,
        `A little ${city} nostalgia`,
        `Old-school ${cat} in ${city}`,
      ],
      subheadlines: [
        `A joyfully vintage ${cat} in ${city} — the classics you grew up on, done right and full of character.`,
        `${city}, bring the whole crew: ${art} ${cat} with old-school soul and a wink of fun.`,
      ],
    },
    boutique: {
      headlines: [
        `${city}'s most-loved ${cat}`,
        // AL-585: was `Find something special in ${city}` — the boutique persona's generic-filler
        // candidate (drops ${cat} → a vertical-AGNOSTIC hero; a bike shop shipped "Find something
        // special in New York", indistinguishable from any gift shop). Same class AL-576 fixed for
        // the "Quality … counts on" filler: replace the ${cat}-less candidate with a category-bearing
        // boutique-voice line ("worth the trip" echoes the persona's own subheadline).
        `The ${city} ${cat} worth the trip`,
        `Your ${city} ${cat}, styled`,
      ],
      subheadlines: [
        `A chic ${cat} in ${city} — pieces worth the trip, chosen with a tastemaker's eye.`,
        `${city} shops with us for ${art} ${cat} that feels personal, current, and quietly covetable.`,
      ],
    },
    heritage: {
      headlines: [
        `${city} has trusted us for years`,
        // AL-508: the indefinite article must agree with the CITY's initial sound — a hardcoded
        // "A" shipped the ungrammatical "A Asheville accounting built on trust" (live, ben-badgley-cpa).
        `${indefiniteArticle(city) === 'an' ? 'An' : 'A'} ${city} ${cat} built on trust`,
        `Generations of ${city} know us`,
      ],
      subheadlines: [
        `The ${cat} ${city} has relied on for years — steady, principled, and here for the long run.`,
        `${city} turns to us for ${art} ${cat} grounded in experience, judgment, and a name that keeps its word.`,
      ],
    },
    botanical: isPlantRetail
      ? {
          // GROW copy for plant/garden/florist retail (AL-611) — the shared botanical petals scene,
          // but a garden-shop voice, never the wellness "Feel better"/"take a deep breath" misfit.
          headlines: [
            `Grow something beautiful in ${city}`,
            `Where ${city} comes to grow`,
            `${city}, let's get growing`,
          ],
          subheadlines: [
            `Plants, tools, and expert advice for ${city} — healthy, well-rooted, and ready to thrive.`,
            `${city} grows with us: ${art} ${cat} full of thriving plants and honest guidance.`,
          ],
        }
      : {
          // CARE copy for health/wellness (the original botanical reading — spa/dental/medical/clinic).
          headlines: [
            `Feel better in ${city}`,
            `Calm, capable care in ${city}`,
            `${city}, take a deep breath`,
          ],
          subheadlines: [
            `Gentle, attentive ${cat} for ${city} — unhurried care that meets you where you are.`,
            `${city} rests easy with ${art} ${cat} that is calm, clear, and always in your corner.`,
          ],
        },
    scholarly: isBookstore
      ? {
          // BROWSE/READ copy for bookstores/libraries (AL-810) — the shared scholarly books aesthetic,
          // in a bookseller's voice, never the education "Where {city} learns"/"Bright futures" misfit.
          headlines: [
            `Find your next read in ${city}`,
            `Where ${city} comes to browse`,
            `${city}'s shelves, well-curated`,
          ],
          subheadlines: [
            `Shelves worth getting lost in — ${art} ${cat} in ${city} with staff picks, deep stacks, and the book you didn't know you were looking for.`,
            `${city} browses with us: ${art} ${cat} where every visit turns up something worth taking home.`,
          ],
        }
      : {
          // LEARNING copy for actual education (school / tutor / academy / coaching / daycare).
          headlines: [
            `Where ${city} learns`,
            `${city}, let's grow together`,
            `Bright futures start in ${city}`,
          ],
          subheadlines: [
            `Encouraging ${cat} for ${city} — patient teaching, real progress, and a place every learner belongs.`,
            `${city} families choose us for ${art} ${cat} that makes learning click and confidence grow.`,
          ],
        },
    precision: {
      headlines: [
        `Precision ${cat} in ${city}`,
        `${city}'s ${cat}, engineered right`,
        `Dialed in for ${city}`,
      ],
      subheadlines: [
        `Exacting ${cat} for ${city} — measured, meticulous, and done to spec the first time.`,
        `${city} counts on us for ${art} ${cat} with the details right down to the last millimeter.`,
      ],
    },
    brutalist: {
      headlines: [
        `${city}. ${catCap}. No compromise`,
        `Bold ${cat} for ${city}`,
        `${city}, made to stand out`,
      ],
      subheadlines: [
        `Uncompromising ${cat} in ${city} — sharp, deliberate, and impossible to ignore.`,
        `${city} comes to us for ${art} ${cat} with a point of view and the work to back it up.`,
      ],
    },
  };

  return key in map ? map[key]! : null;
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

/** One homepage FAQ entry. */
export interface FaqEntry {
  readonly q: string;
  readonly a: string;
}

/** A homepage FAQ block: a headline + exactly four business-specific Q&A pairs. */
export interface HomepageFaq {
  readonly headline: string;
  readonly items: readonly [FaqEntry, FaqEntry, FaqEntry, FaqEntry, FaqEntry];
}

/**
 * Business-specific homepage FAQ (AL-409) — the deterministic homepage
 * content-density lever. The template's `Home.tsx` renders FAQ_HEADLINE +
 * FAQ_1..4_Q/A, but the fast-path build never seeded them, so every deployed site
 * shipped the thin generic content-pack FAQ default and homepages landed ~600
 * words (under the 800 beat-the-source density bar). Seeding these via the proven
 * existing-wins `_content.json` seam (same as HERO_HEADLINE / ABOUT_PARAGRAPH_1 /
 * SERVICES_INTRO) adds ~230 words of REAL, on-vertical content that renders
 * regardless of the container's 14-minute budget — the "authoritative signal
 * immutable against unreliable generator" pattern — AND powers accurate FAQPage
 * JSON-LD for GEO / AI-search.
 *
 * Questions/answers are chosen by {@link CommerceMode} so they match how the
 * business is actually patronized (hospitality → reservations/hours/private
 * events; service → estimates/service-area/licensed; retail → hours/special
 * orders/returns; professional → consultation/prep/fees; nonprofit →
 * donate/volunteer/events; general → offer/hours/contact/why-us). Answers are
 * ~45-55 words, slop-free, and identity-woven (name + category + city) so they
 * never collide across businesses and never trip build_validators' banned-slop
 * gate. Pure; never throws.
 *
 * @param mode - The business's commerce mode (`commerceModeFor(...)` output). Any
 *   unknown/empty value falls back to the `general` set.
 * @param name - The business name (already sanitized by the caller).
 * @param catPhrase - A phrase from {@link categoryPhrase} (e.g. `'meadery'`).
 * @param cityPhrase - The city/community (e.g. `'Ferndale'`, or `'your community'`).
 * @returns A {@link HomepageFaq} with a headline + four Q&A pairs.
 *
 * @example
 * homepageFaq('hospitality', "Schramm's Mead", 'meadery', 'Ferndale').items[0].q
 * // → 'Do you take reservations?'
 */
export function homepageFaq(
  mode: string | null | undefined,
  name: string,
  catPhrase: string,
  cityPhrase: string,
): HomepageFaq {
  const biz = (name || 'We').trim();
  const cat = (catPhrase || 'local business').trim();
  const city = (cityPhrase || 'your community').trim();

  const sets: Record<string, readonly [FaqEntry, FaqEntry, FaqEntry, FaqEntry, FaqEntry]> = {
    quickserve: [
      {
        q: 'What do you serve?',
        a: `${biz} serves fresh ${cat} made for ${city} — come see what is ready today. Our lineup rotates with the seasons and the favorites everyone comes back for, so there is always something worth the trip. Walk right up, take a look at what is on the counter, and we will help you find something you love — no reservation needed.`,
      },
      {
        q: 'Can I order ahead for pickup?',
        a: `Yes — ${biz} makes it easy to order ahead so your ${city} order is boxed up and ready the moment you arrive, with no waiting in line. Use the contact details below to call it in or order online where available, and we will have it ready at the counter. It is the fastest way to grab a treat on a busy day.`,
      },
      {
        q: 'What are your hours and where are you located?',
        a: `${biz} is right here in ${city} — the address, map, and current hours are all in the contact section below, and we keep them updated around holidays. We are an easy walk-up stop whether you are a regular or just passing through, so swing by any time we are open. A quick call confirms hours on a busy weekend.`,
      },
      {
        q: 'Do you have options for dietary needs?',
        a: `We do our best to have something for everyone at ${biz}. Ask our ${city} team about dairy-free, vegan, gluten-friendly, or other options and we will point you to the right pick or tell you honestly what is in each item. Your comfort matters, so never hesitate to ask about ingredients before you order.`,
      },
      {
        q: 'Can you handle catering or large orders?',
        a: `Yes — ${biz} loves being part of ${city} gatherings, from an office drop-off to a party platter. Give us a little lead time using the contact details below and we will help you pick quantities, box everything for easy transport, and have it ready right on schedule. Ask about our most popular crowd-pleasers and we will steer you toward what travels best.`,
      },
    ],
    hospitality: [
      {
        q: 'Do you take reservations?',
        a: `Yes — ${biz} welcomes reservations, and walk-ins are always welcome when we have room. For larger groups or a specific time, call ahead using the number in the contact section below and we will hold the right table for you here in ${city}. On busier evenings a reservation is the surest way to skip the wait.`,
      },
      {
        q: 'What are your hours?',
        a: `Our current hours are posted at the top of this page and kept up to date around holidays and special events. ${biz} holds consistent hours for ${city} so you can plan your visit with confidence, but it never hurts to call ahead on a busy weekend or before a longer trip in. If our hours ever change for a private booking, we note it here first.`,
      },
      {
        q: 'Can you host private events or larger groups?',
        a: `Absolutely. ${biz} regularly hosts celebrations, tastings, and private gatherings for ${city}, and we love helping you plan something memorable. Share your date and headcount with us and we will walk you through the options, talk through food and drink, and reserve your space so everything is ready the moment you arrive.`,
      },
      {
        q: 'Where are you located, and is parking easy?',
        a: `You will find ${biz} right here in ${city} — the map and full address are in the contact section below, with one-tap directions. We are easy to reach whether you are coming from across town or out of the area, and most guests find nearby parking without any trouble. Reach out if you would like directions.`,
      },
      {
        q: 'Can you accommodate allergies or dietary needs?',
        a: `Absolutely — just let ${biz} know when you book or when you sit down. Our ${city} kitchen handles common allergies and dietary requests every day, and we would rather you ask than wonder, so tell your server what you need and we will walk you through the safest choices. When in doubt, call ahead and we will make a plan before you arrive.`,
      },
    ],
    service: [
      {
        q: 'Do you offer free estimates?',
        a: `Yes — ${biz} gives straightforward, no-pressure estimates. Tell us what you need and we will assess the job, lay out an honest scope and price before any work begins, and answer every question in plain words, so ${city} customers never get a surprise on the final bill. The estimate is yours to review with no obligation to book.`,
      },
      {
        q: 'What areas do you serve?',
        a: `${biz} proudly serves ${city} and the surrounding communities. If you are not sure whether you fall within our range, just ask — we will tell you honestly, and if you are outside it we will happily point you toward someone reliable. We would rather give you a straight answer than waste your time.`,
      },
      {
        q: 'Are you licensed and insured?',
        a: `Yes. ${biz} is fully licensed and insured, and we stand behind every job we take on. You can count on ${cat} that is done right the first time, explained clearly as we go, and backed by real accountability throughout ${city}. If anything is not right, we make it right — that is the promise.`,
      },
      {
        q: 'How soon can you start?',
        a: `We work hard to fit your schedule, and for urgent issues we do our best to get to you fast. Reach out with your project and timing using the details below and ${biz} will get you on the calendar quickly, with clear communication from the first call all the way through to the finished job.`,
      },
      {
        q: 'Do you guarantee your work?',
        a: `Yes — ${biz} stands behind every job long after we pack up. If something is not right, tell us and we will come back and fix it; that promise is a big part of why ${city} keeps calling us. We would rather do it right and make it last than cut a corner and lose your trust, so ask us about the guarantee on your specific project.`,
      },
    ],
    retail: [
      {
        q: 'What are your hours and where are you located?',
        a: `${biz} is right here in ${city} — our address and map are in the contact section below, and current hours are posted at the top of the page. We keep consistent hours so you can plan your visit, and we update them around holidays and special sale days. Stop in any time we are open; we would love to see you.`,
      },
      {
        q: 'Do you offer special orders or custom requests?',
        a: `Yes — if you do not see exactly what you are looking for, just ask. ${biz} is glad to help ${city} customers track down or special-order the right item whenever we can, and we will keep you posted every step of the way. Half the fun is finding the perfect thing, and we are happy to hunt for it with you.`,
      },
      {
        q: 'What is your return policy?',
        a: `We want you genuinely happy with your purchase. Bring your item and receipt back to ${biz} and we will make it right — our ${city} team keeps returns and exchanges simple, fair, and free of fine print. If something is not working out, tell us and we will find a solution that feels good to everyone.`,
      },
      {
        q: 'Can I reach you with questions before I visit?',
        a: `Of course. Call or message ${biz} using the details below and a real person from our ${city} shop will help you — no phone trees and no runaround, just a straight, friendly answer. Whether you are checking stock or want a recommendation, we are glad to help before you make the trip.`,
      },
      {
        q: 'Do you offer gift cards or shipping?',
        a: `Many of our ${city} customers ask, so just reach out using the details below and ${biz} will let you know what we can do — gift cards make an easy present, and we will happily arrange to get an item to you when shipping or local delivery is available. If we cannot ship something ourselves, we will tell you straight and suggest the next best option.`,
      },
    ],
    professional: [
      {
        q: 'How do I schedule a consultation?',
        a: `Reach out using the contact details below and ${biz} will set up a consultation at a time that fits your schedule. We listen first, explain your options in plain words, and make sure ${city} clients always know exactly where things stand. There is no pressure — the goal of the first conversation is simply to understand how we can help.`,
      },
      {
        q: 'What should I bring or prepare?',
        a: `Just bring the details of your situation and any documents that feel relevant — ${biz} handles the rest for ${city} clients. We will tell you upfront what we need, keep the paperwork manageable, and never bury you in jargon or fine print. If you are unsure what matters, ask, and we will guide you through it.`,
      },
      {
        q: 'What do you focus on?',
        a: `${biz} concentrates on ${cat} for ${city}, so you get focused, real-world experience rather than a generalist stretched thin. If your matter falls outside our focus, we will say so plainly and help you find the right person for it. We would rather send you to the best fit than take on something we cannot do well.`,
      },
      {
        q: 'How do fees work?',
        a: `We believe in clear, honest pricing with no games. ${biz} explains fees before any work begins, so ${city} clients always understand both the cost and the value they are getting — and never see a surprise on the final bill. If your needs change along the way, we talk it through before anything moves.`,
      },
      {
        q: 'How will we stay in touch on my matter?',
        a: `You will always know where things stand. ${biz} keeps ${city} clients updated at every meaningful step, replies promptly, and gives you one clear point of contact rather than a maze of hand-offs. Anything you share with us stays confidential, and if a question comes up between updates, reach out — we would rather you ask than sit and wonder.`,
      },
    ],
    nonprofit: [
      {
        q: 'How can I help?',
        a: `There are many ways to support ${biz} — give, volunteer, or simply share our mission with ${city}. Every bit of help goes straight toward the people we serve, and no contribution is too small to matter. Reach out using the details below and we will match you with the opportunity that fits your time, skills, and heart.`,
      },
      {
        q: 'Where does my donation go?',
        a: `Your gift to ${biz} goes directly to work for ${city}. We keep our promises simple and our impact clear, and we are always glad to explain exactly how your support makes a difference in real people's lives. Transparency matters to us, so if you ever want the details, just ask and we will walk you through them.`,
      },
      {
        q: 'How do I volunteer?',
        a: `We would love your time and talent. Contact ${biz} using the details below and we will walk you through current volunteer needs in ${city} and find a role that fits your schedule and strengths. Whether you can give an hour or a whole day, there is a meaningful way for you to pitch in.`,
      },
      {
        q: 'Do you host events?',
        a: `Yes — ${biz} brings ${city} together throughout the year with events, drives, and gatherings. Check back here or reach out to learn what is coming up and how to take part. Our events are also a wonderful, low-pressure way to see the mission up close before you decide how you would like to get involved.`,
      },
      {
        q: 'Is my donation tax-deductible?',
        a: `In most cases, yes — ${biz} will provide a receipt for your records with every gift, and our ${city} team is glad to answer questions about how to document your support at tax time. Reach out using the details below if you need specific paperwork, and we will get it to you promptly so nothing about giving feels complicated.`,
      },
    ],
    gallery: [
      {
        q: 'What is currently on view?',
        a: `${biz} keeps a rotating program of exhibitions and a standing collection of original work for ${city} to explore. The current show and featured artists are highlighted on this page, and the collection is always evolving as new pieces arrive. Plan a visit using the details below, or reach out and we will tell you what is on the walls right now.`,
      },
      {
        q: 'How do I visit or plan a private viewing?',
        a: `${biz} welcomes visitors during the hours posted at the top of this page, and we are always happy to arrange a private viewing for ${city} collectors who want unhurried time with a work. Use the contact details below to tell us what you would like to see, and we will set aside the space and walk you through the pieces in person.`,
      },
      {
        q: 'How do I acquire or inquire about a work?',
        a: `Acquiring a piece from ${biz} starts with a simple inquiry — reach out using the details below and we will share pricing, availability, and provenance for any work that catches your eye. Our ${city} team guides you through the acquisition at your pace, answers every question honestly, and helps with framing or delivery when the piece is yours.`,
      },
      {
        q: 'Do you represent or show local artists?',
        a: `Yes — championing artists is the heart of what ${biz} does, and our ${city} program pairs represented names with new voices worth discovering. If you are an artist hoping to show with us, or a visitor curious about who we represent, reach out using the details below and we will tell you about the current roster and how we build each exhibition.`,
      },
      {
        q: 'Where are you located, and is there an opening to attend?',
        a: `You will find ${biz} right here in ${city} — the map and full address are in the contact section below. We host openings and events throughout the season to celebrate each new exhibition, and everyone is welcome. Reach out or check this page for the next opening, and come see the work the way it is meant to be seen — in person.`,
      },
    ],
    general: [
      {
        q: 'What do you offer?',
        a: `${biz} provides ${cat} for ${city}, with a focus on doing the work right and explaining it in plain words. Whatever brought you here, reach out using the details below and we will help you figure out exactly what you need — no pressure and no jargon, just honest guidance from people who know the work.`,
      },
      {
        q: 'What are your hours and location?',
        a: `${biz} is based right here in ${city} — the address, map, and current hours are all in the contact section below. We keep consistent hours so you can plan around us, and we update them around holidays and special occasions. If you are ever unsure, a quick call is the fastest way to confirm.`,
      },
      {
        q: 'How do I get in touch?',
        a: `Call or message ${biz} using the details below and a real person from ${city} will get back to you quickly — clear answers and no runaround. We know your time is valuable, so we keep communication simple and responsive from the very first hello.`,
      },
      {
        q: 'Why should I choose you?',
        a: `${biz} treats ${city} like neighbors, not numbers. Honest work, straight answers, and follow-through you can count on are what set us apart, and it is why so many of our customers come back and send their friends. We earn your trust the old-fashioned way — by doing right by you every single time.`,
      },
      {
        q: 'How do I get started?',
        a: `It is easy — reach out to ${biz} using the contact details below and tell us a little about what you are looking for. We will point you to the right next step for ${city}, answer any questions up front, and make the whole process feel simple from the very first message. There is no pressure and no obligation; we are just glad to help you figure it out.`,
      },
    ],
  };

  const key =
    typeof mode === 'string' && mode.trim().toLowerCase() in sets
      ? mode.trim().toLowerCase()
      : 'general';
  return { headline: 'Questions, answered', items: sets[key]! };
}

/**
 * Per-commerce-mode hero CTA labels ({@link HERO_CTA} + {@link HERO_SECONDARY_CTA}
 * `_content.json` seed tokens). The template Home hero links primary → /contact|/quote
 * and secondary → /services, so labels are chosen to read naturally with those
 * destinations. Seeding these makes the hero CTAs DETERMINISTIC — the fast-path
 * orchestrator otherwise fills the raw `{HERO_CTA}` placeholder unreliably (it wrote
 * "Reserve a table" onto an ice-cream shop, AL-419). A `quickserve` walk-up counter
 * must never say "Reserve a table"; this is the authoritative-signal fix (same seam as
 * HERO_HEADLINE), not the inert prompt-prose brief.
 *
 * @param mode - `commerceModeFor(...)` output. Unknown/empty → the `general` pair.
 * @returns `{ primary, secondary }` CTA labels (both non-empty, slop-free).
 *
 * @example
 * heroCtasFor('quickserve') // → { primary: 'Visit us', secondary: 'See our flavors' }
 * heroCtasFor('hospitality')// → { primary: 'Visit us', secondary: 'View the menu' }
 */
// The `service` commerce mode lumps two conversion patterns that need OPPOSITE hero CTAs:
//   • TRADES (plumber / HVAC / roofer / electrician / cleaning / moving / auto) — convert on a
//     price-first "Get a free quote" / "Get an estimate".
//   • APPOINTMENT / CLASS businesses (yoga / pilates / gym / salon / barber / spa / massage /
//     clinic / dental / chiropractic / vet / …) — convert on "Book now"; they NEVER "quote".
// So the flat `service → 'Get a free quote'` shipped a wrong-vertical CTA on a yoga studio
// (Laughing Lotus: "Get a free quote" on a class business — AL-460). Sub-classify by category:
// an appointment business gets the book CTA, a trade keeps the quote CTA. (The mode's own brief
// already says these are "BOOKED, not checked out", so Book-now is the inclusive default.)
const APPOINTMENT_CATEGORY =
  /\b(yoga|pilates|gym\w*|fitness|crossfit|dance\s?studio|personal\s?train\w*|barre|spin\s?studio|salon\w*|barber\w*|\bhair\b|\bnail\w*|\bspa\b|beauty|med\s?spa|massage|wax\w*|lash\w*|brow\w*|esthetic\w*|\bclinic\w*|dental|dentist\w*|orthodont\w*|\bdoctor\w*|physician\w*|chiropract\w*|veterinar\w*|\bvet\b|optometr\w*|dermatolog\w*|physio\w*|physical\s?therap\w*|acupunctur\w*|therap\w*|counsel\w*|wellness|wellbeing|meditation|rehab\w*|nutrition\w*|dietician|dietitian|midwif\w*|tattoo|piercing)\b/i;

export function heroCtasFor(
  mode: string | null | undefined,
  category?: string | null,
): {
  primary: string;
  secondary: string;
} {
  const sets: Record<string, { primary: string; secondary: string }> = {
    quickserve: { primary: 'Visit us', secondary: 'See our flavors' },
    hospitality: { primary: 'Visit us', secondary: 'View the menu' },
    retail: { primary: 'Visit the shop', secondary: 'Browse our collection' },
    service: { primary: 'Get a free quote', secondary: 'Our services' },
    professional: { primary: 'Book a consultation', secondary: 'Our services' },
    nonprofit: { primary: 'Get involved', secondary: 'See our programs' },
    gallery: { primary: 'View the collection', secondary: 'Plan your visit' },
    general: { primary: 'Get in touch', secondary: 'Learn more' },
  };
  const key =
    typeof mode === 'string' && mode.trim().toLowerCase() in sets
      ? mode.trim().toLowerCase()
      : 'general';
  // An APPOINTMENT/class business inside `service` books, never quotes.
  if (key === 'service' && typeof category === 'string' && APPOINTMENT_CATEGORY.test(category)) {
    return { primary: 'Book now', secondary: 'Our services' };
  }
  return sets[key]!;
}

/**
 * Per-commerce-mode HERO TRUST BADGES — the 3 `{TRUST_BADGE_1..3}` chips shown under the hero CTAs.
 *
 * WHY (AL-518, the AL-516 fix-B): the badges are `TRUST_BADGE_1/2/3` tokens sourced from the
 * per-vertical content pack (`examples/_content.<vertical>.json`). A SERVICE business that
 * collapsed to the RETAIL pack shipped e-commerce chips on a non-retail site — the seven-swords
 * TATTOO studio advertised "Free shipping over $50 / Easy 30-day returns" (you cannot ship or
 * return a tattoo). Root fix: SEED commerce-mode-appropriate badges at delivery time on the SAME
 * existing-wins `_content.json` seam as {HERO_CTA} (AL-420), so the worker value wins over the pack
 * default on the ~150s fast path. `retail` KEEPS the shipping/returns/quality triad (correct there —
 * a florist DOES ship + return); every OTHER mode gets its own honest, non-retail triad. Pure; never throws.
 *
 * @param mode - `commerceModeFor(...)` output. Unknown/empty → the `general` triad.
 * @param category - The raw business category. Inside `service`, an APPOINTMENT/class business
 *   (salon/barber/spa/yoga/clinic) gets a BOOKING-first triad instead of the trades "licensed &
 *   insured" framing — mirrors {@link heroCtasFor}'s appointment-vs-trades sub-split (AL-518b,
 *   watched live on the rudy-seattle barbershop delivery, which read trades-y as plain `service`).
 * @returns A 3-tuple of short, honest, slop-free trust-badge labels.
 *
 * @example trustBadgesFor('service', 'Plumber')     // → ['Licensed & insured', 'Free consultation', 'Satisfaction guaranteed']
 * @example trustBadgesFor('service', 'Barbershop')  // → ['Easy online booking', 'Experienced professionals', 'Satisfaction guaranteed']
 * @example trustBadgesFor('retail')                 // → ['Free shipping over $50', 'Easy 30-day returns', 'Quality guaranteed']
 */
export function trustBadgesFor(
  mode: string | null | undefined,
  category?: string | null,
): [string, string, string] {
  const sets: Record<string, [string, string, string]> = {
    quickserve: ['Made to order', 'Order ahead', 'Grab & go'],
    hospitality: ['Reservations welcome', 'Walk-ins welcome', 'Fresh daily'],
    retail: ['Free shipping over $50', 'Easy 30-day returns', 'Quality guaranteed'],
    service: ['Licensed & insured', 'Free consultation', 'Satisfaction guaranteed'],
    professional: ['Free consultation', 'Confidential', 'By appointment'],
    nonprofit: ['Tax-deductible', 'Community-driven', 'Volunteers welcome'],
    gallery: ['Original works', 'Represented artists', 'Viewings by appointment'],
    general: ['Trusted locally', 'Friendly service', 'Quality guaranteed'],
  };
  const key =
    typeof mode === 'string' && mode.trim().toLowerCase() in sets
      ? mode.trim().toLowerCase()
      : 'general';
  // AL-518b: an appointment/class service (salon/barber/spa/yoga/clinic) converts on BOOKING —
  // "Licensed & insured" is the trades framing (plumber/electrician), which reads off on a barber.
  if (key === 'service' && typeof category === 'string' && APPOINTMENT_CATEGORY.test(category)) {
    return ['Easy online booking', 'Experienced professionals', 'Satisfaction guaranteed'];
  }
  return sets[key]!;
}

/**
 * Clamp a composed description into the SEO sweet spot [120, 156] (what Google shows
 * un-truncated). Truncates at a word boundary when too long (drops any trailing
 * punctuation/space); pads with a short, true tail when too short. Never throws.
 */
function clampSeoDesc(s: string, city: string): string {
  let out = s.replace(/\s+/g, ' ').trim();
  if (out.length > 156) {
    const cut = out.slice(0, 156);
    let trimmed = cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:—–-]+$/, '');
    // Never end a truncation on a dangling article/preposition ("Reach out for a." — AL-507, the
    // first seeded `professional`-mode desc exposed it). Drop trailing stop-words back to the last
    // content word so the sentence closes cleanly (keeps a shorter CTA when one still fits).
    while (/\s(?:a|an|the|and|or|for|to|of|with|your|our|how|we|is)$/i.test(trimmed)) {
      trimmed = trimmed.slice(0, trimmed.lastIndexOf(' ')).replace(/[\s,;:—–-]+$/, '');
    }
    out = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }
  // Pad a too-short desc with true, generic-but-safe tails until it clears 120.
  const pads = [
    ` Find our hours and location in ${city} below.`,
    ` Reach out with any question — we are glad to help.`,
    ` Stop by and see for yourself.`,
  ];
  for (const p of pads) {
    if (out.length >= 120) break;
    out = (out + p).trim();
  }
  return out.length > 156 ? clampSeoDesc(out.slice(0, 156), city) : out;
}

/**
 * Per-commerce-mode homepage META DESCRIPTION (the `{SEO_DESCRIPTION}` token Home.tsx feeds to
 * `useSEO` → the CLIENT `<meta name="description">`). AL-491.
 *
 * WHY: the template content pack keys `SEO_DESCRIPTION` off the BROAD visual vertical
 * (`DESCRIPTION[v]`), so a sub-vertical that collapses to the wrong bucket ships a WRONG-vertical
 * SERP snippet — a brewery + a cocktail bar both collapse to `restaurant` and shipped "Fresh,
 * made-from-scratch food from local ingredients" (confirmed live on half-acre-beer-chicago +
 * the-secret-society-portland). The worker never seeded `SEO_DESCRIPTION`, so the pack default
 * always won. Seeding a commerce-mode-angled, name+category+city-woven description (for exactly the
 * collapsing sub-verticals — gated by {@link heroImageForVertical} in the caller, so core verticals
 * keep their crafted pack descriptions) overrides it via the existing-wins `_content.json` merge,
 * so Google's rendered snippet reads as the real vertical. The mode gives the right ANGLE
 * (hospitality → visit/taste, retail → browse/shop, service → book, …); the woven cat/city give the
 * keywords. Length is GUARANTEED in the 120-156 SEO sweet spot via {@link clampSeoDesc}.
 *
 * @param mode - `commerceModeFor(...)` output. Unknown/empty → the `general` template.
 * @param name - The business name (sanitized by the caller).
 * @param catPhrase - A phrase from {@link categoryPhrase} (e.g. `'brewery'`, `'record store'`).
 * @param cityPhrase - The city/community (e.g. `'Chicago'`, or `'your community'`).
 * @returns A 120-156 char description. Never throws.
 *
 * @example
 * seoDescriptionFor('hospitality', 'Half Acre Beer Company', 'brewery', 'Chicago')
 * // → 'Half Acre Beer Company is Chicago's brewery — a welcoming place to gather, taste, and stay awhile. …'
 */
export function seoDescriptionFor(
  mode: string | null | undefined,
  name: string,
  catPhrase: string,
  cityPhrase: string,
): string {
  const biz = (name || 'This local business').trim();
  const cat = (catPhrase || 'local business').trim();
  const city = (cityPhrase || 'your community').trim();
  const art = indefiniteArticle(cat);
  const templates: Record<string, string> = {
    hospitality: `${biz} is ${city}'s ${cat} — a welcoming place to gather, taste, and linger. Come see why ${city} keeps coming back, and find our hours and what's on right now.`,
    quickserve: `${biz} is ${city}'s ${cat} — fresh favorites made to order at a friendly counter. Swing by to see what's ready today, and find our hours and location below.`,
    retail: `${biz} is ${city}'s ${cat} — a carefully chosen selection, honest prices, and real help finding just what you want. Stop in to browse, or reach out with any question.`,
    service: `${biz} is ${city}'s ${cat} — careful, dependable work and a comfortable experience start to finish. Book a visit and see why ${city} trusts us to get every detail right.`,
    professional: `${biz} is ${city}'s ${cat} — clear guidance, real expertise, and a team that puts your goals first. Reach out for a consultation and see how we help ${city} move forward.`,
    nonprofit: `${biz} serves ${city} as ${art} ${cat} — real, lasting impact powered by neighbors who show up. Learn our mission, meet the people we help, and find the many ways to get involved.`,
    gallery: `${biz} is ${city}'s ${cat} — a curated collection of original work, thoughtfully presented. Explore the current exhibition, discover the artists we represent, and plan your visit below.`,
    general: `${biz} is ${city}'s ${cat} — dependable, friendly, and focused on doing right by everyone who walks in. Reach out to learn more, and find our hours and location below.`,
  };
  const key =
    typeof mode === 'string' && mode.trim().toLowerCase() in templates
      ? mode.trim().toLowerCase()
      : 'general';
  return clampSeoDesc(templates[key]!, city);
}
