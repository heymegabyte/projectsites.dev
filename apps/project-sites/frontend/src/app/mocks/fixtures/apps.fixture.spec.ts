import { appsInstallCountsFixture, type AppsInstallCountsResponse } from './apps.fixture';
import { toRegistryKey, FIXTURES } from './index';

/**
 * apps.fixture — mock body for the single GET read the admin **Apps** section
 * (`pages/admin/sections/apps.component.ts`) fires on render:
 *
 *   GET /apps/install-counts → { counts: Record<string, number> }
 *       DISTINCT-org install count per catalog app slug. Mirrors the worker's
 *       `GET /api/apps/install-counts` (`src/routes/apps.ts:316`):
 *       `SELECT app_slug, COUNT(DISTINCT org_id) AS n FROM app_instances
 *          WHERE deleted_at IS NULL AND app_slug IS NOT NULL GROUP BY app_slug`
 *       → `{ counts }`. Public, auth-free, UN-flagged. Fetched silently by the
 *       component (`{ silent: true }`); a failure just hides the social-proof pills.
 *
 * The catalog grid itself is a STATIC local dataset (`apps-catalog.data.ts`), so this is
 * the section's ONLY on-render network read. The `/admin/apps/instances` + `/admin/apps/:id`
 * sub-routes are DEFERRED (separate routed components), not fixtured here.
 *
 * Matches the worker wire contract EXACTLY so the real endpoint is a drop-in swap.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('appsInstallCountsFixture (GET /apps/install-counts → { counts: Record<string, number> })', () => {
  it('returns the worker envelope { counts } (a plain slug→number record, NOT { data })', () => {
    const res: AppsInstallCountsResponse = appsInstallCountsFixture('populated', q());
    expect(res.counts).toBeDefined();
    expect(typeof res.counts).toBe('object');
    expect(Array.isArray(res.counts)).toBe(false);
    // Every value is a non-negative integer org count.
    for (const [slug, n] of Object.entries(res.counts)) {
      expect(typeof slug).toBe('string');
      expect(typeof n).toBe('number');
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
    }
  });

  it('populated → keyed on REAL catalog app slugs so the pills land on actual cards', () => {
    const counts = appsInstallCountsFixture('populated', q()).counts;
    // Slugs lifted verbatim from apps-catalog.data.ts (the live catalog).
    expect(counts['umami']).toBeGreaterThan(0);
    expect(counts['open-webui']).toBeGreaterThan(0);
    expect(counts['listmonk']).toBeGreaterThan(0);
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(3);
  });

  it('empty → { counts: {} } (the honest no-installs-yet surface — no card shows a pill)', () => {
    const res = appsInstallCountsFixture('empty', q());
    expect(res.counts).toEqual({});
  });

  it('loading / default behave like populated (the believable roster)', () => {
    expect(appsInstallCountsFixture('loading', q())).toEqual(
      appsInstallCountsFixture('populated', q()),
    );
  });

  it('is deterministic + returns a fresh object (no shared-reference mutation leak)', () => {
    const a = appsInstallCountsFixture('populated', q());
    const b = appsInstallCountsFixture('populated', q());
    expect(a).toEqual(b);
    expect(a.counts).not.toBe(b.counts); // spread clone, not the module-level constant
  });

  it('normalizes to the exact registry key GET /apps/install-counts (query stripped)', () => {
    expect(toRegistryKey('GET', '/api/apps/install-counts').key).toBe('GET /apps/install-counts');
    expect(toRegistryKey('GET', '/api/apps/install-counts?x=1').key).toBe(
      'GET /apps/install-counts',
    );
  });

  it('is wired into the shipped FIXTURES registry under GET /apps/install-counts', () => {
    // Assert against the STATIC registry map directly — the merged key always carries this
    // factory regardless of Jasmine's spec order, and it never touches the mutable
    // registerFixtures/EXTRA_FIXTURES seam (which a sibling spec could leak). Deterministic.
    const factory = (FIXTURES as Record<string, (s: string, query: URLSearchParams) => unknown>)[
      'GET /apps/install-counts'
    ];
    expect(typeof factory).toBe('function');
    expect(factory).toBe(appsInstallCountsFixture as unknown as typeof factory);
    expect((factory('populated', q()) as AppsInstallCountsResponse).counts['umami']).toBeGreaterThan(0);
  });
});
