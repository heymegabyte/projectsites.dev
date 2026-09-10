/**
 * Deterministic theme-style selector — maps a business's declared vertical
 * category + freeform design-style hint to one of the template's visual
 * personality PRESETS, emitted as the top-level `_brand.json.themeStyle`.
 *
 * WHY (producer gap, found 2026-09-08): the template
 * (`template/src/themePresets.ts` + `brand.ts`) ships 13 cohesive personalities
 * (font pairing + radius + shadow + motion + `data-style` flourish), but the
 * workflow only ever seeded `businessClass='organization'` and NEVER wrote a
 * `themeStyle`. `brand.ts`'s fallback (`presetForClass('organization')`) then
 * pinned EVERY workflow-built site to `classic`, leaving luxe / heritage /
 * precision / boutique / scholarly / botanical UNREACHABLE — generated sites
 * felt same-y regardless of vertical. This closes the gap: the /create form's
 * Industry/Category (18 verticals) + "Additional details" design hint now drive
 * the site's visual personality.
 *
 * ELABORATION (AL-256, 2026-09-10): the matcher previously scanned the RAW
 * lowercased string, so Google-Places `types[]` (snake_case, e.g. `car_dealer`,
 * `hardware_store`, `real_estate_agency`) never matched — `\bcar\b` fails on
 * `car_dealer` because `_` is a word char — and a hardware store hit the generic
 * `\bstore\b` in `boutique` (chic fashion) rather than `rugged`. Both fell through
 * to the blandest `classic`. Now every input is NORMALIZED (all non-letter/digit
 * runs → single space, accents preserved) BEFORE matching, the vertical rules are
 * broadened to cover Google-Places type strings + real-world synonyms, and the
 * specific verticals (hardware→rugged, jewelry→luxe) are ordered ahead of the
 * generic shop/store rule. Far fewer businesses land on bland `classic`; the four
 * once-orphaned rich presets (luxe / precision / heritage / scholarly) now fire
 * from the signal the fast-path build reliably provides.
 *
 * Precedence: an explicit design-style KEYWORD in the hint wins (the user asked
 * for it by name); else the declared category's vertical default; else
 * `undefined` — so `brand.ts` keeps its own graceful `classic` fallback and a
 * caller can omit the key entirely.
 *
 * Pure. Never throws. Names MUST stay a subset of the template's `PRESET_NAMES`
 * — the invariant test in `theme_style.test.ts` guards against drift.
 */

/**
 * The 13 template preset names — a mirror of `PRESET_NAMES` in
 * `template/src/themePresets.ts`. Kept as a local literal because the template
 * lives in a separate repo the worker cannot import; the invariant test asserts
 * this list matches what the template ships.
 */
export const THEME_STYLE_NAMES = [
  'classic',
  'editorial',
  'warm',
  'luxe',
  'brutalist',
  'bold',
  'futuristic',
  'rugged',
  'botanical',
  'boutique',
  'precision',
  'heritage',
  'scholarly',
] as const;

/** Union of valid preset names. */
export type ThemeStyleName = (typeof THEME_STYLE_NAMES)[number];

/**
 * Normalize a category / hint for matching: lowercase, then collapse every run
 * of non-(letter|digit) characters to a single space, and trim. This turns
 * Google-Places snake_case types (`car_dealer`, `hardware_store`), slash-joined
 * dropdown labels (`Financial / Accounting`), and punctuation-laden freeform
 * text into clean space-separated tokens so `\b` word boundaries match. Accented
 * letters are preserved (`café` stays `café`) via the Unicode property escapes.
 *
 * @param text - Any candidate string (or non-string, which yields `''`).
 * @returns The normalized, space-separated, lowercased string.
 *
 * @example
 * normalizeForMatch('Car_Dealer')            // → 'car dealer'
 * normalizeForMatch('Financial / Accounting')// → 'financial accounting'
 * normalizeForMatch('Restaurant / Café')     // → 'restaurant café'
 */
function normalizeForMatch(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Ordered design-hint keyword → preset. The FIRST matching rule wins, so the
 * most distinctive / rarely-reachable personalities (luxe, heritage, precision)
 * are checked before the broad ones. Scanned against the NORMALIZED hint.
 */
const HINT_RULES: ReadonlyArray<readonly [ThemeStyleName, RegExp]> = [
  [
    'luxe',
    /\b(luxur\w*|elegan\w*|premium|upscale|high\s?end|sophisticat\w*|refined|opulent|exclusive|glamou?r\w*|couture|bespoke|lavish|posh|lux)\b/,
  ],
  [
    'heritage',
    /\b(heritage|timeless|traditional|establish\w*|authoritative|corporate|institutional|dignified|old\s?money|trustworthy|trusted|reputable|prestigious|stately|classic\s?professional)\b/,
  ],
  [
    'precision',
    /\b(precision|engineered|machined|metallic|technical|high\s?performance|motorsport|aerospace|billet|industrial\s?sleek)\b/,
  ],
  [
    'futuristic',
    /\b(futuristic|sleek|glassy|gradient|neon|cyber\w*|high\s?tech|hi\s?tech|space\s?age|holograph\w*|modern\s?tech)\b/,
  ],
  [
    'brutalist',
    /\b(brutalist|brutal|raw|edgy|stark|avant\s?garde|experimental|anti\s?design|striking|maximalist)\b/,
  ],
  [
    'bold',
    /\b(bold|energetic|dynamic|athletic|kinetic|high\s?energy|powerful|punchy|loud|fierce|aggressive)\b/,
  ],
  [
    'botanical',
    /\b(botanical|organic|natural|calm\w*|serene|soothing|fresh|\bzen\b|holistic|earthy|eco\s?friendly|tranquil|wellness)\b/,
  ],
  [
    'warm',
    /\b(warm|cozy|cosy|inviting|friendly|welcoming|homey|homely|rustic|approachable|comfortable|hearth|hospitable)\b/,
  ],
  ['boutique', /\b(chic|fashionable|stylish|trendy|tactile|curated|shoppable|artisan\w*)\b/],
  [
    'scholarly',
    /\b(playful|whimsical|cheerful|bright|\bfun\b|kid\s?friendly|encouraging|scholarly)\b/,
  ],
  ['editorial', /\b(editorial|magazine|literary|journal\w*|understated)\b/],
];

/**
 * Ordered vertical-category → preset. The FIRST matching rule wins. Scanned
 * against the NORMALIZED category, so /create dropdown labels
 * ("Financial / Accounting", "Real Estate"), freeform categories, AND Google
 * Places `types[]` strings ("car_dealer", "hardware_store", "beauty_salon") all
 * resolve. DISTINCTIVE verticals precede the generic shop/store rule so a
 * hardware store → rugged and a jewelry store → luxe (never the boutique
 * `\bstore\b` catch-all).
 */
const CATEGORY_RULES: ReadonlyArray<readonly [ThemeStyleName, RegExp]> = [
  // Charity / civic FIRST — a food bank, food pantry, or soup kitchen is a
  // nonprofit, not a restaurant; without this it hits `\bfood\b`/`\bkitchen\b`
  // in the `warm` rule below and ships restaurant-warm (real prod categories
  // "food pantry" / "food bank" were mis-themed, AL-256). These read as
  // dignified/trustworthy → editorial.
  [
    'editorial',
    /\b(soup\s?kitchen|food\s?(?:bank|pantr\w*|shelf)|\bpantr\w*|homeless|\bshelter\w*|nonprofit|non\s?profit|charit\w*|\bngo\b|humanitarian|relief\s?(?:org|fund|effort)|community\s?(?:cent|org|kitchen))\b/,
  ],
  [
    'botanical',
    /\b(beauty|\bspa\b|wellness|wellbeing|medical|health\w*|dental|dentist\w*|orthodont\w*|\bdoctor\w*|physician\w*|\bclinic\w*|therap\w*|chiropract\w*|veterinar\w*|\bvet\b|optometr\w*|\bdermatolog\w*|\bpediatric\w*|massage|acupunctur\w*|pharmac\w*|physio\w*|holistic|\byoga\b|pilates|meditation|nutrition\w*|dietician|dietitian|rehab\w*|hospice|midwif\w*)\b/,
  ],
  [
    'heritage',
    /\b(financ\w*|account\w*|insurance|insur\w*|wealth|advisor\w*|\bbank\w*|\btax\b|bookkeep\w*|audit\w*|mortgage|actuar\w*|fiduciar\w*|\bcpa\b|invest\w*|\bcapital\b|\bequity\b|underwrit\w*|notary|escrow|payroll|lending|\bloan\w*)\b/,
  ],
  [
    'precision',
    /\b(automotive|\bauto\b|\bcar\b|\bcars\b|dealership|\bdealer\b|vehicle\w*|mechanic\w*|motorsport|machinery|body\s?shop|\btire\w*|transmission|autobody|\bgarage\b|detailing|\bev\b|motorcycle\w*|\bmoto\b|powersports|collision|\bsmog\b|lube)\b/,
  ],
  [
    'scholarly',
    /\b(education\w*|educational|tutor\w*|\bschool\w*|academy|academ\w*|\bcourse\w*|coaching|learning|\bkids\b|children|childcare|university|universit\w*|college|preschool|kindergarten|daycare|montessori|\bstem\b|classes|teach\w*|pedagog\w*|training\s?cent)\b/,
  ],
  [
    'luxe',
    /\b(real\s?estate|realty|realtor\w*|jewel\w*|fine\s?dining|hospitality|\bhotel\w*|resort\w*|lodging|steakhouse|winery|wineries|vineyard|country\s?club|\byacht\w*|concierge|penthouse|five\s?star|boutique\s?hotel|\bspa\s?resort|bridal|\bwatch\w*\s?(shop|store|maker))\b/,
  ],
  [
    'rugged',
    /\b(construction|home\s?services|\btrade\b|\btrades\b|plumb\w*|\bhvac\b|heating|cooling|air\s?condition\w*|furnace\w*|roof\w*|electric\w*|electrician|contractor\w*|landscap\w*|manufactur\w*|logistics|hardware|welding|mason\w*|concrete|excavat\w*|fencing|paving|demolition|\bmoving\b|junk\s?removal|pest\s?control|handyman|carpentr\w*|carpenter|flooring|drywall|septic|gutter\w*|remodel\w*|renovation|\bhauling\b|towing|locksmith|garage\s?door|excavation|\bpaint\w*\s?(contractor|company)|snow\s?removal)\b/,
  ],
  // warm BEFORE boutique so "Coffee Shop" / "Bakery" match food (warm) rather
  // than the generic `\bshop\b` in boutique.
  [
    'warm',
    /\b(restaurant\w*|caf[eé]\w*|bakery|bakeries|\bcoffee\b|\bbar\b|brewery|breweries|brewpub|\bpub\b|bistro|diner|eatery|eateries|salon\w*|barber\w*|\bhair\b|\bnail\w*|\bgrill\w*|pizzeria|\bpizza\b|taqueria|\bdeli\b|\bfood\b(?!\s?(?:bank|pantr|shelf|drive))|catering|caterer\w*|ice\s?cream|\bmeal\w*|takeaway|takeout|nightlife|night\s?club|\blounge\b|\bkitchen\b|grocer\w*|supermarket|smoothie|juice\s?bar|\bbbq\b|steak\s?house|sandwich\w*|\bdonut\w*|doughnut\w*|creamery|patisserie|teahouse|\btea\s?room|food\s?truck)\b/,
  ],
  [
    'boutique',
    /\b(retail|\bshop\w*|\bstore\w*|boutique\w*|apparel|clothing|fashion\w*|merchandise|\bgoods\b|florist\w*|\bgift\w*|book\s?stor\w*|bookstore\w*|\bbooks\b|pet\s?(store|shop)|home\s?goods|furniture|\btoys?\b|stationery|cosmetic\w*|accessor\w*|lifestyle|\bmarket\b|thrift|consignment|antique\w*|\bcrafts?\b)\b/,
  ],
  [
    'futuristic',
    /\b(technolog\w*|\btech\b|\bsaas\b|software|startup\w*|\bapp\b|\bapps\b|platform|\bai\b|artificial\s?intelligence|fintech|developer\w*|\bdev\b|cyber\w*|\bdata\b|\bcloud\b|digital\w*|\bit\s?services|web\s?design|web\s?dev\w*|blockchain|crypto\w*|analytics|automation|robotics|\biot\b|electronics)\b/,
  ],
  [
    'bold',
    /\b(fitness|\bgym\w*|crossfit|\bsport\w*|martial\s?arts|athletic\w*|boxing|\bmma\b|kickbox\w*|weightlift\w*|bodybuild\w*|\bcycling\b|spin\s?studio|bootcamp|\bhiit\b|personal\s?train\w*|strength|conditioning|\bdance\b)\b/,
  ],
  [
    'brutalist',
    /\b(photograph\w*|creative|portfolio|\bart\b|\barts\b|design\s?studio|photo\s?studio|creative\s?studio|production\s?studio|art\s?studio|\bagenc\w*|\bfilm\w*|\bmusic\b|\bmedia\b|branding|advertis\w*|videograph\w*|graphic\s?design|animation|record\s?label|production\s?(house|company))\b/,
  ],
  [
    'editorial',
    /\b(legal|\blaw\b|attorney\w*|lawyer\w*|nonprofit|non\s?profit|charit\w*|foundation|\bchurch\w*|place\s?of\s?worship|ministr\w*|synagogue|\bmosque\b|\btemple\b|congregation|\bngo\b|community\s?(cent|org)|government|municipal\w*|\blibrar\w*|\bmuseum\w*|association\w*|\bunion\b|advocacy|humanitarian|\bcivic\b|public\s?service|social\s?service\w*)\b/,
  ],
];

/** Return the preset of the first rule whose regex matches `text`. */
function firstMatch(
  text: string,
  rules: ReadonlyArray<readonly [ThemeStyleName, RegExp]>,
): ThemeStyleName | undefined {
  for (const [name, re] of rules) {
    if (re.test(text)) return name;
  }
  return undefined;
}

/**
 * Choose a template theme-style personality from a declared category and/or a
 * freeform design-style hint.
 *
 * @param category - The declared vertical (e.g. `"Financial / Accounting"`,
 *   `"Real Estate"`, a Google-Places `type` like `"car_dealer"`, or a freeform
 *   category string) — the /create Industry field.
 * @param designHint - Freeform "Additional details" text where a user may name a
 *   look (e.g. `"elegant luxury feel"`, `"bold and energetic"`).
 * @returns One of the 13 template preset names, or `undefined` when nothing
 *   matches (the caller then omits `themeStyle` and the template falls back to
 *   its own `classic` default). Never throws.
 *
 * @example
 * themeStyleFromInputs('Financial / Accounting')            // → 'heritage'
 * themeStyleFromInputs('car_dealer')                        // → 'precision'
 * themeStyleFromInputs('hardware_store')                    // → 'rugged'
 * themeStyleFromInputs('Retail / Shop', 'elegant luxury')   // → 'luxe'  (hint wins)
 * themeStyleFromInputs('Other')                             // → undefined
 */
export function themeStyleFromInputs(
  category?: string | null,
  designHint?: string | null,
): ThemeStyleName | undefined {
  const hint = normalizeForMatch(designHint);
  if (hint) {
    const byHint = firstMatch(hint, HINT_RULES);
    if (byHint) return byHint;
  }
  const cat = normalizeForMatch(category);
  if (cat) {
    const byCat = firstMatch(cat, CATEGORY_RULES);
    if (byCat) return byCat;
  }
  return undefined;
}
