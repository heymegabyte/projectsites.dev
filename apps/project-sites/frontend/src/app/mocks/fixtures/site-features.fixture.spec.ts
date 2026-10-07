import {
  siteFeaturesFixture,
  type SiteFeaturesResponse,
  type SiteFeatureRow,
} from './site-features.fixture';
import { toRegistryKey } from './index';
import {
  entitlementFor,
  planRank,
  type PlanTier,
} from '../../pages/admin/sections/feature-flags/flag-logic';

/**
 * site-features.fixture — mock body for the ONE GET read the **Features admin section**
 * (`pages/admin/sections/site-features.component.ts`) fires:
 *
 *   GET /site-features → { features: SiteFeature[]; plan: PlanTier }
 *
 * This is LAYER 2 (owner-facing) of the two-layer flag control plane — the site-scoped,
 * plan-aware capability list. The component calls `ApiService.get('/site-features?site_id=…')`
 * (→ `GET /api/site-features`); the interceptor strips `/api` + the query, so the registry key
 * is the exact static `GET /site-features`.
 *
 * Contract pinned here (mirrors `src/routes/features.ts:560-593`):
 *   - envelope is `{ features, plan }` — NOT `{ data }`;
 *   - every row carries the full `SiteFeature` shape (catalog fields + server-derived
 *     `entitled`/`enabled`/`preview`);
 *   - `entitled` is derived from `plan` vs `requiredPlan` EXACTLY as the worker does
 *     (`PLAN_RANK[plan] >= PLAN_RANK[requiredPlan] ? 'available' : isAddon ? 'addon-required'
 *     : 'upgrade-required'`), so a card's lock state always agrees with its tier;
 *   - a non-`available` (locked) row is never `enabled:true` (mirrors the worker's 403-on-
 *     under-entitled-enable invariant);
 *   - `empty` → `{ features: [], plan: 'free' }` (TODAY's real wire — the catalog was removed
 *     2026-08-13, so prod serves `[]` → the component's empty state).
 *
 * Flag-gating: NONE — `GET /api/site-features` is auth-only (no `requireFlag`), so the Features
 * tab renders on `?mock=1` with no flag flip.
 *
 * Wiring: asserted via the STATIC `toRegistryKey` normalization (route → key). The orchestrator
 * merges the `FIXTURES` registry line separately, so this isolated spec pins the key the merged
 * entry MUST use — NOT `findFixture` (which iterates the module-level PARAM_PATTERNS a sibling
 * spec's `registerFixtures` could reorder/leak) per the #35 determinism fix.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

// ───────────────────────── GET /site-features ─────────────────────────

describe('siteFeaturesFixture (GET /site-features → { features, plan })', () => {
  it('returns the worker envelope { features, plan } — NOT { data }', () => {
    const res: SiteFeaturesResponse = siteFeaturesFixture('populated', q());
    expect(Array.isArray(res.features)).toBe(true);
    expect(typeof res.plan).toBe('string');
    // The component reads res.features + res.plan directly; a { data } wrapper would break it.
    expect((res as unknown as { data?: unknown }).data).toBeUndefined();
  });

  it('populated → a believable multi-feature catalog on the pro plan', () => {
    const res = siteFeaturesFixture('populated', q());
    expect(res.features.length).toBeGreaterThan(0);
    expect(res.plan).toBe('pro');
  });

  it('every row carries the full SiteFeature shape with exact field types', () => {
    for (const f of siteFeaturesFixture('populated', q()).features) {
      expect(typeof f.key).toBe('string');
      expect(typeof f.name).toBe('string');
      expect(typeof f.description).toBe('string');
      expect(['free', 'pro', 'business', 'enterprise']).toContain(f.requiredPlan);
      expect(typeof f.isAddon).toBe('boolean');
      expect(typeof f.category).toBe('string');
      expect(['available', 'upgrade-required', 'addon-required']).toContain(f.entitled);
      expect(typeof f.enabled).toBe('boolean');
      expect(typeof f.preview).toBe('boolean');
    }
  });

  it('derives `entitled` the SAME way the worker does (plan vs requiredPlan + isAddon)', () => {
    const res = siteFeaturesFixture('populated', q());
    for (const f of res.features) {
      const expected = entitlementFor({
        plan: res.plan,
        requiredPlan: f.requiredPlan,
        isAddon: f.isAddon,
      });
      expect(f.entitled).toBe(expected);
    }
  });

  it('a feature at/below the plan tier is `available`; a higher non-addon tier is `upgrade-required`', () => {
    const res = siteFeaturesFixture('populated', q());
    for (const f of res.features) {
      const met = planRank(res.plan) >= planRank(f.requiredPlan);
      if (met) {
        expect(f.entitled).toBe('available');
      } else if (!f.isAddon) {
        expect(f.entitled).toBe('upgrade-required');
      } else {
        expect(f.entitled).toBe('addon-required');
      }
    }
  });

  it('exercises all three entitlement states so every card branch renders', () => {
    const states = new Set(siteFeaturesFixture('populated', q()).features.map((f) => f.entitled));
    expect(states.has('available')).toBe(true); // free/pro features on a pro plan
    expect(states.has('upgrade-required')).toBe(true); // business/enterprise non-addon features
    expect(states.has('addon-required')).toBe(true); // the one add-on feature
  });

  it('a LOCKED (non-available) row is never enabled:true (mirrors the worker 403-on-under-entitled-enable)', () => {
    for (const f of siteFeaturesFixture('populated', q()).features) {
      if (f.entitled !== 'available') expect(f.enabled).toBe(false);
    }
  });

  it('at least one available feature is enabled + at least one is off (toggle both states demoable)', () => {
    const available = siteFeaturesFixture('populated', q()).features.filter(
      (f) => f.entitled === 'available',
    );
    expect(available.some((f) => f.enabled)).toBe(true);
    expect(available.some((f) => !f.enabled)).toBe(true);
  });

  it('feature keys are unique + lowercase snake_case (stable track-by + safe lookups)', () => {
    const keys = siteFeaturesFixture('populated', q()).features.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]+$/);
  });

  it('no row ships in preview mode (the UI owns preview locally)', () => {
    for (const f of siteFeaturesFixture('populated', q()).features) {
      expect(f.preview).toBe(false);
    }
  });

  it('empty → { features: [], plan: "free" } (TODAY’s real wire → the component empty state)', () => {
    const res = siteFeaturesFixture('empty', q());
    expect(res.features).toEqual([]);
    expect(res.plan).toBe('free');
  });

  it('loading + default → the same populated catalog (non-empty)', () => {
    expect(siteFeaturesFixture('loading', q()).features.length).toBeGreaterThan(0);
    expect(siteFeaturesFixture('populated', q())).toEqual(siteFeaturesFixture('loading', q()));
  });

  it('is deterministic (stable across calls — safe for repeated renders)', () => {
    expect(siteFeaturesFixture('populated', q())).toEqual(siteFeaturesFixture('populated', q()));
    expect(siteFeaturesFixture('empty', q())).toEqual(siteFeaturesFixture('empty', q()));
  });

  it('returns fresh row objects per call (no shared mutable catalog leak across callers)', () => {
    const a = siteFeaturesFixture('populated', q());
    const b = siteFeaturesFixture('populated', q());
    expect(a.features).not.toBe(b.features);
    if (a.features.length) expect(a.features[0]).not.toBe(b.features[0]);
  });
});

// ───────────────────────── registry wiring (static key normalization) ─────────────────────────

describe('site-features fixture — registry key (the merged FIXTURES entry MUST use this key)', () => {
  it('GET /api/site-features normalizes to the exact static key GET /site-features', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/site-features');
    expect(key).toBe('GET /site-features');
  });

  it('the ?site_id= query is stripped before lookup (static key, NOT a :param pattern)', () => {
    const { key, query } = toRegistryKey(
      'GET',
      'https://projectsites.dev/api/site-features?site_id=site-001',
    );
    expect(key).toBe('GET /site-features');
    // The site is a QUERY arg (not a path segment), so the key carries no wildcard + the
    // interceptor still exposes site_id on the parsed query.
    expect(query.get('site_id')).toBe('site-001');
  });
});
