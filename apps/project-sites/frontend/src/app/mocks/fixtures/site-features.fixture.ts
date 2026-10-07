/**
 * @module mocks/fixtures/site-features
 *
 * @description
 * Mock fixture for the admin **Features** section (`pages/admin/sections/site-features.component.ts`)
 * — LAYER 2 of the two-layer feature-flag control plane: the owner-facing, SITE-scoped,
 * plan-aware capability list a site owner turns on for THEIR hosted site. Serving this on
 * `?mock=1` lights up the whole Features grid (cards · toggles · entitlement-locked states ·
 * preview · expert-mode · spec dossier) with ZERO backend.
 *
 * | Registry key            | Factory                      | Worker contract (traced)                                                |
 * | ----------------------- | ---------------------------- | ----------------------------------------------------------------------- |
 * | `GET /site-features`    | {@link siteFeaturesFixture}  | `{ features: SiteFeature[]; plan: PlanTier }` (`routes/features.ts:560`) |
 *
 * **The route the component fires:** `ApiService.get('/site-features?site_id=…')` →
 * `GET /api/site-features` in `src/routes/features.ts`. The ApiService prepends `/api`; the
 * interceptor strips it + the `?site_id=` query before lookup, so the registry key is the exact
 * static `GET /site-features` (NOT a `:param` pattern — the site is a query arg, not a path seg).
 *
 * **Envelope (EXACT worker wire, `features.ts:592` `c.json({ features: featureList, plan })`):**
 * `{ features, plan }` — NOT `{ data }`. Each `SiteFeature` is the catalog row spread with the
 * three server-derived fields the handler adds per site/plan:
 *   - `entitled: 'available' | 'upgrade-required' | 'addon-required'` — computed by the worker as
 *     `PLAN_RANK[plan] >= PLAN_RANK[requiredPlan] ? 'available' : (isAddon ? 'addon-required' :
 *     'upgrade-required')`. This fixture computes it the SAME way (shared `flag-logic.entitlementFor`),
 *     so a card's lock state always agrees with its `requiredPlan` + the response `plan`.
 *   - `enabled: boolean` — the site's tenant override, else the registry `default_enabled` (here the
 *     fixture carries explicit believable per-feature state).
 *   - `preview: boolean` — owner preview-mode (off for every seed; the UI drives preview locally).
 *
 * **Flag-gating:** NONE. `features.get('/api/site-features', …)` carries NO `requireFlag`
 * middleware (unlike the `token_burn_meter` / `model_registry` routes lower in the same file) — it
 * is auth-only (resolves `orgId` from the session; a `?org_id=` param is ignored as a closed IDOR).
 * So the Features tab renders fully on `?mock=1` with NO flag flip, as soon as a site is selected.
 *
 * **Reality note (why realistic data when prod returns `[]`):** the live `SITE_FEATURE_CATALOG`
 * (`features.ts:490`) is currently an EMPTY array — the child-site catalog was removed 2026-08-13,
 * so the real endpoint serves `{ features: [], plan }` today (the component then shows its honest
 * "all core capabilities built-in" empty state). The component + worker still carry the FULL
 * `SiteFeature` shape + the entitlement machinery intact, ready for the catalog to be re-seeded.
 * A UI-mockout must demo the surface the component is BUILT to render — so the `populated`/default
 * state serves the shape the worker WOULD serve with a populated catalog (a believable set of
 * owner features across all three entitlement states), and the `empty` state mirrors TODAY's real
 * wire (`[]`) so the first-run empty branch is demoable too. Wiring the re-seeded endpoint later is
 * a provider SWAP — the envelope + per-row shape are byte-identical.
 *
 * @remarks
 * - `state` variants: `empty` → `{ features: [], plan: 'free' }` (today's real wire → the component's
 *   "Your site has all core capabilities built-in" empty state); `loading`/`populated`/default → the
 *   rich believable catalog on the **pro** plan (so the grid shows available + still-locked cards
 *   side by side — business/enterprise features stay `upgrade-required`, the one add-on
 *   `addon-required`). `error` is handled by the interceptor (it throws a 500 before this runs).
 * - Believable data, not lorem: real owner-facing capabilities (Online Booking, Live Chat, Pop-up
 *   CTAs, Reviews, Multilingual, A/B testing, Member Portal, Priority Support add-on) with concrete
 *   one-line descriptions, spread across categories + plan tiers so every badge, lock card, toggle,
 *   and expert-mode detail renders with real texture.
 */
import type { FixtureFactory, MockState } from './index';
import {
  entitlementFor,
  type EntitlementState,
  type PlanTier,
} from '../../pages/admin/sections/feature-flags/flag-logic';

/**
 * One owner-facing feature as the worker serves it — the `SITE_FEATURE_CATALOG` row
 * (`features.ts:490`) spread with the three server-derived fields (`entitled`/`enabled`/`preview`).
 * Mirrors the component's private `SiteFeature` interface field-for-field.
 */
export interface SiteFeatureRow {
  key: string;
  name: string;
  description: string;
  requiredPlan: PlanTier;
  isAddon: boolean;
  category: string;
  entitled: EntitlementState;
  enabled: boolean;
  preview: boolean;
}

/** The `GET /api/site-features` envelope — `{ features, plan }`, NOT `{ data }`. */
export interface SiteFeaturesResponse {
  features: SiteFeatureRow[];
  plan: PlanTier;
}

/** The plan the populated demo org is on — `pro`, so the grid mixes available + locked cards. */
const DEMO_PLAN: PlanTier = 'pro';

/**
 * The believable catalog SEED — the raw `SITE_FEATURE_CATALOG`-shaped rows plus each feature's
 * demo enable state. `entitled` is NOT stored here: it's derived per-request from the plan (exactly
 * as the worker does), so the lock state always agrees with `requiredPlan` + the response `plan`.
 */
const CATALOG_SEED: ReadonlyArray<{
  key: string;
  name: string;
  description: string;
  requiredPlan: PlanTier;
  isAddon: boolean;
  category: string;
  /** Demo per-site state (tenant override, else registry default). */
  enabled: boolean;
}> = [
  {
    key: 'online_booking',
    name: 'Online Booking',
    description: 'Let visitors book appointments right from your site — synced to your calendar.',
    requiredPlan: 'free',
    isAddon: false,
    category: 'Conversion',
    enabled: true,
  },
  {
    key: 'live_chat',
    name: 'Live Chat',
    description: 'An always-on chat bubble so visitors can ask a question without picking up the phone.',
    requiredPlan: 'free',
    isAddon: false,
    category: 'Engagement',
    enabled: false,
  },
  {
    key: 'popup_cta',
    name: 'Pop-up CTAs',
    description: 'Timed or exit-intent pop-ups that capture leads before a visitor leaves.',
    requiredPlan: 'pro',
    isAddon: false,
    category: 'Conversion',
    enabled: true,
  },
  {
    key: 'reviews_showcase',
    name: 'Reviews Showcase',
    description: 'Pull your Google reviews onto the site automatically and highlight your best ones.',
    requiredPlan: 'pro',
    isAddon: false,
    category: 'Trust',
    enabled: false,
  },
  {
    key: 'multilingual',
    name: 'Multilingual Site',
    description: 'Mirror your pages into Spanish and more so you reach every customer in their language.',
    requiredPlan: 'business',
    isAddon: false,
    category: 'Reach',
    enabled: false,
  },
  {
    key: 'ab_testing',
    name: 'A/B Testing',
    description: 'Try two versions of a headline or hero and let the winning one run automatically.',
    requiredPlan: 'business',
    isAddon: false,
    category: 'Optimization',
    enabled: false,
  },
  {
    key: 'member_portal',
    name: 'Member Portal',
    description: 'A gated area where customers sign in to see bookings, invoices, and private content.',
    requiredPlan: 'enterprise',
    isAddon: false,
    category: 'Advanced',
    enabled: false,
  },
  {
    key: 'priority_support',
    name: 'Priority Support',
    description: 'Jump the queue with a dedicated support line and a one-hour first-response promise.',
    requiredPlan: 'business',
    isAddon: true,
    category: 'Service',
    enabled: false,
  },
];

/**
 * Project a seed row into the exact wire row the worker returns — spreading the catalog fields +
 * the server-derived `entitled` (computed from `plan` the SAME way the handler does via the shared
 * `entitlementFor`), the demo `enabled`, and `preview:false` (the UI owns preview locally).
 */
function toRow(
  seed: (typeof CATALOG_SEED)[number],
  plan: PlanTier,
): SiteFeatureRow {
  return {
    key: seed.key,
    name: seed.name,
    description: seed.description,
    requiredPlan: seed.requiredPlan,
    isAddon: seed.isAddon,
    category: seed.category,
    entitled: entitlementFor({ plan, requiredPlan: seed.requiredPlan, isAddon: seed.isAddon }),
    // A locked feature can never be live — mirror the worker (an under-entitled enable is
    // rejected 403 there), so a non-`available` card never arrives `enabled:true`.
    enabled: seed.enabled && entitlementFor({ plan, requiredPlan: seed.requiredPlan, isAddon: seed.isAddon }) === 'available',
    preview: false,
  };
}

/**
 * Site-features factory. `empty` → `{ features: [], plan: 'free' }` (TODAY's real wire → the
 * component's "all core capabilities built-in" empty state); `loading`/`populated`/default → the
 * believable catalog on the `pro` plan (available + `upgrade-required` + one `addon-required` cards
 * side by side). `error` is handled by the interceptor (throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const siteFeaturesFixture: FixtureFactory<SiteFeaturesResponse> = (
  state: MockState,
): SiteFeaturesResponse => {
  if (state === 'empty') return { features: [], plan: 'free' };
  return { features: CATALOG_SEED.map((s) => toRow(s, DEMO_PLAN)), plan: DEMO_PLAN };
};
