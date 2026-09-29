import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  slug: 'model_registry',
  name: 'Model Registry',
  description: 'Provider/alias registries plus the four projectsites-* virtual service models, served OpenAI-compatibly at GET /v1/models and /v1/models/:id behind Bearer psk_ API-token auth.',
  lifecycle: 'beta',
  flagKey: 'model_registry',
  owner: 'brian@megabyte.space',
  createdAt: '2026-06-18',
  updatedAt: '2026-09-29',
  routes: [],
  apiRoutes: ['GET /v1/models', 'GET /v1/models/:id'],
  permissions: [],
  dependencies: [],
  e2eTests: ['../e2e/ai-api/openai-compat.e2e.ts'],
  unitTests: ['../libs/features/model_registry/__tests__/model_registry.test.ts'],
  integrationTests: [],
  testStatus: 'passing',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: false, logs: true, analytics: false },
  rollout: {
    defaultEnabled: true,
    environments: { development: true, production: true },
    notes: 'Beta 2026-09-29 (campaign lane-4 §7): enabled at 100% via the registry default. Read-only catalog behind Bearer psk_ auth; no external calls, no DB writes beyond api_tokens last_used_at touch. Reversible via killswitch stage.',
  },
  risks: ['If disabled, GET /v1/models{,/:id} returns 404 — OpenAI-compatible clients that rely on model discovery will fail until re-enabled.'],
  removalNotes: 'Remove the /v1/models route mount in src/index.ts and drop the feature_flags registry entry.',
});
