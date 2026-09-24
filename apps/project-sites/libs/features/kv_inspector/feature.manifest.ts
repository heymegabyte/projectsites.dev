/**
 * @module libs/features/kv_inspector
 *
 * Feature manifest for the KV Namespace Inspector — a read-only, super-admin
 * debugging tool that surfaces the two shared platform KV bindings (CACHE_KV,
 * PROMPT_STORE) in the admin UI with a binding picker, prefix search,
 * cursor-paginated key list, and a value/metadata/TTL detail panel.
 *
 * This is a PLATFORM tool, not a per-site feature — it belongs in the
 * "System Administrator" surface of the admin SPA.
 */

import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  // ---- identity ----
  slug: 'kv_inspector',
  name: 'KV Inspector',
  description:
    'Read-only platform debugging tool for the two shared KV namespaces (CACHE_KV = host/analytics cache, ' +
    'PROMPT_STORE = prompt hot-patch). Exposes binding picker → prefix search → cursor-paginated key list → ' +
    'value + metadata + TTL panel. Super-admin only. Honest "eventually consistent" note in the UI. ' +
    'No writes or deletes exposed.',
  lifecycle: 'in-development',
  flagKey: 'kv_inspector',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-24',
  updatedAt: '2026-09-24',

  // ---- surfaces ----
  routes: ['/admin/kv-inspector'],
  apiRoutes: [
    'GET /api/admin/kv/namespaces',
    'GET /api/admin/kv/:binding/keys',
    'GET /api/admin/kv/:binding/value',
  ],

  // ---- governance ----
  permissions: ['platform:debug'],
  dependencies: [],

  // ---- tests ----
  e2eTests: [],
  unitTests: ['../libs/features/kv_inspector/__tests__/kv_inspector.test.ts'],
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
    'Exposes raw KV key names and values — values may contain cached auth tokens or prompt text. ' +
      'Super-admin gate + 404-on-flag-off limits blast radius.',
    'KV list() is eventually consistent — a just-written key may not appear immediately.',
    'Value size cap (64 KiB) means very large values are truncated; the truncated flag is set.',
  ],

  removalNotes:
    'Remove: this module, the kvInspector app.route() mount in src/index.ts, the kv_inspector ' +
    'FLAG_REGISTRY entry, and the KV Inspector component from the frontend. No D1 schema changes needed.',
});
