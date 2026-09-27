/**
 * @module libs/features/data_resource_registry
 *
 * Feature manifest for the Authoritative Resource Registry — section 1 of the Data & Resource
 * Platform directive (docs/data-resource-platform/DESIGN.md). This is the SERVER-SIDE contract +
 * service foundation that every per-resource surface (the editor Data tab, the parity MCP tools,
 * per-kind adapters) builds on: every Cloudflare resource a site touches is a ROW the platform
 * owns and resolves server-side. The browser + MCP caller supply only `{ site_id, environment }`
 * (both authed); the trusted service maps that to the real CF id and NEVER accepts an id from the
 * client. `resolveResourceRef` is the isolation keystone (reuses assertSiteOwned + the shared-id
 * denylist). No routes are wired yet — this fire ships the migration, schemas, service, and the
 * typed adapter interface only.
 *
 * PLATFORM foundation (not a per-site UI feature yet) — gated dark behind `data_resource_platform`.
 */
import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  // ---- identity ----
  slug: 'data_resource_registry',
  name: 'Data Resource Registry',
  description:
    'Authoritative registry (Data & Resource Platform §1) for every Cloudflare resource a site ' +
    'touches: a row the platform owns and resolves SERVER-SIDE from the authed site+env. Callers ' +
    'name only { kind, environment } — never a CF id. resolveResourceRef reuses assertSiteOwned + ' +
    'the shared-id denylist to reject any id not owned by that site+env. Contract + service ' +
    'foundation only; routes wired in a later phase. Dark behind data_resource_platform.',
  lifecycle: 'in-development',
  flagKey: 'data_resource_platform',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-27',
  updatedAt: '2026-09-27',

  // ---- surfaces (none wired yet — contract + service foundation only) ----
  routes: [],
  apiRoutes: [],

  // ---- governance ----
  permissions: [],
  dependencies: [],

  // ---- tests ----
  e2eTests: [],
  unitTests: [
    '../libs/features/data_resource_registry/__tests__/schemas.test.ts',
    '../libs/features/data_resource_registry/__tests__/service.test.ts',
  ],
  integrationTests: [],
  testStatus: 'passing',

  // ---- schemas ----
  zodSchemas: ['schemas.ts'],

  // ---- observability ----
  observability: {
    axiom: false,
    logs: true,
    analytics: false,
  },

  // ---- rollout ----
  rollout: {
    defaultEnabled: false,
    environments: {
      development: false,
    },
    notes:
      'Ship dark (enabled=0, rollout=0, stage=experimental). This fire wires no routes — the flag ' +
      'gates the future overview/registry surface + parity MCP tools. Promote in ' +
      '/admin/feature-flags once the per-resource routes land. Server guard returns 404 when off.',
  },

  risks: [
    'The registry is the ONLY place CF ids live; a resolver bug that accepts a client id would be ' +
      'an IDOR — mitigated structurally (no id input) + assertSiteOwned + the FORBIDDEN_DB_IDS ' +
      'denylist (fail-closed on a shared-platform id).',
    'Migration 0643 ALTERs site_database_allocations (additive, nullable) — a partial re-run errors ' +
      'on an already-added column; run once.',
  ],

  removalNotes:
    'Remove: this module (libs/features/data_resource_registry), the data_resource_platform ' +
    'FLAG_REGISTRY + FLAG_DOCS entries, and (if applied) the site_resource_registry table + the ' +
    'additive site_database_allocations columns from migration 0643. No routes are mounted yet, so ' +
    'there is nothing to un-wire in src/index.ts.',
});
