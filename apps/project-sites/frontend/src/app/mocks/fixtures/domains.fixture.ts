/**
 * @module mocks/fixtures/domains
 *
 * @description
 * Mock fixtures for the **Domains admin section** (`pages/admin/sections/domains.component.ts`).
 * That section's render is gated by ONE GET read — the per-site hostname list — plus the
 * org-wide aggregator used by the sites-grouped Settings→Domains view. Both are fixtured
 * here (the domain *summary* read is already mocked in `domains-summary.fixture.ts` — P1 —
 * and is intentionally NOT duplicated).
 *
 * | Route                       | Factory                      | Fired by                                             | Worker contract                                             |
 * | --------------------------- | ---------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
 * | `GET /sites/:id/hostnames`  | {@link siteHostnamesFixture} | Domains §3 "Connected domains" (the render-gating read) | `{ data: Hostname[] }` (`getSiteHostnames`, domains.ts)     |
 * | `GET /admin/domains`        | {@link adminDomainsFixture}  | Settings→Domains sites-grouped aggregator            | `{ data: { sites: [{ site, hostnames: [] }] } }` (handlers) |
 *
 * Both are typed to the EXACT WORKER WIRE shape, so wiring the real endpoint is a provider
 * SWAP, not a rewrite:
 * - `GET /sites/:id/hostnames` → each row is the `getSiteHostnames` projection
 *   `{ id, hostname, type, status, ssl_status, is_primary (0|1), auto_renew (0|1) }`, ordered
 *   `is_primary DESC` (so the primary sorts first — mirrors the SQL `ORDER BY`).
 * - `GET /admin/domains` → `{ data: { sites: [{ site:{id,slug,business_name}, hostnames:[…] }] } }`
 *   where each attached row carries the aggregator's wider projection
 *   (`+ site_id, verification_errors, last_verified_at, created_at`).
 *
 * The component itself needs NO tweak — it already builds every state (loading skeleton,
 * `hostnamesError` Retry card, `No connected domains` empty state, and the populated table);
 * serving the populated list lights up the table + the connected/live count chip, while
 * `state=empty` drives the first-run empty state.
 *
 * @remarks
 * - A per-site fixture is registered under a `:param` PATTERN key, so ONE body serves EVERY
 *   demo site id — the roster below is believable for any selected site (it doesn't hard-code
 *   a single slug; the free subdomain uses a generic demo slug that reads cleanly in the UI).
 * - `populated` keeps the list internally honest: EXACTLY ONE `is_primary === 1` (the backup
 *   free subdomain — the always-on fallback), a mix of `custom_cname` + `free_subdomain`, and
 *   a status in every tone the component colors (`active` → verified, `pending` → amber pulse,
 *   `verification_failed` → red Retry). SSL states vary (`active`/`pending_validation`/`none`).
 * - `state` variants: `empty` (`[]` / no sites — the honest first-run surface), `error`
 *   (interceptor throws a 500 before this runs), `populated`/`loading`/default → the rich mix.
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /sites/:id/hostnames ─────────────────────────

/**
 * One hostname row — the `getSiteHostnames` projection (`src/services/domains.ts`), which is
 * also the superset the component's `Hostname` interface reads. `is_primary`/`auto_renew` are
 * `0 | 1` numbers (the worker `COALESCE`s a missing column to 0 / 1).
 */
export interface HostnameRow {
  readonly id: string;
  readonly hostname: string;
  readonly type: 'free_subdomain' | 'custom_cname';
  readonly status: 'active' | 'pending' | 'verification_failed';
  readonly ssl_status: string;
  readonly is_primary: 0 | 1;
  readonly auto_renew: 0 | 1;
}

/** The `GET /api/sites/:id/hostnames` envelope — the worker wraps the roster in `{ data }`. */
export interface SiteHostnamesResponse {
  data: HostnameRow[];
}

/**
 * A believable connected-domains roster for a demo site, `is_primary DESC` ordered (the
 * primary free subdomain first — mirrors the worker SQL). Spans both types + every status
 * tone + varied SSL so the table, the status badges, the SSL column, the connected/live
 * count chip, and the row actions (Retry on the failed row, Transfer/Remove on the customs)
 * all render with real variety.
 */
const HOSTNAMES: readonly HostnameRow[] = [
  // The always-on backup subdomain — primary, live.
  {
    id: 'hn-001',
    hostname: 'beverwyck-barber.projectsites.dev',
    type: 'free_subdomain',
    status: 'active',
    ssl_status: 'active',
    is_primary: 1,
    auto_renew: 1,
  },
  // A verified custom domain (second, non-primary) — exercises Transfer out + Remove.
  {
    id: 'hn-002',
    hostname: 'beverwyckbarber.com',
    type: 'custom_cname',
    status: 'active',
    ssl_status: 'active',
    is_primary: 0,
    auto_renew: 1,
  },
  // A custom domain mid-provision — amber "pending" pulse + pending SSL.
  {
    id: 'hn-003',
    hostname: 'www.beverwyckbarber.com',
    type: 'custom_cname',
    status: 'pending',
    ssl_status: 'pending_validation',
    is_primary: 0,
    auto_renew: 1,
  },
  // A custom domain that failed verification — red tone + the Retry action.
  {
    id: 'hn-004',
    hostname: 'barbershop.beverwyck.co',
    type: 'custom_cname',
    status: 'verification_failed',
    ssl_status: 'none',
    is_primary: 0,
    auto_renew: 1,
  },
];

/**
 * Per-site hostnames factory. `empty` → an empty roster (the honest "No connected domains"
 * first-run state); `error` is handled by the interceptor (it throws a 500 before this runs);
 * `populated`/`loading`/default → the rich believable roster. Served under a `:param` pattern,
 * so ONE body answers every demo site id.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const siteHostnamesFixture: FixtureFactory<SiteHostnamesResponse> = (
  state: MockState,
): SiteHostnamesResponse => {
  if (state === 'empty') return { data: [] };
  return { data: [...HOSTNAMES] };
};

// ───────────────────────── GET /admin/domains ─────────────────────────

/** A site's identity in the aggregator grouping (`SELECT id, slug, business_name`). */
export interface AdminDomainSite {
  readonly id: string;
  readonly slug: string;
  readonly business_name: string | null;
}

/**
 * One attached hostname row in the aggregator — the wider projection the `/admin/domains`
 * SELECT returns (`id, site_id, hostname, type, status, is_primary, ssl_status,
 * verification_errors, last_verified_at, created_at`).
 */
export interface AdminDomainHostname {
  readonly id: string;
  readonly site_id: string;
  readonly hostname: string;
  readonly type: 'free_subdomain' | 'custom_cname';
  readonly status: string;
  readonly is_primary: 0 | 1;
  readonly ssl_status: string;
  readonly verification_errors: string | null;
  readonly last_verified_at: string | null;
  readonly created_at: string;
}

/** One `{ site, hostnames }` group in the aggregated response. */
export interface AdminDomainGroup {
  readonly site: AdminDomainSite;
  readonly hostnames: AdminDomainHostname[];
}

/** The `GET /api/admin/domains` envelope — org sites each with their hostname rows attached. */
export interface AdminDomainsResponse {
  data: {
    sites: AdminDomainGroup[];
  };
}

/** A recent anchor so `created_at`/`last_verified_at` read as believable ISO timestamps. */
const ANCHOR = Date.parse('2026-10-06T13:00:00Z');

/** Build the org-wide aggregated groups — a few sites, some with attached custom hostnames. */
function buildAdminDomainGroups(): AdminDomainGroup[] {
  const iso = (hoursAgo: number): string => new Date(ANCHOR - hoursAgo * 3_600_000).toISOString();
  return [
    {
      site: { id: 'site-001', slug: 'beverwyck-barber', business_name: 'Beverwyck Barber Co.' },
      hostnames: [
        {
          id: 'hn-002',
          site_id: 'site-001',
          hostname: 'beverwyckbarber.com',
          type: 'custom_cname',
          status: 'active',
          is_primary: 1,
          ssl_status: 'active',
          verification_errors: null,
          last_verified_at: iso(2),
          created_at: iso(240),
        },
        {
          id: 'hn-003',
          site_id: 'site-001',
          hostname: 'www.beverwyckbarber.com',
          type: 'custom_cname',
          status: 'pending',
          is_primary: 0,
          ssl_status: 'pending_validation',
          verification_errors: null,
          last_verified_at: null,
          created_at: iso(6),
        },
      ],
    },
    {
      site: { id: 'site-006', slug: 'old-mill-coffee', business_name: 'Old Mill Coffee House' },
      hostnames: [
        {
          id: 'hn-010',
          site_id: 'site-006',
          hostname: 'oldmillcoffee.co',
          type: 'custom_cname',
          status: 'verification_failed',
          is_primary: 0,
          ssl_status: 'none',
          verification_errors: 'CNAME record not found at the DNS provider.',
          last_verified_at: iso(18),
          created_at: iso(72),
        },
      ],
    },
    // A site with no custom domain yet (free subdomain only — not tracked in `hostnames`).
    {
      site: { id: 'site-002', slug: 'sunset-grove', business_name: 'Sunset Grove Landscaping' },
      hostnames: [],
    },
  ];
}

const ADMIN_DOMAIN_GROUPS: readonly AdminDomainGroup[] = buildAdminDomainGroups();

/**
 * Org-wide domains aggregator factory. `empty` → `{ sites: [] }` (no sites in the org yet);
 * `error` is handled by the interceptor; `populated`/`loading`/default → a few sites, some
 * with attached custom hostnames spanning active/pending/failed, and one free-only site with
 * an empty `hostnames` list.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const adminDomainsFixture: FixtureFactory<AdminDomainsResponse> = (
  state: MockState,
): AdminDomainsResponse => {
  if (state === 'empty') return { data: { sites: [] } };
  return { data: { sites: ADMIN_DOMAIN_GROUPS.map((g) => ({ ...g, hostnames: [...g.hostnames] })) } };
};
