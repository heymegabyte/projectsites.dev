/**
 * AL-845 — the #1 top-of-funnel journey (guest business search) must be OBSERVABLE when it runs
 * DEGRADED on the OSM/Nominatim fallback (Google Places unconfigured or erroring). These specs
 * assert the structured degradation events emit with the right shape AND — critically — that the
 * raw query text (PII) is NEVER logged (only `qlen`, the length).
 *
 * Uses the GLOBAL `jest` (no `@jest/globals` import) so @swc/jest hoists `jest.mock` above the
 * handler import (repo gotcha #12); the mock path needs FOUR `../` from libs/features/<slug>/
 * __tests__/ to reach src/ (gotcha #11).
 */
jest.mock('../../../../src/services/nominatim_search.js', () => ({
  searchBusinessesByName: jest.fn(),
}));

import { searchBusinessesByName } from '../../../../src/services/nominatim_search.js';
import { placesSearch } from '../handlers';

const mockOsm = searchBusinessesByName as unknown as jest.Mock;

/** No GOOGLE_PLACES_API_KEY → the handler takes the SEARCH_PROVIDER_NOT_CONFIGURED → OSM path. */
const ENV_NO_PLACES = {} as unknown as Parameters<typeof placesSearch.request>[2];

describe('places_search — guest-search degradation observability (AL-845)', () => {
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockOsm.mockReset();
  });
  afterEach(() => warnSpy.mockRestore());

  /** Parse every structured log line the scoped logger emitted this test. */
  const logs = (): Array<Record<string, unknown>> =>
    warnSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as Record<string, unknown>;
        } catch {
          return {};
        }
      })
      .filter((l) => String(l.scope ?? '').endsWith('places_search')); // scope is service-prefixed

  it('emits search_degraded_osm_fallback (recovered) when Places is unconfigured but OSM has results', async () => {
    mockOsm.mockResolvedValue([{ name: 'Blue Bottle', formatted_address: '1 A St', place_id: 'osm1' }]);
    const res = await placesSearch.request('/api/search/businesses?q=coffee%20shop', {}, ENV_NO_PLACES);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { _source?: string };
    expect(body._source).toBe('osm'); // the funnel recovered via OSM
    const evt = logs().find((l) => l.eventName === 'search_degraded_osm_fallback');
    expect(evt).toBeTruthy();
    expect(evt!.reason).toBe('SEARCH_PROVIDER_NOT_CONFIGURED');
    expect(evt!.provider).toBe('osm');
    expect(evt!.degraded).toBe(true);
    expect(evt!.ok).toBe(true);
    expect(evt!.count).toBe(1);
    expect(evt!.qlen).toBe('coffee shop'.length);
  });

  it('emits search_hard_degraded (ok:false, provider:none) when Places unconfigured AND OSM empty', async () => {
    mockOsm.mockResolvedValue([]);
    const res = await placesSearch.request('/api/search/businesses?q=zzqqxx', {}, ENV_NO_PLACES);
    const body = (await res.json()) as { _error?: { code?: string } };
    expect(body._error?.code).toBe('SEARCH_PROVIDER_NOT_CONFIGURED'); // honest degraded code
    const evt = logs().find((l) => l.eventName === 'search_hard_degraded');
    expect(evt).toBeTruthy();
    expect(evt!.provider).toBe('none');
    expect(evt!.ok).toBe(false);
    expect(evt!.qlen).toBe('zzqqxx'.length);
  });

  it('NEVER logs the raw query text (PII) — only the length via qlen', async () => {
    mockOsm.mockResolvedValue([]);
    await placesSearch.request('/api/search/businesses?q=SecretPersonName', {}, ENV_NO_PLACES);
    const joined = JSON.stringify(logs());
    expect(joined).not.toContain('SecretPersonName');
    expect(logs().some((l) => typeof l.qlen === 'number' && l.qlen === 'SecretPersonName'.length)).toBe(true);
  });
});
