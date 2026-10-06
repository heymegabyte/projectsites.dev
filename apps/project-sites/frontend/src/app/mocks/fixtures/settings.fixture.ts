/**
 * @module mocks/fixtures/settings
 *
 * @description
 * Mock fixtures for the admin **Settings** section (`pages/admin/sections/settings.component.ts`)
 * — the 9-tab per-project control surface (General · Team · AI Chat · MCP · AI Env Vars ·
 * Webhooks · Email · Domains · API Tokens). On `ngOnInit` the component fires FIVE reads
 * (plus `/auth/me` + the per-site `mcp/connections`, both already fixtured elsewhere), and a
 * sixth when the Team tab opens. Each factory below is typed to the EXACT worker wire shape
 * (traced to the handler), so wiring the real endpoint later is a provider SWAP, not a rewrite.
 *
 * **Flag-gating:** NONE of the Settings reads are feature-flag-gated. `GET /sites/:id/ai-settings`
 * (`libs/features/ai_settings/handlers.ts`), `GET /team` (`src/routes/ai_admin.ts`),
 * `GET /env-vars` (`src/routes/env_vars.ts`) and `GET /admin/security`
 * (`libs/features/org_security/handlers.ts`) require only org/site membership — no `requireFlag`.
 * So the Settings section renders FULLY on `?mock=1` with NO flag flip. (Two of the section's
 * SUB-components ARE flag-gated — Email's `/deliverability` on `email_deliverability_wizard`,
 * Webhooks' `/webhooks*` on `outbound_webhooks` — both read with `{ silent: true }`, so they
 * degrade to a calm empty tab with no toast; their fixtures live in `per-site.fixture.ts`, task #34.)
 *
 * | Registry key                    | Factory                        | Fired by (settings.component.ts)                     | Worker contract (traced)                                                  |
 * | ------------------------------- | ------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------- |
 * | `GET /sites/:id/ai-settings`    | {@link aiSettingsFixture}      | `loadGeneral` (:1323) + `loadChatMcps` (:1636) + forms `loadSettings` (:1647) | `{ data: AiSettings }` (`ai_settings/handlers.ts:80`)                     |
 * | `GET /team`                     | {@link teamFixture}            | `loadTeam` (:1362) on `ngOnInit`                     | `{ data: { members: Member[]; invites: Invite[] } }` (`ai_admin.ts:64`)   |
 * | `GET /env-vars`                 | {@link orgEnvVarsFixture}      | `loadOrgEnvVars` (:1445) — `?scope=org` (read-only MCP callout) | `{ vars: EnvVar[] }` (`env_vars.ts:152` → `listEnvVars`)        |
 * | `GET /admin/security`           | {@link orgSecurityFixture}     | `loadSecurity` (:1277) when the Team tab opens       | `{ data: OrgSecurityRow }` (`org_security/handlers.ts:47`)                |
 *
 * NOTE `GET /sites/:id/ai-settings` is the SINGLE richest per-site read — the Settings General
 * tab (contact email + chat persona), the Settings AI-Chat MCP allow-list, AND the Forms-designer
 * (`forms.component.ts:1647`) all read it. It's registered here (one `:param` pattern serves every
 * site id) and is the fix for the fire-281 "Can't reach the server" toast (#34): in the demo it
 * previously 404'd because the fixture site ids don't exist in prod.
 *
 * @remarks
 * - Believable data, not lorem: a configured barber-shop AI persona, a real 3-person team with a
 *   pending invite, a handful of org AI env vars (masked, as the wire returns them), and a sane
 *   security row. Enough texture that every column + the "prefilled from profile" hint + the MCP
 *   env-var callout render with real variety.
 * - `state` variants: `empty` → the honest brand-new-project surface (never-written ai-settings
 *   defaults · a one-owner team with no invites · no env vars · default security) that drives each
 *   tab's first-run empty/launchpad state; `error` is handled by the interceptor (it throws a 500
 *   before these run); `populated`/`loading`/default → the rich believable set.
 * - Per-site reads here are keyed by the `:param` pattern (`GET /sites/:id/ai-settings`); the
 *   org-level reads (`/team`, `/env-vars`, `/admin/security`) are static keys. `/env-vars` honors
 *   neither state-shape change by scope (the component only ever reads `?scope=org`).
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /sites/:id/ai-settings ─────────────────────────

/**
 * The `GET /api/sites/:siteId/ai-settings` body — the full projection the worker returns under
 * `{ data }` (`libs/features/ai_settings/handlers.ts`). The Settings General tab reads
 * `contact_email` / `reply_email` / `chat_system_prompt` / `chat_system_prompt_default` /
 * `allow_web_research`; the AI-Chat tab reads `enabled_mcps`; the Forms designer reads
 * `form_router_prompt` / `form_router_prompt_default` / `reply_email`. Every field the three
 * consumers touch is present, plus the brand/locale/drive columns the wire always carries (the
 * component ignores the extras — a superset body is contract-safe).
 */
export interface AiSettingsBody {
  site_id: string;
  slug: string;
  business_name: string | null;
  chat_persona: string | null;
  chat_system_prompt: string | null;
  chat_system_prompt_default: string;
  form_router_prompt: string | null;
  form_router_prompt_default: string;
  /** The forms-designer MCP allow-list (connected-provider ids). Always an array on the wire. */
  enabled_mcps: string[];
  reply_email: string | null;
  contact_email: string | null;
  brand_tone: string | null;
  brand_primary: string | null;
  brand_accent: string | null;
  timezone: string | null;
  default_locale: string | null;
  search_synonyms: Record<string, unknown>;
  allow_web_research: boolean;
  drive_connected: boolean;
  drive_folder_id: string | null;
  drive_folder_name: string | null;
  drive_last_synced_at: string | null;
  updated_at: string | null;
}

/** The `GET /api/sites/:siteId/ai-settings` envelope — the worker wraps the body in `{ data }`. */
export interface AiSettingsResponse {
  data: AiSettingsBody;
}

/** A recent anchor so `updated_at` / drive timestamps read as believable ISO strings. */
const ANCHOR = Date.parse('2026-10-06T13:00:00Z');
const iso = (hoursAgo: number): string => new Date(ANCHOR - hoursAgo * 3_600_000).toISOString();

/** The worker's `DEFAULT_CHAT_SYSTEM_PROMPT` stand-in (the component shows this as the "default"). */
const DEFAULT_CHAT_SYSTEM_PROMPT =
  'You are the friendly website assistant for this business. Answer visitor questions about ' +
  'services, hours, and location from the site content, and help them get in touch. Keep replies ' +
  'short, warm, and accurate — never invent details you cannot find on the site.';

/** The worker's `DEFAULT_ROUTER_PROMPT` stand-in (the Forms designer shows this as the "default"). */
const DEFAULT_ROUTER_PROMPT =
  'Route each form submission to the right destination. Classify intent (booking, quote, support, ' +
  'general), extract the key fields, and reply to the sender with a concise, on-brand confirmation.';

/** A believable configured AI persona for the demo barber shop (the rich `populated` body). */
const POPULATED_AI_SETTINGS: Omit<AiSettingsBody, 'site_id'> = {
  slug: 'beverwyck-barber',
  business_name: 'Beverwyck Barber Co.',
  chat_persona: 'Warm, concise front-desk concierge',
  chat_system_prompt:
    'You are the website concierge for Beverwyck Barber Co. in Lake Hiawatha, NJ. Greet visitors ' +
    'warmly, answer questions about cuts, beard trims, pricing, and hours, and offer to book an ' +
    'appointment. If someone wants a service you do not list, offer the closest match and suggest ' +
    'they call. Keep replies short and friendly.',
  chat_system_prompt_default: DEFAULT_CHAT_SYSTEM_PROMPT,
  form_router_prompt:
    'Route booking requests to the shop calendar, pricing questions to the services page, and ' +
    'everything else to the owner inbox. Always send the sender a short confirmation.',
  form_router_prompt_default: DEFAULT_ROUTER_PROMPT,
  enabled_mcps: ['slack', 'google_calendar'],
  reply_email: 'book@beverwyckbarber.test',
  contact_email: 'book@beverwyckbarber.test',
  brand_tone: 'Friendly, local, dependable',
  brand_primary: '#0f766e',
  brand_accent: '#f59e0b',
  timezone: 'America/New_York',
  default_locale: 'en',
  search_synonyms: { cut: ['haircut', 'trim'], beard: ['shave', 'grooming'] },
  allow_web_research: true,
  drive_connected: false,
  drive_folder_id: null,
  drive_folder_name: null,
  drive_last_synced_at: iso(72),
  updated_at: iso(48),
};

/** The honest never-written surface — every nullable column null, defaults present, nothing enabled. */
const EMPTY_AI_SETTINGS: Omit<AiSettingsBody, 'site_id'> = {
  slug: 'beverwyck-barber',
  business_name: 'Beverwyck Barber Co.',
  chat_persona: null,
  chat_system_prompt: null,
  chat_system_prompt_default: DEFAULT_CHAT_SYSTEM_PROMPT,
  form_router_prompt: null,
  form_router_prompt_default: DEFAULT_ROUTER_PROMPT,
  enabled_mcps: [],
  reply_email: null,
  contact_email: null,
  brand_tone: null,
  brand_primary: null,
  brand_accent: null,
  timezone: null,
  default_locale: null,
  search_synonyms: {},
  allow_web_research: false,
  drive_connected: false,
  drive_folder_id: null,
  drive_folder_name: null,
  drive_last_synced_at: null,
  updated_at: null,
};

/**
 * AI-settings factory. Served under a `:param` pattern, so ONE body answers every demo site id
 * (the `site_id` echoed back is a demo constant; no consumer keys off it). `empty` → the honest
 * never-written surface (defaults present, nothing configured → the General tab's blank form +
 * the "Improve with AI → load default" launchpad); `populated`/`loading`/default → a believable
 * configured persona. `error` is handled by the interceptor (it throws a 500 before this runs).
 *
 * This is also the fix for the fire-281 demo toast (#34): the read previously 404'd in `?mock=1`
 * (the fixture site ids don't exist in prod) → a "Can't reach the server" toast from
 * `forms.component.ts:1647`. Serving this fixture makes the whole surface toast-free.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const aiSettingsFixture: FixtureFactory<AiSettingsResponse> = (
  state: MockState,
): AiSettingsResponse => {
  const body = state === 'empty' ? EMPTY_AI_SETTINGS : POPULATED_AI_SETTINGS;
  return { data: { site_id: 'site-001', ...structuredCloneBody(body) } };
};

/** Shallow-clone the shared body (+ deep-copy the mutable arrays/objects) so callers can't alias. */
function structuredCloneBody(b: Omit<AiSettingsBody, 'site_id'>): Omit<AiSettingsBody, 'site_id'> {
  return { ...b, enabled_mcps: [...b.enabled_mcps], search_synonyms: { ...b.search_synonyms } };
}

// ───────────────────────── GET /team ─────────────────────────

/** A team member row — mirrors the worker's `members` projection + the component's `Member`. */
export interface TeamMemberRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  created_at: string;
}

/** A pending invite row — mirrors the worker's `invites` projection + the component's `Invite`. */
export interface TeamInviteRow {
  id: string;
  email: string;
  role: string;
  created_at: string;
  expires_at: string;
}

/** The `GET /api/team` envelope — the worker returns `{ data: { members, invites } }`. */
export interface TeamResponse {
  data: { members: TeamMemberRow[]; invites: TeamInviteRow[] };
}

/** A believable 3-person team, owner-first (the owner mirrors the `/auth/me` demo identity). */
const TEAM_MEMBERS: readonly TeamMemberRow[] = [
  { id: 'usr-mock-0001', email: 'owner@beverwyckventures.test', name: 'Alex Rivera', role: 'owner', created_at: iso(2160) },
  { id: 'usr-mock-0002', email: 'marcus@beverwyckbarber.test', name: 'Marcus Webb', role: 'admin', created_at: iso(1440) },
  { id: 'usr-mock-0003', email: 'devon@beverwyckbarber.test', name: 'Devon Pierce', role: 'editor', created_at: iso(720) },
];

/** One pending invite so the invites list + its "revoke" row render (and the expiry reads soon). */
const TEAM_INVITES: readonly TeamInviteRow[] = [
  { id: 'inv-001', email: 'jordan@beverwyckbarber.test', role: 'editor', created_at: iso(36), expires_at: iso(-132) },
];

/**
 * Team factory. `empty` → a lone owner + no invites (the honest brand-new-org surface — the
 * "invite your first teammate" launchpad); `populated`/`loading`/default → the believable
 * 3-person team + one pending invite. `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const teamFixture: FixtureFactory<TeamResponse> = (state: MockState): TeamResponse => {
  if (state === 'empty') {
    return { data: { members: [TEAM_MEMBERS[0]].map((m) => ({ ...m })), invites: [] } };
  }
  return {
    data: {
      members: TEAM_MEMBERS.map((m) => ({ ...m })),
      invites: TEAM_INVITES.map((i) => ({ ...i })),
    },
  };
};

// ───────────────────────── GET /env-vars (?scope=org) ─────────────────────────

/**
 * One org-scope AI env var as the worker's `listEnvVars` projection emits it (`services/
 * ai_env_vars.ts` → the public `EnvVar` shape — plaintext NEVER returned; `value_masked` carries
 * `••••` + last-4 for secrets, the plaintext for non-secrets). The Settings MCP tab reads only
 * `key` + `exposed_to_ai`, but the fixture carries the full wire row so it's a true provider SWAP.
 */
export interface EnvVarRow {
  id: string;
  org_id: string;
  scope: 'org' | 'site' | 'mcp' | 'endpoint' | 'agent';
  site_id: string | null;
  mcp_provider: string | null;
  endpoint_id: string | null;
  agent_id: string | null;
  key: string;
  value_masked: string;
  description: string | null;
  is_secret: boolean;
  exposed_to_ai: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** The `GET /api/env-vars` envelope — the worker returns `{ vars }` (NOT `{ data }`). */
export interface OrgEnvVarsResponse {
  vars: EnvVarRow[];
}

/** The shared demo org id (mirrors the `/auth/me` + billing fixtures — one identity). */
const DEMO_ORG_ID = 'org-mock-0001';
const ts = (hoursAgo: number): number => ANCHOR - hoursAgo * 3_600_000;

/**
 * A believable org-scope AI env-var set, key-sorted (the worker orders by scope then key). A mix
 * of secret (masked) + non-secret (plaintext) and exposed/withheld so the MCP tab's read-only
 * callout + the ">8" toggle + the per-row "exposed to AI" badge all render with real variety.
 */
const ORG_ENV_VARS: readonly EnvVarRow[] = [
  envVar('BOOKING_CALENDAR_URL', 'https://cal.beverwyckbarber.test/book', false, true, 'Public booking link the AI can share'),
  envVar('BRAND_VOICE', 'Warm, local, concise', false, true, 'Tone hint surfaced to the chat + form AI'),
  envVar('OWNER_ESCALATION_EMAIL', 'owner@beverwyckventures.test', false, true, 'Where the AI escalates angry/complex threads'),
  envVar('SHOP_TIMEZONE', 'America/New_York', false, true, null),
  envVar('STRIPE_RESTRICTED_KEY', '••••••••4921', true, false, 'Restricted Stripe key — backend MCP use only, withheld from AI'),
  envVar('SUPPORT_SLACK_WEBHOOK', '••••••••a3f0', true, true, 'Slack incoming webhook for new-lead pings'),
];

/** Build one env-var row with sane timestamps + the shared org/creator identity. */
function envVar(
  key: string,
  valueMasked: string,
  isSecret: boolean,
  exposedToAi: boolean,
  description: string | null,
): EnvVarRow {
  return {
    id: `env-${key.toLowerCase().replace(/_/g, '-')}`,
    org_id: DEMO_ORG_ID,
    scope: 'org',
    site_id: null,
    mcp_provider: null,
    endpoint_id: null,
    agent_id: null,
    key,
    value_masked: valueMasked,
    description,
    is_secret: isSecret,
    exposed_to_ai: exposedToAi,
    created_by: 'usr-mock-0001',
    created_at: ts(720),
    updated_at: ts(48),
  };
}

/**
 * Org-env-vars factory. `empty` → `{ vars: [] }` (no vars → the MCP tab's calm "no org AI vars
 * yet" callout); `populated`/`loading`/default → the believable org set. `error` is handled by
 * the interceptor. (The component only ever requests `?scope=org`, so the body is scope-agnostic.)
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const orgEnvVarsFixture: FixtureFactory<OrgEnvVarsResponse> = (
  state: MockState,
): OrgEnvVarsResponse => ({ vars: state === 'empty' ? [] : ORG_ENV_VARS.map((v) => ({ ...v })) });

// ───────────────────────── GET /admin/security ─────────────────────────

/**
 * The `GET /api/admin/security` body — the `org_security` row the worker returns under `{ data }`
 * (`libs/features/org_security/handlers.ts`). Booleans are INTEGER 0/1 on the wire (the component
 * coerces `require_2fa` with `!!`). The Settings Team tab reads only `require_2fa`; the rest of
 * the row is carried verbatim (the worker still returns the legacy session/idle/domain columns).
 */
export interface OrgSecurityRow {
  session_hours: number;
  idle_minutes: number;
  allowed_domains: string | null;
  require_2fa: number;
  updated_at: string | null;
}

/** The `GET /api/admin/security` envelope — the worker wraps the row in `{ data }`. */
export interface OrgSecurityResponse {
  data: OrgSecurityRow;
}

/**
 * Org-security factory. `empty` → the worker's never-configured DEFAULT row (session 168h, idle
 * 60m, no domain allowlist, 2FA off) — exactly what the handler returns when no `org_security` row
 * exists; `populated`/`loading`/default → a believable configured org (2FA required, a sign-in
 * domain allowlist). `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const orgSecurityFixture: FixtureFactory<OrgSecurityResponse> = (
  state: MockState,
): OrgSecurityResponse => {
  if (state === 'empty') {
    return {
      data: { session_hours: 168, idle_minutes: 60, allowed_domains: null, require_2fa: 0, updated_at: null },
    };
  }
  return {
    data: {
      session_hours: 168,
      idle_minutes: 60,
      allowed_domains: 'beverwyckbarber.test,beverwyckventures.test',
      require_2fa: 1,
      updated_at: iso(96),
    },
  };
};
