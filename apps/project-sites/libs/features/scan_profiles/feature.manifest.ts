import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  slug: 'scan_profiles',
  name: 'Scan Profiles',
  description:
    'D1-persisted CRUD for the lead scanner\'s editable "what to hunt" config — geo bboxes, OSM categories, providers, free-text filters and cadence — so an operator tunes the automatic scanner from the admin UI instead of editing code.',
  lifecycle: 'alpha',
  flagKey: 'scan_profiles',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-22',
  updatedAt: '2026-09-22',
  routes: [],
  apiRoutes: [
    'GET /api/admin/scan-profiles',
    'POST /api/admin/scan-profiles',
    'PATCH /api/admin/scan-profiles/:id',
    'DELETE /api/admin/scan-profiles/:id',
  ],
  permissions: [],
  dependencies: ['lead_scanner'],
  e2eTests: ['e2e/scan_profiles/scan-profiles.spec.ts'],
  unitTests: ['src/__tests__/scan_profiles_routes.test.ts', 'src/__tests__/scan_profiles.test.ts'],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['src/services/scan_profiles.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes:
      'Dark by default (experimental). Flag off = every route 404s; the existing ad-hoc scan routes (POST /api/admin/leads/scan, /scan-osm, gated by the separate lead_scanner flag) keep working, so nothing regresses.',
  },
  risks: [
    'Profiles persist operator-authored geo bboxes + free-text filters. A malformed bbox reaches the OSM/Places query builder — the schema bounds each to a 4-tuple of numbers and caps the array at 500, but the provider may still reject semantically invalid (inverted) boxes.',
    'The cron geo-sweep reads the DUE profiles and runs each bbox through the lead_scan_orchestrator, which sinks leads into the Twenty CRM. An over-broad enabled profile burns OSM/Places quota + CRM rows; maxLeadsPerRun (default 50) is the per-run cost guard.',
    'Profiles default to enabled=false and intervalMinutes=0 (manual-only) — a profile cannot auto-run until an operator explicitly turns it on AND sets a cadence.',
  ],
  removalNotes:
    'Remove src/routes/scan_profiles.ts (+ its app.route mount in src/index.ts), src/services/scan_profile_store.ts, this flag, and the feature-flag seed row. The scan_profiles D1 table is additive and read by nothing else; drop it only after confirming the cron no longer reads it.',
});
