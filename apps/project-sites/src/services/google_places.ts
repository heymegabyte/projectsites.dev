/**
 * @module services/google_places
 * @description Google Places API client for enriching business data.
 * Uses the Places API (New) for detailed business information including
 * hours, photos, reviews, phone, website, geo coordinates.
 *
 * Falls back gracefully when GOOGLE_PLACES_API_KEY is not configured.
 */

/**
 * Normalized envelope returned by {@link lookupBusiness} after Places API
 * Text Search + Details have completed.
 *
 * @remarks
 * Every nullable field is `null` (not `undefined`) so the v3 confidence
 * transformer can distinguish "not provided by Places" from "field missing
 * from response". `photos[]` come pre-resolved to short-lived Places media
 * URLs — re-fetch on render rather than persisting the URL.
 */
export interface PlacesResult {
  place_id: string;
  name: string;
  formatted_address: string;
  phone: string | null;
  website: string | null;
  /** Contact email when the source advertises one (OSM `contact:email`). Optional — Places text search omits it. */
  email?: string | null;
  /** Social profile URLs by network key (from OSM `contact:*`). Optional; keys per `social_links.ts`. */
  socials?: Record<string, string> | null;
  rating: number | null;
  review_count: number | null;
  hours: Array<{ day: string; open: string | null; close: string | null; closed: boolean }> | null;
  geo: { lat: number; lng: number } | null;
  maps_url: string | null;
  photos: Array<{ url: string; attribution: string; width: number; height: number }>;
  types: string[];
  price_level: number | null;
  reviews: Array<{ text: string; author: string; rating: number; time: string }>;
  business_status: string | null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Look up a business using Google Places Text Search, then fetch full details.
 * Returns null if API key is missing or the search finds no results.
 */
export async function lookupBusiness(
  apiKey: string | undefined,
  businessName: string,
  businessAddress: string,
): Promise<PlacesResult | null> {
  if (!apiKey) return null;

  try {
    // Step 1: Text Search to find the place
    const query = `${businessName} ${businessAddress}`.trim();
    const searchUrl = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${apiKey}`;
    const searchRes = await fetch(searchUrl);
    if (!searchRes.ok) return null;

    const searchData = (await searchRes.json()) as {
      results: Array<{
        place_id: string;
        name: string;
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
      }>;
      status: string;
    };

    if (searchData.status !== 'OK' || !searchData.results?.length) return null;

    const placeId = searchData.results[0].place_id;

    // Step 2: Place Details for full info
    const detailsUrl = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=name,formatted_address,formatted_phone_number,international_phone_number,website,rating,user_ratings_total,opening_hours,geometry,photos,types,price_level,reviews,url,business_status&key=${apiKey}`;
    const detailsRes = await fetch(detailsUrl);
    if (!detailsRes.ok) return null;

    const detailsData = (await detailsRes.json()) as {
      result: {
        name: string;
        formatted_address: string;
        formatted_phone_number?: string;
        international_phone_number?: string;
        website?: string;
        rating?: number;
        user_ratings_total?: number;
        opening_hours?: {
          periods?: Array<{
            open: { day: number; time: string };
            close?: { day: number; time: string };
          }>;
          weekday_text?: string[];
        };
        geometry?: { location: { lat: number; lng: number } };
        photos?: Array<{
          photo_reference: string;
          width: number;
          height: number;
          html_attributions: string[];
        }>;
        types?: string[];
        price_level?: number;
        reviews?: Array<{
          text: string;
          author_name: string;
          rating: number;
          relative_time_description: string;
        }>;
        url?: string;
        business_status?: string;
      };
      status: string;
    };

    if (detailsData.status !== 'OK') return null;

    const d = detailsData.result;

    // Parse hours
    let hours: PlacesResult['hours'] = null;
    if (d.opening_hours?.periods) {
      const periods = d.opening_hours.periods;
      hours = DAY_NAMES.map((dayName, idx) => {
        const period = periods.find((p) => p.open.day === idx);
        if (!period)
          return {
            day: dayName,
            open: null as string | null,
            close: null as string | null,
            closed: true,
          };
        const openTime = formatTime(period.open.time);
        const closeTime = period.close ? formatTime(period.close.time) : null;
        return { day: dayName, open: openTime, close: closeTime, closed: false };
      });
    }

    // Build photo URLs
    const photos = (d.photos || []).slice(0, 10).map((p) => ({
      url: `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${p.width}&photo_reference=${p.photo_reference}&key=${apiKey}`,
      attribution: p.html_attributions?.[0] || '',
      width: p.width,
      height: p.height,
    }));

    // Build reviews
    const reviews = (d.reviews || []).slice(0, 5).map((r) => ({
      text: r.text,
      author: r.author_name,
      rating: r.rating,
      time: r.relative_time_description,
    }));

    return {
      place_id: placeId,
      name: d.name,
      formatted_address: d.formatted_address,
      phone: d.international_phone_number || d.formatted_phone_number || null,
      website: d.website || null,
      rating: d.rating ?? null,
      review_count: d.user_ratings_total ?? null,
      hours,
      geo: d.geometry?.location ?? null,
      maps_url: d.url ?? null,
      photos,
      types: d.types || [],
      price_level: d.price_level ?? null,
      reviews,
      business_status: d.business_status ?? null,
    };
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'google_places',
        message: 'Google Places lookup failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** Convert "0930" → "9:30 AM" */
function formatTime(time: string): string {
  const h = parseInt(time.substring(0, 2), 10);
  const m = time.substring(2);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m} ${period}`;
}
