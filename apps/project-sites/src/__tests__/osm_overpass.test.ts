/**
 * Unit tests for the OSM Overpass lead-discovery provider.
 * Pure helpers tested directly; the thin fetch tested with a stub.
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  buildOverpassQuery,
  tagsHaveWebsite,
  osmElementToBusiness,
  fetchOverpassElements,
  discoverSitelessFromOsm,
} from '../services/osm_overpass.js';

describe('osm_overpass — tagsHaveWebsite', () => {
  it('detects website / contact:website / url tags', () => {
    expect(tagsHaveWebsite({ website: 'http://x.com' })).toBe(true);
    expect(tagsHaveWebsite({ 'contact:website': 'x.com' })).toBe(true);
    expect(tagsHaveWebsite({ url: 'x.com' })).toBe(true);
  });
  it('false for no website / blank / undefined', () => {
    expect(tagsHaveWebsite({ name: 'Joe' })).toBe(false);
    expect(tagsHaveWebsite({ website: '   ' })).toBe(false);
    expect(tagsHaveWebsite(undefined)).toBe(false);
  });
});

describe('osm_overpass — buildOverpassQuery', () => {
  it('includes the bbox, json output, and the no-website filters', () => {
    const q = buildOverpassQuery({ bbox: [40.0, -74.3, 40.1, -74.2], categories: ['shop'] });
    expect(q).toContain('[out:json]');
    expect(q).toContain('40,-74.3,40.1,-74.2');
    expect(q).toContain('["shop"]');
    expect(q).toContain('[!"website"]');
    expect(q).toContain('out center tags');
  });
  it('falls back to default category keys', () => {
    const q = buildOverpassQuery({ bbox: [0, 0, 1, 1] });
    expect(q).toContain('["amenity"]');
    expect(q).toContain('["craft"]');
  });
});

describe('osm_overpass — osmElementToBusiness', () => {
  it('maps a siteless named node to a business', () => {
    const biz = osmElementToBusiness({
      type: 'node',
      id: 42,
      tags: {
        name: "Joe's Plumbing",
        phone: '+12015551234',
        shop: 'hardware',
        'addr:housenumber': '12',
        'addr:street': 'Main St',
        'addr:city': 'Newark',
        'contact:facebook': 'joesplumbing',
      },
    });
    expect(biz?.businessName).toBe("Joe's Plumbing");
    expect(biz?.phone).toBe('+12015551234');
    expect(biz?.category).toBe('hardware');
    expect(biz?.address).toBe('12 Main St, Newark');
    expect(biz?.externalId).toBe('osm:node/42');
    expect(biz?.socials).toEqual({ facebook: 'https://facebook.com/joesplumbing' });
  });
  it('skips elements with a website (not a lead)', () => {
    expect(
      osmElementToBusiness({ type: 'node', id: 1, tags: { name: 'X', website: 'http://x.com' } }),
    ).toBeNull();
  });
  it('skips elements with no name', () => {
    expect(osmElementToBusiness({ type: 'node', id: 1, tags: { shop: 'bakery' } })).toBeNull();
  });
  it('AL-820: skips a named transit / infrastructure POI (bus stop, parking, bench) — not a business lead', () => {
    // A named bus stop ("Berkeley Bowl") is not a lead — surfacing it mis-categorized the real grocery.
    for (const tags of [
      { name: 'Berkeley Bowl', highway: 'bus_stop' },
      { name: 'Downtown Transit Center', amenity: 'bus_station' },
      { name: 'Main St Lot', amenity: 'parking' },
      { name: 'Bench', amenity: 'bench' },
      { name: 'Platform 2', public_transport: 'platform' },
      { name: 'Union Station', railway: 'station' },
      { name: 'Bike Racks', amenity: 'bicycle_parking' },
    ]) {
      expect(osmElementToBusiness({ type: 'node', id: 9, tags })).toBeNull();
    }
    // REGRESSION GUARD: a real business with a shop/craft/office signal is NEVER skipped, even if it
    // ALSO carries an amenity/transit-adjacent tag; and business amenities (cafe/restaurant) stay leads.
    expect(osmElementToBusiness({ type: 'node', id: 10, tags: { name: 'Corner Store', shop: 'convenience', amenity: 'parking' } })?.businessName).toBe('Corner Store');
    expect(osmElementToBusiness({ type: 'node', id: 11, tags: { name: 'The Grind', amenity: 'cafe' } })?.category).toBe('cafe');
  });
});

describe('osm_overpass — fetch + discover', () => {
  it('fetchOverpassElements returns [] on HTTP error (never throws)', async () => {
    const stub = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 504, json: () => Promise.resolve({}) });
    expect(await fetchOverpassElements('q', stub as unknown as typeof fetch)).toEqual([]);
  });
  it('fetchOverpassElements returns [] on network throw', async () => {
    const stub = jest.fn().mockRejectedValue(new Error('boom'));
    expect(await fetchOverpassElements('q', stub as unknown as typeof fetch)).toEqual([]);
  });
  it('discoverSitelessFromOsm maps + dedupes siteless businesses', async () => {
    const stub = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          elements: [
            { type: 'node', id: 1, tags: { name: 'A', shop: 'cafe' } },
            { type: 'node', id: 1, tags: { name: 'A', shop: 'cafe' } }, // dup id
            { type: 'node', id: 2, tags: { name: 'B', website: 'http://b.com' } }, // has site
            { type: 'node', id: 3, tags: { shop: 'x' } }, // no name
          ],
        }),
    });
    const out = await discoverSitelessFromOsm(
      { bbox: [0, 0, 1, 1] },
      stub as unknown as typeof fetch,
    );
    expect(out).toHaveLength(1);
    expect(out[0].businessName).toBe('A');
  });
});
