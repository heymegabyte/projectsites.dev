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

/** One homepage FAQ entry. */
export interface FaqEntry {
  readonly q: string;
  readonly a: string;
}

/** A homepage FAQ block: a headline + exactly four business-specific Q&A pairs. */
export interface HomepageFaq {
  readonly headline: string;
  readonly items: readonly [FaqEntry, FaqEntry, FaqEntry, FaqEntry];
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

  const sets: Record<string, readonly [FaqEntry, FaqEntry, FaqEntry, FaqEntry]> = {
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
    ],
  };

  const key =
    typeof mode === 'string' && mode.trim().toLowerCase() in sets
      ? mode.trim().toLowerCase()
      : 'general';
  return { headline: 'Questions, answered', items: sets[key]! };
}
