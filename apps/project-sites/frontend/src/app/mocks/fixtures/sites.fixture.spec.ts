import { sitesFixture, siteDetailFixture, type SitesListResponse } from './sites.fixture';
import { toRegistryKey, FIXTURES } from './index';

/**
 * sites.fixture — the mock body for GET /api/sites (the roster AdminStateService loads
 * to light up the shell + dashboard + sites-list surfaces).
 * Contract: matches the worker `{ data: Site[] }` envelope EXACTLY (so the real endpoint
 * is a drop-in swap); believable multi-site roster spanning every status the status
 * machine + the UI's status-class/label maps handle; state variants empty (0 sites) /
 * populated (full roster). The interceptor owns loading + the error short-circuit.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('sitesFixture (worker-contract-shaped GET /sites, state variants)', () => {
  it('returns the worker envelope shape { data: Site[] }', () => {
    const res: SitesListResponse = sitesFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
  });

  it('every row satisfies the Site contract (required id/slug/business_name/status/timestamps)', () => {
    const { data } = sitesFixture('populated', q());
    for (const s of data) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.slug).toBe('string');
      expect(typeof s.business_name).toBe('string');
      expect(typeof s.status).toBe('string');
      expect(typeof s.created_at).toBe('string');
      expect(typeof s.updated_at).toBe('string');
      // ISO timestamps (the UI formats them) — must parse.
      expect(Number.isNaN(Date.parse(s.created_at))).toBe(false);
      expect(Number.isNaN(Date.parse(s.updated_at))).toBe(false);
    }
  });

  it('spans the status machine so every status-class/label + building-pulse branch renders', () => {
    const statuses = new Set(sitesFixture('populated', q()).data.map((s) => s.status));
    // published (Live), a building-class status, error, and draft — the four
    // getStatusClass buckets the dashboard + sites grid color/animate against.
    expect(statuses.has('published')).toBe(true);
    expect(statuses.has('error')).toBe(true);
    expect(statuses.has('draft')).toBe(true);
    // at least one in-flight status (building/generating/collecting/queued/uploading)
    const building = ['building', 'generating', 'collecting', 'queued', 'uploading'];
    expect([...statuses].some((s) => building.includes(s))).toBe(true);
  });

  it('includes a paid site WITH a primary_hostname and a free site WITHOUT one', () => {
    const { data } = sitesFixture('populated', q());
    expect(data.some((s) => s.plan === 'paid' && !!s.primary_hostname)).toBe(true);
    expect(data.some((s) => (s.plan ?? 'free') !== 'paid' && !s.primary_hostname)).toBe(true);
  });

  it('empty state → an empty roster (real empty variant, never a trimmed slice)', () => {
    const res = sitesFixture('empty', q());
    expect(res.data).toEqual([]);
  });

  it('normalizes to the registry key GET /sites (the orchestrator wires index.ts)', () => {
    // index.ts is merged by the orchestrator later, so assert only that the pure
    // normalizer yields the key this fixture must be registered under — no registry dep.
    expect(toRegistryKey('GET', '/api/sites').key).toBe('GET /sites');
    expect(toRegistryKey('GET', '/api/sites?x=1').key).toBe('GET /sites');
  });
});

describe('siteDetailFixture (GET /sites/:id — single-site detail; closes the silent getSite() 404)', () => {
  it('returns the worker envelope { data: Site } for the canonical selected site', () => {
    const res = siteDetailFixture('populated', q());
    expect(typeof res.data.id).toBe('string');
    expect(typeof res.data.slug).toBe('string');
    expect(typeof res.data.business_name).toBe('string');
  });

  it('is wired into the STATIC registry under the :param key GET /sites/:id', () => {
    // Assert the static FIXTURES map (deterministic; never findFixture — per the #35 flake fix).
    expect(typeof (FIXTURES as Record<string, unknown>)['GET /sites/:id']).toBe('function');
  });

  it('a per-site detail path normalizes to a 2-seg key (distinct from /sites + /sites/:id/*)', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001').key).toBe('GET /sites/site-001');
  });
});
