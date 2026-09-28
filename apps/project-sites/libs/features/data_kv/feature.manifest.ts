/**
 * Feature manifest — per-site KV (Data & Resource Platform, one of the 5 per-kind surfaces).
 *
 * The site-owned KV surface: an owner lists keys (cursor-paginated), gets a value (size-capped +
 * truncated flag), and puts/deletes keys in their site's OWN dedicated Cloudflare KV namespace —
 * NEVER the shared platform CACHE_KV/PROMPT_STORE. The read/write dispatch already lives in the
 * `data_resource_registry` kv adapter (`adapters/kv.ts`) and the parity MCP tools `data_kv_*`; BOTH
 * the routes + tools are gated on THIS flag (`per_site_kv`). Isolation is server-resolved to the
 * site's OWN kv_namespace_id (from site_database_allocations) via `resolveResourceRef` reusing
 * `assertSiteOwned`; the client never supplies a namespace id. Distinct from `kv_inspector` (the
 * shared-platform super-admin tool). Reached from the editor Data tab's Namespace Summary "KV" tile
 * (drill-in → `KvBrowser` / generic detail). Flag DARK → the routes + `data_kv_*` MCP tools 404.
 *
 * Ties the reserved `per_site_kv` flag to its owning surface so the flag is NOT an orphan
 * (`feature-module-architecture` + `drift-detection`).
 */
export const manifest = {
  slug: 'data_kv',
  name: 'KV (per-site)',
  description:
    'Per-site KV drill-in (editor Data tab, from the Namespace Summary tile): list/get/put/delete keys in a site’s OWN kv namespace, server-resolved + owned-gated. DARK when off.',
  flagKey: 'per_site_kv',
  owner: 'brian@megabyte.space',
  stage: 'experimental' as const,
  createdAt: '2026-09-28',
  unitTests: ['../libs/features/platform_mcp/__tests__/platform_mcp_data_kv.test.ts'],
};
