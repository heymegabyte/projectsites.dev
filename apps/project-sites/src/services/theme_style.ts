/**
 * Deterministic theme-style selector — maps a business's declared vertical
 * category + freeform design-style hint to one of the template's visual
 * personality PRESETS, emitted as the top-level `_brand.json.themeStyle`.
 *
 * WHY (producer gap, found 2026-09-08): the template
 * (`template/src/themePresets.ts` + `brand.ts`) ships 16 cohesive personalities
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
 * The 16 template preset names — a mirror of `PRESET_NAMES` in
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
  'noir',
  'retro',
  'artisan',
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
    'noir',
    /\b(noir|cinematic|speakeas\w*|moody|after\s?dark|film\s?noir|dramatic\s?dark|sultry|candlelit|dimly\s?lit|smoky|theatrical\s?dark)\b/,
  ],
  [
    'retro',
    /\b(retro|vintage|nostalg\w*|throwback|mid\s?century|analog|old\s?school|americana|vinyl|fifties|sixties|seventies|eighties)\b/,
  ],
  [
    'artisan',
    /\b(artisan\w*|handcraft\w*|handmade|hand\s?made|small\s?batch|maker|craft\w*|homemade|home\s?made|kraft|hand\s?stamped)\b/,
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
  ['boutique', /\b(chic|fashionable|stylish|trendy|tactile|curated|shoppable)\b/],
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
  // scholarly = learning + books + reading. Bookstores / bookshops / booksellers /
  // libraries belong HERE (books/reading/authors/staff-picks aesthetic), NOT in the
  // generic retail `boutique` catch-all — a bookstore is scholarly, not a clothing
  // boutique (AL-322/AL-323 live mis-theme: booksweet shipped boutique). Ordered before
  // boutique (line below) so `\bbooks\b` wins over `\bstore\w*`.
  [
    'scholarly',
    /\b(education\w*|educational|tutor\w*|\bschool\w*|academy|academ\w*|\bcourse\w*|coaching|learning|\bkids\b|children|childcare|university|universit\w*|college|preschool|kindergarten|daycare|montessori|\bstem\b|classes|teach\w*|pedagog\w*|training\s?cent|book\s?stor\w*|bookstore\w*|bookshop\w*|booksell\w*|\bbooks\b|\blibrar\w*)\b/,
  ],
  [
    'luxe',
    /\b(real\s?estate|realty|realtor\w*|jewel\w*|fine\s?dining|hospitality|\bhotel\w*|resort\w*|lodging|steakhouse|winery|wineries|vineyard|country\s?club|\byacht\w*|concierge|penthouse|five\s?star|boutique\s?hotel|\bspa\s?resort|bridal|\bwatch\w*\s?(shop|store|maker))\b/,
  ],
  [
    'rugged',
    /\b(construction|home\s?services|\btrade\b|\btrades\b|plumb\w*|\bhvac\b|heating|cooling|air\s?condition\w*|furnace\w*|roof\w*|electric\w*|electrician|contractor\w*|landscap\w*|manufactur\w*|logistics|hardware|welding|mason\w*|concrete|excavat\w*|fencing|paving|demolition|\bmoving\b|junk\s?removal|pest\s?control|handyman|carpentr\w*|carpenter|flooring|drywall|septic|gutter\w*|remodel\w*|renovation|\bhauling\b|towing|locksmith|garage\s?door|excavation|\bpaint\w*\s?(contractor|company)|snow\s?removal)\b/,
  ],
  // Style-forward hospitality/retail verticals that suit a MORE ELABORATE named
  // personality than the generic warm/boutique catch-alls (AL-334) — checked
  // before them so a cocktail lounge → noir (not warm's `\blounge\b`), a record
  // store → retro (not boutique's `\bstore\b`), a coffee roaster → artisan (not
  // warm's `\bcoffee\b`). These three FE-advertised themes were previously
  // unreachable by the worker matcher → they silently shipped `classic`.
  [
    'noir',
    /\b(speakeas\w*|cocktail\s?(?:bar|lounge|room)|night\s?club\w*|nightclub\w*|tattoo\w*|hookah\w*|cigar\s?(?:bar|lounge|shop)|whisk\w*\s?bar|jazz\s?(?:bar|club|lounge)|burlesque|piano\s?bar)\b/,
  ],
  [
    'retro',
    /\b(record\s?stor\w*|vinyl\s?(?:shop|store|record\w*)|arcade\w*|roller\s?rink|comic\s?(?:shop|store|book\s?stor\w*)|vintage\s?(?:shop|store|clothing|boutique|market)|retro\s?\w+|pinball)\b/,
  ],
  [
    'artisan',
    /\b(coffee\s?roaster\w*|\broaster\w*|creamer(?:y|ies)|cheesemong\w*|chocolatier\w*|confection\w*|potter\w*|ceramic\w*|woodwork\w*|glassblow\w*|leather\s?(?:goods|work\w*|smith\w*)|cooperage|distiller\w*|meader\w*|\bcandle\w*|soap\s?maker\w*|craft\s?(?:brewer\w*|distiller\w*|studio|goods)|artisan\w*|handmade\w*|handcraft\w*)\b/,
  ],
  // warm BEFORE boutique so "Coffee Shop" / "Bakery" match food (warm) rather
  // than the generic `\bshop\b` in boutique.
  [
    'warm',
    /\b(restaurant\w*|caf[eé]\w*|bakery|bakeries|\bcoffee\b|\bbar\b|brewery|breweries|brewpub|\bpub\b|bistro|diner|eatery|eateries|salon\w*|barber\w*|\bhair\b|\bnail\w*|\bgrill\w*|pizzeria|\bpizza\b|taqueria|\bdeli\b|\bfood\b(?!\s?(?:bank|pantr|shelf|drive))|catering|caterer\w*|ice\s?cream|\bmeal\w*|takeaway|takeout|nightlife|night\s?club|\blounge\b|\bkitchen\b|grocer\w*|supermarket|smoothie|juice\s?bar|\bbbq\b|steak\s?house|sandwich\w*|\bdonut\w*|doughnut\w*|creamery|patisserie|teahouse|\btea\s?room|food\s?truck)\b/,
  ],
  [
    'boutique',
    /\b(retail|\bshop\w*|\bstore\w*|boutique\w*|apparel|clothing|fashion\w*|merchandise|\bgoods\b|florist\w*|\bgift\w*|pet\s?(store|shop)|home\s?goods|furniture|\btoys?\b|stationery|cosmetic\w*|accessor\w*|lifestyle|\bmarket\b|thrift|consignment|antique\w*|\bcrafts?\b)\b/,
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
    // NOTE: `librar*` moved to the `scholarly` rule above (books/learning aesthetic
    // suits a library better than civic-editorial) per AL-323.
    'editorial',
    /\b(legal|\blaw\b|attorney\w*|lawyer\w*|nonprofit|non\s?profit|charit\w*|foundation|\bchurch\w*|place\s?of\s?worship|ministr\w*|synagogue|\bmosque\b|\btemple\b|congregation|\bngo\b|community\s?(cent|org)|government|municipal\w*|\bmuseum\w*|association\w*|\bunion\b|advocacy|humanitarian|\bcivic\b|public\s?service|social\s?service\w*)\b/,
  ],
];

/**
 * Return the label of the first rule whose regex matches `text`. Generic over the
 * label type so it serves both the theme-style ({@link ThemeStyleName}) and the
 * commerce-mode ({@link CommerceMode}) rule tables.
 */
function firstMatch<T extends string>(
  text: string,
  rules: ReadonlyArray<readonly [T, RegExp]>,
): T | undefined {
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
 * @returns One of the 16 template preset names, or `undefined` when nothing
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

/**
 * Per-personality CONTENT design brief for the build orchestrator (AL-356).
 *
 * WHY (producer gap, 2026-09-11): the template stamps each personality's
 * fonts/color/radius/shadow/motion + a `:root[data-style]` flourish (CSS side —
 * `themePresets.ts` + `index.css`), and `themeStyleFromInputs` already routes the
 * right personality onto `_brand.json.themeStyle`. But the orchestrator PROMPT
 * (`buildPrompt` in `workflows/site-generation.ts`) only told Claude Code to keep
 * the theme FONTS — it never named the personality or its CONTENT design language.
 * So a `noir` steakhouse could still get bright airy stock photos + flat corporate
 * copy: the CSS read cinematic, the CONTENT didn't. This map closes that gap — one
 * dense directive per personality covering the four content levers CSS can't reach:
 * IMAGERY mood, COPY tone, SECTION emphasis, MOTION character. `buildPrompt` injects
 * the matching brief so imagery/copy/section choices REINFORCE the theme, making it
 * read as an elaborate real brand rather than a recolored template.
 *
 * Keyed by every {@link ThemeStyleName}; `personalityBriefFor` is the safe accessor.
 */
export const THEME_PERSONALITY_BRIEF: Record<ThemeStyleName, string> = {
  classic:
    'Modern, geometric, confident — the versatile default. Imagery: clean contemporary photography, crisp product/space shots. Copy: clear, confident, benefit-led. Sections: hero → services → about → proof → contact. Motion: smooth, modern reveals.',
  editorial:
    'Trustworthy, calm, magazine-grade. Imagery: honest documentary photography of real people/places, generous whitespace, zero glossy stock. Copy: measured, credible, mission-first with proof. Sections: emphasize mission/about, credentials, clearly-explained services. Motion: restrained, slow fades.',
  warm: 'Inviting, soft, approachable. Imagery: golden-hour warmth, candid people, close-ups of food/space/hands. Copy: friendly second-person, welcoming, sensory. Sections: mood hero → signature offerings → hours & location up top. Motion: gentle, springy reveals.',
  luxe: 'Refined, premium, editorial-elegant. Imagery: dramatic low-key hero, tight detail/craft shots, abundant negative space — no busy collages. Copy: understated confidence, sensory restraint, never salesy. Sections: signature experience, reservations/private appointments, provenance & craft. Motion: slow, deliberate.',
  brutalist:
    'High-impact, editorial-bold. Imagery: stark high-contrast, type-as-image, raw off-grid crops. Copy: short declarative punches, no filler. Sections: bold statement hero, work/portfolio grid, blunt CTA. Motion: snappy, hard cuts.',
  bold: 'Athletic, loud, kinetic. Imagery: action shots, sweat, motion, high-energy crowds. Copy: imperative and motivational, punchy verbs. Sections: CTA hero → programs/classes → results/transformation → join. Motion: fast, punchy.',
  futuristic:
    'Sleek, glassy, gradient-forward. Imagery: product/UI, abstract gradients, dark glass, subtle grid. Copy: crisp, benefit-led, technically confident. Sections: product hero → feature grid → metrics/integrations → start CTA. Motion: floaty, soft glow reveals.',
  rugged:
    'Sturdy, industrial, dependable. Imagery: real job-sites, equipment, work-in-progress, actual crews — not stock suits. Copy: plain, direct, no-nonsense; licensed/insured/experience trust cues. Sections: services → service-area → free-estimate CTA. Motion: grounded, minimal.',
  botanical:
    'Calming, fresh, reassuring. Imagery: airy natural light, greenery, clean clinical warmth, unhurried faces. Copy: gentle, reassuring, patient-first. Sections: services → practitioners → book-appointment. Motion: soft, slow.',
  boutique:
    'Chic, tactile, editorial-shoppable. Imagery: styled flat-lays, lifestyle vignettes, editorial fashion crops. Copy: covetable, curated, tastemaker voice. Sections: featured collections → brand story → shop CTAs. Motion: elegant lifts.',
  precision:
    'Engineered, sharp, metallic. Imagery: crisp vehicle/product detail, spec close-ups, showroom light. Copy: technical, spec-forward, confident. Sections: inventory/specs → capabilities → book-service. Motion: fast, precise.',
  heritage:
    'Timeless, authoritative, trusted. Imagery: dignified portraits, established locations, subdued palette. Copy: formal, credible, legacy/experience cues. Sections: about/history → credentials → consultation CTA. Motion: dignified, quiet.',
  scholarly:
    'Bright, friendly, encouraging. Imagery: warm learning moments, real students/kids, cheerful spaces. Copy: encouraging, plain, framed around the learner. Sections: programs/courses → outcomes → enroll CTA. Motion: springy, welcoming.',
  noir: 'Cinematic, intimate, after-dark. Imagery: candlelit low-key photography, deep shadow, warm highlights, moody close-ups — NEVER bright or airy stock. Copy: evocative, sensory, understated luxury; short confident lines. Sections: atmospheric hero → signature offerings (menu/cocktails) → reservations & private dining → late-night hours. Motion: slow, theatrical reveals.',
  retro:
    'Playful, nostalgic, joyfully vintage. Imagery: bold saturated color, vintage textures, characterful product shots. Copy: fun, cheeky, nostalgic. Sections: personality hero → offerings/menu → events/community. Motion: bouncy spring.',
  artisan:
    'Handmade, earthy, honest. Imagery: hands-at-work/process, raw materials, warm natural light, kraft/paper texture. Copy: honest, craft-proud, provenance-led. Sections: our craft/process → products → visit us. Motion: gentle, tactile.',
};

/**
 * Return the CONTENT design brief for a personality name. Never throws.
 *
 * @param name - A theme-style name (any type); typically the result of
 *   {@link themeStyleFromInputs}.
 * @returns The matching {@link THEME_PERSONALITY_BRIEF} entry, or `undefined` for
 *   any unknown/empty/non-string input (the caller then omits the prompt block,
 *   exactly matching the pre-AL-356 behavior for unmatched verticals).
 *
 * @example
 * personalityBriefFor('noir')      // → 'Cinematic, intimate, after-dark. …'
 * personalityBriefFor('nope')      // → undefined
 * personalityBriefFor(undefined)   // → undefined
 */
export function personalityBriefFor(name: unknown): string | undefined {
  if (typeof name === 'string') {
    const key = name.trim().toLowerCase();
    if (key in THEME_PERSONALITY_BRIEF) return THEME_PERSONALITY_BRIEF[key as ThemeStyleName];
  }
  return undefined;
}

/**
 * How a business is actually PATRONIZED — an axis ORTHOGONAL to the visual
 * {@link ThemeStyleName} personality. Personality drives look (fonts/color/motion);
 * commerce mode drives the CONVERSION intent — which CTAs are on-brand and which
 * are a wrong-vertical defect.
 */
export type CommerceMode =
  | 'retail'
  | 'hospitality'
  | 'service'
  | 'professional'
  | 'nonprofit'
  | 'general';

/**
 * Ordered vertical → commerce mode. FIRST match wins, so the ordering matters:
 * nonprofit BEFORE hospitality (a food bank is charity, not a restaurant),
 * hospitality BEFORE retail (a distillery/winery/brewery is VISITED/TASTED, not
 * checked-out — even though it sells bottles), service + professional BEFORE
 * retail (a salon/law-firm is booked/retained, not carted). Retail is the genuine
 * sells-products bucket (shop/boutique/jewelry/florist/bookstore/hardware) where
 * e-commerce cart language is on-brand. Scanned against the NORMALIZED input.
 *
 * WHY (AL-407, 2026-09-12): the build prompt steered the H1 vertical but NOT the
 * CTA/commerce intent, so `artisan`/`luxe`/`warm` hospitality verticals shipped
 * e-commerce heroes — a delivered DISTILLERY got "Shop now / Free shipping over
 * $50 / Easy 30-day returns" + a clothing-store hero image, the opposite of
 * "beat the source". This map + {@link COMMERCE_INTENT_BRIEF} give the orchestrator
 * the missing conversion axis so hospitality/service/professional/nonprofit sites
 * read as their real category instead of a recolored retail template.
 */
const COMMERCE_MODE_RULES: ReadonlyArray<readonly [CommerceMode, RegExp]> = [
  [
    'nonprofit',
    /\b(soup\s?kitchen|food\s?(?:bank|pantr\w*|shelf)|\bpantr\w*|homeless|\bshelter\w*|nonprofit|non\s?profit|charit\w*|\bngo\b|humanitarian|relief\s?(?:org|fund|effort)|foundation|\bchurch\w*|ministr\w*|synagogue|\bmosque\b|\btemple\b|congregation|place\s?of\s?worship|community\s?(?:cent|org|kitchen)|advocacy|\bcivic\b|public\s?service|social\s?service\w*)\b/,
  ],
  [
    'hospitality',
    /\b(restaurant\w*|caf[eé]\w*|bakery|bakeries|coffee\s?(?:shop|house|roaster\w*)|\bcoffee\b|\bbar\b|brewery|breweries|brewpub|\bpub\b|bistro|diner|eatery|eateries|\bgrill\w*|pizzeria|\bpizza\b|taqueria|\bdeli\b|catering|caterer\w*|ice\s?cream|creamer(?:y|ies)|takeaway|takeout|nightlife|night\s?club\w*|nightclub\w*|\blounge\b|\bkitchen\b|smoothie|juice\s?bar|\bbbq\b|steak\s?house|steakhouse|sandwich\w*|\bdonut\w*|doughnut\w*|patisserie|teahouse|\btea\s?room|food\s?truck|distiller\w*|winer(?:y|ies)|vineyard\w*|cider\w*|cidery|meader\w*|meadery|tasting\s?room|\bhotel\w*|resort\w*|\binn\b|lodging|\bmotel\w*|\bbnb\b|bed\s?and\s?breakfast|hospitality|banquet|\bfood\b(?!\s?(?:bank|pantr|shelf|drive)))\b/,
  ],
  [
    'service',
    /\b(plumb\w*|\bhvac\b|heating|cooling|air\s?condition\w*|furnace\w*|roof\w*|electric\w*|electrician|contractor\w*|construction|landscap\w*|\blawn\b|cleaning|\bmaid\w*|janitor\w*|pest\s?control|handyman|carpentr\w*|carpenter|flooring|drywall|septic|gutter\w*|remodel\w*|renovation|towing|locksmith|garage\s?door|excavat\w*|fencing|paving|demolition|\bmoving\b|junk\s?removal|snow\s?removal|salon\w*|barber\w*|\bhair\b|\bnail\w*|\bspa\b|beauty|\bmed\s?spa|wellness|massage|\bclinic\w*|dental|dentist\w*|orthodont\w*|\bdoctor\w*|physician\w*|chiropract\w*|veterinar\w*|\bvet\b|optometr\w*|dermatolog\w*|physio\w*|acupunctur\w*|fitness|\bgym\w*|crossfit|yoga\b|pilates|personal\s?train\w*|dance\s?studio|automotive|\bauto\b|mechanic\w*|body\s?shop|\btire\w*|detailing|collision|\bsmog\b|lube|repair\w*|photograph\w*|\bmover\w*)\b/,
  ],
  [
    'professional',
    /\b(legal|\blaw\b|attorney\w*|lawyer\w*|law\s?firm|financ\w*|account\w*|\bcpa\b|bookkeep\w*|\btax\b|audit\w*|insurance|insur\w*|wealth|advisor\w*|\bbank\w*|mortgage|invest\w*|escrow|notary|payroll|real\s?estate|realty|realtor\w*|consult\w*|\bagenc\w*|architect\w*|engineer\w*|marketing|\bpr\b|public\s?relations|staffing|recruit\w*|\bsaas\b|software|startup\w*|\bit\s?services|web\s?(?:design|dev\w*)|technolog\w*)\b/,
  ],
  [
    'retail',
    /\b(retail|\bshop\w*|\bstore\w*|boutique\w*|apparel|clothing|fashion\w*|merchandise|\bgoods\b|florist\w*|\bflower\w*|\bgift\w*|pet\s?(?:store|shop|supply)|home\s?goods|furniture|\btoys?\b|stationery|cosmetic\w*|accessor\w*|jewel\w*|goldsmith\w*|\bwatch\w*\s?(?:shop|store|maker)|book\s?stor\w*|bookshop\w*|booksell\w*|\bbooks\b|record\s?stor\w*|vinyl\s?(?:shop|store)|hardware|\bmarket\b|thrift|consignment|antique\w*|grocer\w*|supermarket|electronics|garden\s?cent\w*|nursery|\bcrafts?\s?(?:shop|store|supply))\b/,
  ],
];

/**
 * Per-mode CONVERSION brief for the build orchestrator — names the on-brand
 * primary CTAs and, for every non-retail mode, EXPLICITLY forbids e-commerce
 * checkout language ("Shop now / Add to cart / Free shipping / 30-day returns /
 * Browse collections"). `retail` is the ONLY mode where that language is on-brand.
 */
export const COMMERCE_INTENT_BRIEF: Record<CommerceMode, string> = {
  retail:
    'This business SELLS products, so genuine e-commerce affordances fit. Primary CTAs: Shop / Browse the collection / View products / Add to cart / Buy — plus store hours + location + a map. Product grids with price and a quick-add are appropriate. This is the ONE mode where "Shop now" / "Free shipping" / cart language is on-brand.',
  hospitality:
    'People VISIT, TASTE, DINE, BOOK, or RESERVE here — they do NOT check out a shopping cart. Primary CTAs: Reserve a table / Book a tour / View the menu / Visit us / Order online (pickup/delivery) / Find us / See hours & location. Present offerings as a MENU or a COLLECTION to explore, never a store to check out. FORBIDDEN as primary framing: "Shop now", "Add to cart", "Free shipping", "30-day returns", "Browse collections" — e-commerce checkout copy on a restaurant / bar / brewery / distillery / winery / cidery / hotel is a wrong-vertical defect (a small "where to buy our bottles" link is fine as a secondary, never the hero CTA).',
  service:
    'Customers BOOK, SCHEDULE, or REQUEST work — they do not buy from a cart. Primary CTAs: Book now / Schedule service / Request a free quote / Get an estimate / Call us. Emphasize service-area, credentials (licensed / insured / years in business), and before/after or portfolio proof. FORBIDDEN: shopping-cart / "Add to cart" / "Free shipping" language — a plumber / salon / clinic / gym / auto shop is booked, not checked out.',
  professional:
    'Clients CONSULT, RETAIN, and INQUIRE — a high-trust relationship, never a cart. Primary CTAs: Book a consultation / Contact us / Request a proposal / Schedule a call. Emphasize expertise, credentials, results/case studies, and trust signals. FORBIDDEN: e-commerce "Shop / Add to cart / Free shipping" — a law / accounting / financial / real-estate / consulting firm is retained, not purchased in a cart.',
  nonprofit:
    'Supporters DONATE, VOLUNTEER, and GET INVOLVED — mission-first, not commerce. Primary CTAs: Donate / Volunteer / Get involved / Sponsor / Learn how to help. Lead with impact, mission, and the people served. FORBIDDEN as primary framing: retail "Shop now" / "Add to cart" as the hero CTA (a merch/store link is fine only as a secondary).',
  general:
    'Use the primary CTAs that match how THIS business actually converts — typically Contact us / Learn more / Get in touch / Get a quote. Only use e-commerce cart language ("Shop now", "Add to cart", "Free shipping") if the business genuinely sells products online; otherwise it is a wrong-vertical defect.',
};

/**
 * Classify a business's commerce mode from its declared category and/or freeform
 * design hint. Returns `'general'` when nothing matches (never `undefined` — the
 * conversion axis always applies, unlike the optional visual personality).
 *
 * @param category - The declared vertical (the /create Industry field, a freeform
 *   category, or a Google-Places `type`).
 * @param designHint - Freeform "Additional details" text (rarely decisive here; the
 *   category is the primary signal, but a hint mentioning the vertical still counts).
 * @returns One of the six {@link CommerceMode} values. Never throws.
 *
 * @example
 * commerceModeFor('Distillery')                  // → 'hospitality'
 * commerceModeFor('Jewelry Store')               // → 'retail'
 * commerceModeFor('Plumbing')                    // → 'service'
 * commerceModeFor('Law Firm')                    // → 'professional'
 * commerceModeFor('Soup Kitchen')                // → 'nonprofit'
 * commerceModeFor('Consulting')                  // → 'professional'
 * commerceModeFor('Something Unclassifiable')    // → 'general'
 */
export function commerceModeFor(
  category?: string | null,
  designHint?: string | null,
): CommerceMode {
  const cat = normalizeForMatch(category);
  if (cat) {
    const byCat = firstMatch(cat, COMMERCE_MODE_RULES);
    if (byCat) return byCat;
  }
  const hint = normalizeForMatch(designHint);
  if (hint) {
    const byHint = firstMatch(hint, COMMERCE_MODE_RULES);
    if (byHint) return byHint;
  }
  return 'general';
}

/**
 * Return the conversion brief for a commerce mode. Never throws; falls back to the
 * `general` brief for any unknown/empty/non-string input.
 *
 * @param mode - A commerce mode (typically the result of {@link commerceModeFor}).
 * @returns The matching {@link COMMERCE_INTENT_BRIEF} entry (always a non-empty string).
 *
 * @example
 * commerceIntentBriefFor('hospitality') // → 'People VISIT, TASTE, DINE, BOOK…'
 * commerceIntentBriefFor('nope')        // → COMMERCE_INTENT_BRIEF.general
 */
export function commerceIntentBriefFor(mode: unknown): string {
  if (typeof mode === 'string') {
    const key = mode.trim().toLowerCase();
    if (key in COMMERCE_INTENT_BRIEF) return COMMERCE_INTENT_BRIEF[key as CommerceMode];
  }
  return COMMERCE_INTENT_BRIEF.general;
}
