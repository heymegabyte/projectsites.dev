/**
 * @module libs/features/d1_manager
 *
 * Feature manifest for the D1 Manager — a read-only, super-admin surface that discovers the
 * Cloudflare account's D1 databases and shows each one's Overview metadata (on-disk size,
 * table count, primary region, read-replication mode, version). This is the "resource
 * discovery + Overview" tier of the D1 data-management epic; it complements the existing
 * super-admin raw SQL console + schema browser (which read the shared multi-tenant DB) with a
 * database-level metadata view the SQL endpoints don't provide.
 *
 * PLATFORM tool, not a per-site feature — it belongs in the "System Administrator" surface of
 * the admin SPA and is ALSO surfaced in the Editor Data panel's D1 Overview strip.
 */

import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  // ---- identity ----
  slug: 'd1_manager',
  name: 'D1 Manager',
  description:
    'Read-only, super-admin D1 resource-discovery + Overview surface. Lists the account\'s D1 ' +
    'databases and shows one database\'s metadata (file size, table count, region, read-replication, ' +
    'version) via the Cloudflare D1 REST API. Credentials stay server-side; the account is ' +
    'env.CF_ACCOUNT_ID (never client-supplied); the :databaseId is a validated UUID (no path injection) ' +
    'and the super-admin gate is the authz boundary. Honest "not available" (never a fabricated empty ' +
    'list) when the CF API fails. Read-only — no query/write/restore.',
  lifecycle: 'in-development',
  flagKey: 'd1_manager',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-25',
  updatedAt: '2026-09-25',

  // ---- surfaces ----
  routes: ['/admin/data'],
  apiRoutes: [
    'GET /api/admin/d1/databases',
    'GET /api/admin/d1/:databaseId/overview',
    'POST /api/admin/d1/:databaseId/export',
  ],

  // ---- governance ----
  permissions: ['platform:debug'],
  dependencies: [],

  // ---- tests ----
  e2eTests: [],
  unitTests: ['../libs/features/d1_manager/__tests__/d1_manager.test.ts'],
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
      'Ship dark (enabled=0, rollout=0, stage=experimental). Promote in /admin/feature-flags ' +
      'to enable for super-admins only. Read-only metadata view — safe to promote when needed.',
  },

  risks: [
    'Surfaces account-wide D1 database metadata (size, table count, region). Super-admin gate + ' +
      '404-on-flag-off limits blast radius; no row data or credentials are exposed.',
    'Cloudflare D1 REST list/get is best-effort — a credential/API failure returns available:false ' +
      '(honest), never a fabricated empty list.',
  ],

  removalNotes:
    'Remove: this module, the d1Manager app.route() mount in src/index.ts, the d1_manager ' +
    'FLAG_REGISTRY entry, the PS_D1_OVERVIEW bridge messages in the editor, and the D1 Overview ' +
    'strip in the Editor Data panel. No D1 schema changes needed.',
});
