/**
 * Feature manifest — per-site Durable Objects (Data & Resource Platform, one of the 5 per-kind surfaces).
 *
 * The site-owned Durable Objects surface: an owner reads the DO namespaces bound to their OWN site
 * (class, script, id-derivation) — `instancesEnumerable:false`, `stateBrowsable:false` (CF cannot read
 * DO state, so the surface is honest: namespaces/ids only, never fabricated state). The read + guarded
 * manage (CLOSED enum status_probe|reset — no arbitrary-method passthrough) already lives in the
 * `data_resource_registry` durable_object adapter (`adapters/durable_object.ts`) and the parity MCP
 * tools `data_do_*`; BOTH the routes + tools are gated on THIS flag (`per_site_durable_objects`).
 * Server-resolved via `resolveResourceRef` reusing `assertSiteOwned` + the shared-id denylist; the
 * client never names a CF id. Only SITE_BUILDER is bound → honest `not_registered` when a site has no
 * per-site DO. Reached from the editor Data tab's Namespace Summary "Durable Objects" tile. Flag DARK
 * → the routes + `data_do_*` MCP tools 404.
 *
 * Ties the reserved `per_site_durable_objects` flag to its owning surface so the flag is NOT an orphan.
 */
export const manifest = {
  slug: 'data_durable_objects',
  name: 'Durable Objects (per-site)',
  description:
    'Per-site Durable Objects drill-in (editor Data tab, from the Namespace Summary tile): read a site’s OWN DO namespaces (class/script, never state), server-resolved + owned-gated. DARK when off.',
  flagKey: 'per_site_durable_objects',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-09-28',
  unitTests: ['../libs/features/platform_mcp/__tests__/platform_mcp_data_durable_objects.test.ts'],
};
