import { defineFeatureManifest } from '@projectsites/feature-manifests';
export default defineFeatureManifest({
  slug: 'site_publish_schedule',
  name: 'Scheduled Site Publishing',
  description:
    'Schedule a BUILT site to go live (status→published) at a future datetime; the every-minute cron flips DUE sites live and marks the row fired. One pending schedule per site; unbuilt sites are skipped.',
  lifecycle: 'alpha',
  flagKey: 'scheduled_publish',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-15',
  updatedAt: '2026-09-15',
  routes: [],
  apiRoutes: [
    'POST /api/sites/:id/publish-schedule',
    'GET /api/sites/:id/publish-schedule',
    'DELETE /api/sites/:id/publish-schedule',
  ],
  permissions: ['admin:read', 'admin:write'],
  dependencies: [],
  e2eTests: ['e2e/site_publish_schedule/schedule.spec.ts'],
  unitTests: ['../libs/features/site_publish_schedule/__tests__/site_publish_schedule.test.ts'],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes: 'Dark by default (experimental). Server guard 404s until promoted. Cron sweep finds no rows to fire while off.',
  },
  risks: [
    'The cron flips site.status to published — only for sites with a build (current_build_version); an unbuilt site is skipped so a blank page is never served.',
    'KV host-resolution cache (60s TTL) means a scheduled go-live becomes visible within ~1 minute of publish_at, not instantly.',
  ],
  removalNotes:
    'Drop the /api/sites/:id/publish-schedule routes, the Stage 6.2 hook in scheduled(), and the site_publish_schedules table (migration 0634). No effect on normal publishing (build → publish) which is independent of this table.',
});
