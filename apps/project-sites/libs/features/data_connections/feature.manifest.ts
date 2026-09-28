/**
 * Feature manifest — per-site Connections (Data & Resource Platform, one of the 5 per-kind surfaces).
 *
 * The site-owned Connections surface: a site owner reads their OWN external service connections
 * (`mcp_connections` providers, secret-free column allowlist + masked host — a connection value is
 * NEVER echoed) from the editor Data tab, drilled into from the Namespace Summary "Connections"
 * tile. The read + `list`/`get` dispatch already lives in the `data_resource_registry` connection
 * adapter (`adapters/connection.ts`) and the parity MCP tools `data_connections_*`; BOTH the routes
 * and the tools are gated on THIS flag (`per_site_connections`) so a super-admin promotes Connections
 * independently of the other per-kind surfaces. Ownership is server-resolved via `assertSiteOwned`;
 * the client never names a CF id. Flag DARK by default → the routes + `data_connections_*` MCP tools
 * 404 (never 403) and the tile drill-in shows an honest "not enabled yet" state.
 *
 * This manifest ties the reserved `per_site_connections` flag to its owning surface so the flag is
 * NOT an orphan (per `feature-module-architecture` + `drift-detection`). The backend (adapter + MCP
 * tools + their flag-off tests) already ships; this fire wires the editor drill-in that reaches it.
 */
export const manifest = {
  slug: 'data_connections',
  name: 'Connections (per-site)',
  description:
    'Per-site Connections drill-in (editor Data tab, from the Namespace Summary tile): reads a site’s OWN external connections (masked, secret-free), server-resolved + owned-gated. DARK when off.',
  flagKey: 'per_site_connections',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-09-28',
  unitTests: ['../libs/features/platform_mcp/__tests__/platform_mcp_data_connections.test.ts'],
};
