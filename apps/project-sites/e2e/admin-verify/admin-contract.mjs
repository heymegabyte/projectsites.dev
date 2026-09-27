/**
 * admin-contract.mjs — THE single source of truth for every admin section.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this file, "what admin sections exist + what each must satisfy" was
 * scattered across FIVE drifting places: app.routes.ts (routes+guards+flags),
 * admin-section-labels.ts (labels), inline SECTIONS[] arrays in 3+ browserbase
 * specs, a 730-checkbox test doc, and the hand-curated
 * nav in admin.component. Nothing derived from one source, so sections silently
 * drifted in and out of coverage — the "routed+mounted ≠ reachable" and
 * "advertised-route orphan" bug classes.
 *
 * This contract is the ONE list. Everything reads it:
 *   - scripts/validate-admin-contract.mjs  → drift gate (contract ⇄ app.routes ⇄ labels)
 *   - e2e/admin-verify/contract-sweep.mjs  → prod per-section assertions + real DONE gate
 *
 * ADD A SECTION → ADD A ROW HERE. The validator fails the build if app.routes.ts
 * gains an admin route with no row (uncovered) or a row points at a dead route (stale).
 *
 * PER-SECTION CONTRACT (the TDD spec each section must satisfy on PROD, authed):
 *   1. RENDER      — main content ≥ minLen chars (not blank / not a spinner)
 *   2. REAL DATA   — `signal` regex matches the rendered DOM (loose "content exists"
 *                    is NOT enough — the signal is section-specific)
 *   3. NOT-LYING   — no "ghost empty" (a table shell with 0 rows AND no honest
 *                    empty-state) and no false-success copy
 *   4. NOT-SWALLOWED — every endpoint in `api` returns 2xx with a non-empty body
 *                    (catches swallowed-SQL→404 + response-key-mismatch classes)
 *   5. FLAG-AWARE  — a flag-gated section that is DARK shows a calm gate-notice,
 *                    never a crash or a 404 shell (flag:… entries)
 *   6. A11Y        — 0 axe-critical (advisory unless PSVIS_AXE=1)
 *
 * `severity`: 'hard' = a failure flips the DONE gate red. 'soft' = reported,
 * non-blocking (use while a section's testids/endpoints are still being wired —
 * promote to 'hard' once green, per the audit-arc maturity ladder).
 *
 * FIELD REFERENCE
 *   slug        stable id — matches ADMIN_SECTION_LABELS key + the app.routes child path
 *   route       canonical '/admin/…' URL
 *   label       human label (mirror ADMIN_SECTION_LABELS)
 *   kind        'section' (renders) | 'dynamic' (needs a real :id) | 'alias' (redirects)
 *   guard       'auth' | 'sysAdmin' | 'superAdmin'  (who may reach it)
 *   flag        feature-flag key that gates it, or null (always on)
 *   api         worker endpoints the section calls that MUST return real data ([] = unknown, render+signal only)
 *   signal      case-insensitive regex source — the section-specific real-data signal
 *   shell       required data-testid on the section root (the reachability + mount proof)
 *   minLen      minimum rendered main-text length
 *   redirectTo  (alias only) the URL the route must redirect to
 *   severity    'hard' | 'soft'
 *   notes       operator context
 */

/** @typedef {'section'|'dynamic'|'alias'} SectionKind */
/** @typedef {'auth'|'sysAdmin'|'superAdmin'} Guard */

/**
 * @type {ReadonlyArray<{
 *   slug: string, route: string, label: string, kind: SectionKind, guard: Guard,
 *   flag: string|null, api: string[], signal: string, shell: string, minLen: number,
 *   redirectTo?: string, severity: 'hard'|'soft', notes?: string
 * }>}
 */
export const ADMIN_CONTRACT = [
  // ── Core owner sections (auth) ────────────────────────────────────────────
  { slug: 'dashboard', route: '/admin', label: 'Dashboard', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'getting started|guide|quick|welcome|next|explore', shell: 'dashboard-shell', minLen: 200, severity: 'hard',
    notes: 'Getting-Started hub (AI-chat dashboard removed). Section-guide grid.' },
  { slug: 'editor', route: '/admin/editor', label: 'Editor', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'editor|bolt|preview|file|project', shell: 'editor-shell', minLen: 80, severity: 'hard',
    notes: 'bolt.diy iframe host — WebContainer cold-boot; render proof = iframe mount.' },
  { slug: 'welcome', route: '/admin/welcome', label: 'Welcome', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'editor|bolt|preview|welcome|start', shell: 'editor-shell', minLen: 80, severity: 'soft',
    notes: 'Onboarding empty-state of the editor.' },
  { slug: 'snapshots', route: '/admin/snapshots', label: 'Snapshots', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'snapshot|version|frozen|rollback|restore', shell: 'snapshots-shell', minLen: 150, severity: 'hard' },
  { slug: 'analytics', route: '/admin/analytics', label: 'Analytics', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/network-analytics'], signal: 'visit|traffic|request|overview|trend|live|funnel', shell: 'analytics-shell', minLen: 150, severity: 'hard',
    notes: 'Tabbed: overview/live/funnel/sections/forms/visitor/health/social. Real zone traffic via /api/network-analytics.' },
  { slug: 'forms', route: '/admin/forms', label: 'Forms', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'form|submission|field|contact|response|entry', shell: 'forms-shell', minLen: 120, severity: 'hard' },
  { slug: 'billing', route: '/admin/billing', label: 'Billing', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/billing/subscription', '/api/billing/entitlements'], signal: 'plan|subscription|invoice|usage|billing|upgrade', shell: 'billing-shell', minLen: 150, severity: 'hard' },
  { slug: 'logs', route: '/admin/logs', label: 'Logs', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/logs/search'], signal: 'log|audit|explorer|event|trace|request', shell: 'logs-shell', minLen: 150, severity: 'hard',
    notes: 'Tabbed: audit / explorer / traces. Backend: /api/logs/{search,cost-by-route} → Workers Observability.' },
  { slug: 'audit', route: '/admin/audit', label: 'Audit Log', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/audit-logs'], signal: 'audit|action|actor|event|timestamp', shell: 'audit-shell', minLen: 120, severity: 'hard' },
  { slug: 'settings', route: '/admin/settings', label: 'Settings', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'setting|general|mcp|webhook|ai chat|preference|integration', shell: 'settings-shell', minLen: 120, severity: 'hard',
    notes: 'Tabs read #fragment: #mcp #ai-chat #webhooks #email #domains #api-tokens. /admin/{mcp,ai-chat,webhooks,domains,api-tokens} redirect (alias) in here.' },
  { slug: 'user', route: '/admin/user', label: 'User Settings', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/auth/me'], signal: 'profile|theme|api key|display name|preference|account', shell: 'user-settings-shell', minLen: 120, severity: 'hard' },
  { slug: 'team', route: '/admin/team', label: 'Team', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/auth/organization/list-members'], signal: 'member|invite|seat|role|team|pending', shell: 'team-shell', minLen: 120, severity: 'hard',
    notes: 'Better Auth org plugin. Needs custom D1 endpoint bridging (see better-auth-sections memory).' },
  { slug: 'auth-security', route: '/admin/auth-security', label: 'Auth Security', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/audit-logs'], signal: 'session|sign-?in|anomaly|2fa|security|revoke', shell: 'auth-security-shell', minLen: 120, severity: 'hard',
    notes: 'Frontend view over /api/audit-logs auth.* rows. Calm empty state until Better Auth cutover — never an error.' },
  { slug: 'site-features', route: '/admin/site-features', label: 'Site Features', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/site-features'], signal: 'feature|enable|plan|entitle|preview|toggle', shell: 'site-features-shell', minLen: 150, severity: 'hard',
    notes: 'LAYER 2 (owner-facing). Non-operators land here when bounced off feature-flags.' },
  { slug: 'social', route: '/admin/social', label: 'Social', kind: 'section', guard: 'auth', flag: null,
    api: ['/api/social/analytics/aggregate'], signal: 'post|schedule|social|compose|network|channel', shell: 'social-shell', minLen: 120, severity: 'hard' },
  { slug: 'voice', route: '/admin/voice', label: 'Voice', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'voice|call|phone|number|conversation|agent|sms', shell: 'voice-shell', minLen: 120, severity: 'hard',
    notes: 'Dark-render class (2026-08-03) — verify it MOUNTS, not just 0-errors.' },
  { slug: 'deliverability', route: '/admin/deliverability', label: 'Email Deliverability', kind: 'section', guard: 'auth', flag: 'email_deliverability_wizard',
    api: [], signal: 'spf|dkim|dmarc|deliverab|email|dns|record', shell: 'deliverability-shell', minLen: 120, severity: 'hard' },
  { slug: 'docs', route: '/admin/docs', label: 'API Docs', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'endpoint|openapi|api|try it|request|operation', shell: 'docs-shell', minLen: 120, severity: 'hard' },
  // (removed) ai-endpoints — the UI-authored AI-endpoint feature was retired per
  // ADR-0035 (code-defined Functions on Workers-for-Platforms replaced it). No
  // /admin/ai-endpoints route exists; the contract row was stale drift.
  { slug: 'apps', route: '/admin/apps', label: 'Apps', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'app|catalog|deploy|container|install|instance', shell: 'apps-shell', minLen: 120, severity: 'hard' },
  { slug: 'apps-instances', route: '/admin/apps/instances', label: 'App Instances', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'instance|running|restart|log|deploy|status', shell: 'apps-instances-shell', minLen: 100, severity: 'hard' },
  { slug: 'apps-detail', route: '/admin/apps/:id', label: 'App Detail', kind: 'dynamic', guard: 'auth', flag: null,
    api: [], signal: 'app|deploy|install|env|detail|container|instance', shell: 'apps-detail-shell', minLen: 100, severity: 'soft',
    notes: 'Param route — sweep resolves a catalog app id from /admin/apps.' },
  { slug: 'accept-invite', route: '/admin/accept-invite', label: 'Accept Invite', kind: 'section', guard: 'auth', flag: null,
    api: [], signal: 'invite|join|team|accept|token', shell: 'accept-invite-shell', minLen: 60, severity: 'soft',
    notes: 'Landing for ?token=… — thin by design without a token.' },

  // ── Dynamic sections — need a real :id (contract-sweep resolves brian's first site) ──
  { slug: 'sites-detail', route: '/admin/sites/:id', label: 'Site Detail', kind: 'dynamic', guard: 'auth', flag: null,
    api: [], signal: 'log|snapshot|sql|integration|projectsites\\.dev|tab', shell: 'site-detail-shell', minLen: 150, severity: 'hard',
    notes: '4 tabs (logs/snapshots/sql/integrations) via ?tab=. siteId from ActivatedRoute.' },
  { slug: 'sites-branches', route: '/admin/sites/:id/branches', label: 'Site Branches', kind: 'dynamic', guard: 'auth', flag: null,
    api: [], signal: 'branch|preview|variant|create|compare', shell: 'site-branches-shell', minLen: 100, severity: 'hard' },
  { slug: 'sites-mcp-server', route: '/admin/sites/:id/mcp-server', label: 'Site MCP Server', kind: 'dynamic', guard: 'auth', flag: null,
    api: [], signal: 'mcp|tool|server|endpoint|connect|token', shell: 'site-mcp-shell', minLen: 100, severity: 'hard' },
  { slug: 'sites-copilot', route: '/admin/sites/:id/copilot', label: 'Site Copilot', kind: 'dynamic', guard: 'auth', flag: 'multimodal_copilot',
    api: [], signal: 'copilot|intent|session|enable|gate', shell: 'site-copilot-shell', minLen: 80, severity: 'soft',
    notes: 'Flag-gated — DARK must show gate-notice, not a crash.' },
  { slug: 'sites-dna', route: '/admin/sites/:id/dna', label: 'Site DNA', kind: 'dynamic', guard: 'auth', flag: 'site_dna_taste_graph',
    api: [], signal: 'dna|taste|preference|feedback|signal|gate', shell: 'site-dna-shell', minLen: 80, severity: 'soft',
    notes: 'Flag-gated — DARK must show gate-notice, not a crash.' },
  { slug: 'snapshots-diff', route: '/admin/snapshots/diff', label: 'Snapshot Diff', kind: 'dynamic', guard: 'auth', flag: null,
    api: [], signal: 'diff|from|to|change|compare|snapshot', shell: 'snapshots-diff-shell', minLen: 80, severity: 'soft',
    notes: 'Needs ?from=A&to=B — thin without params.' },
  { slug: 'domain-stack', route: '/admin/domains/:id/stack', label: 'Domain Stack', kind: 'dynamic', guard: 'auth', flag: 'domain_stack_wizard',
    api: [], signal: 'dns|ssl|email|gsc|stack|wizard|step', shell: 'domain-stack-shell', minLen: 80, severity: 'soft' },
  { slug: 'apps-instance-detail', route: '/admin/apps/instances/:id', label: 'App Instance', kind: 'dynamic', guard: 'auth', flag: null,
    api: [], signal: 'instance|log|env|restart|status|deploy', shell: 'apps-instance-detail-shell', minLen: 80, severity: 'soft' },

  // ── Operator sections (sysAdmin / superAdmin) — sweep must auth as brian ──────
  { slug: 'feature-flags', route: '/admin/feature-flags', label: 'Feature Flags', kind: 'section', guard: 'sysAdmin', flag: null,
    api: ['/api/feature-flags'], signal: 'flag|rollout|stage|experimental|killswitch|toggle', shell: 'feature-flags-shell', minLen: 150, severity: 'hard',
    notes: 'sysAdminGuard — seed ps_session.identifier (NOT email) or brian bounces to site-features.' },
  { slug: 'system-services', route: '/admin/system-services', label: 'System Services', kind: 'section', guard: 'sysAdmin', flag: null,
    api: ['/api/super-admin/services'], signal: 'service|status|health|edge|container|probe|registry', shell: 'system-services-shell', minLen: 150, severity: 'hard' },
  // Data-resource inspectors (KV/R2/Vectorize/Queues) — read-only super-admin browsers for the
  // prompt's "Other Cloudflare data resources". Component+route shipped but were UNCOVERED (no
  // contract row) + un-nav-linked; wired here. Flag-dark like `leads` → soft severity (worker 404s
  // when the flag is off, so the sweep must not hard-fail a legitimately-dark route).
  { slug: 'kv-inspector', route: '/admin/kv-inspector', label: 'KV Inspector', kind: 'section', guard: 'sysAdmin', flag: 'kv_inspector',
    api: ['/api/admin/kv/namespaces'], signal: 'kv|namespace|key|value|binding|prefix|read-only', shell: 'kv-inspector', minLen: 80, severity: 'soft',
    notes: 'Flag-dark + super-admin read-only KV browser. Worker 404s when kv_inspector flag off.' },
  { slug: 'r2-inspector', route: '/admin/r2-inspector', label: 'R2 Inspector', kind: 'section', guard: 'sysAdmin', flag: 'r2_inspector',
    api: ['/api/admin/r2/buckets'], signal: 'r2|bucket|object|prefix|storage|download|read-only', shell: 'r2-inspector', minLen: 80, severity: 'soft',
    notes: 'Flag-dark + super-admin read-only R2 object browser. Worker 404s when r2_inspector flag off.' },
  { slug: 'vectorize-inspector', route: '/admin/vectorize-inspector', label: 'Vectorize Inspector', kind: 'section', guard: 'sysAdmin', flag: 'vectorize_inspector',
    api: ['/api/admin/vectorize/indexes'], signal: 'vector|index|dimension|metric|embedding|vectorize', shell: 'vectorize-inspector', minLen: 80, severity: 'soft',
    notes: 'Flag-dark + super-admin read-only Vectorize index browser. Worker 404s when vectorize_inspector flag off.' },
  { slug: 'queues-inspector', route: '/admin/queues-inspector', label: 'Queues Inspector', kind: 'section', guard: 'sysAdmin', flag: 'queues_inspector',
    api: ['/api/admin/queues'], signal: 'queue|message|backlog|consumer|producer|dlq', shell: 'queues-inspector', minLen: 80, severity: 'soft',
    notes: 'Flag-dark + super-admin read-only Queues browser. Worker 404s when queues_inspector flag off.' },
  { slug: 'leads', route: '/admin/leads', label: 'Lead Scanner', kind: 'section', guard: 'sysAdmin', flag: 'lead_scanner',
    api: [], signal: 'lead|scan|no-?website|outreach|claim|score', shell: 'leads-shell', minLen: 100, severity: 'soft',
    notes: 'Flag-dark + super-admin. Worker 404s when flag off, 403s non-operators.' },
  { slug: 'super-admin', route: '/admin/super-admin', label: 'Super Admin', kind: 'section', guard: 'superAdmin', flag: null,
    api: [], signal: 'cost|markup|wallet|adjust|margin|operator', shell: 'super-admin-shell', minLen: 120, severity: 'hard',
    notes: 'Server-gated on users.is_super_admin=1; non-super sees a Restricted page (not a crash).' },

  // ── Aliases — assert the REDIRECT resolves, never a not-found shell ───────────
  { slug: 'alias-traces', route: '/admin/traces', label: 'AI Traces', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/logs?tab=traces', severity: 'hard' },
  // Bare /admin/sites has no list page of its own — the dashboard ('' → /admin) is
  // the site list; app.routes.ts redirects 'sites' → '' so a natural URL guess lands.
  { slug: 'alias-sites', route: '/admin/sites', label: 'Sites', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin', severity: 'hard' },
  { slug: 'alias-seo', route: '/admin/seo', label: 'SEO', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/site-features', severity: 'hard' },
  { slug: 'alias-mcp', route: '/admin/mcp', label: 'MCP', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/settings#mcp', severity: 'hard' },
  { slug: 'alias-ai-chat', route: '/admin/ai-chat', label: 'AI Chat', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/settings#ai-chat', severity: 'hard' },
  { slug: 'alias-webhooks', route: '/admin/webhooks', label: 'Webhooks', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/settings#webhooks', severity: 'hard' },
  { slug: 'alias-domains', route: '/admin/domains', label: 'Domains', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/settings#domains', severity: 'hard' },
  { slug: 'alias-api-tokens', route: '/admin/api-tokens', label: 'API Tokens', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/settings#api-tokens', severity: 'hard',
    notes: 'Redirect always live; the embedded #api-tokens Settings tab self-gates on the public_api_v1 flag.' },
  { slug: 'alias-ai-logs', route: '/admin/ai-logs', label: 'AI Logs', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/logs?tab=traces', severity: 'hard' },
  { slug: 'alias-social-analytics', route: '/admin/social/analytics', label: 'Social Analytics', kind: 'alias', guard: 'auth', flag: null,
    api: [], signal: '', shell: '', minLen: 0, redirectTo: '/admin/analytics?tab=social', severity: 'hard' },
];

/** The raw admin child path for a contract row ('/admin/analytics' → 'analytics', '/admin' → ''). */
export const childPath = (route) => route.replace(/^\/admin\/?/, '').replace(/[?#].*$/, '');

/** Sections a prod sweep renders + asserts (excludes aliases). */
export const RENDER_SECTIONS = ADMIN_CONTRACT.filter((s) => s.kind !== 'alias');

/** Redirect aliases — asserted for their 3xx/rewrite target, never rendered. */
export const ALIAS_SECTIONS = ADMIN_CONTRACT.filter((s) => s.kind === 'alias');

/** Hard sections gate the DONE state; soft ones are reported non-blocking. */
export const HARD_SECTIONS = ADMIN_CONTRACT.filter((s) => s.severity === 'hard');

// Running THIS file directly is a no-op by design — it's the section REGISTRY
// (imported by contract-sweep.mjs), not the runnable gate. Guard the false-green
// trap: `node admin-contract.mjs` used to exit 0 SILENTLY, so anyone following that
// literal instruction then read a STALE _ADMIN_CONTRACT_REPORT.json (written by a
// PRIOR contract-sweep run) and believed the contract was freshly verified. Emit a
// loud pointer to the real gate instead. Fires only as the entry module; on `import`
// (contract-sweep) argv[1] is the sweep, so this stays silent.
if (process.argv[1]?.endsWith('admin-contract.mjs')) {
  console.log(
    '::notice:: admin-contract.mjs is the section REGISTRY (exports only) — NOT a runnable check.\n' +
      `  Defines ${ADMIN_CONTRACT.length} sections (${RENDER_SECTIONS.length} rendered + ${ALIAS_SECTIONS.length} aliases; ${HARD_SECTIONS.length} hard).\n` +
      '  → Run the ACTUAL dim-6 gate:  node e2e/admin-verify/contract-sweep.mjs\n' +
      '     (drives every section vs PROD as brian in a real browser, writes _ADMIN_CONTRACT_REPORT.json).\n' +
      '  Reading _ADMIN_CONTRACT_REPORT.json after running THIS file = a FALSE-GREEN — no fresh run happened.',
  );
}
