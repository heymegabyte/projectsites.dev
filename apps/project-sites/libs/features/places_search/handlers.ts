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

  // Honest-empty: if the Places provider isn't configured, say so with a stable
  // code instead of silently calling Google with an empty key (which 403s and
  // reads to the UI as "no businesses found"). The create flow still works via
  // manual entry — the caller can surface "search unavailable, enter manually".
  if (!c.env.GOOGLE_PLACES_API_KEY) {
    return c.json({
      data: [],
      _error: {
        code: 'SEARCH_PROVIDER_NOT_CONFIGURED',
        status: 0,
        message: 'Business search is not configured',
      },
    });
  }

  const requestBody: Record<string, unknown> = { textQuery: boundedQ };

  // Optional location bias from browser geolocation.
  const lat = c.req.query('lat');
  const lng = c.req.query('lng');
  if (lat && lng) {
    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);
    if (!isNaN(latitude) && !isNaN(longitude)) {
      requestBody.locationBias = {
        circle: {
          center: { latitude, longitude },
          radius: 50000.0, // 50 km radius
        },
      };
    }
  }

  // Cache successful business-search results in KV to spare the Google Places daily
  // SearchTextRequest quota. Popular/repeat queries ("pizza chicago") re-hit the same
  // text search on every 300ms keystroke-debounce otherwise, and exhausting the daily
  // cap degrades the whole business-lookup funnel (it falls back to manual entry, but
  // live search is gone). Only successful non-empty results are cached (errors/empties
  // stay live so recovery + new listings surface immediately). 6h TTL — listings are stable.
  const cacheKey = `bizsearch:${boundedQ.toLowerCase()}:${lat ?? ''}:${lng ?? ''}`;
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
    // Honest-empty: keep 200 (the create flow degrades to manual entry + a 5xx
    // would fire the frontend's rethrowing error handler → console noise), but
    // carry a STABLE code so the failure is diagnosable and the caller can show
    // "search temporarily unavailable" instead of a misleading "no businesses found".
    return c.json({
      data: [],
      _error: {
        code: 'SEARCH_PROVIDER_UNAVAILABLE',
        status: response.status,
        // Generic, stable, user-safe. The RAW upstream body (GCP billing state,
        // console URLs, PERMISSION_DENIED payloads) is logged SERVER-SIDE above —
        // never leaked to the client (info-disclosure hardening).
        message: 'Business search is temporarily unavailable',
      },
    });
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
  if (data.length > 0) {
    await c.env.CACHE_KV?.put(cacheKey, JSON.stringify({ data }), { expirationTtl: 21600 }).catch(
      () => {},
    );
  }

  return c.json({ data });
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
