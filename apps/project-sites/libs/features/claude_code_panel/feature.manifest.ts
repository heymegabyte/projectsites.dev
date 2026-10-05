/**
 * @module libs/features/claude_code_panel
 *
 * Feature manifest for the embedded "Claude Code" editor tab's dark-flag (WLK-39 §75 flagship,
 * S7-prep). The flag gates a single resolution endpoint the bolt.diy editor probes once on mount
 * (over the PS_CLAUDE_FLAG bridge) to decide whether to render the Claude Code top tab — DARK by
 * default, promotable per-tenant via a flag override without a code change.
 */
import { defineFeatureManifest } from '@projectsites/feature-manifests';

export default defineFeatureManifest({
  slug: 'claude_code_panel',
  name: 'Claude Code Panel',
  // ≤200 chars (schema min 30) — a longer one fails validate:features.
  description:
    'Dark-flag for the embedded Claude Code editor tab (WLK-39). Gates GET /api/sites/:siteId/claude-code/status the editor probes on mount; 404 when off hides the tab (mirrors per_site_data).',
  lifecycle: 'in-development',
  flagKey: 'claude_code_panel',
  owner: 'brian@megabyte.space',
  createdAt: '2026-10-04',
  updatedAt: '2026-10-04',

  routes: [],
  apiRoutes: ['GET /api/sites/:siteId/claude-code/status'],

  permissions: ['sites:read'],
  dependencies: [],

  e2eTests: [],
  unitTests: ['src/__tests__/claude_code_panel_status_route.test.ts'],
  integrationTests: [],
  testStatus: 'passing',

  zodSchemas: [],

  observability: { axiom: false, logs: true, analytics: false },

  rollout: {
    defaultEnabled: false,
    environments: { development: false, production: false },
    notes:
      'Experimental, DARK (default-off). Replaces the S0 default-OFF client constant with the real flag: the editor renders the Claude Code tab only when this resolves ON, defaulting OFF until it resolves (standalone editor — no bridge — stays OFF). Reversible — promotion is a flag override in /admin/feature-flags, no code change. S7 flips it ON + proves it live.',
  },

  risks: [
    'Resolution-only endpoint — returns a single boolean for the OWNED site (assertSiteOwned IDOR-guarded); exposes no site data. Off → 404 for everyone (existence never leaked).',
    'The editor defaults the tab OFF until the probe resolves ON, so a transport failure / dark flag keeps the flagship hidden (fail-safe, never a spuriously-shown tab).',
  ],

  removalNotes:
    'Remove this module, the claudeCodePanel app.route() mount + import in src/index.ts, the claude_code_panel rows in feature_flags registry.ts + docs.ts, the PS_CLAUDE_FLAG bridge (embedded-mode.ts + bolt-embed.service.ts), and revert app/components/workbench/claude-code-flag.ts to the S0 constant. No owned D1 tables or migrations.',
});
