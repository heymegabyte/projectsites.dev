/**
 * @file Per-site DATA BROWSER whitelist + helpers — powers the bolt.diy editor's
 * Data workbench tab (`app/components/workbench/DataPanel.tsx`) via the admin
 * `PS_DATA` bridge (`PS_DATA_REQUEST` → admin `GET /api/sites/:id/data-overview[/:table]`
 * → `PS_DATA_RESPONSE`).
 *
 * @remarks
 * AL-520: the DataPanel + the admin bridge (`bolt-embed.service.ts`) both shipped
 * (2026-09-08) but the WORKER server leg was never implemented — every Data-tab
 * request 404'd, so the tab was built-but-unwired (lying-connected). This module is
 * the SSOT for which per-site tables the owner may browse.
 *
 * SECURITY: the table name AND the selected columns come ONLY from this fixed
 * constant — never from client input — so the handler can safely interpolate them
 * into SQL (the `:table` path param is matched against `key` before use). Values
 * (site_id, limit) are always parameterized. Column lists are curated to exclude
 * blobs (`payload`, `metadata`) and PII-heavy fields (`ip_address`, `user_agent`).
 * All 6 tables verified against prod D1 to carry `site_id` + `created_at` (2026-09-14).
 */

/** One browsable per-site table: its real name, display copy, and safe column list. */
export interface SiteDataTableSpec {
  /** Stable key used in the `:table` path param + `data-testid`. */
  readonly key: string;
  /** Real D1 table name (trusted — never client-derived). */
  readonly table: string;
  /** Human label shown in the panel. */
  readonly label: string;
  /** One-line description of what the table holds. */
  readonly description: string;
  /** Curated, safe SELECT columns (no blobs / PII-heavy fields). First-class trusted. */
  readonly columns: readonly string[];
}

/**
 * The fixed set of per-site tables the Data tab may browse. Ordered by how central
 * each is to a typical site owner (analytics + form entries first).
 */
export const SITE_DATA_TABLES: readonly SiteDataTableSpec[] = [
  {
    columns: ['id', 'event_type', 'path', 'referrer', 'created_at'],
    description: 'Pageviews and tracked events from your live site.',
    key: 'visitor_events',
    label: 'Visitor Events',
    table: 'visitor_events',
  },
  {
    columns: ['id', 'form_name', 'email', 'status', 'origin_url', 'created_at'],
    description: 'Contact and lead-form entries visitors sent you.',
    key: 'form_submissions',
    label: 'Form Submissions',
    table: 'form_submissions',
  },
  {
    columns: ['id', 'name', 'email', 'phone', 'source_form', 'status', 'created_at'],
    description: 'Captured leads with contact details and status.',
    key: 'leads',
    label: 'Leads',
    table: 'leads',
  },
  {
    columns: ['id', 'email', 'segment', 'confirmed', 'unsubscribed', 'created_at'],
    description: 'Email newsletter sign-ups and segments.',
    key: 'newsletter_subscribers',
    label: 'Subscribers',
    table: 'newsletter_subscribers',
  },
  {
    columns: ['id', 'visitor_name', 'visitor_email', 'status', 'created_at'],
    description: 'Appointment and booking requests.',
    key: 'booking_appointments',
    label: 'Bookings',
    table: 'booking_appointments',
  },
  {
    columns: ['id', 'snapshot_name', 'build_version', 'description', 'created_at'],
    description: 'Saved versions of your site build.',
    key: 'site_snapshots',
    label: 'Snapshots',
    table: 'site_snapshots',
  },
];

/**
 * Resolve a client-supplied table key to its trusted spec, or `null` if the key is
 * not whitelisted. The `null` return is the injection guard — a handler MUST 404 on
 * it and NEVER touch the raw key again.
 *
 * @param key - The `:table` path param from the request.
 * @returns The matching {@link SiteDataTableSpec}, or `null` when not whitelisted.
 *
 * @example resolveSiteDataTable('form_submissions') // → { key: 'form_submissions', ... }
 * @example resolveSiteDataTable('users; DROP TABLE') // → null
 */
export function resolveSiteDataTable(key: string | undefined | null): SiteDataTableSpec | null {
  if (typeof key !== 'string') return null;
  return SITE_DATA_TABLES.find((t) => t.key === key) ?? null;
}

/**
 * Clamp a raw `limit` query value into the safe browse window: 1–100, default 25.
 * Non-numeric / missing input falls back to the default.
 *
 * @param raw - The raw `limit` query string (or undefined).
 * @returns An integer in [1, 100].
 *
 * @example clampDataLimit('25')   // → 25
 * @example clampDataLimit('9999') // → 100
 * @example clampDataLimit(undefined) // → 25
 */
export function clampDataLimit(raw: string | undefined | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(Math.floor(n), 100);
}

/**
 * Build the trusted comma-separated column list for a table's browse SELECT. Every
 * name comes from the fixed whitelist, so the result is safe to interpolate into SQL.
 *
 * @param spec - A trusted {@link SiteDataTableSpec}.
 * @returns e.g. `"id, form_name, email, status, origin_url, created_at"`.
 *
 * @example siteDataColumnsSql(SITE_DATA_TABLES[1]) // → 'id, form_name, email, status, origin_url, created_at'
 */
export function siteDataColumnsSql(spec: SiteDataTableSpec): string {
  return spec.columns.join(', ');
}
