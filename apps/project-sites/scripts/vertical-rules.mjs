/**
 * vertical-rules.mjs — the vertical → brand/content-pack classifier, extracted PURE.
 *
 * This is the single source of truth for "which vertical does this business belong
 * to" — the `VERTICAL_RULES` regex table + the two scoring functions. It is a PURE
 * module (zero side-effects, no fs, no network) so it can be unit-tested directly
 * (`node --test scripts/vertical-rules.test.mjs`) WITHOUT booting the container HTTP
 * server that `container-server.mjs` starts at import.
 *
 * container-server.mjs's `pickVerticalPreset(dir, promptText)` reads the deterministic
 * signals off disk (slug + _brand.json identity + prompt + research/content), then
 * delegates the actual classification here:
 *   - `matchDeclaredCategory(declared)` — the AUTHORITATIVE short-circuit: first rule
 *     (by array order) whose regex matches the user-declared `_category.txt` wins.
 *   - `scoreVertical(primary, secondary)` — the fuzzy fallback: identity (primary) hits
 *     weigh 10×, noisy research (secondary) hits weigh 1×; highest score wins; ties go
 *     to the earlier rule (so restaurant beats retail for "coffee shop").
 *
 * The Dockerfile COPYs this to /home/cuser/vertical-rules.mjs (same dir as
 * container-server.mjs → /home/cuser/container-server.mjs), so the `./vertical-rules.mjs`
 * import resolves identically in the container and in the local scripts/ checkout.
 */

/**
 * Deterministic vertical → preset table. First element = the examples/_brand.<vertical>.json
 * (and, via applyVerticalContentPack, examples/_content.<vertical>.json) preset filename;
 * second = the keyword regex. ORDER MATTERS for ties (earlier wins) and for the authoritative
 * declared-category short-circuit (first match wins). Leading \b + STEM match (no trailing \b)
 * so inflections resolve: dentist→"dentistry", plumb→"plumbing", photograph→"photography".
 * Short/ambiguous tokens carry an explicit trailing \b (spa\b not "space", bar\b not "barbecue").
 */
export const VERTICAL_RULES = [
  // Dental = its OWN vertical (light, dentistry copy). Placed BEFORE medical so a
  // tie favors it; dental terms were REMOVED from the medical regex below so a
  // general family-medicine practice no longer renders dentistry copy — the medical
  // pack WAS 100% dental ("Cleanings & Exams/Invisalign", fire-29). Pairs with the
  // template's examples/_brand.dental.json + _content.dental.json. Both stay LIGHT.
  ['_brand.dental.json', /\b(dentist|dental|orthodont|endodont|periodont|prosthodont|oral surgeon|oral surgery|dds\b|dmd\b|teeth|tooth|hygienist|smile makeover)/],
  ['_brand.medical.json', /\b(doctor|physician|clinic|medical|health|hospital|chiropract|dermatolog|pediatric|veterinar|optometr|ophthalmolog|physical therapy|physiotherap|physio|urgent care|family medicine|primary care|internal medicine|surgeon|cardiolog|pharmac)/],
  // Fitness = its OWN vertical (dark, strength-gym copy), NOT wellness. Placed
  // before wellness so a tie favors it; gym/fitness/strength terms were REMOVED
  // from the wellness regex below so a strength gym no longer scores wellness
  // (it rendered yoga copy + LIGHT theme — fire-20). Kept out of
  // LIGHT_VERTICAL_PRESETS so fitness stays DARK. Pairs with the template's
  // examples/_brand.fitness.json + _content.fitness.json pack.
  ['_brand.fitness.json', /\b(gym\b|crossfit|cross-fit|fitness|strength training|strength and conditioning|barbell|powerlifting|power lifting|weightlifting|weight lifting|olympic lifting|personal trainer|personal training|bootcamp|boot camp|kettlebell|calisthenics|athletic club|hiit\b|martial arts|karate|taekwondo|jiu-jitsu|jiu jitsu|judo|muay thai|kickboxing|\bdojo\b)/],
  ['_brand.wellness.json', /\b(yoga|pilates|spa\b|massage|wellness|meditation|salon|beaut|nail|barber|acupunctur|reiki|nutrition|wellbeing|well-being)/],
  // Legal = the professional-services vertical (light, trust/credential copy). Per the
  // orchestrator CLAUDE.md it covers lawyer/attorney AND accountant/CPA/tax/bookkeeping/
  // financial-advisor/insurance — all professional-services that render the same LIGHT
  // credential-forward pack (fire-85: those 6 were falling through / hitting agency).
  ['_brand.legal.json', /\b(law\b|lawyer|attorney|legal|counsel|litigation|paralegal|notary|estate planning|llp\b|accountant|accounting|\bcpa\b|\btax\b|tax prep|bookkeep|financial advis|financial plan|wealth management|insurance)/],
  // "kitchen" is a strong restaurant signal (Hell's Kitchen, The Kitchen) BUT "soup
  // kitchen" is a NONPROFIT — the negative lookbehind lets restaurant keep "kitchen"
  // while letting "soup kitchen" fall through to the nonprofit rule below (fire-85: a
  // declared "soup kitchen" category was shipping as a restaurant since restaurant is
  // checked before nonprofit and grabbed the bareword "kitchen").
  // Seafood market / fishmonger route to restaurant (food vertical, LIGHT, food copy)
  // — NOT retail "free shipping / browse our collection" (fire — pike-place-fish-market
  // shipped retail e-commerce framing on a physical fish market). Pairs with AL-698's
  // theme_style.ts warm/quickserve routing for the same seafood-market signals.
  ['_brand.restaurant.json', /\b(restaurant|restaurateur|farm-to-table|farm to table|cafe|café|coffee|bakery|bar\b|bistro|dining|gastropub|osteria|trattoria|ramen|sushi|diner|eatery|catering|pizzeria|brewery|food truck|(?<!soup )kitchen|chophouse|smokehouse|noodle|burger|barbecue|bbq\b|tavern|pub\b|creamery|gelato|ice cream|grill|steakhouse|winery|vineyard|taqueria|deli\b|seafood|fish\s?market|fishmonger|raw bar|oyster bar)/],
  ['_brand.local-service.json', /\b(local service|local-service|home services?|plumb|hvac|electric|roofing|roofer|landscap|lawn|cleaning|janitor|contractor|handyman|pest control|locksmith|moving|movers|garage door|paint|construction|remodel|flooring|fencing|paving|towing|auto repair|mechanic|tree service|arborist|appliance repair|pool service|pressure washing|gutter|septic|chimney sweep)/],
  ['_brand.nonprofit.json', /\b(nonprofit|non-profit|charit|foundation|ministry|church|synagogue|mosque|temple|community center|volunteer|shelter|soup kitchen|food bank|pantry|relief center|mutual aid|501c3|outreach|humanitarian|advocacy|ngo\b|animal rescue|humane society|rescue mission)/],
  // Hospitality = hotels / resorts / inns / lodges (DARK, luxe stay-with-us copy).
  // Placed BEFORE retail so a tie favors it AND retail's "boutique" no longer matches
  // "boutique hotel" (negative lookahead below). A hotel was scoring RETAIL on the
  // bareword "boutique" + incidental "shop"/"goods" in research and shipping
  // "free shipping / browse our collection" e-commerce framing (fire — hotel-emma).
  ['_brand.hospitality.json', /\b(hotel|motel|resort|\binn\b|lodge\b|lodging|hospitality|hostel|bed and breakfast|b&b|boutique hotel|guest\s?house|\bsuites?\b|accommodations?|hotelier|innkeeper|boutique inn)/],
  // Gallery = art galleries / museums / exhibition spaces (DARK, art-forward editorial
  // copy). Placed BEFORE retail so a gallery's incidental "shop"/"store" (gift shop) in
  // research no longer scores it RETAIL "free shipping" e-commerce copy (fire —
  // sean-kelly-gallery). Identity hits ("gallery", "contemporary art") weigh 10× the
  // noise. Pairs with examples/_brand.gallery.json + _content.gallery.json.
  ['_brand.gallery.json', /\b(art gallery|\bgallery\b|art museum|\bmuseum\b|exhibition|fine art|contemporary art|art dealer|\bcurator\b|art collection|art space|sculpture garden|artist-run|art fair|vernissage)/],
  // Retail = physical/e-commerce stores. NARROWED (fire): "boutique" no longer matches
  // "boutique hotel" (→ hospitality) and "shop" no longer matches "tattoo shop"
  // (→ no-match, orchestrator keeps its own brand). Real boutiques/gift-shops/apparel
  // still score retail. Coffee/barber "X shop" tie-break to restaurant/wellness by ORDER
  // (both are listed earlier). DARK, rugged gear-shop copy.
  ['_brand.retail.json', /\b(?:store|retail|apparel|clothing|jewelr|goods|merchandise|marketplace|e-commerce|ecommerce|outfitter|bookstore|bookshop|book store|boutique(?!\s+hotel)|(?<!tattoo\s)shop)/],
  ['_brand.saas.json', /\b(saas|software|platform|api\b|startup|analytics|dashboard|developer tool|automation|machine learning|fintech|cybersecurity|app\b|web app)/],
  // Real-estate BEFORE agency (fire-50): the authoritative short-circuit is
  // first-match-by-ORDER over the declared category, and "real estate agency"
  // matches BOTH — checked first, real-estate wins so a realtor no longer ships as
  // a magenta AGENCY site (Ridgeline Realty Group → agency copy/theme, fire-50). Own
  // vertical (dark, listings/buyers/sellers copy); OUT of LIGHT_VERTICAL_PRESETS →
  // DARK. Pairs with examples/_brand.real-estate.json + _content.real-estate.json.
  ['_brand.real-estate.json', /\b(real estate|real-estate|realtor|realty|home buyer|homebuyer|home seller|house hunting|open house|home valuation|buyer's agent|buyers agent|seller's agent|sellers agent|property listing|homes for sale|for sale by owner|mls\b|property management|property manager|mortgage|home loan|refinanc)/],
  ['_brand.agency.json', /\b(agency|marketing|advertis|branding|design studio|creative studio|consult|pr firm|media agency|growth marketing|seo agency)/],
  ['_brand.portfolio.json', /\b(portfolio|photograph|artist|freelance|illustrat|filmmaker|musician|architect|videograph)/],
];

/**
 * Presets whose colorScheme is light — Brian directive: healthcare/wellness/legal/
 * restaurant/local-service/nonprofit render LIGHT (white/cyan), never dark. Hospitality
 * + gallery are DARK (aspirational/art-forward), so they are NOT in this set.
 */
export const LIGHT_VERTICAL_PRESETS = new Set([
  '_brand.medical.json', '_brand.dental.json', '_brand.wellness.json', '_brand.legal.json',
  '_brand.restaurant.json', '_brand.local-service.json', '_brand.nonprofit.json',
]);

/**
 * AUTHORITATIVE short-circuit: the user-declared category (Google Places type / explicit
 * business_type, threaded as _category.txt) is the single most trustworthy signal — the
 * orchestrator NEVER writes it, so (unlike _brand.json) it survives a hallucination. First
 * rule (by array ORDER) whose regex matches the declared string WINS outright.
 * @param {string} declared - lowercased user-declared category text (may be '').
 * @returns {string} preset filename (e.g. '_brand.hospitality.json') or '' when no match.
 * @example matchDeclaredCategory('boutique hotel') // → '_brand.hospitality.json'
 */
export function matchDeclaredCategory(declared) {
  if (!declared) return '';
  for (const [file, re] of VERTICAL_RULES) {
    if (new RegExp(re.source, 'i').test(declared)) return file;
  }
  return '';
}

/**
 * SCORED classifier (not first-match): count keyword hits per vertical; identity
 * (primary) hits weigh 10× the noisy research (secondary) hits. Highest score wins;
 * ties go to the EARLIER rule (strict `>`), so "coffee shop" → restaurant (listed
 * before retail) and "boutique hotel" → hospitality (before retail).
 * @param {string} primary - the business's OWN authoritative identity (slug + name/type/desc), lowercased.
 * @param {string} secondary - broad noisier context (prompt + research + content), lowercased.
 * @returns {string} preset filename or '' when nothing matches.
 * @example scoreVertical('sean kelly gallery contemporary art', 'new york city art dealer shop') // → '_brand.gallery.json'
 */
export function scoreVertical(primary, secondary) {
  let best = '';
  let bestScore = 0;
  for (const [file, re] of VERTICAL_RULES) {
    const g = new RegExp(re.source, 'gi');
    const pHits = (String(primary).match(g) || []).length;
    const sHits = (String(secondary).match(g) || []).length;
    const score = pHits * 10 + sHits;
    if (score > bestScore) { bestScore = score; best = file; }
  }
  return bestScore > 0 ? best : '';
}
