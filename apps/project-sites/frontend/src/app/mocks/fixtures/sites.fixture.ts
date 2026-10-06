/**
 * @module mocks/fixtures/sites
 *
 * @description
 * Mock fixture for the admin site roster (`GET /api/sites`). This is the KEYSTONE P1
 * read: {@link import('../../pages/admin/admin-state.service').AdminStateService} forkJoins
 * it (with the domain summary, subscription + `/auth/me`) in `loadData`, and the Dashboard
 * and Sites-list sections are PURE consumers of `state.sites()` — so serving this fixture
 * lights up the entire admin shell + dashboard + sites grid on mock data.
 *
 * Typed to the EXACT worker response contract — `{ data: Site[] }` (see `GET /api/sites`
 * in `src/routes/api.ts`; `Site` mirrors `services/api.service.ts`) — so wiring the real
 * endpoint is a provider SWAP, not a rewrite.
 *
 * @remarks
 * - Believable multi-site roster (8 sites), newest-first (the UI shows recency), spanning
 *   EVERY `getStatusClass` bucket the Dashboard + Sites grid color/animate against:
 *   `published` (Live), an in-flight `generating`/`collecting`/`queued` (amber pulse),
 *   `error` (red), and `draft` — so every status chip + the building-pulse branch renders.
 * - A paid site carries a real `primary_hostname` (custom domain) + `plan:'paid'`; free
 *   sites fall back to the `{slug}.projectsites.dev` default (no `primary_hostname`) so
 *   `getSiteUrl` + the plan badge exercise both paths.
 * - `state` variants: `empty` (0 sites → the first-run empty state), `error` (interceptor
 *   throws a 500 before this runs), `populated`/`loading` → the full roster.
 */
import type { Site } from '../../services/api.service';
import type { FixtureFactory, MockState } from './index';

/** The `GET /api/sites` envelope — the worker wraps the roster in `{ data }`. */
export interface SitesListResponse {
  data: Site[];
}

/**
 * The sites fixture factory. `empty` → an empty roster (first-run state); `error` is
 * handled by the interceptor (it throws a 500 before calling this);
 * `populated`/`loading`/default → the full believable roster.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const sitesFixture: FixtureFactory<SitesListResponse> = (
  state: MockState,
): SitesListResponse => {
  if (state === 'empty') return { data: [] };
  return { data: SITES };
};

/**
 * 8 believable sites, newest-first, spanning every status + both plan tiers.
 * `[slug, business_name, address, status, plan, primary_hostname|null, buildVersion|null,
 *  phone|null, website|null]`, with `created_at`/`updated_at` descending from a recent anchor.
 */
const SITES: Site[] = buildSites();

/** Build the believable site roster (pure; deterministic). */
function buildSites(): Site[] {
  type Seed = [
    slug: string,
    businessName: string,
    address: string,
    status: string,
    plan: string,
    primaryHostname: string | null,
    buildVersion: number | null,
    phone: string | null,
    website: string | null,
  ];
  const seeds: Seed[] = [
    ['beverwyck-barber', "Beverwyck Barber Co.", '12 Beverwyck Rd, Lake Hiawatha, NJ 07034', 'published', 'paid', 'beverwyckbarber.com', 7, '+1 973-555-0148', 'https://beverwyckbarber.com'],
    ['sunset-grove', 'Sunset Grove Landscaping', '88 Valley Rd, Montclair, NJ 07042', 'published', 'free', null, 4, '+1 973-555-0192', null],
    ['maple-and-main', 'Maple & Main Bakery', '5 Springfield Ave, Summit, NJ 07901', 'generating', 'paid', null, null, '+1 908-555-0176', null],
    ['riverside-yoga', 'Riverside Yoga Studio', '240 Newark Ave, Jersey City, NJ 07302', 'collecting', 'free', null, null, '+1 201-555-0198', null],
    ['ironbound-auto', 'Ironbound Auto Detailing', '355 Ferry St, Newark, NJ 07105', 'error', 'free', null, 2, '+1 973-555-0121', null],
    ['old-mill-coffee', 'Old Mill Coffee House', '19 North Ave W, Cranford, NJ 07016', 'published', 'paid', 'oldmillcoffee.co', 5, '+1 908-555-0103', 'https://oldmillcoffee.co'],
    ['luna-nail-lounge', 'Luna Nail Lounge', '402 Main St, Hackensack, NJ 07601', 'draft', 'free', null, null, '+1 201-555-0142', null],
    ['brightside-hvac', 'Brightside HVAC', '77 Stelton Rd, Piscataway, NJ 08854', 'published', 'free', null, 3, '+1 732-555-0128', null],
  ];

  const anchor = Date.parse('2026-10-06T13:00:00Z');
  return seeds.map((s, i) => {
    const [slug, business_name, business_address, status, plan, primary_hostname, buildVersion, phone, website] = s;
    const created = new Date(anchor - (i + 3) * 36 * 60 * 60 * 1000).toISOString();
    // Updated more recently than created (a live/in-flight site churns).
    const updated = new Date(anchor - i * 42 * 60 * 1000).toISOString();
    const site: Site = {
      id: `site-${String(i + 1).padStart(3, '0')}`,
      slug,
      business_name,
      business_address,
      status,
      plan,
      created_at: created,
      updated_at: updated,
    };
    if (primary_hostname) site.primary_hostname = primary_hostname;
    if (buildVersion != null) site.current_build_version = buildVersion;
    if (phone) site.business_phone = phone;
    if (website) site.business_website = website;
    return site;
  });
}
