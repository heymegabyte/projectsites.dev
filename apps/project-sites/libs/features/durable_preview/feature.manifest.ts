import { defineFeatureManifest } from '@projectsites/feature-manifests';
export default defineFeatureManifest({
  slug: 'durable_preview',
  name: 'Durable Preview Model',
  description:
    'Server-side Preview/Promote release state: a per-site working-tree record (base SHA, monotonic draft revision, tree digest) plus an append-only immutable release log. Save upserts Preview only.',
  lifecycle: 'alpha',
  flagKey: 'durable_preview',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-28',
  updatedAt: '2026-09-28',
  routes: [],
  apiRoutes: [
    'POST /api/sites/:id/preview-state',
    'GET /api/sites/:id/preview-state',
    'GET /api/sites/:id/releases',
    'POST /api/sites/:id/promote',
  ],
  permissions: ['admin:read', 'admin:write'],
  dependencies: [],
  e2eTests: [],
  unitTests: [
    '../libs/features/durable_preview/__tests__/durable_preview.test.ts',
    '../libs/features/durable_preview/__tests__/promote.test.ts',
  ],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes:
      'Dark by default (experimental). Server guard 404s until promoted. State + API only — the Promote button UI + promote transaction are later slices. Migrating existing sites requires no redeploy (a site has no working-tree/release rows until next saved/promoted).',
  },
  risks: [
    'Additive only: creates site_working_tree + site_releases; touches no existing table. A save/generate writes the working tree exclusively — never a commit, deploy, or Production change (Production changes only via an authorized Promote, a later slice).',
    'Promoted bytes must equal the frozen Preview revision — the artifact_digest column on site_releases exists so a future Promote can prove that equality; nothing enforces it in this state-only slice.',
  ],
  removalNotes:
    'Drop the /api/sites/:id/preview-state + /api/sites/:id/releases routes, unmount durablePreview from index.ts, remove the durable_preview flag from the registry + docs, and drop the site_working_tree + site_releases tables (migration 0646). No effect on normal build → publish (independent of these tables).',
});
