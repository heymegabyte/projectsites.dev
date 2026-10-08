/**
 * @module libs/features/site_automations
 *
 * Feature manifest for the Automations panel (RES-AUTO slice 1) — a read-only
 * discovery endpoint listing a site's workflow/automation instances (its
 * `workflow_jobs` rows) so the owner can see what ran, when, and its outcome.
 */
import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  slug: 'site_automations',
  name: 'Site Automations Panel',
  description:
    'The Automations panel: lists a sites workflow_jobs (id, type, status, timestamps), org-scoped, PLUS a RETRY mutation (POST .../:id/retry) re-dispatching the sites workflow the way reset does.',
  lifecycle: 'alpha',
  flagKey: 'site_automations',
  owner: 'brian@megabyte.space',
  createdAt: '2026-10-02',
  updatedAt: '2026-10-02',

  routes: [],
  apiRoutes: [
    'GET /api/sites/:siteId/automations',
    'POST /api/sites/:siteId/automations/:id/retry',
    'POST /api/sites/:siteId/automations/:id/cancel',
  ],

  permissions: ['sites:read', 'sites:write'],
  dependencies: [],

  e2eTests: [],
  unitTests: [
    'src/__tests__/site_automations_route.test.ts',
    'src/__tests__/site_automations_retry_route.test.ts',
    'src/__tests__/site_automations_cancel_route.test.ts',
  ],
  integrationTests: [],
  testStatus: 'passing',

  zodSchemas: ['schemas.ts'],

  observability: { axiom: false, logs: true, analytics: false },

  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes:
      'Alpha, discovery only (read-only — no writes). Reads workflow_jobs for the owned site. Promote to beta once the Automations panel UI consumes it + a prod smoke confirms the list is accurate.',
  },

  risks: [
    'Reads the shared platform workflow_jobs table — hard-scoped to site_id AND guarded by assertSiteOwned so it never exposes another tenant\'s jobs.',
    'List is capped at 200 rows; a very active site could have older runs omitted (acceptable for a recent-activity panel).',
    'The retry mutation re-dispatches a $-costly SITE_WORKFLOW build — guarded by assertSiteOwned (IDOR) AND an in-flight (building/generating) check so a double-click cannot spawn two concurrent builds.',
  ],

  removalNotes:
    'Remove this module, the siteAutomations app.route() mount + import in src/index.ts, and the site_automations rows in feature_flags registry.ts + docs.ts. No owned D1 tables or migrations (reads the existing workflow_jobs table).',
});
