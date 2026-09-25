/**
 * @module pages/admin/admin-section-labels
 *
 * Route-segment → human label map that drives the per-route document title
 * (`<label> · ProjectSites`) + meta description in {@link AdminComponent}.
 *
 * Every routed admin section MUST have an entry here — a missing entry falls
 * back to 'Dashboard' (the `/admin` home), leaving a stale/incorrect document
 * title (WCAG 2.4.2 Page Titled). Keep this in sync with the admin child routes
 * in `app.routes.ts`.
 */
export const ADMIN_SECTION_LABELS: Readonly<Record<string, string>> = {
  // `/admin` (path:'') now renders the AI Dashboard, NOT the editor — the editor
  // moved to `/admin/editor`. Label the index route 'Dashboard' so the breadcrumb
  // + document title match what's on screen (WCAG 2.4.2). editor* stay 'Editor'.
  '': 'Dashboard', admin: 'Dashboard', editor: 'Editor',
  snapshots: 'Snapshots', analytics: 'Analytics',
  forms: 'Forms', traces: 'AI Traces', 'ai-logs': 'AI Traces',
  domains: 'Domains', docs: 'Docs',
  user: 'User Settings', apps: 'Apps', instances: 'App Instances',
  billing: 'Billing', settings: 'Settings',
  voice: 'Voice',
  'feature-flags': 'Feature Flags',
  'site-features': 'Features', social: 'Social',
  swarm: 'Swarm',
  logs: 'Logs',
  mcp: 'MCP', seo: 'SEO', inbox: 'Inbox',
  import: 'Import', sites: 'Sites', welcome: 'Welcome', email: 'Email',
  copilot: 'Copilot', dna: 'Site DNA', branches: 'Branches',
  'mcp-server': 'MCP Server', stack: 'Domain Stack', diff: 'Snapshot Diff',
  // Coverage gap closed: these routed sections fell back to 'Editor' → stale
  // document title (WCAG 2.4.2). Verified live the titles stayed "Editor".
  deliverability: 'Deliverability', webhooks: 'Webhooks',
  'api-tokens': 'API Tokens',
  'accept-invite': 'Accept Invite',
  // Route↔label coverage gap closed via validate-admin-contract.mjs (WCAG 2.4.2):
  // these routed sections had no label → document title fell back to 'Dashboard'.
  audit: 'Audit Log', team: 'Team', 'auth-security': 'Auth Security',
  'system-services': 'System Services',
  // Operator sections — nav-linked but were missing labels → title fell back to
  // 'Dashboard' (WCAG 2.4.2 Page Titled). Found via the route↔nav↔label coverage diff.
  leads: 'Lead Scanner',
  // Data-resource inspectors — components + routes shipped (a00e1143e / R2), but were
  // missing labels → document title fell back to 'Dashboard' (WCAG 2.4.2). Labels match each h1.
  'kv-inspector': 'KV Inspector',
  'r2-inspector': 'R2 Inspector',
  'vectorize-inspector': 'Vectorize Inspector',
  'queues-inspector': 'Queues Inspector',
  'super-admin': 'Super Admin',
};

/**
 * Resolve the human label for a single route segment.
 * Falls back to 'Dashboard' (the `/admin` home) for unknown segments.
 */
export function adminSectionLabel(segment: string): string {
  return ADMIN_SECTION_LABELS[segment] ?? 'Dashboard';
}

/**
 * Resolve the human label for a full admin URL, handling PARAM + SUB-PATH
 * routes that a bare last-segment lookup mislabels.
 *
 * The old `url.split('/').pop()` grabbed the LAST segment — which for a param
 * route (`/admin/sites/:id`, `/admin/swarm/:siteId`, `/admin/apps/:id`) is the
 * PARAM VALUE (a site id), and for some sub-paths (`/admin/snapshots/diff`,
 * `/admin/domains/:id/stack`) is an unmapped tail → both fell back to a wrong
 * "Dashboard" breadcrumb + document title + SR route-announcer (WCAG 2.4.2).
 *
 * Walk segments most-specific → least and return the first KNOWN label: a
 * sub-view keeps its own label (`/sites/:id/branches` → "Branches"); a param
 * value is skipped so the section root wins (`/sites/:id` → "Sites"); a fully
 * unknown path (a 404) still falls back to 'Dashboard' (unchanged).
 */
export function adminSectionLabelFromPath(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  const segments = path.split('/').filter(Boolean);
  const afterAdmin = segments[0] === 'admin' ? segments.slice(1) : segments;
  if (afterAdmin.length === 0) return ADMIN_SECTION_LABELS[''] ?? 'Dashboard';
  for (let i = afterAdmin.length - 1; i >= 0; i--) {
    const label = ADMIN_SECTION_LABELS[afterAdmin[i]];
    if (label) return label;
  }
  return 'Dashboard';
}

/**
 * True when the URL targets a specific site's detail view (`/admin/sites/:id`
 * or any sub-path like `/admin/sites/:id/branches`). Used to enrich the
 * document title + SR route-announcer with the REAL site name (P2 — breadcrumbs
 * with real names) instead of the generic "Sites" section label. The list view
 * `/admin/sites` (no id segment) returns false — it stays "Sites".
 */
export function isSiteDetailPath(url: string): boolean {
  const path = url.split('?')[0].split('#')[0];
  const segments = path.split('/').filter(Boolean);
  const afterAdmin = segments[0] === 'admin' ? segments.slice(1) : segments;
  return afterAdmin[0] === 'sites' && afterAdmin.length >= 2 && !!afterAdmin[1];
}
