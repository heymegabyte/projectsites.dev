import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  slug: 'mcp_oauth_provider',
  name: 'MCP OAuth 2.1 authorization server',
  description: 'OAuth 2.1 AS so MCP clients (Claude Code) get tokens via PKCE instead of pasting psk_ tokens.',
  flagKey: 'mcp_server',
  owner: 'brian@megabyte.space',
  createdAt: '2026-06-17',
  updatedAt: '2026-09-29',
  lifecycle: 'alpha',
  routes: [
    'GET /.well-known/oauth-authorization-server',
    'GET /oauth/authorize',
  ],
  apiRoutes: [
    'POST /oauth/register',
    'POST /api/oauth/authorize',
    'POST /oauth/token',
  ],
  permissions: ['sites:read', 'sites:write'],
  dependencies: ['platform_mcp'],
  e2eTests: [],
  unitTests: [
    '../libs/features/mcp_oauth_provider/__tests__/oauth_provider.test.ts',
    '../libs/features/mcp_oauth_provider/__tests__/scope_intersection_atomic_codes.test.ts',
  ],
  integrationTests: [],
  testStatus: 'passing',
  zodSchemas: ['schemas.ts'],
  observability: { axiom: true, logs: true, analytics: false },
  rollout: {
    defaultEnabled: false,
    environments: { development: true },
    notes:
      'Alpha. OAuth 2.1 AS (RFC 8414 metadata + 7591 DCR + PKCE-S256 authorization_code) issuing scoped psk_ tokens. Clients in KV; codes in D1 (mcp_oauth_codes, migration 0649) with atomic single-use consumption + presenter-scope intersection (requested ∩ presenter; session presenters resolve via membership RBAC) per campaign lane-2 fire-57. Promote after the Angular /oauth/consent page ships + a prod connect smoke.',
  },
  risks: [
    'When disabled, all /oauth/* + /.well-known/oauth-authorization-server routes 404 — MCP clients fall back to pasting a psk_ token.',
    'The authorization-code → token exchange mints a real psk_ token; a flaw in PKCE/redirect validation would widen blast radius. Mitigated by presenter-scope intersection at authorize + defensive re-intersection at exchange (child ≤ presenter), atomic single-use D1 codes (hash-only at rest) + 10-min TTL + exact redirect_uri match + adversarial test coverage.',
  ],
  removalNotes:
    'Remove this module, the oauthProvider app.route() mount in src/index.ts, the mcp_oauth_provider flag, and drop the mcp_oauth_codes D1 table (migration 0649). KV oauth_client:* keys expire on their own.',
});
