/**
 * @module libs/features/site_functions
 *
 * Feature manifest for the Functions panel — the FIFTH Resources sub-tab (beside
 * Media / Files / Buckets / Automations). A read-only discovery endpoint listing a
 * site's CODE-DEFINED Functions (Workers-for-Platforms): its deployed `functions/`
 * worker + its declared cron schedules, with real deploy status.
 *
 * DOCTRINE (ADR-0035, docs/FUNCTIONS-CONVERGENCE.md): Functions are authored in a
 * `functions/` folder in the editor, NEVER a dashboard form — so this manifest's
 * surface is a READ/MANAGE VIEW, not an authoring form. No writes.
 */
import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  slug: 'site_functions',
  name: 'Site Functions Panel',
  description:
    'Functions panel (fifth Resources sub-tab): read-only list of a sites code-defined WfP Functions (deployed functions/ worker + declared crons) from authoritative persisted signals. ADR-0035, no writes.',
  lifecycle: 'alpha',
  flagKey: 'site_functions',
  owner: 'brian@megabyte.space',
  createdAt: '2026-10-08',
  updatedAt: '2026-10-08',

  routes: [],
  apiRoutes: ['GET /api/sites/:siteId/functions'],

  permissions: ['sites:read'],
  dependencies: [],

  e2eTests: [],
  unitTests: ['src/__tests__/site_functions_route.test.ts'],
  integrationTests: [],
  testStatus: 'passing',

  zodSchemas: ['schemas.ts'],

  observability: { axiom: false, logs: true, analytics: false },

  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes:
      'Alpha, discovery only (read-only — no writes). Reads the authoritative functions deploy signals (sites.functions_deployed_at + the R2 last-good bundle + site_functions_schedules) for the owned site. Default DARK; lead flips the prod flag + deploys + live-verifies the editor Resources → Functions tab. Promote to beta once a prod smoke confirms the list is accurate for a site with a deployed functions/ worker.',
  },

  risks: [
    'Reads the shared platform tables (sites, site_functions_schedules) — hard-scoped to the OWNED site_id AND guarded by assertSiteOwned so it never exposes another tenants functions.',
    'The HTTP-function entry is one deployment unit (the bundled functions/ worker), not a per-route list — the route manifest is not persisted server-side, so fabricating per-route rows would be dishonest (mirrors backend_inventory). Route-level detail would need the manifest persisted at deploy (future work).',
    'On a deployment where Workers-for-Platforms is not provisioned (isWfpConfigured=false), the panel reports that honestly via wfpConfigured=false rather than showing a misleading empty.',
  ],

  removalNotes:
    'Remove this module, the siteFunctions app.route() mount + import in src/index.ts, and the site_functions rows in feature_flags registry.ts + docs.ts, plus the FunctionsPanel wiring in the editor (app/components/workbench/ResourcesPanel.tsx + FunctionsPanel.tsx) and the PS_RES_FUNCTIONS bridge in app/lib/embed/embedded-mode.ts + apps/project-sites/frontend/src/app/services/bolt-embed.service.ts. No owned D1 tables or migrations (reads existing sites + site_functions_schedules).',
});
