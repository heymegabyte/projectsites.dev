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
    const rest = s.slice(n.length).replace(/^\s*,\s*/, '').trim();
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
 * Free-text business search via OSM Nominatim. Returns up to 10 named businesses, or `[]` on any
 * failure (fail-soft — the caller preserves its honest `_error` envelope).
 *
 * @param query - The visitor's business query, e.g. `"Blue Bottle Coffee San Francisco"`.
 * @param opts - Optional viewbox bias (`{ lat, lng }` from browser geolocation) + a `fetchImpl` for tests.
 * @returns Mapped {@link BusinessSearchResult}[] (≤10), newest provider wins; `[]` on error.
 *
 * @remarks Impure — performs a network fetch. Timeboxed to 6s.
 */
export async function searchBusinessesByName(
  query: string,
  opts?: { lat?: number; lng?: number; fetchImpl?: typeof fetch },
): Promise<BusinessSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const doFetch = opts?.fetchImpl ?? fetch;
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
