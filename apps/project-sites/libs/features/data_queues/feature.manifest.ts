/**
 * Feature manifest — per-site Queues (Data & Resource Platform, one of the 5 per-kind surfaces).
 *
 * The site-owned Queues surface: an owner lists the queues bound to their OWN site, describes one
 * (delivery delay, retention, DLQ, backlog, producers/consumers), and sends a message. On THIS
 * deployment there is NO `QUEUE` binding (producer + consumer blocks are commented; code falls back
 * to Workflows), so `queue` is in `UNSUPPORTED_KINDS` and the surface is HONEST — `resolveResourceRef`
 * returns `unsupported_kind` and the tile shows "Not available", never a fabricated queue. The
 * read/send dispatch already lives in the `data_resource_registry` queue adapter (`adapters/queue.ts`)
 * and the parity MCP tools `data_queues_*`; BOTH the routes + tools are gated on THIS flag
 * (`per_site_queues`). Server-resolved via `resolveResourceRef` reusing `assertSiteOwned`; the client
 * never names a CF id. Distinct from `queues_inspector` (shared-platform super-admin tool). Reached
 * from the editor Data tab's Namespace Summary "Queues" tile. Flag DARK → the routes + `data_queues_*`
 * MCP tools 404.
 *
 * Ties the reserved `per_site_queues` flag to its owning surface so the flag is NOT an orphan.
 */
export const manifest = {
  slug: 'data_queues',
  name: 'Queues (per-site)',
  description:
    'Per-site Queues drill-in (editor Data tab, from the Namespace Summary tile): list/describe/send for a site’s OWN queues, server-resolved + owned-gated (honest not-available). DARK when off.',
  flagKey: 'per_site_queues',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-09-28',
  unitTests: ['../libs/features/platform_mcp/__tests__/platform_mcp_data_queues.test.ts'],
};
