import {
  featureFlagsFixture,
  liveCheckFixture,
  WFP_HOSTING_FLAG_KEY,
  PUBLISH_LIVE_CHECK_FLAG_KEY,
  type FeatureFlagsResponse,
  type LiveCheckResponse,
} from './hosting.fixture';
import { toRegistryKey } from './index';

/**
 * hosting.fixture — mock bodies for the two GET reads the **Hosting admin section**
 * (`pages/admin/sections/hosting.component.ts`) fires:
 *
 *   GET /feature-flags        → { flags: FeatureFlag[]; count } (the FLAG-GATE read —
 *       the component renders the live hosting surface ONLY when the `site_wfp_hosting`
 *       row is `default_enabled === true && stage !== 'killswitch'`; mirrors the worker's
 *       `GET /api/feature-flags` in `src/routes/features.ts`, each row the registry shape
 *       `{ key, description, default_enabled, default_rollout_percent, stage, owner_email,
 *       has_docs, source }`).
 *   GET /sites/:id/live-check → { data: { live, status, url } } (the PUBLISH-1 propagation
 *       probe the component polls for a PUBLISHED site; mirrors `GET /api/sites/:id/live-check`
 *       in `src/routes/api.ts`. The `url` is the SERVER-DERIVED `https://{slug}.projectsites.dev`).
 *
 * Both match the worker wire contract EXACTLY so the real endpoint is a drop-in swap.
 *
 * Flag-gating notes (verified against `src/modules/feature_flags/registry.ts`):
 *   - `site_wfp_hosting` ships `default_enabled:true, stage:'beta', rollout:100` — ON by
 *     default, so the mock mirrors that (the hosting live surface renders without a toggle).
 *   - `publish_live_check` ships `default_enabled:false, stage:'experimental'` — DARK, so
 *     in prod the live-check route 404s and `ApiService.liveCheck` maps it to the `null`
 *     sentinel → `liveState='off'` → the always-shown production link (zero regression).
 *     The fixture still serves the real `{ data: {...} }` envelope (feature-ON shape) so the
 *     surface is demoable end-to-end; the default `populated` returns the settled `live:true`.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

// ───────────────────────── GET /feature-flags ─────────────────────────

describe('featureFlagsFixture (GET /feature-flags → { flags: FeatureFlag[]; count })', () => {
  it('returns the worker envelope { flags, count } with every registry field per row', () => {
    const res: FeatureFlagsResponse = featureFlagsFixture('populated', q());
    expect(Array.isArray(res.flags)).toBe(true);
    expect(res.flags.length).toBeGreaterThan(0);
    expect(res.count).toBe(res.flags.length); // worker sets count = flags.length
    for (const f of res.flags) {
      expect(typeof f.key).toBe('string');
      expect(typeof f.description).toBe('string');
      expect(typeof f.default_enabled).toBe('boolean');
      expect(typeof f.default_rollout_percent).toBe('number');
      expect(typeof f.stage).toBe('string');
      expect(typeof f.owner_email).toBe('string');
      expect(typeof f.has_docs).toBe('boolean');
      expect(typeof f.source).toBe('string'); // worker adds 'registry' | 'd1'
    }
  });

  it('populated → the site_wfp_hosting row is ON (default_enabled true, stage NOT killswitch)', () => {
    // This is the gate the hosting component reads — ON lights up the live surface.
    const row = featureFlagsFixture('populated', q()).flags.find(
      (f) => f.key === WFP_HOSTING_FLAG_KEY,
    );
    expect(row).toBeDefined();
    expect(row!.default_enabled).toBe(true);
    expect(row!.stage).not.toBe('killswitch');
    expect(row!.stage).toBe('beta'); // mirrors the real registry row
    expect(row!.default_rollout_percent).toBe(100);
  });

  it('populated → carries the publish_live_check row (DARK — matches the real registry default)', () => {
    const row = featureFlagsFixture('populated', q()).flags.find(
      (f) => f.key === PUBLISH_LIVE_CHECK_FLAG_KEY,
    );
    expect(row).toBeDefined();
    expect(row!.default_enabled).toBe(false);
    expect(row!.stage).toBe('experimental');
  });

  it('empty → { flags: [], count: 0 } (the honest registry-unavailable first-run state)', () => {
    const res = featureFlagsFixture('empty', q());
    expect(res.flags).toEqual([]);
    expect(res.count).toBe(0);
  });

  it('is deterministic + flag keys unique (stable across calls, safe keys for lookups)', () => {
    const a = featureFlagsFixture('populated', q());
    const b = featureFlagsFixture('populated', q());
    expect(a).toEqual(b);
    const keys = a.flags.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('normalizes to the exact registry key GET /feature-flags', () => {
    expect(toRegistryKey('GET', '/api/feature-flags').key).toBe('GET /feature-flags');
    // Query (if any) is stripped before lookup.
    expect(toRegistryKey('GET', '/api/feature-flags?x=1').key).toBe('GET /feature-flags');
  });
});

// ───────────────────────── GET /sites/:id/live-check ─────────────────────────

describe('liveCheckFixture (GET /sites/:id/live-check → { data: { live, status, url } })', () => {
  it('returns the worker envelope { data: { live, status, url } } with exact field types', () => {
    const res: LiveCheckResponse = liveCheckFixture('populated', q());
    expect(res.data).toBeDefined();
    expect(typeof res.data.live).toBe('boolean');
    expect(typeof res.data.status).toBe('number');
    expect(typeof res.data.url).toBe('string');
  });

  it('populated → the settled happy path: live:true + status 200 (reveals the production link)', () => {
    const d = liveCheckFixture('populated', q()).data;
    expect(d.live).toBe(true);
    expect(d.status).toBe(200);
  });

  it('live is strictly status === 200 (mirrors the worker invariant)', () => {
    for (const state of ['populated', 'loading', 'empty'] as const) {
      const d = liveCheckFixture(state, q()).data;
      expect(d.live).toBe(d.status === 200);
    }
  });

  it('empty → the still-propagating state: live:false (the "finishing deployment…" card)', () => {
    const d = liveCheckFixture('empty', q()).data;
    expect(d.live).toBe(false);
    expect(d.status).not.toBe(200);
  });

  it('url is the server-derived https://{slug}.projectsites.dev (never a client value)', () => {
    const d = liveCheckFixture('populated', q()).data;
    expect(d.url).toMatch(/^https:\/\/[a-z0-9-]+\.projectsites\.dev$/);
  });

  it('is deterministic (stable across calls)', () => {
    expect(liveCheckFixture('populated', q())).toEqual(liveCheckFixture('populated', q()));
  });

  it('normalizes to the :param registry key GET /sites/:id/live-check (any site id)', () => {
    expect(toRegistryKey('GET', '/api/sites/site-001/live-check').key).toBe(
      'GET /sites/site-001/live-check',
    );
    expect(toRegistryKey('GET', '/api/sites/abc/live-check').key).toBe(
      'GET /sites/abc/live-check',
    );
  });
});
