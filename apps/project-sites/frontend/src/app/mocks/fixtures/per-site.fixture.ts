/**
 * @module mocks/fixtures/per-site
 *
 * @description
 * Mock fixtures for the PER-SITE reads (`GET /api/sites/:id/…`) that the
 * already-mocked demo surfaces fire the moment a site is selected — the routes
 * that previously fell through to the REAL backend in `?mock=1` and 404'd (the
 * fixture site ids don't exist in prod), firing "Can't reach the server" toasts
 * and littering the demo network tab:
 *
 * | Route                               | Factory                     | Fired by (demo surface)                              | Worker contract                                   |
 * | ----------------------------------- | --------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
 * | `GET /sites/:id/mcp/connections`    | {@link mcpConnectionsFixture} | Billing — `refreshSlackConnected` (one call per site) | `{ data: { providers: string[]; connections: [] } }` |
 * | `GET /sites/:id/snapshots/metrics`  | {@link snapshotMetricsFixture} | Dashboard — `loadLatestMetrics` (on site-load)       | `{ data: MetricsRow[] }`                            |
 *
 * **#34 shell sweep (fire-281 toast-free demo):** eight MORE per-site GET reads fire the moment
 * a section/tab opens in the demo and previously 404'd (fixture ids don't exist in prod). Two were
 * NON-silent (snapshots list + GitHub status) → they toasted "Can't reach the server"; the other
 * six read with `{ silent: true }` (no toast) but still littered the demo network tab with failed
 * requests. All eight are now fixtured here (empty-but-well-formed = the honest first-run surface),
 * so NO spurious 404/error fires anywhere in the demo:
 *
 * | Route                               | Factory                     | Fired by (demo surface)                              | Worker contract                                   |
 * | ----------------------------------- | --------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
 * | `GET /sites/:id/snapshots`          | {@link snapshotsListFixture} | Snapshots tab — `loadSnapshots` (NON-silent → toasted) | `{ data: Snapshot[]; git_history: [] }` (`site_versioning`) |
 * | `GET /sites/:id/github/status`      | {@link githubStatusFixture } | Snapshots tab — GitHub backup card (NON-silent → toasted) | `{ data: { connected: boolean; … } }` (`site_github`)  |
 * | `GET /sites/:id/ai-logs`            | {@link aiLogsFixture }       | AI-Logs section — `loadTraces` (silent)              | `{ data: TraceRow[]; meta }` (`site_activity`)     |
 * | `GET /sites/:id/deliverability`     | {@link deliverabilityFixture } | Settings → Email tab (silent; flag `email_deliverability_wizard`) | `{ ok; report; needsDomain }` (`email_deliverability`) |
 * | `GET /sites/:id/copilot/config`     | {@link copilotConfigFixture } | Site-copilot dock — `loadConfig` (silent)            | `{ site_id; enabled }` (`copilot.ts`)              |
 * | `GET /sites/:id/logs/tail`          | {@link logsTailFixture }     | Site-detail Logs tab — `loadLogs` (silent)           | `{ logs: LogRow[] }` (`site_detail_tabs`)          |
 * | `GET /sites/:id/webhooks`           | {@link webhooksFixture }     | Settings → Webhooks tab (silent; flag `outbound_webhooks`) | `{ ok; endpoints: [] }` (`webhooks_admin`)   |
 * | `GET /sites/:id/webhooks/deliveries`| {@link webhookDeliveriesFixture } | Settings → Webhooks tab (silent; flag `outbound_webhooks`) | `{ ok; deliveries: [] }` (`webhooks_admin`) |
 *
 * These are registered under `:param` PATTERN keys (see {@link
 * import('./index').FIXTURES}) so a single fixture serves EVERY site id — the
 * matcher resolves `/sites/<anything>/mcp/connections` to the one pattern.
 *
 * @remarks
 * - The clean demo default is EMPTY-but-well-formed: no site has a connected MCP
 *   provider and no snapshot metrics exist, so every consumer reads
 *   `data.connections ?? []` / `Object.values(data)[0]` and renders its calm
 *   "connect your first integration" / "—" state — NEVER a spurious error toast.
 *   (This mirrors a brand-new org, which is the honest first-run per-site state.)
 * - `providers` carries the real worker catalogue (the keys `allProviders()`
 *   returns) so the Settings MCP connect-picker renders its full provider grid.
 * - Each returns the EXACT worker wire shape, so wiring the real endpoint later is
 *   a provider SWAP, not a rewrite. The interceptor owns loading + the `error`
 *   short-circuit; `state` has no effect on the body here (every state is the same
 *   honest empty per-site surface — there's nothing to "populate" without a real
 *   per-site backend, and a demo must never fabricate a connected integration).
 */
import type { FixtureFactory, MockState } from './index';

// ───────────────────────── GET /sites/:id/mcp/connections ─────────────────────────

/** One connected-provider row (mirrors the worker's `mcp_connections` projection). */
export interface McpConnectionRow {
  id: string;
  provider: string;
  display_name: string | null;
  status: string;
  scopes_json: string | null;
  account_metadata_json: string | null;
  connected_at: string | null;
  metadata: unknown;
}

/**
 * `GET /api/sites/:id/mcp/connections` envelope — the worker's
 * `mcpConnections` handler wraps a `providers` catalogue + the site's active
 * `connections` under `{ data }` (NOT a bare array).
 */
export interface McpConnectionsResponse {
  data: {
    providers: string[];
    connections: McpConnectionRow[];
  };
}

/**
 * The MCP provider catalogue the worker's `allProviders()` emits (the keys of
 * its `ADAPTERS` map, `src/services/mcp_client.ts`). Mirrored here so the
 * Settings connect-picker renders the same grid the real endpoint would feed.
 * Kept in declaration order so the demo grid is deterministic.
 */
const MCP_PROVIDERS: readonly string[] = [
  'mailchimp',
  'stripe',
  'resend',
  'hubspot',
  'slack',
  'notion',
  'github',
  'linear',
  'discord',
  'google_calendar',
  'twilio',
  'calendly',
  'airtable',
  'zapier',
  'pagerduty',
  'vercel',
];

/**
 * MCP connections factory. Always returns the real provider catalogue with an
 * EMPTY `connections` list — the honest demo default (no site has connected an
 * integration), which every consumer renders as its calm "connect your first
 * integration" state. `state` is intentionally ignored: a demo must never
 * fabricate a live third-party connection, so there is no `populated` variant.
 *
 * @param _state - The mock state knob (unused — see module remarks).
 */
export const mcpConnectionsFixture: FixtureFactory<McpConnectionsResponse> = (
  _state: MockState,
): McpConnectionsResponse => ({
  data: {
    providers: [...MCP_PROVIDERS],
    connections: [],
  },
});

// ───────────────────────── GET /sites/:id/snapshots/metrics ─────────────────────────

/**
 * The `GET /api/sites/:id/snapshots/metrics` envelope — the worker's
 * `snapshotQuality` grid handler returns `{ data: MetricsRow[] }` (one enriched
 * row per snapshot). The dashboard reads `Object.values(data)[0]`, so an empty
 * array means "no snapshots captured yet" and the CWV widget degrades to "—".
 */
export interface SnapshotMetricsResponse {
  data: unknown[];
}

/**
 * Snapshot-metrics factory. Returns an EMPTY grid on every state — the demo's
 * sites have no captured snapshot metrics, so the dashboard's background CWV
 * widget degrades cleanly to "—" (it's `{ silent: true }`, so a real 404 here
 * was silent, but it still polluted the demo network tab with a failed request).
 *
 * @param _state - The mock state knob (unused — the demo has no snapshot metrics).
 */
export const snapshotMetricsFixture: FixtureFactory<SnapshotMetricsResponse> = (
  _state: MockState,
): SnapshotMetricsResponse => ({ data: [] });

// ═══════════════════════ #34 shell sweep — toast-free demo ═══════════════════════
// Eight more per-site reads fired on section/tab open. Empty-but-well-formed = the
// honest first-run surface every consumer renders calmly (no spurious 404/error).

/** A recent anchor so the sweep fixtures' ISO timestamps read as believable. */
const SWEEP_ANCHOR = Date.parse('2026-10-06T13:00:00Z');
const sweepIso = (hoursAgo: number): string =>
  new Date(SWEEP_ANCHOR - hoursAgo * 3_600_000).toISOString();

// ───────────────────────── GET /sites/:id/snapshots ─────────────────────────

/** One snapshot row — the `site_versioning` list projection + the `commit_iso` enrichment. */
export interface SnapshotRow {
  id: string;
  snapshot_name: string;
  build_version: string;
  description: string | null;
  created_at: string;
  /** Authoritative commit timestamp (git history) or the row's `created_at` fallback. */
  commit_iso: string;
}

/**
 * The `GET /api/sites/:siteId/snapshots` envelope — the worker returns `{ data, git_history }`
 * (the enriched D1 rows + the raw git log). The Snapshots tab reads `data`; `git_history` is
 * carried as an empty array (the demo has no git store), matching the handler's degrade path.
 */
export interface SnapshotsListResponse {
  data: SnapshotRow[];
  git_history: unknown[];
}

/** Two believable snapshots (the auto "initial" + an AI-named edit), newest-first. */
const SNAPSHOTS: readonly SnapshotRow[] = [
  {
    id: 'snap-002',
    snapshot_name: 'warmer-hero-and-booking-cta',
    build_version: 'v2',
    description: 'Warmed the hero palette and promoted the booking CTA above the fold.',
    created_at: sweepIso(48),
    commit_iso: sweepIso(48),
  },
  {
    id: 'snap-001',
    snapshot_name: 'initial',
    build_version: 'v1',
    description: 'First generated build.',
    created_at: sweepIso(720),
    commit_iso: sweepIso(720),
  },
];

/**
 * Snapshots-list factory. This read is NON-silent, so a 404 in the demo toasted — fixturing it
 * is a #34 toast fix. `empty` → no snapshots (the honest brand-new-site surface → the "your first
 * snapshot is created on build" empty state); `populated`/`loading`/default → two believable
 * snapshots. `error` is handled by the interceptor. `git_history` is always `[]` (no demo git
 * store — the handler's own degrade path).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const snapshotsListFixture: FixtureFactory<SnapshotsListResponse> = (
  state: MockState,
): SnapshotsListResponse => ({
  data: state === 'empty' ? [] : SNAPSHOTS.map((s) => ({ ...s })),
  git_history: [],
});

// ───────────────────────── GET /sites/:id/github/status ─────────────────────────

/**
 * The `GET /api/sites/:siteId/github/status` body — the `site_github` handler returns a
 * discriminated `{ connected }` object under `{ data }`. The honest demo default is DISCONNECTED
 * (no site has linked a GitHub repo — the "Connect GitHub to back up" empty state), so only the
 * `connected: false` shape is ever returned (a demo must never fabricate a live GitHub link).
 */
export interface GithubStatusBody {
  connected: boolean;
  owner?: string;
  repo?: string;
  html_url?: string;
  last_backup_at?: string;
  last_commit_sha?: string;
  commit_count?: number;
  github_user?: string;
  github_avatar_url?: string;
}

/** The `GET /api/sites/:siteId/github/status` envelope — the worker wraps it in `{ data }`. */
export interface GithubStatusResponse {
  data: GithubStatusBody;
}

/**
 * GitHub-status factory. This read is NON-silent, so a 404 in the demo toasted — fixturing it is a
 * #34 toast fix. Always returns `{ connected: false }` (the honest first-run surface → the
 * "Connect GitHub" card); `state` is intentionally ignored (a demo must never fabricate a live
 * third-party connection, so there is no `connected: true` variant). `error` is handled by the
 * interceptor.
 *
 * @param _state - The mock state knob (unused — see remarks).
 */
export const githubStatusFixture: FixtureFactory<GithubStatusResponse> = (
  _state: MockState,
): GithubStatusResponse => ({ data: { connected: false } });

// ───────────────────────── GET /sites/:id/ai-logs ─────────────────────────

/** One AI trace row — the `site_activity` `ai_form_logs` projection. */
export interface AiLogRow {
  id: string;
  submission_id: string | null;
  trace_kind: string;
  endpoint_slug: string | null;
  model: string | null;
  status: string;
  latency_ms: number | null;
  tokens_input: number | null;
  tokens_output: number | null;
  credits_debited: number | null;
  tool_name: string | null;
  tool_status: string | null;
  output_preview: string | null;
  error_message: string | null;
  created_at: string;
}

/** The `GET /api/sites/:siteId/ai-logs` envelope — `{ data, meta }` (NOT a bare array). */
export interface AiLogsResponse {
  data: AiLogRow[];
  meta: { limit: number; total: number; has_more: boolean };
}

/** Three believable AI traces (a chat reply, a form-router classify, a tool call), newest-first. */
const AI_LOGS: readonly AiLogRow[] = [
  {
    id: 'trace-003',
    submission_id: null,
    trace_kind: 'chat',
    endpoint_slug: null,
    model: 'claude-haiku-4-5',
    status: 'ok',
    latency_ms: 742,
    tokens_input: 512,
    tokens_output: 118,
    credits_debited: 1,
    tool_name: null,
    tool_status: null,
    output_preview: "We're open until 7pm today — I can book you a 3pm fade with Marcus if that works?",
    error_message: null,
    created_at: sweepIso(3),
  },
  {
    id: 'trace-002',
    submission_id: 'sub-014',
    trace_kind: 'form_router',
    endpoint_slug: 'contact',
    model: 'claude-haiku-4-5',
    status: 'ok',
    latency_ms: 480,
    tokens_input: 310,
    tokens_output: 64,
    credits_debited: 1,
    tool_name: null,
    tool_status: null,
    output_preview: 'Classified: booking · routed to shop calendar · sender confirmation sent.',
    error_message: null,
    created_at: sweepIso(9),
  },
  {
    id: 'trace-001',
    submission_id: 'sub-014',
    trace_kind: 'tool_call',
    endpoint_slug: 'contact',
    model: 'claude-haiku-4-5',
    status: 'ok',
    latency_ms: 1203,
    tokens_input: 96,
    tokens_output: 22,
    credits_debited: 1,
    tool_name: 'google_calendar.create_event',
    tool_status: 'ok',
    output_preview: 'Created event "Fade — Thursday 3:00pm" on Beverwyck Bookings.',
    error_message: null,
    created_at: sweepIso(9),
  },
];

/**
 * AI-logs factory. `empty` → `{ data: [], meta: { total: 0 } }` (no traces yet → the calm "AI
 * activity shows up here" empty state); `populated`/`loading`/default → three believable traces.
 * `has_more` is `false` (the demo set fits one page). `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const aiLogsFixture: FixtureFactory<AiLogsResponse> = (state: MockState): AiLogsResponse => {
  const rows = state === 'empty' ? [] : AI_LOGS.map((r) => ({ ...r }));
  return { data: rows, meta: { limit: 50, total: rows.length, has_more: false } };
};

// ───────────────────────── GET /sites/:id/deliverability ─────────────────────────

/**
 * The `GET /api/sites/:siteId/deliverability` envelope — the `email_deliverability` handler
 * returns `{ ok, report, needsDomain }`. The honest demo default is `needsDomain: true` (no custom
 * sending domain configured → the "add your domain to check SPF/DKIM/DMARC" wizard start), so
 * `report` stays `null`. Mirrors the handler's pre-domain path; the read is `{ silent: true }`, so
 * even in prod (flag `email_deliverability_wizard` OFF → 404) it never toasts — the fixture just
 * keeps the demo network tab clean.
 */
export interface DeliverabilityResponse {
  ok: boolean;
  report: unknown | null;
  needsDomain: boolean;
}

/**
 * Deliverability factory. Always returns the honest pre-domain surface (`ok:true`, `report:null`,
 * `needsDomain:true`) → the Email tab's "connect a domain to run the SPF/DKIM/DMARC check" wizard
 * start. `state` is ignored (the demo has no custom sending domain, so there is no populated
 * report to show). `error` is handled by the interceptor.
 *
 * @param _state - The mock state knob (unused — see remarks).
 */
export const deliverabilityFixture: FixtureFactory<DeliverabilityResponse> = (
  _state: MockState,
): DeliverabilityResponse => ({ ok: true, report: null, needsDomain: true });

// ───────────────────────── GET /sites/:id/copilot/config ─────────────────────────

/** The `GET /api/sites/:siteId/copilot/config` envelope — `{ site_id, enabled }` (NOT `{ data }`). */
export interface CopilotConfigResponse {
  site_id: string;
  enabled: boolean;
}

/**
 * Copilot-config factory. `empty` → `{ enabled: false }` (the copilot dock stays dormant);
 * `populated`/`loading`/default → `{ enabled: true }` (the multimodal copilot is available). The
 * component reads only `enabled` (the extra `site_id` is ignored). `error` is handled by the
 * interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const copilotConfigFixture: FixtureFactory<CopilotConfigResponse> = (
  state: MockState,
): CopilotConfigResponse => ({ site_id: 'site-001', enabled: state !== 'empty' });

// ───────────────────────── GET /sites/:id/logs/tail ─────────────────────────

/** One audit-log tail row — the `site_detail_tabs` mapped projection. */
export interface LogTailRow {
  ts: string;
  level: string;
  source: string;
  message: string;
}

/** The `GET /api/sites/:siteId/logs/tail` envelope — `{ logs }` (NOT `{ data }`). */
export interface LogsTailResponse {
  logs: LogTailRow[];
}

/** A believable recent audit tail (publish → build → snapshot), newest-first. */
const LOGS_TAIL: readonly LogTailRow[] = [
  { ts: sweepIso(2), level: 'info', source: 'system', message: 'Published build v2 to beverwyck-barber.projectsites.dev' },
  { ts: sweepIso(48), level: 'info', source: 'owner@beverwyckventures.test', message: 'Created snapshot "warmer-hero-and-booking-cta"' },
  { ts: sweepIso(49), level: 'info', source: 'system', message: 'Build v2 completed in 4m 12s' },
  { ts: sweepIso(720), level: 'info', source: 'system', message: 'Initial build published' },
];

/**
 * Logs-tail factory. `empty` → `{ logs: [] }` (no activity yet → the calm "nothing logged yet"
 * empty state); `populated`/`loading`/default → a believable recent tail. `error` is handled by
 * the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const logsTailFixture: FixtureFactory<LogsTailResponse> = (
  state: MockState,
): LogsTailResponse => ({ logs: state === 'empty' ? [] : LOGS_TAIL.map((l) => ({ ...l })) });

// ───────────────────────── GET /sites/:id/webhooks ─────────────────────────

/** The `GET /api/sites/:siteId/webhooks` envelope — `{ ok, endpoints }` (NOT `{ data }`). */
export interface WebhooksResponse {
  ok: boolean;
  endpoints: unknown[];
}

/**
 * Webhooks-endpoints factory. Always returns the honest empty surface (`ok:true`, `endpoints:[]`)
 * → the Settings Webhooks tab's "add your first endpoint" launchpad. `state` is ignored (no
 * endpoints to populate without a real backend). The read is `{ silent: true }`, so even in prod
 * (flag `outbound_webhooks` OFF → 404) it never toasts — the fixture keeps the demo network tab
 * clean. `error` is handled by the interceptor.
 *
 * @param _state - The mock state knob (unused — see remarks).
 */
export const webhooksFixture: FixtureFactory<WebhooksResponse> = (
  _state: MockState,
): WebhooksResponse => ({ ok: true, endpoints: [] });

// ───────────────────────── GET /sites/:id/webhooks/deliveries ─────────────────────────

/** The `GET /api/sites/:siteId/webhooks/deliveries` envelope — `{ ok, deliveries }`. */
export interface WebhookDeliveriesResponse {
  ok: boolean;
  deliveries: unknown[];
}

/**
 * Webhook-deliveries factory. Always returns the honest empty surface (`ok:true`,
 * `deliveries:[]`) → the Webhooks tab's empty deliveries log (no endpoints → no deliveries).
 * `state` is ignored (same rationale as {@link webhooksFixture}). `error` is handled by the
 * interceptor.
 *
 * @param _state - The mock state knob (unused — see remarks).
 */
export const webhookDeliveriesFixture: FixtureFactory<WebhookDeliveriesResponse> = (
  _state: MockState,
): WebhookDeliveriesResponse => ({ ok: true, deliveries: [] });

// ═══════════════════ #34 — Snapshots section's three per-site reads ═══════════════════
// The Snapshots section mounts three self-fetching cards — the health sparkline, the
// readiness panel, and the timeline-notes — each firing a per-site GET the moment a site
// is selected. In prod all three are flag-gated (`site_doctor` / `activity_feed`) and 404
// when dark, which the components treat as "feature off → stay hidden" ({ silent: true }).
// In the demo the fixture ids don't exist in prod, so these 404'd and littered the demo
// network tab — fixturing them (with believable populated data) lets the demo SHOW these
// surfaces instead of hiding them. Each returns the EXACT worker wire shape:
//   GET /sites/:id/sparkline      → { siteId, days: {date,visits}[] }  (site_health_sparklines; honors ?days=)
//   GET /sites/:id/annotations    → { data: Annotation[] }             (analytics_annotations)
//   GET /sites/:id/readiness      → { score, grade, checks[] }         (prod_readiness_score)
// (The brief named these under a `/snapshots/*` prefix; the live components + worker
//  mount them at the un-prefixed per-site paths above — verified against source, which wins.)

// ───────────────────────── GET /sites/:id/sparkline ─────────────────────────

/** One day of traffic — mirrors the worker's `getSparkline` row (`{ date, visits }`). */
export interface SparkDay {
  date: string;
  visits: number;
}

/**
 * The `GET /api/sites/:siteId/sparkline` envelope — `getSparkline` returns
 * `{ siteId, days }` (NOT `{ data }`). The health-sparkline card only renders when
 * `days.length >= 2 && total > 0`, so the populated fixture carries a real 7-day trend.
 */
export interface SparklineResponse {
  siteId: string;
  days: SparkDay[];
}

/** A believable fortnight of daily visits (oldest→newest), gently trending up with a weekend dip. */
const SPARK_DAYS: readonly SparkDay[] = [
  { date: '2026-09-23', visits: 38 },
  { date: '2026-09-24', visits: 44 },
  { date: '2026-09-25', visits: 41 },
  { date: '2026-09-26', visits: 52 },
  { date: '2026-09-27', visits: 29 }, // weekend dip
  { date: '2026-09-28', visits: 24 },
  { date: '2026-09-29', visits: 58 },
  { date: '2026-09-30', visits: 63 },
  { date: '2026-10-01', visits: 57 },
  { date: '2026-10-02', visits: 71 },
  { date: '2026-10-03', visits: 66 },
  { date: '2026-10-04', visits: 34 }, // weekend dip
  { date: '2026-10-05', visits: 31 },
  { date: '2026-10-06', visits: 79 },
];

/**
 * Sparkline factory. `empty` → `{ days: [] }` (no traffic yet → the card self-hides, the
 * honest brand-new-site surface); `populated`/`loading`/default → a real trend. Honors the
 * `days` query param the card sends (`?days=7`) by returning the LAST N days (the worker's
 * `day >= date('now','-Nd')` window), clamped to 1..30 like the handler. `error` is handled
 * by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 * @param query - Parsed request query (reads `days`, default 7, max 30).
 */
export const sparklineFixture: FixtureFactory<SparklineResponse> = (
  state: MockState,
  query: URLSearchParams,
): SparklineResponse => {
  if (state === 'empty') return { siteId: 'site-001', days: [] };
  const raw = Number(query.get('days') ?? '7');
  const days = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 30) : 7;
  return {
    siteId: 'site-001',
    days: SPARK_DAYS.slice(-days).map((d) => ({ ...d })),
  };
};

// ───────────────────────── GET /sites/:id/annotations ─────────────────────────

/** One timeline annotation — mirrors the worker's `analytics_annotations` row. */
export interface AnnotationRow {
  id: string;
  siteId: string;
  date: string;
  note: string;
  category: string;
  createdAt: string;
}

/** The `GET /api/sites/:siteId/annotations` envelope — the worker wraps the list in `{ data }`. */
export interface AnnotationsResponse {
  data: AnnotationRow[];
}

/** Two believable timeline markers (a deploy + a marketing push), newest-first. */
const ANNOTATIONS: readonly AnnotationRow[] = [
  {
    id: 'anno-002',
    siteId: 'site-001',
    date: '2026-10-04',
    note: 'Launched the fall booking promo across Instagram + the homepage banner.',
    category: 'marketing',
    createdAt: sweepIso(48),
  },
  {
    id: 'anno-001',
    siteId: 'site-001',
    date: '2026-10-02',
    note: 'Published build v2 — warmer hero palette + booking CTA above the fold.',
    category: 'deploy',
    createdAt: sweepIso(96),
  },
];

/**
 * Annotations factory. `empty` → `{ data: [] }` (no notes yet → the timeline-notes card's
 * "add a marker" launchpad — the card still shows once the list loads 200); `populated`/
 * `loading`/default → two believable markers. `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const annotationsFixture: FixtureFactory<AnnotationsResponse> = (
  state: MockState,
): AnnotationsResponse => ({
  data: state === 'empty' ? [] : ANNOTATIONS.map((a) => ({ ...a })),
});

// ───────────────────────── GET /sites/:id/readiness ─────────────────────────

/** One readiness check — mirrors the worker's `ReadinessCheck` (`{ name, pass, weight, hint }`). */
export interface ReadinessCheckRow {
  name: string;
  pass: boolean;
  weight: number;
  hint: string;
}

/**
 * The `GET /api/sites/:siteId/readiness` envelope — `computeReadiness` returns a BARE
 * `{ score, grade, checks }` (NOT `{ data }`). The readiness panel only renders when
 * `grade` is a string, and surfaces the FAILING checks as the actionable fix list.
 */
export interface ReadinessResponse {
  score: number;
  grade: string;
  checks: ReadinessCheckRow[];
}

/**
 * The four weighted checks the worker computes (25 pts each, sum 100). The demo default
 * passes published + custom-domain + performance and fails sitemap → score 75, grade C,
 * so the panel renders a realistic one-item "left to make this production-ready" list
 * (the most instructive demo state). `empty` flips perf + sitemap to failing → score 50,
 * grade F (a freshly-built, not-yet-tuned site).
 */
function readinessChecks(full: boolean): ReadinessCheckRow[] {
  return [
    {
      name: 'published',
      pass: true,
      weight: 25,
      hint: 'Site is live.',
    },
    {
      name: 'custom_domain',
      pass: full,
      weight: 25,
      hint: full
        ? 'Custom domain is active.'
        : 'Connect a custom domain to build credibility and improve SEO.',
    },
    {
      name: 'performance',
      pass: true,
      weight: 25,
      hint: 'Lighthouse score is 96.',
    },
    {
      name: 'sitemap',
      pass: false,
      weight: 25,
      hint: 'No sitemap.xml found in the current build — search engines may miss pages.',
    },
  ];
}

/**
 * Readiness factory. `populated`/`loading`/default → a grade-C site (3 of 4 checks pass →
 * score 75, one actionable fix); `empty` → a grade-F freshly-built site (2 of 4 pass →
 * score 50). The score is always the sum of passing weights, mirroring the worker. `error`
 * is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const readinessFixture: FixtureFactory<ReadinessResponse> = (
  state: MockState,
): ReadinessResponse => {
  const checks = readinessChecks(state !== 'empty');
  const score = checks.reduce((sum, c) => sum + (c.pass ? c.weight : 0), 0);
  const grade = score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  return { score, grade, checks };
};
