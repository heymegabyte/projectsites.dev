import { leadsFixture, type LeadsListResponse } from './leads.fixture';
import { toRegistryKey, findFixture } from './index';

/**
 * leads.fixture — the mock body for GET /api/admin/leads.
 * Contract: matches the worker `{ leads, count, total }` envelope; 50+ believable
 * rows (exercise #26 Load more); honors offset/limit like the worker's listLeads
 * (right slice + true total); state variants empty (0) / populated (full).
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('leadsFixture (worker-contract-shaped, paginated, state variants)', () => {
  it('returns the worker envelope shape { leads, count, total }', () => {
    const res: LeadsListResponse = leadsFixture('populated', q());
    expect(Array.isArray(res.leads)).toBe(true);
    expect(typeof res.count).toBe('number');
    expect(typeof res.total).toBe('number');
  });

  it('ships 50+ believable rows so Load-more pagination is exercised', () => {
    const res = leadsFixture('populated', q());
    expect(res.total).toBeGreaterThanOrEqual(50);
  });

  it('first page (no offset) returns exactly the page limit (50), not the whole store', () => {
    const res = leadsFixture('populated', q());
    expect(res.leads.length).toBe(50);
    expect(res.count).toBe(50);
    expect(res.total).toBeGreaterThan(50); // store holds more than one page
  });

  it('honors offset/limit — page 2 (offset=50) returns the tail slice + the SAME true total', () => {
    const page1 = leadsFixture('populated', q('offset=0&limit=50'));
    const page2 = leadsFixture('populated', q('offset=50&limit=50'));
    expect(page1.total).toBe(page2.total); // total is store-wide, never the page length
    // page1 ∪ page2 covers the whole store with no overlap.
    expect(page1.leads.length + page2.leads.length).toBe(page2.total);
    const ids = new Set([...page1.leads, ...page2.leads].map((l) => l.leadId));
    expect(ids.size).toBe(page2.total); // all unique (no duplicate row across pages)
  });

  it('each row matches the LeadSummary contract (socials always an object; nullable contact)', () => {
    const { leads } = leadsFixture('populated', q());
    for (const l of leads) {
      expect(typeof l.leadId).toBe('string');
      expect(typeof l.businessName).toBe('string');
      expect(typeof l.leadScore).toBe('number');
      expect(typeof l.hasWebsite).toBe('boolean');
      // socials is ALWAYS an object (worker emits {} when none) — null-safe for the template.
      expect(l.socials && typeof l.socials === 'object' && !Array.isArray(l.socials)).toBe(true);
    }
  });

  it('is ordered highest score first (mirrors the worker ORDER BY lead_score DESC)', () => {
    const { leads } = leadsFixture('populated', q('limit=200'));
    for (let i = 1; i < leads.length; i++) {
      expect(leads[i - 1]!.leadScore).toBeGreaterThanOrEqual(leads[i]!.leadScore);
    }
  });

  it('empty state → 0 rows, total 0 (a real empty variant, not a trimmed slice)', () => {
    const res = leadsFixture('empty', q());
    expect(res.leads.length).toBe(0);
    expect(res.count).toBe(0);
    expect(res.total).toBe(0);
  });

  it('has a realistic spread: some rows with socials, some with only email, some bare', () => {
    const { leads } = leadsFixture('populated', q('limit=200'));
    expect(leads.some((l) => Object.keys(l.socials).length > 0)).toBe(true);
    expect(leads.some((l) => l.email && Object.keys(l.socials).length === 0)).toBe(true);
    expect(leads.some((l) => l.enrichedAt)).toBe(true);
  });

  it('is reachable through the registry under GET /admin/leads', () => {
    const { key } = toRegistryKey('GET', '/api/admin/leads?onlyNoWebsite=true&offset=50');
    expect(key).toBe('GET /admin/leads');
    expect(findFixture(key)).toBe(leadsFixture as never);
  });
});

describe('toRegistryKey (normalization)', () => {
  it('strips /api prefix, query, and trailing slash', () => {
    expect(toRegistryKey('get', '/api/admin/leads/').key).toBe('GET /admin/leads');
    expect(toRegistryKey('GET', '/api/admin/leads?x=1').key).toBe('GET /admin/leads');
    expect(toRegistryKey('GET', 'https://host/api/admin/leads').key).toBe('GET /admin/leads');
  });

  it('exposes the parsed query params for pagination', () => {
    const { query } = toRegistryKey('GET', '/api/admin/leads?offset=50&limit=25');
    expect(query.get('offset')).toBe('50');
    expect(query.get('limit')).toBe('25');
  });

  it('leaves a non-/api path unchanged (so it simply will not match)', () => {
    expect(toRegistryKey('GET', '/health').key).toBe('GET /health');
  });
});
