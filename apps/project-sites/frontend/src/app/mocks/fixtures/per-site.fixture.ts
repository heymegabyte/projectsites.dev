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
