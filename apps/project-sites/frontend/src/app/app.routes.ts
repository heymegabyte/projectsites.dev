import { inject } from '@angular/core';
import { type Routes, Router } from '@angular/router';
import { authGuard } from './guards/auth.guard';
import { sysAdminGuard } from './guards/sys-admin.guard';

export const routes: Routes = [
  {
    // Marketing homepage — classic A/B/C surface restored as the default
    // per 2026-05-28 user directive. All navigation stays SPA-only inside
    // the AppComponent shell (no full page reloads on internal nav).
    path: '',
    loadComponent: () =>
      import('./pages/homepage/homepage.component').then((m) => m.HomepageComponent),
  },
  {
    // Backward-compat alias: any old link to /classic still resolves to
    // the same homepage component (no 404 for inbound PostHog events /
    // screenshot tests / external bookmarks).
    path: 'classic',
    redirectTo: '',
    pathMatch: 'full',
  },
  {
    path: 'search',
    loadComponent: () => import('./pages/search/search.component').then((m) => m.SearchComponent),
  },
  {
    path: 'pricing',
    loadComponent: () =>
      import('./pages/pricing/pricing.component').then((m) => m.PricingComponent),
  },
  {
    // AN48 — public, no-auth read-only analytics view. The HMAC token in the URL
    // is the capability; an invalid/expired token shows a friendly message.
    path: 'shared/analytics/:token',
    loadComponent: () =>
      import('./pages/public-analytics.component').then((m) => m.PublicAnalyticsComponent),
  },
  {
    // Better Auth takes over the canonical /signin — the app's 401-redirect target
    // (ApiService bounces protected 401s to /signin?returnUrl=…). Post-cutover the
    // legacy magic-link/Google page is dead (BA owns /api/auth/*), so /signin now
    // serves the Better Auth sign-in UI directly.
    path: 'signin',
    loadComponent: () => import('./pages/auth/sign-in.component').then((m) => m.SignInComponent),
  },
  {
    // Back-compat alias for the Better Auth UI's internal links + bookmarks.
    path: 'auth/sign-in',
    redirectTo: 'signin',
    pathMatch: 'full',
  },
  {
    path: 'auth/sign-up',
    loadComponent: () => import('./pages/auth/sign-up.component').then((m) => m.SignUpComponent),
  },
  {
    path: 'auth/sessions',
    loadComponent: () =>
      import('./pages/auth/session-management.component').then((m) => m.SessionManagementComponent),
  },
  {
    path: 'auth/2fa/enroll',
    loadComponent: () =>
      import('./pages/auth/two-factor-enroll.component').then((m) => m.TwoFactorEnrollComponent),
  },
  {
    path: 'auth/2fa/verify',
    loadComponent: () =>
      import('./pages/auth/two-factor-verify.component').then((m) => m.TwoFactorVerifyComponent),
  },
  {
    path: 'create',
    loadComponent: () => import('./pages/create/create.component').then((m) => m.CreateComponent),
  },
  {
    path: 'details',
    redirectTo: 'create',
  },
  {
    path: 'waiting',
    loadComponent: () =>
      import('./pages/waiting/waiting.component').then((m) => m.WaitingComponent),
  },
  {
    // v2 cockpit was removed 2026-05-31 (reverted to the legacy admin Brian loves).
    // Redirect any stale /admin/v2 bookmark back to the real admin.
    path: 'admin/v2',
    redirectTo: 'admin',
    pathMatch: 'prefix',
  },
  {
    path: 'admin',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/admin/admin.component').then((m) => m.AdminComponent),
    children: [
      {
        // /admin → Getting Started hub: a purpose-grouped guide to every admin
        // section + tips + helpful links (replaced the former AI chat dashboard).
        // The bolt.diy editor lives at /admin/editor (untouched). /admin/welcome
        // keeps the empty-state editor card around for onboarding links.
        path: '',
        loadComponent: () =>
          import('./pages/admin/sections/dashboard.component').then(
            (m) => m.AdminDashboardComponent,
          ),
        pathMatch: 'full',
      },
      {
        path: 'welcome',
        loadComponent: () =>
          import('./pages/admin/sections/editor.component').then((m) => m.AdminEditorComponent),
      },
      {
        path: 'editor',
        loadComponent: () =>
          import('./pages/admin/sections/editor.component').then((m) => m.AdminEditorComponent),
      },
      { path: 'dashboard', redirectTo: '', pathMatch: 'full' },
      {
        // Team invite acceptance landing — reads ?token=… and POSTs to backend.
        path: 'accept-invite',
        loadComponent: () =>
          import('./pages/admin/sections/accept-invite.component').then(
            (m) => m.AdminAcceptInviteComponent,
          ),
      },
      {
        // Team members + invites (idea #24) — Better Auth org plugin
        // (/api/auth/organization/*). Lists members + pending invitations,
        // invite form, per-row remove/cancel, seat usage.
        path: 'team',
        loadComponent: () =>
          import('./pages/admin/sections/team.component').then((m) => m.TeamComponent),
      },
      {
        // Auth security & health (idea #3) — frontend-only view over the
        // existing GET /api/audit-logs. Filters to auth.* rows, derives
        // sign-in/anomaly metrics + a recent-suspicious table. Data is dark
        // until the Better Auth cutover → calm empty state, never an error.
        path: 'auth-security',
        loadComponent: () =>
          import('./pages/admin/sections/auth-security.component').then(
            (m) => m.AuthSecurityComponent,
          ),
      },
      {
        path: 'snapshots',
        loadComponent: () =>
          import('./pages/admin/sections/snapshots.component').then(
            (m) => m.AdminSnapshotsComponent,
          ),
      },
      {
        // Side-by-side snapshot diff — `?from=A&to=B`. Lazy-chunked so the
        // `diff` rendering payload only ships when a user actually opens
        // the diff view.
        path: 'snapshots/diff',
        loadComponent: () =>
          import('./pages/admin/sections/snapshots-diff.component').then(
            (m) => m.AdminSnapshotsDiffComponent,
          ),
      },
      {
        // Bare `/admin/sites` has no list page of its own — the dashboard ('') is the
        // sites hub (recent-sites widgets + selected-site context) and drill-in is
        // `/admin/sites/:id`. A user typing `/admin/sites` (a natural guess given the
        // `:id` route) previously hit the styled admin 404; redirect it to the dashboard,
        // mirroring the `dashboard → ''` alias above. (loop item-6, 2026-09-03)
        path: 'sites',
        redirectTo: '',
        pathMatch: 'full',
      },
      {
        // Per-site detail page with 4 tabs (Logs / Snapshots+Rollback / SQL /
        // Integrations). Closes TEST-PLAN.md TAB-01..TAB-13.
        path: 'sites/:id',
        loadComponent: () =>
          import('./pages/admin/sections/site-detail.component').then(
            (m) => m.AdminSiteDetailComponent,
          ),
      },
      {
        // Branch-style site previews — /admin/sites/:id/branches (#27)
        path: 'sites/:id/branches',
        loadComponent: () =>
          import('./pages/admin/sections/site-branches.component').then(
            (m) => m.SiteBranchesComponent,
          ),
      },
      {
        // Per-site MCP server management — /admin/sites/:id/mcp-server (#29)
        path: 'sites/:id/mcp-server',
        loadComponent: () =>
          import('./pages/admin/sections/site-mcp-server.component').then(
            (m) => m.SiteMcpServerComponent,
          ),
      },
      {
        // Unified analytics dashboard (2026-06-23) — aggregate traffic + the raw
        // Live Events stream combined into one tabbed surface (?tab=overview|live).
        path: 'analytics',
        loadComponent: () =>
          import('./pages/admin/sections/analytics-dashboard.component').then(
            (m) => m.AdminAnalyticsDashboardComponent,
          ),
      },
      {
        path: 'billing',
        loadComponent: () =>
          import('./pages/admin/sections/billing.component').then((m) => m.AdminBillingComponent),
      },
      {
        // API Tokens folded into Settings (2026-08-12) — this standalone route
        // redirects to the #api-tokens tab. Backend GET|POST|DELETE /api/v1-tokens
        // stays flag-gated on public_api_v1; the embedded tab self-gates too.
        path: 'api-tokens',
        redirectTo: () => inject(Router).parseUrl('/admin/settings#api-tokens'),
        pathMatch: 'full',
      },
      {
        // Two-layer control plane — LAYER 1 (Feature Flags). Platform-ops
        // flags for the operator. Reads GET /api/feature-flags merged with the
        // super-admin overrides; supports filter / search / toggle / rollout /
        // killswitch with progressive disclosure + dangerous-change confirm.
        // sysAdminGuard hides it from normal site owners (operator-only); a
        // non-operator hitting the URL is bounced to their /admin/site-features.
        path: 'feature-flags',
        canActivate: [sysAdminGuard],
        loadComponent: () =>
          import('./pages/admin/sections/feature-flags.component').then(
            (m) => m.AdminFeatureFlagsComponent,
          ),
      },
      {
        // Super-Admin KV Inspector — read-only browser for the shared platform KV
        // namespaces (CACHE_KV/PROMPT_STORE). Backend GET /api/admin/kv/* is
        // super-admin + `kv_inspector`-flag gated (404-dark when off); sysAdminGuard
        // hides the route from normal owners.
        path: 'kv-inspector',
        canActivate: [sysAdminGuard],
        loadComponent: () =>
          import('./pages/admin/sections/kv-inspector.component').then(
            (m) => m.KvInspectorComponent,
          ),
      },
      {
        // Super-Admin R2 Inspector — read-only browser for the shared platform R2
        // bucket (SITES_BUCKET). Backend GET /api/admin/r2/* is super-admin +
        // `r2_inspector`-flag gated (404-dark when off); sysAdminGuard hides the route.
        path: 'r2-inspector',
        canActivate: [sysAdminGuard],
        loadComponent: () =>
          import('./pages/admin/sections/r2-inspector.component').then(
            (m) => m.R2InspectorComponent,
          ),
      },
      {
        // Read-only super-admin Vectorize index inspector — the account's Cloudflare
        // Vectorize indexes (RAG/embeddings). Backend GET /api/admin/vectorize/* is
        // super-admin + `vectorize_inspector`-flag gated (404-dark); sysAdminGuard hides it.
        path: 'vectorize-inspector',
        canActivate: [sysAdminGuard],
        loadComponent: () =>
          import('./pages/admin/sections/vectorize-inspector.component').then(
            (m) => m.VectorizeInspectorComponent,
          ),
      },
      {
        // Read-only super-admin Queues inspector — the account's Cloudflare Queues
        // (job/workflow pipelines). Backend GET /api/admin/queues/* is super-admin +
        // `queues_inspector`-flag gated (404-dark); sysAdminGuard hides the route.
        path: 'queues-inspector',
        canActivate: [sysAdminGuard],
        loadComponent: () =>
          import('./pages/admin/sections/queues-inspector.component').then(
            (m) => m.QueuesInspectorComponent,
          ),
      },
      {
        // Super-Admin lead scanner (#9) — Places no-website scan → scored leads →
        // mint outreach claim links. Flag-dark (`lead_scanner`) + super-admin only;
        // the worker route 404s when the flag is off and 403s non-operators.
        path: 'leads',
        canActivate: [sysAdminGuard],
        loadComponent: () =>
          import('./pages/admin/sections/leads.component').then((m) => m.AdminLeadsComponent),
      },
      {
        // Two-layer control plane — LAYER 2 (Features, owner-facing). Site/tenant
        // -scoped features a site owner enables for their hosted site, plan-aware
        // with entitlement-locked states, preview, and undo. Backed by
        // GET/POST /api/site-features.
        path: 'site-features',
        loadComponent: () =>
          import('./pages/admin/sections/site-features.component').then(
            (m) => m.AdminSiteFeaturesComponent,
          ),
      },
      {
        path: 'forms',
        loadComponent: () =>
          import('./pages/admin/sections/forms.component').then((m) => m.AdminFormsComponent),
      },
      {
        // Interactive API explorer (OpenAPI 3.1). Shell hosts the left-rail
        // endpoint nav + a `<router-outlet>`; per-endpoint detail is its own
        // lazy chunk so the overview reader never pays for the Try-It UI.
        path: 'docs',
        loadComponent: () =>
          import('./pages/admin/sections/docs.component').then((m) => m.AdminDocsComponent),
        children: [
          {
            path: '',
            loadComponent: () =>
              import('./pages/admin/sections/docs/docs-overview.component').then(
                (m) => m.DocsOverviewComponent,
              ),
          },
          {
            // `/admin/docs/:endpointId` — `:endpointId` is the OpenAPI
            // `operationId` (e.g. `get_api_auth_me`, `post_api_sites`). The
            // child component looks the op up via `DocsSpecService.findById`
            // and renders a 404 card if no match is found.
            path: ':endpointId',
            loadComponent: () =>
              import('./pages/admin/sections/docs/docs-endpoint.component').then(
                (m) => m.DocsEndpointComponent,
              ),
          },
        ],
      },
      // ai-chat moved into Settings as a tab — keep redirect for old links.
      // Static redirectTo can't carry a #fragment (it lands on /admin/settings General,
      // not the AI Chat tab). Settings reads the fragment to open its 'ai-chat' tab, so
      // use a functional redirect that preserves it (same fix as /admin/mcp).
      // Old name kept for any deep links / bookmarks → the Traces tab under Logs.
      {
        // Voice — phone numbers, unified call+SMS conversations timeline,
        // browser-mic test console, agent prompt editor + immutable
        // safety meta-prompt, MCP attachments, share surface. Top-level
        // shell lazy-loads sub-components on demand.
        path: 'voice',
        loadComponent: () =>
          import('./pages/admin/sections/voice.component').then((m) => m.VoiceComponent),
      },
      // /admin/mcp → the MCP tab inside Settings. `settings` is a flat route (no
      // children), so the old `redirectTo: 'settings/mcp'` 404'd; settings reads the
      // `#mcp` fragment to open the MCP tab, so redirect there with the fragment.
      {
        path: 'settings',
        loadComponent: () =>
          import('./pages/admin/sections/settings.component').then((m) => m.AdminSettingsComponent),
      },
      {
        // User-level preferences: theme + API keys. Distinct from per-project
        // settings — switching projects must NOT touch personal preferences.
        path: 'user',
        loadComponent: () =>
          import('./pages/admin/sections/user-settings.component').then(
            (m) => m.AdminUserSettingsComponent,
          ),
      },
      {
        // `/admin/user-settings` matches the section's component filename — a
        // natural guess — but the real route is `/admin/user`. Without this,
        // that guess (and any stale link) hit the styled admin-404. Redirect it
        // to the real surface, mirroring the sites/domains/mcp alias redirects.
        path: 'user-settings',
        redirectTo: 'user',
        pathMatch: 'full',
      },
      // Per-project Domain Management folded into Settings (2026-08-12) — this
      // standalone route redirects to the #domains tab. The component itself
      // (sections/domains.component.ts) is now rendered inside settings.
      // pathMatch:'full' so the more-specific domains/:id/stack still routes.
      {
        path: 'domains',
        redirectTo: () => inject(Router).parseUrl('/admin/settings#domains'),
        pathMatch: 'full',
      },
      // Domain Stack Wizard — 7-tile progress board (DNS→SSL→email-auth→GSC).
      // Feature-flagged: domain_stack_wizard.
      {
        path: 'domains/:id/stack',
        loadComponent: () =>
          import('./pages/admin/sections/domain-stack.component').then(
            (m) => m.AdminDomainStackComponent,
          ),
      },
      // Unified logging dashboard (2026-06-08) — Audit Trail + structured Log
      // Explorer combined into one tabbed surface (?tab=audit|explorer).
      {
        path: 'logs',
        loadComponent: () =>
          import('./pages/admin/sections/logs-dashboard.component').then(
            (m) => m.AdminLogsDashboardComponent,
          ),
      },
      {
        // Email Deliverability Wizard (#12) — SPF/DKIM/DMARC check + fixes.
        // Component + worker route + flag (email_deliverability_wizard) all
        // existed; the route was the only missing piece (was admin-404).
        path: 'deliverability',
        loadComponent: () =>
          import('./pages/admin/sections/deliverability.component').then(
            (m) => m.AdminDeliverabilityComponent,
          ),
      },
      // ─── Apps store ───────────────────────────────────────────────
      // Catalog of self-hostable apps deployable to Cloudflare Workers
      // Containers in <5 min. List → detail → instances. All three lazy.
      // Order matters: more-specific routes (`apps/instances`, `apps/instances/:id`)
      // come BEFORE `apps/:id` so the param route doesn't swallow them.
      {
        path: 'apps',
        loadComponent: () =>
          import('./pages/admin/sections/apps.component').then((m) => m.AppsComponent),
      },
      {
        path: 'apps/instances',
        loadComponent: () =>
          import('./pages/admin/sections/apps-instances.component').then(
            (m) => m.AppInstancesComponent,
          ),
      },
      {
        path: 'apps/instances/:id',
        loadComponent: () =>
          import('./pages/admin/sections/apps-instances.component').then(
            (m) => m.AppInstanceDetailComponent,
          ),
      },
      {
        path: 'apps/:id',
        loadComponent: () =>
          import('./pages/admin/sections/apps-detail.component').then((m) => m.AppDetailComponent),
      },
      // ─── Pulse Social ─────────────────────────────────────────────
      // Composer + scheduler for 11 social networks. Lazy-loaded — the
      // composer + preview surface only ships when /admin/social is
      // visited. Backend at apps/project-sites/src/routes/social.ts.
      {
        path: 'social',
        loadComponent: () =>
          import('./pages/admin/sections/social.component').then((m) => m.AdminSocialComponent),
      },
      // ─── Pulse Analytics drill-downs ──────────────────────────────
      // Full-page version of the dashboard SocialPerformance widget.
      // Same data source (/api/social/analytics/aggregate) with deeper
      // breakdowns + window switcher.
      {
        // Standalone Social analytics page folded into Analytics → Social tab.
        path: 'social/analytics',
        redirectTo: () => inject(Router).parseUrl('/admin/analytics?tab=social'),
        pathMatch: 'full',
      },
      // ─── Section aliases ──────────────────────────────────────────
      // The dashboard section-guide + not-found route hints link
      // /admin/traces, /admin/seo, but those surfaces live elsewhere (Traces
      // is a tab under Logs, and search-readiness toggles under site
      // Features). Without these redirects each link rendered the admin
      // not-found page ("This admin page doesn't exist"). Redirect so every
      // advertised link + bookmark resolves to the real surface.
      {
        // AI Traces is the `traces` tab under the unified Logs dashboard.
        path: 'traces',
        redirectTo: () => inject(Router).parseUrl('/admin/logs?tab=traces'),
        pathMatch: 'full',
      },
      {
        // No standalone SEO section — search-readiness capabilities (structured
        // data autopilot, llms.txt, quotable answers) toggle under site Features.
        path: 'seo',
        redirectTo: () => inject(Router).parseUrl('/admin/site-features'),
        pathMatch: 'full',
      },
      {
        // MCP lives as the MCP tab inside Settings (Slack/Stripe/Notion/HubSpot
        // +20 more). Settings reads the `#mcp` fragment to open that tab, so the
        // functional redirect carries the fragment (a static redirectTo can't).
        // Without this, /admin/mcp rendered the admin not-found page.
        path: 'mcp',
        redirectTo: () => inject(Router).parseUrl('/admin/settings#mcp'),
        pathMatch: 'full',
      },
      {
        // AI Chat moved into Settings as a tab — keep old deep-links + the `g c`
        // g-chord working. Settings reads the `#ai-chat` fragment to open it.
        // Without this, /admin/ai-chat rendered the admin not-found page.
        path: 'ai-chat',
        redirectTo: () => inject(Router).parseUrl('/admin/settings#ai-chat'),
        pathMatch: 'full',
      },
      {
        // Webhooks live as the Webhooks tab inside Settings (signed, retried event
        // notifications). Carry the #webhooks fragment so Settings opens that tab.
        // Without this, /admin/webhooks (command palette "Go to Webhooks") 404'd.
        path: 'webhooks',
        redirectTo: () => inject(Router).parseUrl('/admin/settings#webhooks'),
        pathMatch: 'full',
      },
      {
        // AI Logs was renamed to the Traces tab under the unified Logs dashboard
        // (not-found RENAMED_ROUTES: ai-logs → traces). Keep old deep-links working.
        path: 'ai-logs',
        redirectTo: () => inject(Router).parseUrl('/admin/logs?tab=traces'),
        pathMatch: 'full',
      },
      {
        // Audit Log — a standalone section (AdminAuditComponent) whose route was
        // lost, so audit-notification hrefs + the not-found hint list linked to a
        // 404. Restore it (no required inputs; reads AdminStateService from shell).
        path: 'audit',
        loadComponent: () =>
          import('./pages/admin/sections/audit.component').then((m) => m.AdminAuditComponent),
      },
      // ─── Multimodal AI Site Copilot (#25) ────────────────────────
      // Per-site copilot admin: enable toggle + intent distribution + sessions.
      // Flag-gated: multimodal_copilot. Shows gate notice when off.
      {
        path: 'sites/:id/copilot',
        loadComponent: () =>
          import('./pages/admin/sections/site-copilot.component').then(
            (m) => m.AdminSiteCopilotComponent,
          ),
      },
      // ─── Site DNA Taste Graph (#7) ────────────────────────────────
      // Per-site taste-signal admin: feedback history + preference bars +
      // manual feedback form. Flag-gated: site_dna_taste_graph.
      {
        path: 'sites/:id/dna',
        loadComponent: () =>
          import('./pages/admin/sections/site-dna.component').then((m) => m.AdminSiteDnaComponent),
      },
      {
        // Super-admin — gated server-side on `users.is_super_admin = 1` (the
        // worker routes return 403 to non-super-admins; the component shows a
        // "Restricted" page). Operator console for cost × markup_factor tuning
        // + wallet drill-down + manual adjustments. Moved from top-level to
        // /admin/super-admin so it lives inside the admin shell.
        path: 'super-admin',
        canActivate: [authGuard],
        loadComponent: () =>
          import('./pages/super-admin/super-admin.component').then((m) => m.SuperAdminComponent),
      },
      {
        // Operator-only platform service catalog (§66) — surfaces SERVICE_REGISTRY
        // (edge/data/auth/billing/AI + self-hosted subdomain containers) which had
        // NO admin view. Backed by GET /api/super-admin/services (super-admin gated).
        path: 'system-services',
        canActivate: [sysAdminGuard],
        loadComponent: () =>
          import('./pages/admin/sections/system-services.component').then(
            (m) => m.SystemServicesComponent,
          ),
      },
      {
        // Admin-scoped 404 — MUST be last. Catches any unknown `/admin/*` path
        // (stale bookmark to a renamed route, or a param-route hit without its
        // param like `/admin/swarm`) and renders INSIDE the cockpit shell,
        // instead of falling through to the ROOT `**` public marketing 404.
        path: '**',
        loadComponent: () =>
          import('./pages/admin/sections/not-found.component').then(
            (m) => m.AdminNotFoundComponent,
          ),
      },
    ],
  },
  {
    path: 'editor/:slug',
    redirectTo: 'admin/editor',
  },
  {
    // Public Trust Center (backlog #30). The component + spec + a shipped changelog entry
    // ("New /trust page") existed, and /blog + /changelog footers link to it — but the route
    // was never wired, so /trust 404'd (built-but-unrouted; caught by marketing-links.e2e.ts).
    path: 'trust',
    loadComponent: () => import('./pages/trust/trust.component').then((m) => m.TrustComponent),
  },
  {
    path: 'privacy',
    loadComponent: () => import('./pages/legal/legal.component').then((m) => m.LegalComponent),
    data: { type: 'privacy' },
  },
  {
    path: 'terms',
    loadComponent: () => import('./pages/legal/legal.component').then((m) => m.LegalComponent),
    data: { type: 'terms' },
  },
  {
    path: 'content',
    loadComponent: () => import('./pages/legal/legal.component').then((m) => m.LegalComponent),
    data: { type: 'content' },
  },
  // NOTE: no Angular `/contact` route — the worker 301-redirects `/contact`
  // to the homepage/search contact section before Angular ever sees it (see
  // apps/project-sites/src/index.ts). A standalone ContactComponent used to
  // live here but was unreachable dead code duplicating the `#contact-section`
  // form on /search; removed 2026-06-02.
  {
    path: 'billing',
    redirectTo: 'admin/billing',
  },
  {
    path: 'blog',
    loadComponent: () =>
      import('./pages/blog/blog-list.component').then((m) => m.BlogListComponent),
  },
  {
    path: 'blog/:slug',
    loadComponent: () =>
      import('./pages/blog/blog-post.component').then((m) => m.BlogPostComponent),
  },
  {
    path: 'changelog',
    loadComponent: () =>
      import('./pages/changelog/changelog.component').then((m) => m.ChangelogComponent),
  },
  {
    // Public reviewer page (#4 review_approval_links) — stakeholder approve/reject via shared link.
    path: 'review/:id',
    loadComponent: () => import('./pages/review/review.component').then((m) => m.ReviewComponent),
  },
  {
    // /developers — MCP acquisition page for developers living in Claude Code /
    // Cursor / Cline. Hero is the .mcp.json connect snippet. No auth required.
    path: 'developers',
    loadComponent: () =>
      import('./pages/developers/developers.component').then((m) => m.DevelopersComponent),
  },
  {
    // /oauth/consent — OAuth 2.1 consent screen for the MCP one-click connect
    // flow. The worker's GET /oauth/authorize 302s here with the OAuth params;
    // on Allow it POSTs /api/oauth/authorize (server re-validates everything).
    path: 'oauth/consent',
    loadComponent: () =>
      import('./pages/oauth-consent/oauth-consent.component').then((m) => m.OauthConsentComponent),
  },
  {
    // Public integrations catalog — every third-party service the platform
    // speaks to. Filterable + searchable, backed by
    // /api/public/integrations. Lazy-loaded.
    path: 'integrations',
    loadComponent: () =>
      import('./pages/integrations/integrations.component').then((m) => m.IntegrationsComponent),
  },
  {
    // Public product roadmap — Trello-style board (Planned / In Progress / Shipped)
    // backed by GET /api/public/roadmap. The API + MetaService `roadmap` entry +
    // changelog announcement all pre-existed; this route was the missing piece
    // (/roadmap previously soft-404'd to the not-found page). Lazy-loaded.
    path: 'roadmap',
    loadComponent: () =>
      import('./pages/roadmap/roadmap.component').then((m) => m.RoadmapComponent),
  },
  {
    // Public press kit — 8-slide 1920×1080 cinematic picture walkthrough,
    // brand assets, founder bio, fact sheet, press releases, media contacts.
    // Lazy-loaded so press traffic doesn't pay for the walkthrough chunk
    // until requested.
    path: 'press',
    loadComponent: () => import('./pages/press/press.component').then((m) => m.PressComponent),
  },
  {
    // Inline checkout harness — mounts <app-inline-checkout> with a fixed
    // amount so Playwright can drive the 1-click Stripe Link flow under
    // the brian@megabyte.space stub. Production traffic also lands here
    // when a "Buy credits" CTA is clicked.
    path: 'checkout',
    loadComponent: () =>
      import('./pages/checkout/checkout.component').then((m) => m.CheckoutComponent),
  },
  {
    path: 'error',
    loadComponent: () =>
      import('./pages/error/server-error.component').then((m) => m.ServerErrorComponent),
  },
  {
    path: 'offline',
    loadComponent: () => import('./pages/error/offline.component').then((m) => m.OfflineComponent),
  },
  {
    path: '**',
    loadComponent: () =>
      import('./pages/error/not-found.component').then((m) => m.NotFoundComponent),
  },
];
