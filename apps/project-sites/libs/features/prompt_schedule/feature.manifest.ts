import { defineFeatureManifest } from '@projectsites/feature-manifests';
export default defineFeatureManifest({
  slug: 'prompt_schedule',
  name: 'Prompt Scheduler',
  description:
    'Schedule a prompt-registry variant active for a time window (activate_at/deactivate_at); the pipeline reads getActiveVariant(key,now) at resolve time. Read-time eval, no cron.',
  lifecycle: 'alpha',
  flagKey: 'prompt_schedule',
  owner: 'brian@megabyte.space',
  createdAt: '2026-09-15',
  updatedAt: '2026-09-15',
  routes: [],
  apiRoutes: [
    'POST /api/prompt-schedules',
    'GET /api/prompt-schedules',
    'GET /api/prompt-schedules/active',
    'DELETE /api/prompt-schedules/:id',
  ],
  permissions: ['admin:read', 'admin:write'],
  dependencies: ['prompt_studio'],
  e2eTests: ['e2e/prompt_schedule/schedule.spec.ts'],
  unitTests: ['../libs/features/prompt_schedule/__tests__/prompt_schedule.test.ts'],
  integrationTests: [],
  testStatus: 'partial',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes: 'Dark by default (experimental). Server guard 404s until promoted. Read-time eval — no cron.',
  },
  risks: [
    'When promoted, the generation pipeline must consult getActiveVariant() at prompt-resolve time; until then schedules are stored but not consumed.',
    'Overlapping windows: most-recently-activated wins — verify intended precedence before scheduling overlaps.',
  ],
  removalNotes:
    'Drop /api/prompt-schedules routes + the prompt_schedules table (migration 0633). No effect on default prompt resolution (getActiveVariant is only consulted when the flag is on).',
});
