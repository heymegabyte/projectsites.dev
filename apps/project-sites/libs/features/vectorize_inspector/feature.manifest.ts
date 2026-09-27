/**
 * @module libs/features/vectorize_inspector
 *
 * Feature manifest for the read-only Vectorize Index Inspector — a super-admin
 * platform debugging tool that lists the account's Cloudflare Vectorize indexes and
 * describes each (dimensions, distance metric, description, vector count, freshness).
 *
 * PLATFORM tool, not a per-site feature — belongs in the "System Administrator"
 * surface of the admin SPA, alongside the KV + R2 inspectors.
 */

import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  // ---- identity ----
  slug: 'vectorize_inspector',
  name: 'Vectorize Inspector',
  description:
    'Read-only platform debugging tool for the account Cloudflare Vectorize indexes ' +
    '(RAG / embeddings — shared platform infra, not tenant-owned). Lists indexes and ' +
    'describes each: dimensions, distance metric, description, vector count, and last ' +
    'processed mutation. Super-admin only. No insert / query / delete exposed. Cloudflare ' +
    'credentials stay server-side (v2 REST via the worker global key); the account id is ' +
    'server-derived, never client-supplied.',
  lifecycle: 'in-development',
  flagKey: 'vectorize_inspector',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-25',
  updatedAt: '2026-09-25',

  // ---- surfaces ----
  routes: ['/admin/vectorize-inspector'],
  apiRoutes: [
    'GET /api/admin/vectorize/indexes',
    'GET /api/admin/vectorize/indexes/:name',
  ],

  // ---- governance ----
  permissions: ['platform:debug'],
  dependencies: [],

  // ---- tests ----
  e2eTests: [],
  unitTests: ['../libs/features/vectorize_inspector/__tests__/vectorize_inspector.test.ts'],
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
    'Exposes Vectorize index NAMES + config (dimensions/metric) — names may hint at internal ' +
      'RAG datasets. Super-admin gate + 404-on-flag-off limits blast radius.',
    'Read-only: no vectors are queried, inserted, or deleted here — only index metadata + counts.',
    'Uses the worker global CF key server-side for the v2 REST API; the browser never sees it.',
  ],

  removalNotes:
    'Remove: this module, the vectorizeInspector app.route() mount in src/index.ts, the ' +
    'vectorize_inspector FLAG_REGISTRY entry, and the Vectorize Inspector component from the ' +
    'frontend. No D1 schema changes needed.',
});
