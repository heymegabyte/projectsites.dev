/**
 * @module libs/features/places_search/handlers
 *
 * @description
 * Public Google Places search endpoints the homepage SPA uses on screen 1: a
 * business text-search (with KV cache + honest-empty degradation) and an address
 * autocomplete (with a Text-Search fallback). Both proxy the Google Places API
 * using the worker's `GOOGLE_PLACES_API_KEY`; neither touches D1. When the
 * provider is unconfigured or down, both return `200 { data: [], _error }` (a
 * stable code, never a misleading empty) so the create flow degrades to manual
 * entry instead of surfacing a 5xx.
 *
 * | Method | Path                  | Auth   | Purpose                                             |
 * | ------ | --------------------- | ------ | --------------------------------------------------- |
 * | GET    | /api/search/businesses| public | Google Places text search (KV-cached, ≤10 results)  |
 * | GET    | /api/search/address   | public | Places autocomplete → Text-Search fallback          |
 *
 * Extracted VERBATIM from the `search.ts` monolith (route-decomposition
 * installment 25) — only the route-registration receiver changed (`search.` →
 * `placesSearch.`). The `GooglePlace`/`GooglePlacesResponse` +
 * `AutocompleteSuggestion`/`AutocompleteResponse` interfaces (exclusive to these
 * two routes) moved here; `badRequest` (still used by other search.ts routes) is
 * re-imported. No `onError` — the `badRequest` throw bubbles to the app-level
 * error handler exactly as before.
 *
 * @packageDocumentation
 */

import { Hono } from 'hono';
import { badRequest } from '@project-sites/shared';
import type { Env, Variables } from '../../../src/types/env.js';
import { searchBusinessesByName } from '../../../src/services/nominatim_search.js';

type AppContext = { Bindings: Env; Variables: Variables };

export const placesSearch = new Hono<AppContext>();

// ─── Google Places Search ───────────────────────────────────

interface GooglePlace {
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  types?: string[];
  location?: { latitude: number; longitude: number };
  nationalPhoneNumber?: string;
  websiteUri?: string;
}

interface GooglePlacesResponse {
  places?: GooglePlace[];
}

placesSearch.get('/api/search/businesses', async (c) => {
  const q = c.req.query('q');

  if (!q || q.trim().length === 0) {
    throw badRequest('Missing required query parameter: q');
  }

  // Bound query length to prevent abuse.
  const boundedQ = q.trim().slice(0, 200);

  // Optional location bias from browser geolocation — parsed ONCE and reused by both the
  // Places request AND the OSM/Nominatim fallback viewbox.
  const latStr = c.req.query('lat');
  const lngStr = c.req.query('lng');
  const geoLat = latStr ? parseFloat(latStr) : Number.NaN;
  const geoLng = lngStr ? parseFloat(lngStr) : Number.NaN;
  const hasGeo = !Number.isNaN(geoLat) && !Number.isNaN(geoLng);
  const osmOpts = hasGeo ? { lat: geoLat, lng: geoLng } : undefined;

  // Cache successful business-search results in KV to spare the daily quota (and, now, the
  // Nominatim ≤1 req/sec policy). Popular/repeat queries re-hit the same text search on every
  // 300ms keystroke-debounce otherwise. Only successful non-empty results are cached (errors/
  // empties stay live so recovery + new listings surface immediately). 6h TTL — listings stable.
  // `v2` namespace bump (2026-09-19): the OSM mapper now strips the duplicate leading business name +
  // joins the house number (nominatim_search.cleanNominatimAddress). Bump so cached PRE-FIX entries
  // (6h TTL, carrying the "Name, Name, 123 St" duplicate) are ignored and the clean address takes
  // effect immediately on deploy instead of persisting for up to 6h.
  const cacheKey = `bizsearch:v2:${boundedQ.toLowerCase()}:${latStr ?? ''}:${lngStr ?? ''}`;

  // OSM/Nominatim fallback (AL-729): when Google Places is unconfigured or down, try OSM's
  // free-text NAME search BEFORE surfacing the honest `_error`. Places is persistently 429/403
  // (GCP billing not enabled), so without this the guest-acquisition funnel's PRIMARY action
  // dead-ends for every visitor ("Business lookup is temporarily unavailable"). Real OSM hits
  // are KV-cached (6h) like Places so keystroke-debounced repeats never re-hit Nominatim.
  const osmFallbackOr = async (code: string, status: number, message: string) => {
    const osm = await searchBusinessesByName(boundedQ, osmOpts);
    if (osm.length > 0) {
      // Cache WITH `_source` so a cache HIT reports the provider too (a bare `{data}` cache made
      // the funnel's provider unobservable — the probe defaulted to 'places' even for OSM hits).
      await c.env.CACHE_KV?.put(cacheKey, JSON.stringify({ data: osm, _source: 'osm' }), {
        expirationTtl: 21600,
      }).catch(() => {});
      return c.json({ data: osm, _source: 'osm' });
    }
    return c.json({ data: [], _error: { code, status, message } });
  };

  // If the Places provider isn't configured, try OSM, else surface the stable code (calling
  // Google with an empty key 403s and reads to the UI as a misleading "no businesses found").
  if (!c.env.GOOGLE_PLACES_API_KEY) {
    return osmFallbackOr('SEARCH_PROVIDER_NOT_CONFIGURED', 0, 'Business search is not configured');
  }

  const requestBody: Record<string, unknown> = { textQuery: boundedQ };
  if (hasGeo) {
    requestBody.locationBias = {
      circle: { center: { latitude: geoLat, longitude: geoLng }, radius: 50000.0 }, // 50 km
    };
  }

  const cachedRaw = await c.env.CACHE_KV?.get(cacheKey).catch(() => null);
  if (cachedRaw) {
    return c.json(JSON.parse(cachedRaw) as { data: unknown[] });
  }

  const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': c.env.GOOGLE_PLACES_API_KEY,
      'X-Goog-FieldMask':
        'places.displayName,places.formattedAddress,places.id,places.types,places.location,places.nationalPhoneNumber,places.websiteUri',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'search',
        message: 'Google Places API error',
        status: response.status,
        body: errorText.slice(0, 500),
        query: q,
      }),
    );
    // Places is down (429/403/5xx) — try OSM/Nominatim before surfacing the honest
    // `_error`. Keep 200 either way (a 5xx would fire the frontend's rethrowing error
    // handler → console noise); the fallback returns real OSM results when it can, else a
    // STABLE code the caller shows as "search temporarily unavailable" (never a misleading
    // "no businesses found"). The RAW upstream body (GCP billing state, console URLs,
    // PERMISSION_DENIED payloads) is logged SERVER-SIDE above — never leaked to the client.
    return osmFallbackOr(
      'SEARCH_PROVIDER_UNAVAILABLE',
      response.status,
      'Business search is temporarily unavailable',
    );
  }

  const json = (await response.json()) as GooglePlacesResponse;
  const places = (json.places ?? []).slice(0, 10);

  const data = places.map((place) => ({
    place_id: place.id,
    name: place.displayName?.text ?? '',
    address: place.formattedAddress ?? '',
    types: place.types ?? [],
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    phone: place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
  }));

  // Only cache real hits — never an empty/error so recovery + new listings surface live.
  // Stamp `_source: 'places'` (cache + response) so the funnel's provider is always observable.
  if (data.length > 0) {
    await c.env.CACHE_KV?.put(cacheKey, JSON.stringify({ data, _source: 'places' }), {
      expirationTtl: 21600,
    }).catch(() => {});
  }

  return c.json({ data, _source: 'places' });
});

// ─── Google Places Address Autocomplete ──────────────────────

interface AutocompleteSuggestion {
  placePrediction?: {
    placeId: string;
    text?: { text: string };
    structuredFormat?: {
      mainText?: { text: string };
      secondaryText?: { text: string };
    };
  };
}

interface AutocompleteResponse {
  suggestions?: AutocompleteSuggestion[];
}

placesSearch.get('/api/search/address', async (c) => {
  const q = c.req.query('q');

  if (!q || q.trim().length < 2) {
    return c.json({ data: [] });
  }

  const lat = c.req.query('lat');
  const lng = c.req.query('lng');
  let locationBias: Record<string, unknown> | undefined;
  if (lat && lng) {
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    if (!isNaN(latitude) && !isNaN(longitude)) {
      locationBias = {
        circle: {
          center: { latitude, longitude },
          radius: 50000.0,
        },
      };
    }
  }

  const autocompleteBody: Record<string, unknown> = { input: q };
  if (locationBias) {
    autocompleteBody.locationBias = locationBias;
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': c.env.GOOGLE_PLACES_API_KEY,
      },
      body: JSON.stringify(autocompleteBody),
    });

    if (response.ok) {
      const json = (await response.json()) as AutocompleteResponse;
      const suggestions = (json.suggestions ?? []).slice(0, 8);
      // Type-predicate filter narrows `placePrediction` to non-optional so the map body
      // needs no non-null `!` appeasement; then drop any prediction missing a placeId —
      // a suggestion the client can't resolve is a dead row (embarrassingly-easy-to-use).
      type ResolvedPrediction = AutocompleteSuggestion & {
        placePrediction: NonNullable<AutocompleteSuggestion['placePrediction']>;
      };
      const data = suggestions
        .filter((s): s is ResolvedPrediction => Boolean(s.placePrediction?.placeId))
        .map((s) => ({
          place_id: s.placePrediction.placeId,
          description: s.placePrediction.text?.text ?? '',
          main_text: s.placePrediction.structuredFormat?.mainText?.text ?? '',
          secondary_text: s.placePrediction.structuredFormat?.secondaryText?.text ?? '',
        }));

      if (data.length > 0) {
        return c.json({ data });
      }
    } else {
      const errorText = await response.text().catch(() => '');
      console.warn(
        JSON.stringify({
          level: 'warn',
          service: 'search',
          message: 'Places Autocomplete API failed, falling back to Text Search',
          status: response.status,
          body: errorText.slice(0, 500),
          query: q,
        }),
      );
    }
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'search',
        message: 'Places Autocomplete API exception, falling back to Text Search',
        error: String(err),
        query: q,
      }),
    );
  }

  // Fallback: Text Search API (same API that powers business search).
  const textSearchBody: Record<string, unknown> = { textQuery: q };
  if (locationBias) {
    textSearchBody.locationBias = locationBias;
  }

  try {
    const fallbackResponse = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': c.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.id',
      },
      body: JSON.stringify(textSearchBody),
    });

    if (!fallbackResponse.ok) {
      const errorText = await fallbackResponse.text().catch(() => '');
      console.warn(
        JSON.stringify({
          level: 'error',
          service: 'search',
          message: 'Address search — Autocomplete AND Text Search fallback both failed',
          status: fallbackResponse.status,
          body: errorText.slice(0, 500),
          query: q,
        }),
      );
      // Provider is down on BOTH paths → carry the honest `_error` (parity with
      // business search) so the caller shows "address lookup unavailable" instead of
      // a silent empty dropdown that reads as "no such address". NOTE: a genuine
      // 0-match (both APIs returned 200 with no results) still falls through to the
      // no-`_error` empty return below — honest-empty is preserved.
      return c.json({
        data: [],
        _error: {
          code: 'SEARCH_PROVIDER_UNAVAILABLE',
          status: fallbackResponse.status,
          // Generic + user-safe; the raw upstream body is logged server-side above.
          message: 'Address lookup is temporarily unavailable',
        },
      });
    }

    const fallbackJson = (await fallbackResponse.json()) as GooglePlacesResponse;
    const places = (fallbackJson.places ?? []).slice(0, 8);
    const data = places.map((place) => ({
      place_id: place.id ?? '',
      description: place.formattedAddress ?? '',
      main_text: place.displayName?.text ?? '',
      secondary_text: place.formattedAddress ?? '',
    }));

    return c.json({ data });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'error',
        service: 'search',
        message: 'Address search — Text Search fallback threw',
        error: String(err),
        query: q,
      }),
    );
    // Fetch threw (network/DNS/timeout) on the last path → honest `_error`, not a
    // silent empty (parity with the `!fallbackResponse.ok` branch above).
    return c.json({
      data: [],
      _error: {
        code: 'SEARCH_PROVIDER_UNAVAILABLE',
        status: 502,
        // Generic + user-safe; the thrown error is logged server-side above.
        message: 'Address lookup is temporarily unavailable',
      },
    });
  }
});
