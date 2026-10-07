/**
 * @module mocks/fixtures/user-settings
 *
 * @description
 * Mock fixtures for the admin **User settings** section
 * (`pages/admin/sections/user-settings.component.ts`) — the per-PERSON (not org, not project)
 * control surface: Profile · Theme · API keys · Active sessions · Notifications · Danger zone.
 * On `ngOnInit` the component fires FOUR load-time reads:
 *
 * | Registry key                 | Factory                      | Fired by (user-settings.component.ts)        | Transport / Worker contract (traced)                                 |
 * | ---------------------------- | ---------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
 * | `GET /auth/me`               | — (already `admin-me.fixture`) | `loadServerDisplayName` (:1193, HttpClient)  | `{ data: { …, display_name } }` — **NOT duplicated here**            |
 * | `GET /admin/api-keys`        | {@link apiKeysFixture}       | `loadApiKeys` (:1261, ApiService)            | `{ data: ApiKeyRow[] }` (`libs/features/api_keys/handlers.ts:75`)    |
 * | `GET /admin/sessions`        | {@link sessionsFixture}      | `loadSessions` (:1462, raw HttpClient)       | `{ data: UserSessionRow[] }` (`ai_admin.ts:675` → `auth.ts:1057`)    |
 * | `GET /admin/notifications`   | {@link notificationPrefsFixture} | `hydrateNotificationPrefs` (:1674, ApiService) | `{ data: { prefs: Record<string,boolean> } }` (`api.ts:4577`)   |
 *
 * **Transport note (HttpClient vs native fetch):** ALL four reads use Angular `HttpClient` — three
 * via `ApiService` (`/admin/api-keys`, `/admin/notifications`) and two via raw `this.http.get`
 * (`/auth/me`, `/admin/sessions`). NONE use native `window.fetch`. So the P0–P2d `HttpInterceptor`
 * seam covers every one of them (the native-fetch shim, also live, is not needed for this section —
 * but harms nothing). The raw-HttpClient reads still pass THROUGH the interceptor, so they're mocked.
 *
 * **Flag-gating:** NONE of these reads is feature-flag-gated. `api_keys` handlers require only
 * org+user context (`need(c)`, no `requireFlag`); `GET /admin/sessions` (`ai_admin.ts`) and
 * `GET /admin/notifications` (`api.ts`) require only a `userId`. So the User-settings section
 * renders FULLY on `?mock=1` with NO flag flip.
 *
 * @remarks
 * - Believable data, not lorem: two named API keys (one with a soon expiry + a recent "last used",
 *   one freshly-rotated never-used) matching the demo barber-shop owner, a realistic 3-device
 *   session list (this Mac + an iPhone + a stale Windows login to revoke), and a notification-pref
 *   map that flips a couple of the component's defaults so the toggles visibly reflect server state.
 * - `state` variants: `empty` → the honest brand-new-account surface (no keys → the "Generate your
 *   first key" launchpad · only the current session · an empty pref map → the component keeps its
 *   on-by-default toggles); `error` is handled by the interceptor (it throws a 500 before these
 *   run); `populated`/`loading`/default → the rich believable set.
 * - Every registry key here is a STATIC key (no `:param`) — these are account-level, not per-site.
 * - The owner identity (ids / emails / the `created_by`) mirrors the shared demo org used by
 *   `admin-me.fixture` + `settings.fixture` (one coherent person across the whole demo).
 */
import type { FixtureFactory, MockState } from './index';

/** A recent anchor so timestamps read as believable ISO strings (mirrors settings.fixture's ANCHOR). */
const ANCHOR = Date.parse('2026-10-06T13:00:00Z');
const iso = (hoursAgo: number): string => new Date(ANCHOR - hoursAgo * 3_600_000).toISOString();

// ───────────────────────── GET /admin/api-keys ─────────────────────────

/**
 * One row of the `GET /api/admin/api-keys` body — the projection the worker returns under `{ data }`
 * (`libs/features/api_keys/handlers.ts:83`). The handler `SELECT`s the raw columns
 * (`id, name, prefix, scopes_json, last_used_at, expires_at, created_at, revoked_at`) and augments
 * each row with a parsed `scopes` array + a computed `active` boolean. The component's `ApiKeyRow`
 * reads `id/name/prefix/scopes/last_used_at/expires_at/rotated_at?/active`; the fixture carries the
 * full wire row (raw cols included) so wiring the real endpoint is a pure provider SWAP. (`rotated_at`
 * is not a worker column — the component treats it as optional; omitting it renders the "—" cell.)
 */
export interface ApiKeyWireRow {
  id: string;
  name: string;
  prefix: string;
  /** The raw JSON-text column the worker SELECTs (the component ignores it, reading `scopes`). */
  scopes_json: string | null;
  /** Parsed scope list the worker adds alongside the raw column. */
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  /** Worker-computed: not revoked AND (no expiry OR expiry in the future). */
  active: boolean;
}

/** The `GET /api/admin/api-keys` envelope — the worker wraps the rows in `{ data }`. */
export interface ApiKeysResponse {
  data: ApiKeyWireRow[];
}

/** Build one believable key row, computing `active` the same way the worker does. */
function apiKey(
  id: string,
  name: string,
  prefix: string,
  scopes: string[],
  lastUsedAt: string | null,
  expiresAt: string | null,
  createdAt: string,
  revokedAt: string | null = null,
): ApiKeyWireRow {
  const active = !revokedAt && (!expiresAt || new Date(expiresAt).getTime() > ANCHOR);
  return {
    id,
    name,
    prefix,
    scopes_json: JSON.stringify(scopes),
    scopes,
    last_used_at: lastUsedAt,
    expires_at: expiresAt,
    created_at: createdAt,
    revoked_at: revokedAt,
    active,
  };
}

/**
 * A believable key set, newest-first (the worker orders by `created_at DESC`): a live CI key used
 * recently with a soon-ish expiry, a long-lived "local dev" key, and a REVOKED legacy key (so the
 * table's revoked-row styling + the "Revoked" status pill render). `expires_at` dates sit in the
 * future relative to the ANCHOR so `active` + `showKeyExpiry` read correctly.
 */
const POPULATED_API_KEYS: readonly ApiKeyWireRow[] = [
  apiKey('key-mock-0001', 'CI deploy', 'psk_live_7f3a', ['read', 'write'], iso(5), iso(-2136), iso(240)),
  apiKey('key-mock-0002', 'Local dev', 'psk_live_b21c', ['read'], iso(72), null, iso(1440)),
  apiKey('key-mock-0003', 'Legacy backup (2025)', 'psk_live_0d9e', ['read', 'write'], iso(4320), iso(-1416), iso(8760), iso(2160)),
];

/**
 * API-keys factory. `empty` → `{ data: [] }` (no keys → the component's "Generate your first key"
 * launchpad empty state); `populated`/`loading`/default → the believable set above. `error` is
 * handled by the interceptor (it throws a 500 before this runs).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const apiKeysFixture: FixtureFactory<ApiKeysResponse> = (state: MockState): ApiKeysResponse => ({
  data: state === 'empty' ? [] : POPULATED_API_KEYS.map((k) => ({ ...k, scopes: [...k.scopes] })),
});

// ───────────────────────── GET /admin/sessions ─────────────────────────

/**
 * One row of the `GET /api/admin/sessions` body — the `UserSessionRow` the worker returns under
 * `{ data }` (`ai_admin.ts:675` → `listUserSessions`, `auth.ts:1057`). Device/browser/os are parsed
 * from the stored `device_info`; `location` is the row's `ip_address`; `current` flags the caller's
 * own session (token-hash match). Every field is OPTIONAL on the wire except `id` (matches the
 * component's `SessionRow`); the component falls back to "Unknown device"/"Unknown location" when a
 * field is absent, so the fixture carries them all for believable rows.
 */
export interface SessionWireRow {
  id: string;
  device?: string;
  browser?: string;
  os?: string;
  location?: string;
  last_active_at?: string;
  current?: boolean;
}

/** The `GET /api/admin/sessions` envelope — the worker wraps the rows in `{ data }`. */
export interface SessionsResponse {
  data: SessionWireRow[];
}

/** The caller's own session — always present so the panel never looks blank + `current` is set. */
const CURRENT_SESSION: SessionWireRow = {
  id: 'ses-mock-current',
  device: 'Desktop',
  browser: 'Chrome',
  os: 'macOS',
  location: 'Newark, NJ',
  last_active_at: iso(0),
  current: true,
};

/**
 * A believable multi-device list, most-recently-active first (the worker orders by `last_active_at
 * DESC`): this Mac (current), a recent iPhone, and a stale Windows login the owner would want to
 * revoke. The two non-current rows drive the per-row "Revoke" buttons + the "Revoke N other
 * sessions" affordance (so `otherSessionsCount()` reads 2).
 */
const POPULATED_SESSIONS: readonly SessionWireRow[] = [
  CURRENT_SESSION,
  {
    id: 'ses-mock-0002',
    device: 'Mobile',
    browser: 'Safari',
    os: 'iOS',
    location: 'Lake Hiawatha, NJ',
    last_active_at: iso(6),
    current: false,
  },
  {
    id: 'ses-mock-0003',
    device: 'Desktop',
    browser: 'Firefox',
    os: 'Windows',
    location: 'Jersey City, NJ',
    last_active_at: iso(52),
    current: false,
  },
];

/**
 * Sessions factory. `empty` → ONLY the current session (`otherSessionsCount()` → 0, so the
 * "Revoke other sessions" affordance hides — the honest "just this device" surface); `populated`/
 * `loading`/default → the 3-device list. `error` is handled by the interceptor.
 *
 * NOTE a non-empty list always INCLUDES the current session (the component shows the real list
 * verbatim when non-empty, and only synthesizes a fallback current-device row when the list is
 * EMPTY or the read fails — so the fixture must carry its own `current: true` row to match prod).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const sessionsFixture: FixtureFactory<SessionsResponse> = (state: MockState): SessionsResponse => ({
  data: state === 'empty' ? [{ ...CURRENT_SESSION }] : POPULATED_SESSIONS.map((s) => ({ ...s })),
});

// ───────────────────────── GET /admin/notifications ─────────────────────────

/**
 * The `GET /api/admin/notifications` body — the worker returns the per-user pref map under
 * `{ data: { prefs } }` (`api.ts:4577`; the stored value is the bare `Record<string, boolean>`
 * validated by `NotificationPrefsMapSchema`). The component applies this map OVER its default
 * groups by pref id, leaving any id the server hasn't seen at its default — so the keys here mirror
 * the component's six default pref ids (`product.weekly`, `product.changelog`, `security.signin`,
 * `security.keys`, `billing.invoices`, `billing.failures`). (The two `security.*` prefs are locked
 * "always on" in the UI — the component ignores a server "off" for them, so their value is moot;
 * the fixture keeps them `true` to mirror an honest store.)
 */
export interface NotificationPrefsResponse {
  data: { prefs: Record<string, boolean> };
}

/**
 * A believable saved pref map that DIFFERS from the component defaults (which are all-on) so the
 * cross-device hydrate visibly changes the toggles: the owner muted the weekly summary + invoice
 * receipts, everything else on. Mirrors the component's six pref ids exactly.
 */
const POPULATED_PREFS: Record<string, boolean> = {
  'product.weekly': false,
  'product.changelog': true,
  'security.signin': true,
  'security.keys': true,
  'billing.invoices': false,
  'billing.failures': true,
};

/**
 * Notification-prefs factory. `empty` → `{ data: { prefs: {} } }` (an empty map — the component's
 * hydrate no-ops on an empty object, keeping its on-by-default toggles, the honest never-saved
 * surface); `populated`/`loading`/default → the believable saved map above. `error` is handled by
 * the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const notificationPrefsFixture: FixtureFactory<NotificationPrefsResponse> = (
  state: MockState,
): NotificationPrefsResponse => ({
  data: { prefs: state === 'empty' ? {} : { ...POPULATED_PREFS } },
});
