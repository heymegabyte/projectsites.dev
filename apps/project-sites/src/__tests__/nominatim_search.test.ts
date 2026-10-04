/**
 * Unit tests for the OSM Nominatim public-search fallback (AL-729).
 * Pure mapper tested directly; the thin fetch tested with an injected stub.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  mapNominatimResult,
  cleanNominatimAddress,
  searchBusinessesByName,
  buildNominatimQueryVariants,
  mapCategorySynonyms,
  type NominatimResult,
} from '../services/nominatim_search.js';

const BLUE_BOTTLE: NominatimResult = {
  osm_type: 'node',
  osm_id: 240109189,
  lat: '37.7764',
  lon: '-122.4231',
  name: 'Blue Bottle Coffee',
  display_name: 'Blue Bottle Coffee, 66, Mint Street, SoMa, San Francisco, CA, 94103, USA',
  class: 'amenity',
  type: 'cafe',
  extratags: { website: 'https://bluebottlecoffee.com', phone: '+1-510-653-3394' },
};

describe('nominatim_search — mapNominatimResult', () => {
  it('maps a named cafe result to the public business shape', () => {
    const b = mapNominatimResult(BLUE_BOTTLE);
    expect(b).not.toBeNull();
    expect(b?.place_id).toBe('osm:n240109189'); // osm: + type-char + id
    expect(b?.name).toBe('Blue Bottle Coffee');
    expect(b?.types).toEqual(['cafe']);
    expect(b?.lat).toBeCloseTo(37.7764, 3);
    expect(b?.lng).toBeCloseTo(-122.4231, 3);
    expect(b?.website).toBe('https://bluebottlecoffee.com');
    expect(b?.phone).toBe('+1-510-653-3394');
    expect(b?.address).toContain('San Francisco');
    // The subtitle must NOT repeat the bold title (the #1-acquisition-surface glitch) — and the
    // house number joins its street so the address reads naturally + downstream streetAddress is right.
    expect(b?.address.toLowerCase().startsWith('blue bottle')).toBe(false);
    expect(b?.address).toBe('66 Mint Street, SoMa, San Francisco, CA, 94103, USA');
  });

  it('derives place_id char from osm_type (way → w, relation → r)', () => {
    expect(mapNominatimResult({ ...BLUE_BOTTLE, osm_type: 'way', osm_id: 5 })?.place_id).toBe(
      'osm:w5',
    );
    expect(mapNominatimResult({ ...BLUE_BOTTLE, osm_type: 'relation', osm_id: 9 })?.place_id).toBe(
      'osm:r9',
    );
  });

  it('falls back to the first display_name segment when name is absent', () => {
    const b = mapNominatimResult({ ...BLUE_BOTTLE, name: undefined });
    expect(b?.name).toBe('Blue Bottle Coffee');
  });

  it('reads phone/website from contact:* extratags when the bare keys are absent', () => {
    const b = mapNominatimResult({
      ...BLUE_BOTTLE,
      extratags: { 'contact:phone': '+1-212-555-0100', 'contact:website': 'https://x.example' },
    });
    expect(b?.phone).toBe('+1-212-555-0100');
    expect(b?.website).toBe('https://x.example');
  });

  it('returns null for a result with no usable name (pure address hit)', () => {
    expect(mapNominatimResult({ osm_type: 'node', osm_id: 1, display_name: '' })).toBeNull();
    expect(mapNominatimResult({ osm_type: 'node', osm_id: 1 })).toBeNull();
  });

  it('nulls lat/lng when the coordinates are missing or unparseable', () => {
    const b = mapNominatimResult({ ...BLUE_BOTTLE, lat: undefined, lon: 'x' });
    expect(b?.lat).toBeNull();
    expect(b?.lng).toBeNull();
  });
});

describe('nominatim_search — cleanNominatimAddress (no duplicate leading name)', () => {
  it('drops the leading business name Nominatim prepends + joins the house number to its street', () => {
    expect(
      cleanNominatimAddress(
        'Blue Bottle Coffee, 66, Mint Street, SoMa, San Francisco, CA, 94103, USA',
        'Blue Bottle Coffee',
      ),
    ).toBe('66 Mint Street, SoMa, San Francisco, CA, 94103, USA');
  });

  it('is case-insensitive on the name prefix', () => {
    expect(cleanNominatimAddress('MOE’S TAVERN, 12, Main St, Springfield', 'MOE’s Tavern')).toBe(
      '12 Main St, Springfield',
    );
  });

  it('leaves the address untouched when it does not start with the name', () => {
    expect(cleanNominatimAddress('742 Evergreen Terrace, Springfield', 'Krusty Burger')).toBe(
      '742 Evergreen Terrace, Springfield',
    );
  });

  it('keeps the full string if stripping the name would empty it', () => {
    expect(cleanNominatimAddress('Blue Bottle Coffee', 'Blue Bottle Coffee')).toBe(
      'Blue Bottle Coffee',
    );
  });

  it('handles empty inputs safely', () => {
    expect(cleanNominatimAddress('', 'X')).toBe('');
    expect(cleanNominatimAddress('123, Elm St', '')).toBe('123 Elm St');
  });
});

describe('nominatim_search — searchBusinessesByName', () => {
  it('returns [] on an empty/whitespace query without fetching', async () => {
    const stub = jest.fn();
    expect(
      await searchBusinessesByName('   ', { fetchImpl: stub as unknown as typeof fetch }),
    ).toEqual([]);
    expect(stub).not.toHaveBeenCalled();
  });

  it('returns [] on HTTP error (never throws)', async () => {
    const stub = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve([]) });
    expect(
      await searchBusinessesByName('Blue Bottle', { fetchImpl: stub as unknown as typeof fetch }),
    ).toEqual([]);
  });

  it('returns [] on a network throw (fail-soft)', async () => {
    const stub = jest.fn().mockRejectedValue(new Error('boom'));
    expect(
      await searchBusinessesByName('Blue Bottle', { fetchImpl: stub as unknown as typeof fetch }),
    ).toEqual([]);
  });

  it('returns [] when the body is not an array', async () => {
    const stub = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ error: 'nope' }) });
    expect(
      await searchBusinessesByName('Blue Bottle', { fetchImpl: stub as unknown as typeof fetch }),
    ).toEqual([]);
  });

  it('maps results, skips nameless, and sends the descriptive UA', async () => {
    const stub = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve([
          BLUE_BOTTLE,
          { osm_type: 'node', osm_id: 2, display_name: '' }, // no name → skipped
        ]),
    });
    const out = await searchBusinessesByName('Blue Bottle Coffee San Francisco', {
      fetchImpl: stub as unknown as typeof fetch,
    });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Blue Bottle Coffee');
    const [url, opts] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('nominatim.openstreetmap.org/search');
    expect(url).toContain('format=jsonv2');
    expect((opts.headers as Record<string, string>)['User-Agent']).toContain('ProjectSites.dev');
  });

  it('adds a viewbox bias when geolocation is provided', async () => {
    const stub = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([BLUE_BOTTLE]) });
    await searchBusinessesByName('cafe', {
      lat: 37.77,
      lng: -122.42,
      fetchImpl: stub as unknown as typeof fetch,
    });
    const [url] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('viewbox=');
  });

  // ── Category-query fallback (Google-Maps/Places repair 2026-10-03) ───────────────
  // The #1 acquisition action sends a CATEGORY phrase ("coffee shop newark nj"); Nominatim's
  // geocoder returns 0 for that but resolves the "… in …" special-phrase rewrite. The fallback
  // engaged but returned [] before this fix, so the funnel dead-ended with Places billing-dead.
  it('retries the colloquial→dictionary "… in …" rewrite when the literal category query returns nothing', async () => {
    const stub = jest.fn();
    // 1st call (literal "coffee shop newark nj") → empty array (Nominatim category miss).
    stub.mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) });
    // 2nd call (mapped+rewritten "cafe in newark nj") → a real cafe.
    stub.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve([BLUE_BOTTLE]),
    });
    const out = await searchBusinessesByName('coffee shop newark nj', {
      fetchImpl: stub as unknown as typeof fetch,
    });
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('Blue Bottle Coffee');
    // Exactly two requests: literal first, mapped rewrite second.
    expect(stub).toHaveBeenCalledTimes(2);
    // URLSearchParams encodes spaces as '+' — assert on the raw (encoded) query.
    const firstUrl = (stub.mock.calls[0] as [string])[0];
    const secondUrl = (stub.mock.calls[1] as [string])[0];
    expect(firstUrl).toContain('q=coffee+shop+newark+nj');
    // "coffee shop" → Nominatim dictionary word "cafe", with the "… in …" connector.
    expect(secondUrl).toContain('q=cafe+in+newark+nj');
  });

  it('does NOT make a 2nd request when the literal query already has hits (name search)', async () => {
    const stub = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([BLUE_BOTTLE]) });
    const out = await searchBusinessesByName('Blue Bottle Coffee Newark', {
      fetchImpl: stub as unknown as typeof fetch,
    });
    expect(out).toHaveLength(1);
    expect(stub).toHaveBeenCalledTimes(1); // literal hit → no rewrite retry
  });

  it('returns [] (and caps at 2 requests) when BOTH the literal and the rewrite miss', async () => {
    const stub = jest
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve([]) });
    const out = await searchBusinessesByName('nonexistent widget shop zzz nj', {
      fetchImpl: stub as unknown as typeof fetch,
    });
    expect(out).toEqual([]);
    expect(stub).toHaveBeenCalledTimes(2); // literal + rewrite, then give up
  });
});

describe('nominatim_search — mapCategorySynonyms', () => {
  it('maps "coffee shop" → the Nominatim dictionary word "cafe"', () => {
    expect(mapCategorySynonyms('coffee shop newark nj')).toBe('cafe newark nj');
    expect(mapCategorySynonyms('coffee shop')).toBe('cafe');
  });

  it('maps barber/salon colloquialisms to Nominatim words', () => {
    expect(mapCategorySynonyms('barber shop')).toBe('hairdresser');
    expect(mapCategorySynonyms('nail salon')).toBe('beauty');
    expect(mapCategorySynonyms('gym')).toBe('fitness centre');
    expect(mapCategorySynonyms('auto repair')).toBe('car repair');
  });

  it('returns the query unchanged when no colloquial category matches', () => {
    expect(mapCategorySynonyms('cafe newark nj')).toBe('cafe newark nj');
    expect(mapCategorySynonyms('Blue Bottle Coffee')).toBe('Blue Bottle Coffee');
  });
});

describe('nominatim_search — buildNominatimQueryVariants', () => {
  it('returns [] for an empty/whitespace query', () => {
    expect(buildNominatimQueryVariants('')).toEqual([]);
    expect(buildNominatimQueryVariants('   ')).toEqual([]);
  });

  it('adds a colloquial→dictionary "… in …" variant, splitting a 2-token US-state tail', () => {
    // "coffee shop" maps to Nominatim's "cafe"; state tail "nj" splits as the place.
    expect(buildNominatimQueryVariants('coffee shop newark nj')).toEqual([
      'coffee shop newark nj',
      'cafe in newark nj',
    ]);
  });

  it('splits a single trailing location token when the tail is not a state abbreviation', () => {
    // 3 tokens, last token is not a 2-letter state → split off the single trailing location word.
    expect(buildNominatimQueryVariants('plumbers downtown austin')).toEqual([
      'plumbers downtown austin',
      'plumbers downtown in austin',
    ]);
  });

  it('maps the colloquial category even when the query already has a connector', () => {
    expect(buildNominatimQueryVariants('coffee shop in newark')).toEqual([
      'coffee shop in newark',
      'cafe in newark',
    ]);
  });

  it('does NOT add a duplicate when a connector query has no mappable colloquialism', () => {
    expect(buildNominatimQueryVariants('Blue Bottle Coffee in San Francisco')).toEqual([
      'Blue Bottle Coffee in San Francisco',
    ]);
    expect(buildNominatimQueryVariants('cafe near me')).toEqual(['cafe near me']);
  });

  it('does NOT rewrite a 1–2 token query (nothing to split into category + place)', () => {
    expect(buildNominatimQueryVariants('cafe')).toEqual(['cafe']);
    expect(buildNominatimQueryVariants('Blue Bottle')).toEqual(['Blue Bottle']);
  });

  it('collapses internal whitespace before building variants', () => {
    expect(buildNominatimQueryVariants('  coffee   shop   newark  nj ')).toEqual([
      'coffee shop newark nj',
      'cafe in newark nj',
    ]);
  });
});
