/**
 * @module mocks/fixtures/audit
 *
 * @description
 * Mock fixture for the admin AUDIT surface (`GET /api/audit-logs`) — the forensics
 * grid at `/admin/audit` and the "Audit Trail" tab inside `/admin/logs`. Typed to the
 * EXACT worker response contract traced in `libs/features/audit_logs/handlers.ts`:
 *
 * ```
 * { data: AuditRow[],
 *   meta: { limit, offset, total, has_more,
 *           stats: { unique_actions, actors, last_24h } } }
 * ```
 *
 * so when the real endpoint serves the data it's a provider SWAP, not a rewrite. The
 * component (`audit.component.ts`) reads `r.data` for the TanStack grid and
 * `r.meta.total` + `r.meta.stats` for the four KPI cards (Events · Unique actions ·
 * Last 24h · Actors) — the stats are the worker's TRUE full-set aggregates, computed
 * over the WHOLE store and independent of the ≤500-row page (so the cards never
 * undercount past the cap). The fixture mirrors that exactly.
 *
 * @remarks
 * - Believable forensic data, not lorem: 36 rows spanning the real privileged-action
 *   vocabulary (deploys, hostname changes, billing edits, MCP connects, member invites,
 *   logins, resets, an editor runtime error, system cron rows) across three demo sites,
 *   a mix of human actors + a null `system` actor, and a mix of rich metadata + bare
 *   rows — so every column, the actor/`—` fallback, the site filter, and the
 *   syntax-highlighted metadata detail panel all render with real variety.
 * - Honors `offset`/`limit` exactly like the worker's handler: returns the matching
 *   page SLICE, but `total` + `stats` are ALWAYS the full-store aggregates and
 *   `has_more = offset + page.length < total`. The component loads `limit=500` (no
 *   offset), so the default is the whole store in one page.
 * - `stats` are DERIVED from the row set (never hand-tallied) so they can't drift:
 *   `unique_actions` = distinct `action`, `actors` = distinct `actor_id`, `last_24h` =
 *   rows within 24h of now. Rows are dated relative to `Date.now()` so "Last 24h" is
 *   always a live, believable subset.
 * - `state` variants: `empty` (0 rows, 0 stats — a brand-new org's honest audit log),
 *   `error` (interceptor throws a 500 before this runs), `populated`/`loading`/default
 *   (the full store). Every state is reachable with `?mock=1&state=…`.
 */
import type { FixtureFactory, MockState } from './index';

/**
 * One audit row — mirrors the worker's SELECT projection AND the admin component's
 * local `AuditRow` interface (`audit.component.ts`). `metadata` is a parsed OBJECT (or
 * null) — the worker `JSON.parse`s `metadata_json` before responding, so the FE never
 * sees the raw string. Every text field is nullable (org-level rows have no site,
 * system rows have no actor, in-flight rows may lack a message).
 */
export interface AuditRowFixture {
  id: string;
  action: string;
  message: string | null;
  target_type: string | null;
  target_id: string | null;
  actor_id: string | null;
  metadata: Record<string, unknown> | null;
  request_id: string | null;
  created_at: string;
  site: string | null;
}

/** The `meta.stats` block — worker's full-set aggregates (NOT the loaded page). */
export interface AuditStats {
  unique_actions: number;
  actors: number;
  last_24h: number;
}

/** The `GET /api/audit-logs` envelope — `data` page + `meta` (full-set total/stats). */
export interface AuditLogsResponse {
  data: AuditRowFixture[];
  meta: {
    limit: number;
    offset: number;
    total: number;
    has_more: boolean;
    stats: AuditStats;
  };
}

/** Default page size — mirrors the worker's cap + the component's `limit=500` load. */
const DEFAULT_LIMIT = 500;

/** The full believable audit store, newest-first (worker orders `created_at DESC`). */
const ROWS: readonly AuditRowFixture[] = buildRows();

/**
 * The audit fixture factory. Reads the request's `offset`/`limit` and returns the
 * matching page SLICE plus the full-store `total` + `stats`, exactly like the worker.
 * `empty` → 0 rows + 0 stats; `error` is handled by the interceptor (it throws a 500
 * before calling this). `populated`/`loading`/default → the full store.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 * @param query - Parsed query params from the request URL (for offset/limit).
 */
export const auditFixture: FixtureFactory<AuditLogsResponse> = (
  state: MockState,
  query: URLSearchParams,
): AuditLogsResponse => {
  const rows = state === 'empty' ? [] : ROWS;
  const total = rows.length;

  // Honor offset/limit the same way the worker's handler does: clamp limit to [1,500],
  // offset to [0,total]; a fresh component load sends limit=500 + no offset → whole store.
  const limit = clampInt(query.get('limit'), DEFAULT_LIMIT, 1, 500);
  const offset = clampInt(query.get('offset'), 0, 0, total);
  const slice = rows.slice(offset, offset + limit);

  return {
    data: [...slice],
    meta: {
      limit,
      offset,
      total,
      has_more: offset + slice.length < total,
      stats: computeStats(rows),
    },
  };
};

/**
 * Full-set aggregates DERIVED from the row set (never hand-tallied), so they match
 * whatever `buildRows` produces and can't drift. `unique_actions` = distinct `action`;
 * `actors` = distinct `actor_id` (the `system`/null actor counts as one bucket, which
 * is how the KPI card presents it); `last_24h` = rows created within the last 24h.
 */
function computeStats(rows: readonly AuditRowFixture[]): AuditStats {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return {
    unique_actions: new Set(rows.map((r) => r.action)).size,
    actors: new Set(rows.map((r) => r.actor_id)).size,
    last_24h: rows.filter((r) => Date.parse(r.created_at) >= cutoff).length,
  };
}

/** Parse a query-param int with a default + clamp; non-numeric → the default. */
function clampInt(raw: string | null, dflt: number, min: number, max: number): number {
  const n = raw == null ? dflt : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

/**
 * Build the 36-row believable audit store (pure; deterministic). Rows are dated
 * backwards from `Date.now()` so "Last 24h" is always a live, plausible subset and
 * the newest-first ordering is organic. Spans the real privileged-action vocabulary,
 * three demo sites, human + system actors, and a mix of rich/absent metadata.
 */
function buildRows(): AuditRowFixture[] {
  // [action, minutesAgo, actor|null, site|null, targetType|null, targetId|null, message|null, metadata|null]
  type Seed = [
    string,
    number,
    string | null,
    string | null,
    string | null,
    string | null,
    string | null,
    Record<string, unknown> | null,
  ];

  const ACTOR_AVA = 'ava-chen';
  const ACTOR_MARCUS = 'marcus-lee';
  const ACTOR_PRIYA = 'priya-nadar';
  const SITE_VITOS = 'vitos-mens-salon';
  const SITE_MAPLE = 'maple-and-main-bakery';
  const SITE_HARBOR = 'harbor-point-plumbing';

  const seeds: Seed[] = [
    // Newest first. A dense, varied forensic timeline a real operator would recognize.
    ['site.deployed', 4, ACTOR_AVA, SITE_VITOS, 'site', 'site-vitos', "Deployed “Vito's Mens Salon” to production", { version: 'v47', duration_ms: 18342, trigger: 'editor' }],
    ['hostname.primary_changed', 11, ACTOR_AVA, SITE_VITOS, 'hostname', 'hn-0xA19', "Set vitosmens.com as the primary hostname", { from: 'vitos-mens-salon.projectsites.dev', to: 'vitosmens.com' }],
    ['billing.subscription_updated', 23, ACTOR_MARCUS, null, 'subscription', 'sub_1PsDemo', 'Upgraded the organization to the Paid plan', { from_plan: 'free', to_plan: 'paid', seats: 10 }],
    ['mcp.connected', 38, ACTOR_PRIYA, SITE_MAPLE, 'mcp_connection', 'mcp-stripe-01', "Connected Stripe to “Maple & Main Bakery”", { provider: 'stripe', scopes: ['read_write'] }],
    ['member.invited', 52, ACTOR_MARCUS, null, 'user', 'user-invite-7', 'Invited priya@maple-main.test as an Admin', { email: 'priya@maple-main.test', role: 'admin' }],
    ['site.published', 67, ACTOR_PRIYA, SITE_MAPLE, 'site', 'site-maple', "Published “Maple & Main Bakery”", { version: 'v12' }],
    ['auth.login', 74, ACTOR_AVA, null, 'session', 'sess-9f21', 'Signed in via Google', { method: 'google_oauth', ip_city: 'Newark, NJ' }],
    ['domain.purchased', 96, ACTOR_AVA, SITE_VITOS, 'domain', 'dom-vitosmens', 'Purchased vitosmens.com (1 yr)', { registrar: 'cloudflare', years: 1, price_usd: 10.11 }],
    ['site.reset', 118, ACTOR_PRIYA, SITE_HARBOR, 'site', 'site-harbor', "Reset “Harbor Point Plumbing” for a full rebuild", { reason: 'owner_requested' }],
    ['editor.runtime_error', 133, null, SITE_HARBOR, 'editor', 'site-harbor', 'Editor runtime error: Cannot read properties of undefined', { code: 'TypeError', file: 'src/App.tsx', line: 214 }],
    ['hostname.provisioned', 155, ACTOR_AVA, SITE_VITOS, 'hostname', 'hn-0xB07', 'Provisioned the custom hostname vitosmens.com', { ssl_status: 'pending_validation' }],
    ['billing.topup', 171, ACTOR_MARCUS, null, 'wallet', 'wtx-5001', 'Added $50.00 of build credit', { amount_cents: 5000, brand: 'visa', last4: '4242' }],
    ['form.submission_received', 188, null, SITE_MAPLE, 'form_submission', 'sub-3321', 'New contact-form submission on Maple & Main', { name: 'Dana R.', intent: 'catering_quote' }],
    ['mcp.disconnected', 204, ACTOR_PRIYA, SITE_MAPLE, 'mcp_connection', 'mcp-resend-04', "Disconnected Resend from “Maple & Main Bakery”", { provider: 'resend' }],
    ['site.deployed', 221, ACTOR_PRIYA, SITE_HARBOR, 'site', 'site-harbor', "Deployed “Harbor Point Plumbing” to production", { version: 'v3', duration_ms: 20514 }],
    ['member.role_changed', 239, ACTOR_MARCUS, null, 'user', 'user-ava', "Changed Ava Chen's role to Owner", { from: 'admin', to: 'owner' }],
    ['auth.login', 258, ACTOR_PRIYA, null, 'session', 'sess-7c03', 'Signed in via magic link', { method: 'magic_link', ip_city: 'Summit, NJ' }],
    ['settings.updated', 276, ACTOR_AVA, SITE_VITOS, 'site', 'site-vitos', 'Updated business hours + contact details', { fields: ['hours', 'phone'] }],
    ['snapshot.created', 294, null, SITE_VITOS, 'snapshot', 'snap-init', "Auto-created the “initial” snapshot", { label: 'initial', auto: true }],
    ['domain.search', 312, ACTOR_AVA, SITE_VITOS, null, null, null, { query: 'vitos', results: 14 }],
    ['billing.portal_opened', 331, ACTOR_MARCUS, null, 'subscription', 'sub_1PsDemo', 'Opened the Stripe billing portal', null],
    ['hostname.unsubscribed', 352, ACTOR_AVA, SITE_VITOS, 'hostname', 'hn-0xA14', 'Removed an old hostname', { hostname: 'vitos-old.projectsites.dev' }],
    ['site.deleted', 371, ACTOR_MARCUS, null, 'site', 'site-oldtest', 'Deleted an abandoned draft site', { slug: 'test-draft-01' }],
    ['ai.prompt_improved', 389, ACTOR_PRIYA, SITE_MAPLE, 'site', 'site-maple', 'Improved the build prompt with AI', null],
    ['form.submission_received', 408, null, SITE_HARBOR, 'form_submission', 'sub-3301', 'New contact-form submission on Harbor Point', { name: 'Luis M.', intent: 'emergency_repair' }],
    ['member.removed', 427, ACTOR_MARCUS, null, 'user', 'user-temp', 'Removed a temporary contractor seat', { email: 'contractor@tmp.test' }],
    ['auth.logout', 446, ACTOR_AVA, null, 'session', 'sess-9f21', 'Signed out', null],
    ['site.published', 466, ACTOR_AVA, SITE_VITOS, 'site', 'site-vitos', "Published “Vito's Mens Salon”", { version: 'v46' }],
    ['mcp.connected', 487, ACTOR_AVA, SITE_VITOS, 'mcp_connection', 'mcp-cal-02', "Connected Google Calendar to “Vito's Mens Salon”", { provider: 'google_calendar' }],
    ['env_var.created', 509, ACTOR_PRIYA, SITE_MAPLE, 'env_var', 'ev-0x31', 'Added a site env var OVEN_API_KEY', { scope: 'site', key: 'OVEN_API_KEY' }],
    // A few rows OLDER than 24h so "Last 24h" is a strict subset (not all rows).
    ['billing.subscription_updated', 1600, ACTOR_MARCUS, null, 'subscription', 'sub_1PsDemo', 'Started the Paid trial', { from_plan: 'free', to_plan: 'trialing' }],
    ['site.deployed', 1900, ACTOR_AVA, SITE_VITOS, 'site', 'site-vitos', "Deployed “Vito's Mens Salon” to production", { version: 'v45', duration_ms: 17110 }],
    ['auth.login', 2400, ACTOR_MARCUS, null, 'session', 'sess-4a88', 'Signed in via Google', { method: 'google_oauth', ip_city: 'Hoboken, NJ' }],
    ['snapshot.created', 2900, null, SITE_MAPLE, 'snapshot', 'snap-pre-launch', 'Auto-created the “pre-launch” snapshot', { label: 'pre-launch', auto: true }],
    ['site.created', 3600, ACTOR_PRIYA, SITE_HARBOR, 'site', 'site-harbor', "Created “Harbor Point Plumbing” from search", { place_id: 'ChIJdemo_harbor', source: 'google_places' }],
    ['org.created', 4320, ACTOR_MARCUS, null, 'org', 'org-mock-0001', 'Created the organization', { name: 'Beverwyck Demo Co.' }],
  ];

  return seeds.map((s, i) => {
    const [action, minutesAgo, actor_id, site, target_type, target_id, message, metadata] = s;
    return {
      id: `audit-${String(i + 1).padStart(3, '0')}`,
      action,
      message,
      target_type,
      target_id,
      actor_id,
      metadata,
      // request_id present on most rows (the forensic norm); a couple null for variety.
      request_id: i % 7 === 6 ? null : `req-${(0x4f21a + i * 977).toString(16)}`,
      created_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
      site,
    };
  });
}
