/**
 * @module libs/features/queues_inspector
 *
 * Feature manifest for the read-only Queues Inspector — a super-admin platform
 * debugging tool that lists the account's Cloudflare Queues and describes each
 * (settings, producers, consumers).
 *
 * PLATFORM tool, not a per-site feature — belongs in the "System Administrator"
 * surface of the admin SPA, alongside the KV / R2 / Vectorize inspectors.
 */

import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  // ---- identity ----
  slug: 'queues_inspector',
  name: 'Queues Inspector',
  description:
    'Read-only platform debugging tool for the account Cloudflare Queues (job / workflow ' +
    'pipelines — shared platform infra, not tenant-owned). Lists queues and describes each: ' +
    'delivery delay, message retention, and the producers + consumers (worker script / ' +
    'service) bound to it. Super-admin only. No publish / purge / delete exposed. Cloudflare ' +
    'credentials stay server-side (account REST via the worker global key); the account id is ' +
    'server-derived, never client-supplied.',
  lifecycle: 'in-development',
  flagKey: 'queues_inspector',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-25',
  updatedAt: '2026-09-25',

  // ---- surfaces ----
  routes: ['/admin/queues-inspector'],
  apiRoutes: ['GET /api/admin/queues', 'GET /api/admin/queues/:id'],

  // ---- governance ----
  permissions: ['platform:debug'],
  dependencies: [],

  // ---- tests ----
  e2eTests: [],
  unitTests: ['../libs/features/queues_inspector/__tests__/queues_inspector.test.ts'],
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
    'Exposes queue NAMES + producer/consumer worker scripts — may hint at internal pipelines. ' +
      'Super-admin gate + 404-on-flag-off limits blast radius.',
    'Read-only: no messages are published, consumed, or purged here — only queue metadata.',
    'Uses the worker global CF key server-side for the account REST API; the browser never sees it.',
  ],

  removalNotes:
    'Remove: this module, the queuesInspector app.route() mount in src/index.ts, the ' +
    'queues_inspector FLAG_REGISTRY entry, and the Queues Inspector component from the frontend. ' +
    'No D1 schema changes needed.',
});
