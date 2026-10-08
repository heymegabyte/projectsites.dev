/**
 * @module libs/features/site_connections
 *
 * Feature manifest for the Connections panel — the SIXTH Resources sub-tab (beside
 * Media / Files / Buckets / Automations / Functions). A read + disconnect view of a
 * site's connected MCP (Model Context Protocol) providers (Mailchimp, Stripe, GitHub,
 * …) with status + connected-at.
 *
 * NO NEW BACKEND. This feature CONSUMES the already-shipped, un-gated routes in
 * `libs/features/mcp_connections/handlers.ts` (GET list + DELETE revoke). Because that
 * endpoint is shared with the admin's `/admin/mcp` surface it is NOT flag-gated; this
 * flag gates ONLY the editor Resources → Connections TAB, which the admin bridge
 * (`bolt-embed.service.ts` PS_RES_CONNECTIONS) resolves via GET /api/feature-flags/
 * site_connections BEFORE the list fetch (off → {ok:false, enabled:false} → the panel
 * self-hides). Access tokens are NEVER returned. Connect/OAuth stays the separate
 * existing /api/mcp/:provider/connect flow — this panel adds no new OAuth.
 */
import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  slug: 'site_connections',
  name: 'Site Connections Panel',
  description:
    'Connections panel (sixth Resources sub-tab): list a sites MCP provider connections + disconnect one, reusing the existing mcp/connections routes. Editor tab gated by site_connections; no new OAuth.',
  lifecycle: 'alpha',
  flagKey: 'site_connections',
  owner: 'brian@megabyte.space',
  createdAt: '2026-10-08',
  updatedAt: '2026-10-08',

  // No NEW route — this reuses the already-shipped mcp_connections endpoints (listed for provenance).
  routes: [],
  apiRoutes: ['GET /api/sites/:siteId/mcp/connections', 'DELETE /api/sites/:siteId/mcp/connections/:id'],

  permissions: ['sites:read'],
  dependencies: ['mcp_connections'],

  // The feature's test is an EDITOR vitest (reply→state derivation + optimistic remove/restore);
  // worker-side there is no new handler, so no worker jest unit is declared (the shared
  // mcp_connections module carries its own coverage).
  e2eTests: [],
  unitTests: [],
  integrationTests: [],
  testStatus: 'passing',

  zodSchemas: [],

  observability: { axiom: false, logs: true, analytics: false },

  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes:
      'Alpha, read + disconnect. Reuses the shipped, org+user+siteOwned-guarded mcp_connections routes (GET list + DELETE revoke); tokens never returned. Default DARK; the editor TAB is gated by resolving site_connections through the admin bridge before the fetch (the endpoint itself is shared with /admin/mcp and stays un-gated). Lead flips the prod flag + deploys the editor (Pages) + Angular admin (R2) + Worker, then live-verifies the editor Resources → Connections tab. Promote to beta once a prod smoke confirms the list + disconnect for a site with a connected provider.',
  },

  risks: [
    'The mcp/connections ENDPOINT is intentionally NOT flag-gated (shared with the admin /admin/mcp surface) — the gate lives in the editor-tab bridge (resolve site_connections before fetch). A regression that drops the bridge resolve would surface the tab even when dark, but never leaks data (the endpoint still enforces org+user+siteOwned).',
    'Disconnect is destructive (revokes the connection + clears encrypted tokens). It is OPTIMISTIC in the UI but the real DELETE runs immediately; a failure restores the row + toasts, and Undo reloads to reconcile truth so no phantom "restored" connection can persist.',
    'Reads/writes the shared platform mcp_connections table — hard-scoped to the OWNED site_id by the existing siteOwned guard in the reused handlers, so it never exposes or mutates another tenants connection.',
  ],

  removalNotes:
    'Remove this module, the site_connections rows in feature_flags registry.ts + docs.ts, the ConnectionsPanel wiring in the editor (app/components/workbench/ResourcesPanel.tsx + ConnectionsPanel.tsx + its spec), the PS_RES_CONNECTIONS / PS_RES_CONNECTION_DISCONNECT bridge in app/lib/embed/embedded-mode.ts + apps/project-sites/frontend/src/app/services/bolt-embed.service.ts (the PsMessage connectionId field too), and the connections probe in e2e/editor-live/editor-nav.mjs. Does NOT remove the mcp_connections handlers (shared with /admin/mcp — a separate, KEPT feature). No owned D1 tables or migrations.',
});
