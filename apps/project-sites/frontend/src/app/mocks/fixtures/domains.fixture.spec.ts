import {
  siteHostnamesFixture,
  adminDomainsFixture,
  type SiteHostnamesResponse,
  type AdminDomainsResponse,
} from './domains.fixture';
import { toRegistryKey } from './index';

/**
 * domains.fixture — mock bodies for the Domains section's two GET reads:
 *
 *   GET /sites/:id/hostnames → { data: Hostname[] }
 *       (the RENDER-GATING read — the "Connected domains" table funnels through this;
 *        each row { id, hostname, type, status, ssl_status, is_primary, auto_renew },
 *        ordered is_primary DESC — matches `getSiteHostnames` in src/services/domains.ts)
 *   GET /admin/domains       → { data: { sites: [{ site, hostnames: [] }] } }
 *       (the org-wide aggregator — the sites-grouped Settings→Domains view)
 *
 * Each matches the worker wire contract EXACTLY so the real endpoint is a drop-in swap.
 * State variants: populated (a rich mix — custom + free, active/pending/failed, SSL
 * states, exactly one primary) · empty ([]  / no sites — the honest first-run state).
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

/** Every status the component's `statusTone()` buckets (verified/pending/error/neutral). */
const KNOWN_STATUSES = new Set([
  'active',
  'verified',
  'pending',
  'pending_validation',
  'provisioning',
  'verification_failed',
  'error',
  'failed',
]);

describe('siteHostnamesFixture (GET /sites/:id/hostnames → { data: Hostname[] })', () => {
  it('returns the worker envelope { data: Hostname[] } with every row field the worker emits', () => {
    const res: SiteHostnamesResponse = siteHostnamesFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
    for (const h of res.data) {
      expect(typeof h.id).toBe('string');
      expect(typeof h.hostname).toBe('string');
      expect(typeof h.type).toBe('string');
      expect(typeof h.status).toBe('string');
      expect(typeof h.ssl_status).toBe('string');
      expect(typeof h.is_primary).toBe('number'); // 0 | 1 (worker COALESCEs)
      expect(typeof h.auto_renew).toBe('number');
    }
  });

  it('populated → carries BOTH a free_subdomain and a custom_cname (exercises both action paths)', () => {
    const rows = siteHostnamesFixture('populated', q()).data;
    expect(rows.some((h) => h.type === 'free_subdomain')).toBe(true);
    expect(rows.some((h) => h.type === 'custom_cname')).toBe(true);
  });

  it('populated → spans active + pending + verification_failed (every status tone renders)', () => {
    const statuses = siteHostnamesFixture('populated', q()).data.map((h) => h.status);
    expect(statuses).toContain('active');
    expect(statuses).toContain('pending');
    expect(statuses).toContain('verification_failed');
    // Only statuses the component knows how to tone — no mystery value falls to neutral.
    for (const s of statuses) expect(KNOWN_STATUSES.has(s)).toBe(true);
  });

  it('populated → EXACTLY ONE primary (is_primary === 1), and it sorts first (worker order)', () => {
    const rows = siteHostnamesFixture('populated', q()).data;
    const primaries = rows.filter((h) => h.is_primary === 1);
    expect(primaries.length).toBe(1);
    // getSiteHostnames orders `is_primary DESC` → the primary is row 0.
    expect(rows[0].is_primary).toBe(1);
  });

  it('populated → the free subdomain is a real {slug}.projectsites.dev host', () => {
    const rows = siteHostnamesFixture('populated', q()).data;
    const free = rows.find((h) => h.type === 'free_subdomain');
    expect(free).toBeDefined();
    expect(free!.hostname).toMatch(/\.projectsites\.dev$/);
  });

  it('empty → an empty roster [] (the honest "No connected domains" first-run state)', () => {
    expect(siteHostnamesFixture('empty', q()).data).toEqual([]);
  });

  it('is deterministic + row ids unique (stable across calls, safe for @for track h.id)', () => {
    const a = siteHostnamesFixture('populated', q()).data;
    const b = siteHostnamesFixture('populated', q()).data;
    expect(a).toEqual(b);
    const ids = a.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('normalizes to the :param registry key GET /sites/:id/hostnames', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001/hostnames').key).toBe(
      'GET /sites/site-001/hostnames',
    );
  });
});

describe('adminDomainsFixture (GET /admin/domains → { data: { sites: [{ site, hostnames }] } })', () => {
  it('returns the worker envelope { data: { sites: [...] } } with the grouped shape', () => {
    const res: AdminDomainsResponse = adminDomainsFixture('populated', q());
    expect(Array.isArray(res.data.sites)).toBe(true);
    expect(res.data.sites.length).toBeGreaterThan(0);
    for (const group of res.data.sites) {
      expect(typeof group.site.id).toBe('string');
      expect(typeof group.site.slug).toBe('string');
      expect(Array.isArray(group.hostnames)).toBe(true);
      for (const h of group.hostnames) {
        expect(typeof h.id).toBe('string');
        expect(typeof h.site_id).toBe('string');
        expect(typeof h.hostname).toBe('string');
        expect(h.site_id).toBe(group.site.id); // rows belong to their group's site
      }
    }
  });

  it('populated → at least one group has an attached hostname (not an all-empty aggregate)', () => {
    const groups = adminDomainsFixture('populated', q()).data.sites;
    expect(groups.some((g) => g.hostnames.length > 0)).toBe(true);
  });

  it('empty → { data: { sites: [] } } (no sites in the org yet)', () => {
    expect(adminDomainsFixture('empty', q()).data.sites).toEqual([]);
  });

  it('normalizes to the exact registry key GET /admin/domains', () => {
    expect(toRegistryKey('GET', '/api/admin/domains').key).toBe('GET /admin/domains');
  });
});
