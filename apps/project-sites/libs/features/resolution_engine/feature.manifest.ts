import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  slug: 'resolution_engine',
  name: 'Resolution Engine',
  description:
    'Dual-provider research primitive (WLK-39 S6-a): runDualResearch fans two INDEPENDENT provider calls (OpenAI+Anthropic) in parallel via the AI Gateway, returning both for S6-b synthesis.',
  lifecycle: 'in-development',
  flagKey: 'resolution_engine',
  owner: 'brian@megabyte.space',
  createdAt: '2026-10-04',
  updatedAt: '2026-10-04',
  routes: [],
  // No HTTP route in this slice — pure service primitive (runDualResearch). The
  // authed route + Claude synthesis + panel consumption are S6-b's concern.
  apiRoutes: [],
  permissions: [],
  dependencies: ['model_registry'],
  e2eTests: [],
  unitTests: ['../libs/features/resolution_engine/__tests__/resolution_engine.test.ts'],
  integrationTests: [],
  testStatus: 'passing',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: { development: false, production: false },
    notes:
      'Experimental, DARK (default-off). S6-a ships the tested dual-research service primitive only; S6-b adds the authed route (404 when off), Claude synthesis of both legs, and the resolution panel. Reversible — the flag gates runDualResearch (ResolutionEngineDisabledError when off, zero provider calls).',
  },
  risks: [
    'When enabled, each call fans out TWO provider research requests — ~2× research token spend vs a single-provider path. Gated dark until S6-b wires the synthesis + a cost ceiling.',
    'Independence (invariant #7) depends on the two legs using DISTINCT providers; the schema rejects a same-provider pair, and the default is openai+anthropic.',
  ],
  removalNotes:
    'Delete libs/features/resolution_engine/ and drop the resolution_engine entry from the feature_flags registry. No route mount or migration to unwind in this slice.',
});
