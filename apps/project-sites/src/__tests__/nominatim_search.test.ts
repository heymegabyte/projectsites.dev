/**
 * Unit tests for the OSM Nominatim public-search fallback (AL-729).
 * Pure mapper tested directly; the thin fetch tested with an injected stub.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  mapNominatimResult,
  cleanNominatimAddress,
  searchBusinessesByName,
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
});
