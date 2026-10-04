/**
 * @module services/nominatim_search
 *
 * @description
 * OSM **Nominatim** free-text business search — the resilience fallback for the PUBLIC
 * business lookup (`GET /api/search/businesses`) when Google Places is down/unconfigured.
 *
 * WHY (AL-729): Google Places is persistently 429/403 (billing not enabled on the GCP
 * project), so the guest-acquisition funnel's PRIMARY action degraded to a dead-end
 * "Business lookup is temporarily unavailable" for EVERY visitor — pushing them to the
 * weaker "Build a custom website" manual path. The lead scanner already falls back to OSM
 * (`osm_overpass.ts`, area+tag based) — but the public NAME search had no such fallback.
 * Nominatim is the right OSM tool for a free-text NAME query (Overpass needs a bbox+tags),
 * so this restores real business results with NO dependency on Google Places billing.
 *
 * Fail-soft: any error / non-200 / timeout → `[]` (the caller keeps its honest `_error`).
 * Nominatim usage policy: a descriptive User-Agent is required + ≤1 req/sec — the caller
 * KV-caches hits (6h) so repeat/keystroke-debounced queries never re-hit the endpoint.
 *
 * @packageDocumentation
 */

/** A business-search result — identical shape to the Places path in `places_search/handlers.ts`. */
export interface BusinessSearchResult {
  /** Stable id. OSM results are prefixed `osm:` (e.g. `osm:n240109189`) to distinguish from Google place_ids. */
  readonly place_id: string;
  readonly name: string;
  readonly address: string;
  readonly types: readonly string[];
  readonly lat: number | null;
  readonly lng: number | null;
  readonly phone: string | null;
  readonly website: string | null;
}

/** A single Nominatim `jsonv2` search result (only the fields we consume). */
export interface NominatimResult {
  readonly osm_type?: string;
  readonly osm_id?: number;
  readonly lat?: string;
  readonly lon?: string;
  readonly name?: string;
  readonly display_name?: string;
  readonly type?: string;
  readonly class?: string;
  readonly extratags?: Record<string, string> | null;
}

/** Descriptive UA per the Nominatim usage policy (a contact so they can reach us if we misbehave). */
const NOMINATIM_UA = 'ProjectSites.dev/1.0 (business search fallback; ops@projectsites.dev)';

/**
 * Colloquial business-category phrase → Nominatim SPECIAL-PHRASE word.
 *
 * Nominatim's `"{category} in {place}"` lookup only resolves when `{category}` is in its FIXED
 * special-phrase dictionary (verified live 2026-10-03: `"cafe in Newark NJ"` → 10 results, but
 * `"coffee shop in Newark NJ"` → 0 — "coffee shop" is NOT a dictionary phrase, "cafe" is). Visitors
 * type the colloquial form ("coffee shop", "barber"), so map the common colloquialisms to the word
 * Nominatim indexes. Longest keys first so multi-word phrases win over single-word substrings.
 */
const NOMINATIM_CATEGORY_SYNONYMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcoffee shops?\b/gi, 'cafe'],
  [/\bcoffee house\b/gi, 'cafe'],
  [/\bbarber shops?\b/gi, 'hairdresser'],
  [/\bbarbers?\b/gi, 'hairdresser'],
  [/\bhair salons?\b/gi, 'hairdresser'],
  [/\bbeauty salons?\b/gi, 'hairdresser'],
  [/\bnail salons?\b/gi, 'beauty'],
  [/\bgyms?\b/gi, 'fitness centre'],
  [/\bauto repair\b/gi, 'car repair'],
  [/\bmechanics?\b/gi, 'car repair'],
  [/\blaw firms?\b/gi, 'lawyer'],
  [/\battorneys?\b/gi, 'lawyer'],
  [/\bdentists?\b/gi, 'dentist'],
  [/\bbakeries\b/gi, 'bakery'],
  [/\bpizzerias?\b/gi, 'restaurant'],
  [/\bdiners?\b/gi, 'restaurant'],
  [/\bbookstores?\b/gi, 'books'],
  [/\bflorists?\b/gi, 'florist'],
];

/**
 * Rewrite colloquial category words in a query to Nominatim special-phrase vocabulary.
 * Pure; returns the query unchanged when nothing matches.
 *
 * @param q - The (already whitespace-collapsed) query.
 * @returns The query with the FIRST matching colloquial category mapped to its Nominatim word.
 * @example mapCategorySynonyms('coffee shop newark nj') // → 'cafe newark nj'
 */
export function mapCategorySynonyms(q: string): string {
  for (const [re, word] of NOMINATIM_CATEGORY_SYNONYMS) {
    re.lastIndex = 0; // the regexes are `g`-flagged (module-shared) — reset before each test
    if (re.test(q)) {
      re.lastIndex = 0;
      return q.replace(re, word);
    }
  }
  return q;
}

/**
 * Build the ordered list of Nominatim query variants to try for one visitor query.
 *
 * WHY (Google-Maps/Places integration repair, 2026-10-03): Nominatim is a GEOCODER keyed on place
 * names + addresses, NOT a category index. A bare colloquial category phrase — exactly the "search
 * your business" shape the acquisition funnel sends (`"coffee shop newark nj"`) — matches NOTHING
 * (verified live: `count: 0`), so the OSM fallback engaged but returned `[]` and the funnel still
 * dead-ended even though Google Places was correctly bypassed (Places is billing-dead /
 * Places-API-New-disabled on the GCP project → REQUEST_DENIED/PERMISSION_DENIED). Two things make
 * Nominatim resolve a category search, BOTH needed: (1) the `"{category} in {place}"` SPECIAL-PHRASE
 * connector, and (2) the category must be a Nominatim DICTIONARY word — `"cafe in Newark NJ"` → 10
 * results, but `"coffee shop in Newark NJ"` → 0 (verified). So we try, in order: the literal query
 * (a real business NAME like "Blue Bottle Coffee Newark" resolves directly — never mangle it), then
 * the colloquial→dictionary `… in …` rewrite (`"coffee shop newark nj"` → `"cafe in newark nj"`).
 * First variant with hits wins.
 *
 * Pure (no I/O) → unit-provable. Variants are de-duplicated preserving order.
 *
 * @param query - The visitor's trimmed business query.
 * @returns 1–2 distinct query strings to try in order (literal first, mapped `… in …` rewrite second).
 * @example
 * buildNominatimQueryVariants('coffee shop newark nj')
 * // → ['coffee shop newark nj', 'cafe in newark nj']
 * @example
 * buildNominatimQueryVariants('Blue Bottle Coffee in San Francisco')
 * // → ['Blue Bottle Coffee in San Francisco']  (already has a connector — no rewrite)
 */
export function buildNominatimQueryVariants(query: string): string[] {
  const q = (query ?? '').trim().replace(/\s+/g, ' ');
  if (!q) return [];
  const variants = [q];
  const lower = q.toLowerCase();
  const hasConnector = /\b(in|near|at|around)\b/.test(lower);
  const tokens = q.split(' ');
  // Synthesize a dictionary-mapped "… in …" variant when the query has no existing locational
  // connector AND has ≥3 tokens (something to split into "category" + "place"). The location tail
  // is 2 words when the last token is a US state abbreviation ("newark nj"), else the single
  // trailing token. The CATEGORY half is run through the colloquial→Nominatim-word map so "coffee
  // shop" becomes the indexed word "cafe".
  if (!hasConnector && tokens.length >= 3) {
    const last = tokens[tokens.length - 1] ?? '';
    const isStateish = /^[a-z]{2}$/i.test(last); // "nj" / "ny" / "ca" …
    const tailCount = isStateish ? 2 : 1;
    const splitAt = tokens.length - tailCount;
    if (splitAt >= 1) {
      const category = mapCategorySynonyms(tokens.slice(0, splitAt).join(' '));
      const place = tokens.slice(splitAt).join(' ');
      const rewritten = `${category} in ${place}`;
      if (!variants.some((v) => v.toLowerCase() === rewritten.toLowerCase())) {
        variants.push(rewritten);
      }
    }
  } else if (hasConnector) {
    // Already has a connector (e.g. "coffee shop in newark") — still map the colloquial category to
    // the Nominatim dictionary word so it resolves ("coffee shop in newark" → "cafe in newark").
    const mapped = mapCategorySynonyms(q);
    if (!variants.some((v) => v.toLowerCase() === mapped.toLowerCase())) variants.push(mapped);
  }
  return variants;
}

/** Nominatim usage policy ceiling (≤1 req/sec); we try at most this many variants per lookup. */
const MAX_NOMINATIM_VARIANTS = 2;

/**
 * Clean a Nominatim `display_name` into a human address for the result subtitle. Nominatim prepends
 * the POI name ("Blue Bottle Coffee, 66, Mint Street, …") when the node is named — so a naive subtitle
 * REPEATS the bold result title (a visible glitch on the #1 acquisition surface) AND, downstream,
 * makes the first comma-field the business NAME instead of a street (so `postalAddressFor` would set
 * a LocalBusiness `streetAddress` to the business name for OSM-sourced sites). This drops the leading
 * "{name}, " and joins the comma-split house number to its street ("66, Mint Street" → "66 Mint
 * Street") so the address reads naturally everywhere it is consumed. Pure — unit-tested.
 *
 * @param displayName - The raw Nominatim `display_name`.
 * @param name - The already-resolved business name.
 * @returns A clean address with no duplicate leading name and a natural "{number} {street}" head.
 * @example
 * cleanNominatimAddress('Blue Bottle Coffee, 66, Mint Street, SF, CA, 94103, USA', 'Blue Bottle Coffee')
 * // → '66 Mint Street, SF, CA, 94103, USA'
 */
export function cleanNominatimAddress(displayName: string, name: string): string {
  let s = (displayName ?? '').trim();
  const n = (name ?? '').trim();
  if (n && s.toLowerCase().startsWith(n.toLowerCase())) {
    const rest = s
      .slice(n.length)
      .replace(/^\s*,\s*/, '')
      .trim();
    if (rest) s = rest; // keep the full string if stripping would empty it (display_name === name)
  }
  return s.replace(/^(\d+[a-z]?),\s+/i, '$1 '); // "66, Mint Street" → "66 Mint Street"
}

/**
 * Map one Nominatim result to the public business-search shape. Skips results with no usable
 * name (pure address/region hits — not a business a visitor would claim).
 *
 * @param r - A Nominatim `jsonv2` result.
 * @returns The mapped {@link BusinessSearchResult}, or `null` when it has no business name.
 *
 * @example
 * mapNominatimResult({ osm_type:'node', osm_id:1, name:'Blue Bottle Coffee', class:'amenity', type:'cafe',
 *   lat:'37.7', lon:'-122.4', extratags:{ website:'https://bluebottlecoffee.com' } })
 * // → { place_id:'osm:n1', name:'Blue Bottle Coffee', types:['cafe'], website:'https://bluebottlecoffee.com', … }
 */
export function mapNominatimResult(r: NominatimResult): BusinessSearchResult | null {
  const name = (r.name ?? '').trim() || (r.display_name ?? '').split(',')[0]?.trim() || '';
  if (!name) return null;
  const et = r.extratags ?? {};
  const latN = r.lat ? Number.parseFloat(r.lat) : Number.NaN;
  const lngN = r.lon ? Number.parseFloat(r.lon) : Number.NaN;
  const idChar = (r.osm_type ?? 'n').charAt(0); // n(ode) | w(ay) | r(elation)
  return {
    address: cleanNominatimAddress(r.display_name ?? '', name),
    lat: Number.isNaN(latN) ? null : latN,
    lng: Number.isNaN(lngN) ? null : lngN,
    name,
    phone: et.phone ?? et['contact:phone'] ?? null,
    place_id: `osm:${idChar}${r.osm_id ?? ''}`,
    types: r.type ? [r.type] : [],
    website: et.website ?? et['contact:website'] ?? null,
  };
}

/**
 * Run ONE Nominatim search for an exact query string and map the hits. Fail-soft: any
 * non-200 / non-array / network throw → `[]`. Extracted from {@link searchBusinessesByName}
 * so the multi-variant loop can reuse a single, unit-provable fetch unit.
 *
 * @param q - The EXACT query to send to Nominatim (already a chosen variant).
 * @param doFetch - The fetch implementation (injected for tests).
 * @param opts - Optional viewbox bias (`{ lat, lng }`).
 * @returns Mapped {@link BusinessSearchResult}[] (≤10); `[]` on any failure.
 */
async function runNominatimSearch(
  q: string,
  doFetch: typeof fetch,
  opts?: { lat?: number; lng?: number },
): Promise<BusinessSearchResult[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('extratags', '1');
  url.searchParams.set('limit', '10');
  // A viewbox around the geolocation biases (but does not restrict — `bounded=0`) results toward the visitor.
  if (typeof opts?.lat === 'number' && typeof opts?.lng === 'number') {
    const d = 0.5; // ~55km box
    url.searchParams.set(
      'viewbox',
      `${opts.lng - d},${opts.lat - d},${opts.lng + d},${opts.lat + d}`,
    );
  }
  try {
    const res = await doFetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': NOMINATIM_UA },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const arr = (await res.json()) as NominatimResult[];
    if (!Array.isArray(arr)) return [];
    const out: BusinessSearchResult[] = [];
    for (const r of arr) {
      const mapped = mapNominatimResult(r);
      if (mapped) out.push(mapped);
      if (out.length >= 10) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Free-text business search via OSM Nominatim. Returns up to 10 named businesses, or `[]` on any
 * failure (fail-soft — the caller preserves its honest `_error` envelope).
 *
 * Tries the visitor's literal query FIRST; if that yields nothing, retries with the
 * Nominatim-friendly `… in …` SPECIAL-PHRASE rewrite ({@link buildNominatimQueryVariants}) so a
 * bare CATEGORY search ("coffee shop newark nj") — which Nominatim's geocoder returns 0 for —
 * still surfaces real businesses ("coffee shop in newark nj"). The first variant with hits wins;
 * at most {@link MAX_NOMINATIM_VARIANTS} requests per lookup (Nominatim ≤1 req/sec courtesy — the
 * caller KV-caches hits so this runs once per cold query, not per keystroke).
 *
 * @param query - The visitor's business query, e.g. `"Blue Bottle Coffee San Francisco"` or `"coffee shop newark nj"`.
 * @param opts - Optional viewbox bias (`{ lat, lng }` from browser geolocation) + a `fetchImpl` for tests.
 * @returns Mapped {@link BusinessSearchResult}[] (≤10); `[]` on error or genuine no-match.
 *
 * @remarks Impure — performs up to 2 sequential network fetches, each timeboxed to 6s.
 */
export async function searchBusinessesByName(
  query: string,
  opts?: { lat?: number; lng?: number; fetchImpl?: typeof fetch },
): Promise<BusinessSearchResult[]> {
  const doFetch = opts?.fetchImpl ?? fetch;
  const geo =
    typeof opts?.lat === 'number' && typeof opts?.lng === 'number'
      ? { lat: opts.lat, lng: opts.lng }
      : undefined;
  const variants = buildNominatimQueryVariants(query).slice(0, MAX_NOMINATIM_VARIANTS);
  for (const variant of variants) {
    const hits = await runNominatimSearch(variant, doFetch, geo);
    if (hits.length > 0) return hits;
  }
  return [];
}
