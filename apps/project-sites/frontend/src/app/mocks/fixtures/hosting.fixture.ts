/**
 * @module mocks/fixtures/hosting
 *
 * @description
 * Mock fixtures for the **Hosting admin section** (`pages/admin/sections/hosting.component.ts` —
 * the WfP site-hosting owner surface). That section fires TWO GET reads; both are fixtured here
 * (the site roster it reads for `selectedSite()` is already mocked by `sites.fixture.ts` — P1 —
 * and is intentionally NOT duplicated):
 *
 * | Route                       | Factory                      | Fired by                                                   | Worker contract                                                              |
 * | --------------------------- | ---------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
 * | `GET /feature-flags`        | {@link featureFlagsFixture } | `ApiService.getFeatureFlags()` on `ngOnInit` (the flag gate) | `{ flags: FeatureFlag[]; count }` (`GET /api/feature-flags`, src/routes/features.ts) |
 * | `GET /sites/:id/live-check` | {@link liveCheckFixture }    | `ApiService.liveCheck(siteId)` poll (PUBLISH-1, published site) | `{ data: { live, status, url } }` (`GET /api/sites/:id/live-check`, src/routes/api.ts) |
 *
 * Both are typed to the EXACT WORKER WIRE shape, so wiring the real endpoint is a provider SWAP,
 * not a rewrite.
 *
 * ## Flag-gating (verified against `src/modules/feature_flags/registry.ts`)
 *
 * - The component renders its live hosting surface ONLY when the `site_wfp_hosting` registry row
 *   resolves `default_enabled === true && stage !== 'killswitch'`. The REAL registry ships that
 *   row `default_enabled:true, stage:'beta', rollout:100` (promoted 2026-09-29) — ON by default —
 *   so the mock mirrors it: the hosting live surface renders with NO toggle needed. (`state=empty`
 *   drops to `{ flags: [] }`, which the component treats as flag-absent → its honest gated card.)
 * - The live-check route is gated on a SEPARATE flag, `publish_live_check`, which ships
 *   `default_enabled:false, stage:'experimental'` — DARK. In prod it 404s and
 *   `ApiService.liveCheck` maps that to the `null` sentinel → the component's `liveState` stays
 *   `off` → it keeps the ALWAYS-shown production link (zero regression). The fixture still serves
 *   the real `{ data: {...} }` envelope (the feature-ON shape) so the surface is demoable
 *   end-to-end; the default `populated` returns the SETTLED `live:true` (the production link is
 *   shown via `liveState='live'`, never the pending "finishing deployment…" strip).
 *
 * ## What renders on `?mock=1`
 *
 * The already-mocked `GET /sites` roster (`sites.fixture.ts`) carries a `published` site WITH a
 * `current_build_version` AND a `primary_hostname` (Beverwyck Barber Co.), so once it's the
 * selected site the hosting surface shows the `WfP dispatch` pill (`serveMode='wfp'`), both URL
 * cards (preview + production), and the enabled "Promote to production" CTA — the full success
 * state. No component tweak is needed: every state (loading / error / gated / empty / live) is
 * already built; serving these two fixtures simply lights up the live state.
 *
 * @remarks
 * - `GET /sites/:id/live-check` is registered under a `:param` PATTERN key, so ONE body serves
 *   EVERY demo site id. The `url` below uses the demo primary site's slug so it reads cleanly in
 *   the UI, but the body is not id-specific (the component only reads `live` to gate the link).
 * - `state` variants: `populated`/`loading`/default → the rich/settled bodies; `empty` → the
 *   honest edge (no flags registered / still-propagating); `error` is handled by the interceptor
 *   (it throws a 500 before these run).
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /feature-flags ─────────────────────────

/**
 * The feature-flag gate key the hosting component reads (`WFP_FLAG_KEY` in
 * `hosting.component.ts`). Exported so the spec pins the exact row.
 */
export const WFP_HOSTING_FLAG_KEY = 'site_wfp_hosting';

/** The flag the live-check route is gated on (`publish_live_check`). Exported for the spec. */
export const PUBLISH_LIVE_CHECK_FLAG_KEY = 'publish_live_check';

/**
 * One registry row as the worker emits it from `GET /api/feature-flags` — the frontend's
 * `FeatureFlag` interface (`services/api.service.ts`) PLUS the `source` tag the worker
 * attaches (`'registry' | 'd1'`, kept optional on the FE type, always present on the wire).
 */
export interface FeatureFlagRow {
  readonly key: string;
  readonly description: string;
  readonly default_enabled: boolean;
  readonly default_rollout_percent: number;
  readonly stage: 'experimental' | 'beta' | 'stable' | 'deprecated' | 'killswitch';
  readonly owner_email: string;
  readonly has_docs: boolean;
  readonly source: 'registry' | 'd1';
}

/** The `GET /api/feature-flags` envelope — the worker returns `{ flags, count }` (NOT `{ data }`). */
export interface FeatureFlagsResponse {
  flags: FeatureFlagRow[];
  count: number;
}

/**
 * A representative slice of the registry, mirroring the REAL rows from
 * `src/modules/feature_flags/registry.ts` (verbatim `default_enabled` / `stage` / `rollout` /
 * `owner_email`). The two hosting-relevant flags lead; a handful of other real flags follow so
 * any other consumer of `getFeatureFlags()` (a flag-list surface) sees a believable registry.
 * Descriptions are trimmed to a clean one-liner (the wire carries the long prose; the component
 * reads only `key` / `default_enabled` / `stage`, so a shorter description is contract-safe).
 */
const FLAGS: readonly FeatureFlagRow[] = [
  {
    key: WFP_HOSTING_FLAG_KEY,
    description:
      'WfP site hosting — every new generated site born on a Cloudflare Workers-for-Platforms dispatch namespace (a preview slot + a production slot), so the dispatched per-site Worker serves instead of the R2-static-direct path. Additive + fail-soft: any WfP miss falls back to R2.',
    default_enabled: true,
    default_rollout_percent: 100,
    stage: 'beta',
    owner_email: 'brian@megabyte.space',
    has_docs: true,
    source: 'registry',
  },
  {
    key: PUBLISH_LIVE_CHECK_FLAG_KEY,
    description:
      'Money-path PUBLISH propagation guard (PUBLISH-1) — gates GET /api/sites/:id/live-check, a CORS-safe server-side liveness probe the admin hosting UI polls after publish so "View Live" unlocks only once the site truly serves a 200.',
    default_enabled: false,
    default_rollout_percent: 0,
    stage: 'experimental',
    owner_email: 'brian@megabyte.space',
    has_docs: true,
    source: 'registry',
  },
  {
    key: 'per_site_data',
    description:
      "Per-site Data Platform — the editor Data tab's Tables surface reads a customer's OWN dedicated Cloudflare D1 (blank at first), never the shared platform DB.",
    default_enabled: false,
    default_rollout_percent: 0,
    stage: 'experimental',
    owner_email: 'brian@megabyte.space',
    has_docs: true,
    source: 'registry',
  },
  {
    key: 'r2_buckets',
    description:
      "Per-site R2 bucket manager — the editor Resources → Buckets tab. Owners manage their site's OWN Cloudflare R2 buckets.",
    default_enabled: true,
    default_rollout_percent: 100,
    stage: 'experimental',
    owner_email: 'brian@megabyte.space',
    has_docs: true,
    source: 'registry',
  },
  {
    key: 'donations_engine',
    description:
      'Donations engine — the reference feature module (manifest + flag + Zod schemas + tests) powering a site donation surface.',
    default_enabled: false,
    default_rollout_percent: 0,
    stage: 'experimental',
    owner_email: 'brian@megabyte.space',
    has_docs: true,
    source: 'registry',
  },
];

/**
 * Feature-flags factory. `empty` → `{ flags: [], count: 0 }` (the honest registry-unavailable
 * first-run state — the hosting component then renders its gated card, since the
 * `site_wfp_hosting` row is absent); `error` is handled by the interceptor (it throws a 500 before
 * this runs); `populated`/`loading`/default → the believable registry slice with `site_wfp_hosting`
 * ON (so the hosting live surface renders).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const featureFlagsFixture: FixtureFactory<FeatureFlagsResponse> = (
  state: MockState,
): FeatureFlagsResponse => {
  if (state === 'empty') return { flags: [], count: 0 };
  const flags = FLAGS.map((f) => ({ ...f }));
  return { flags, count: flags.length };
};

// ───────────────────────── GET /sites/:id/live-check ─────────────────────────

/**
 * The `GET /api/sites/:id/live-check` body — the worker's PUBLISH-1 liveness probe, unwrapped by
 * `ApiService.liveCheck` from `{ data }`. `live` is strictly `status === 200`; `url` is the
 * SERVER-derived default hostname the Worker probed (`https://{slug}.projectsites.dev`), never a
 * client value. Mirrors `LiveCheckResult` in `services/api.service.ts`.
 */
export interface LiveCheckBody {
  readonly live: boolean;
  readonly status: number;
  readonly url: string;
}

/** The `GET /api/sites/:id/live-check` envelope — the worker wraps the probe in `{ data }`. */
export interface LiveCheckResponse {
  data: LiveCheckBody;
}

/** The demo primary site's slug — so the probed `url` reads cleanly in the UI. */
const DEMO_SLUG = 'beverwyck-barber';

/**
 * Live-check factory. Served under a `:param` pattern, so ONE body answers every demo site id
 * (the component reads only `live` to gate the production link; the body is not id-specific).
 *
 * - `populated`/`loading`/default → the SETTLED happy path (`live:true`, `status:200`) → the
 *   component's `liveState` resolves `live` and reveals the production "open" link immediately
 *   (never the pending "finishing deployment…" strip).
 * - `empty` → the still-propagating edge (`live:false`, `status:0`) → were `publish_live_check`
 *   ON for the demo, this drives the calm "finishing deployment…" card; it keeps `live === (status
 *   === 200)` honest.
 * - `error` is handled by the interceptor (it throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const liveCheckFixture: FixtureFactory<LiveCheckResponse> = (
  state: MockState,
): LiveCheckResponse => {
  const url = `https://${DEMO_SLUG}.projectsites.dev`;
  if (state === 'empty') return { data: { live: false, status: 0, url } };
  return { data: { live: true, status: 200, url } };
};
