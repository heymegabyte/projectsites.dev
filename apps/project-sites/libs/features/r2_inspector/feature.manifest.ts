/**
 * @module libs/features/r2_inspector
 *
 * Feature manifest for the R2 Object Inspector — a read-only, super-admin
 * debugging tool that surfaces the shared platform R2 bucket (SITES_BUCKET) in
 * the admin UI with a bucket picker, prefix search, cursor-paginated object list,
 * and an object metadata (HEAD) detail panel.
 *
 * This is a PLATFORM tool, not a per-site feature — it belongs in the
 * "System Administrator" surface of the admin SPA.
 */

import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  // ---- identity ----
  slug: 'r2_inspector',
  name: 'R2 Inspector',
  description:
    'Read-only platform debugging tool for the shared R2 bucket (SITES_BUCKET = generated ' +
    'site output + media). Exposes bucket picker → prefix search → cursor-paginated object ' +
    'list → object metadata (key, size, uploaded, etag, content-type, custom metadata) via ' +
    'HEAD. Super-admin only. No writes, no deletes, no body download exposed.',
  lifecycle: 'in-development',
  flagKey: 'r2_inspector',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-24',
  updatedAt: '2026-09-24',

  // ---- surfaces ----
  routes: ['/admin/r2-inspector'],
  apiRoutes: [
    'GET /api/admin/r2/buckets',
    'GET /api/admin/r2/:bucket/objects',
    'GET /api/admin/r2/:bucket/object',
  ],

  // ---- governance ----
  permissions: ['platform:debug'],
  dependencies: [],

  // ---- tests ----
  e2eTests: [],
  unitTests: ['../libs/features/r2_inspector/__tests__/r2_inspector.test.ts'],
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
      'to enable for super-admins only. Read-only debug tool — safe to promote when needed.',
  },

  risks: [
    'Exposes raw R2 object keys + metadata — keys may reveal site slugs / paths. ' +
      'Super-admin gate + 404-on-flag-off limits blast radius.',
    'Metadata only (HEAD) — object BODIES are never streamed here, so no large-object memory risk.',
    'SITES_BUCKET is a SHARED platform bucket (all sites + media), NOT tenant-owned — a super-admin ' +
      'debug view, not a per-owner file browser.',
  ],

  removalNotes:
    'Remove: this module, the r2Inspector app.route() mount in src/index.ts, the r2_inspector ' +
    'FLAG_REGISTRY entry, and the R2 Inspector component from the frontend. No D1 schema changes needed.',
});
