/**
 * @module mocks/fixtures/apps
 *
 * @description
 * Mock fixture for the admin **Apps** section (`pages/admin/sections/apps.component.ts`) — the
 * self-hostable **app store** catalog. The section's grid is rendered from a STATIC local catalog
 * (`apps-catalog.data.ts`, compiled into the bundle), NOT from the network — so the ONLY on-render
 * network read the section's own list makes is a single social-proof call:
 *
 * | Registry key               | Factory                     | Worker contract (traced)                                              |
 * | -------------------------- | --------------------------- | --------------------------------------------------------------------- |
 * | `GET /apps/install-counts` | {@link appsInstallCountsFixture } | `{ counts: Record<string, number> }` (`src/routes/apps.ts:316`)  |
 *
 * `GET /api/apps/install-counts` returns a DISTINCT-org install count per catalog app slug
 * (`SELECT app_slug, COUNT(DISTINCT org_id) AS n FROM app_instances … GROUP BY app_slug`). The
 * component (`ngOnInit`) fetches it **silently** (`{ silent: true }`) via
 * {@link import('../../services/api.service').ApiService}`.get()`, maps `res.counts` into the
 * `installCounts` signal, and renders an "N orgs" social-proof pill on each catalog card. A
 * failure (or missing count) just hides the pill — the catalog never breaks. Typed to the EXACT
 * worker wire shape, so wiring the real endpoint later is a provider SWAP, not a rewrite.
 *
 * **HttpClient vs native fetch:** HttpClient (`ApiService` wraps `HttpClient`) — so this is served
 * by the standard HttpInterceptor seam (NOT the native-fetch shim).
 *
 * **Flag-gating:** NONE. `GET /api/apps/install-counts` is a PUBLIC, auth-free, un-flagged route
 * (its JSDoc: "No auth (drives discovery)"); the whole `apps` Hono router carries no `apps.use(…)`
 * flag middleware. So the Apps catalog renders fully on `?mock=1` with ZERO flag flips.
 *
 * **DEFERRED sub-routes (NOT fixtured here — separate routed components):** the "My instances"
 * button links to `/admin/apps/instances` (`apps-instances.component.ts` → `GET /api/apps/instances`,
 * `{ instances: [...] }`) and each card opens `/admin/apps/:id` (`apps-detail.component.ts`). Those
 * are lazy-routed children the task explicitly scopes OUT ("the big apps-instances / apps-detail
 * sub-components are DEFERRED — just the section's own list loads"). A later slice can fixture
 * `GET /apps/instances` + the per-instance reads for the full installed-apps experience.
 *
 * @remarks
 * - The `counts` map is keyed on REAL catalog app slugs from `apps-catalog.data.ts` (`umami`,
 *   `listmonk`, `open-webui`, `lobe-chat`, `langflow`, `litellm`, `phoenix`, `stirling-pdf`,
 *   `payload`), so the social-proof pills light up on the actual cards in the grid — believable
 *   marketplace texture, not lorem. Counts read as plausible org adoption (the hero app highest).
 * - `state` variants: `empty` → `{ counts: {} }` (the honest brand-new-platform surface where NO
 *   card shows an install pill — exercises the "no social proof yet" branch); `populated` /
 *   `loading` / default → the believable per-slug roster. `error` is handled by the interceptor
 *   (it throws a 500 before this runs) — which, because the component fetches `{ silent: true }`
 *   + resets `installCounts` to `{}` on error, degrades to the same pill-less catalog (no toast).
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /apps/install-counts ─────────────────────────

/**
 * The `GET /api/apps/install-counts` envelope — the worker returns `{ counts }`, a plain
 * `Record<app_slug, distinct_org_count>` (NOT `{ data }`). The component reads `res.counts`
 * directly and treats a missing slug as `0` (no pill).
 */
export interface AppsInstallCountsResponse {
  counts: Record<string, number>;
}

/**
 * Believable DISTINCT-org install counts keyed by REAL catalog app slugs (from
 * `apps-catalog.data.ts`). Spread across the live apps so several cards show a social-proof pill
 * with varied adoption — the hero analytics app most-installed, a long tail of smaller numbers.
 * Slugs absent from this map (most of the 25-app catalog) correctly render NO pill.
 */
const INSTALL_COUNTS: Readonly<Record<string, number>> = {
  umami: 42,
  listmonk: 18,
  'open-webui': 27,
  'lobe-chat': 11,
  langflow: 7,
  litellm: 15,
  phoenix: 4,
  'stirling-pdf': 9,
  payload: 6,
};

/**
 * Install-counts factory. `empty` → `{ counts: {} }` (the honest no-installs-yet surface — no
 * card renders a social-proof pill); `populated` / `loading` / default → the believable per-slug
 * roster. `error` is handled by the interceptor (throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const appsInstallCountsFixture: FixtureFactory<AppsInstallCountsResponse> = (
  state: MockState,
): AppsInstallCountsResponse => ({ counts: state === 'empty' ? {} : { ...INSTALL_COUNTS } });
