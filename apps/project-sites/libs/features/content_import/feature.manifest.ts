import { defineFeatureManifest } from '@projectsites/feature-manifests';
export default defineFeatureManifest({
  slug: 'content_import',
  name: 'Content Import',
  description:
    'Parse a platform export (WordPress/Squarespace/Wix/Webflow/CSV/RSS) into normalized ContentItem[] to seed into a generated site — the export-based ingestion path complementing the crawler.',
  lifecycle: 'alpha',
  flagKey: 'content_import',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-19',
  updatedAt: '2026-09-19',
  routes: [],
  apiRoutes: ['POST /api/content-import/parse'],
  permissions: ['admin:write'],
  dependencies: [],
  e2eTests: [],
  unitTests: [
    '../libs/features/content_import/__tests__/content_import_endpoint.test.ts',
    '../src/__tests__/content_import.test.ts',
  ],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes:
      'Dark by default (experimental). Server guard 404s until promoted. Pure parse — no writes, no state.',
  },
  risks: [
    'Parse-only v1: returns normalized items; seeding them INTO a build (or an R2-upload path for multi-MB exports) is a follow-on. The raw payload is capped at 200 KB to stay under the 256 KB body limit.',
    'The parsers are regex/JSON/CSV based — a malformed export returns a typed 400, never a 500 or a partial write.',
  ],
  removalNotes:
    'Drop the /api/content-import/parse route + this module. The pure parsers in src/services/content_import.ts (still unit-tested) can stay or be removed with it. No table, no state — nothing to migrate.',
});
