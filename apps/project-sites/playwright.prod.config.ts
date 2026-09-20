import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Prod smoke set — broadened from voice-only. The feature-journey + adversarial
  // suites do a REAL login via E2E_API_KEY (helpers/auth.ts Pathway C) and browse
  // every admin feature against the live URL. Set E2E_API_KEY in CI.
  // ⚠️ Basename semantics: Playwright prepends '**/' to any testMatch string, so a
  // bare 'name.spec.ts' matches at ANY depth under testDir — including stale twins
  // in e2e/admin/. Entries whose basename recurs in a subdir MUST be anchored with
  // an explicit 'e2e/'-relative glob (see the two anchored entries below).
  testMatch: [
    'feature-journey.spec.ts',
    'health.spec.ts',
    'golden-path.spec.ts',
    'generated-site-visitor-journey.spec.ts', // AL-769 — THE delivered-site VISITOR journey (guest on {slug}.projectsites.dev): homepage-first SPA nav + click-to-call + directions + contact form + FAQ/blog/gallery + axe-6bp, 0 console errors, non-mutating
    'search-and-places.spec.ts', // AL-804 — TOP-OF-FUNNEL guest acquisition: homepage-first hero business search (typed→debounced→dropdown/degraded→Custom option→click→/signin funnel), robust to Places-403 graceful-degrade, open-dropdown axe-6bp, 0 console errors, non-mutating. Rewritten from the DELETED vanilla 4-screen selectors (all 11 old tests were prod-RED).
    'create-edit-publish-flow.spec.ts', // THE canonical REAL flow (create→build→view→edit→publish); skipped unless E2E_REAL_BUILD=1 (paid ~40min build)
    'e2e/voice.spec.ts', // ANCHORED: bare 'voice.spec.ts' also pulled in e2e/admin/voice.spec.ts (stale, deleted)
    'observability_gateway.spec.ts',
    'adversarial/**/*.spec.ts',
    // BLOCKING CWV gate — asserts LCP≤2000 / CLS≤0.05 / FCP≤1200 on the live marketing
    // homepage under throttled 3G/6×CPU. A CWV regression fails the prod suite instead
    // of silently shipping.
    'perf/ttfr.spec.ts',
    'auth-oauth-buttons.spec.ts', // F001 — Google + GitHub OAuth buttons (Pass 1)
    'auth-and-signin.spec.ts', // Full auth flow (all 6 methods + 2FA)
    'admin-journey.spec.ts', // Admin shell journey (Pass 6)
    'admin-sections-smoke.spec.ts', // 15 admin section redirect checks + API health (Pass 7)
    'marketing-seo.spec.ts', // 9 route SEO metadata + critical files (Pass 7)
    'marketing-meta-clientnav.spec.ts', // client-nav blog title guard + search accessible names (guards 24c7b2c04; goto-based SEO spec can't catch SPA-nav clobber)
    'security-headers-extended.spec.ts', // HSTS, CSP, CORS, security posture (Pass 7)
    'auth-signup-oauth.spec.ts', // Sign-up Google + GitHub OAuth buttons (Pass 8/14)
    'auth-full-flow.spec.ts', // P2 203 — homepage → sign-up → sign-in → admin nav (enrolled Pass 19 after green verify)
    'auth-full-oauth-flow.spec.ts', // P0 90 — OAuth callback token→session→admin + sign-in/up Google buttons (enrolled Pass 19)
    'admin-social.spec.ts', // Social + 8 admin section redirects (Pass 11)
    'admin-sysadmin.spec.ts', // Sysadmin + system-services + subdomain probes (Pass 17)
    'admin-site-detail.spec.ts', // Site detail routes + subdomain landing pages (Pass 18)
    'integration-health.spec.ts', // 8 probes across all services (Pass 9)
    'e2e/feature-flags.spec.ts', // ANCHORED (bare basename also pulled in e2e/admin/feature-flags.spec.ts, stale, deleted) — Public API + admin auth gates (Pass 9)
    'accessibility.spec.ts', // 8 routes × 6bp axe-core WCAG 2.2 AA (Pass 9)
    'admin-voice-billing.spec.ts', // Voice + billing auth gates + API smoke (Pass 21)
    'ai-actions/*.spec.ts', // P10 — money-endpoint family (payment-safety) + code-export (export-safety) unauth leak-free gates (Pass 25)
    'api-safety/*.spec.ts', // P10 — backend API unauth safety-gate sweep: destructive/billing/route-family/auth-session/webhook-token (Pass 26; dir is api-safety not coverage — coverage/ is gitignored)
    'admin-verify/*.spec.ts', // P0-ADMIN — every admin feature WORKS + POPULATED with real data (authed, real-browser technical+visual)
    'browserbase/*.spec.ts', // P0-ADMIN — managed real-Chrome DEEP-component visual (skips unless RUN_BROWSERBASE=1 + creds; Browserbase bills per session)
    'admin-dashboard.spec.ts', // First authenticated dashboard journey (Convergence Pass 1)
    // NOTE (#91, Pass 20): admin-and-billing/docs/modals/upgrades-30 got checkA11y
    // WIRED but are deliberately NOT enrolled — they hang against prod (pre-existing
    // unbounded-wait staleness, why they were never in the cert). Their surfaces
    // (billing/docs/modals/palette) are already axe-critical-verified by the enrolled
    // admin-*-journey specs. Enrollment is a separate stale-spec-repair task.
    'admin-*-journey.spec.ts', // 12 authenticated section journeys (Convergence Pass 2)
    'admin-logs-journey.spec.ts', // Logs dashboard tabs journey — audit + explorer + filter + pagination (also matched by the glob above)
    'admin-api-tokens-journey.spec.ts', // API tokens one-time-reveal + value-domains + revoke journey (also matched by the glob above)
    'admin-feature-flags.spec.ts', // sysAdmin feature-flags journey (Convergence Pass 2)
    'value-domains-*.spec.ts', // TDD Contract #10 value-domain suites (Convergence Pass 3)
    'auth-session-lifecycle.spec.ts', // Sign-out / expiry / 429 / reload (Convergence Pass 8)
    'auth-surface-journey.spec.ts', // P2 — authed /admin shell renders + sign-out clears session (Pass 18)
    // auth-magic-link-roundtrip.spec.ts is EXCLUDED on purpose: it sends 2 REAL
    // emails per run — run manually with E2E_PEEK_SECRET + --workers=1 only.
    'admin-user-settings-journey.spec.ts', // /admin/user profile + display-name value domains (settings-security wave; also matched by the admin-*-journey glob)
    'admin-auth-security-journey.spec.ts', // /admin/auth-security sessions + revoke + 2FA entry (settings-security wave; also matched by the admin-*-journey glob)
    'admin/review-links.spec.ts', // ANCHORED subdir path (→ '**/admin/review-links.spec.ts') — Share-link dialog journey, modernized from the removed /admin/review-links page (stale-7 triage 2026-07-31). The other 6 stale e2e/admin twins (bulk-ops, recipes, ai-chat-extras, email, seo, mcp) were DELETED: surfaces removed or relocated into Settings tabs already covered by admin-settings-journey + ai-chat-context.
    // ── Flag-verification suites (modernized Pass-14) — evidence behind the
    //    experimental→beta bumps that LANDED: pwa_manifest_full,
    //    outbound_webhooks, unified_inbox. The other five evidence specs
    //    (analytics/deliverability/site-mcp/pseo/video-studio) were
    //    modernized but carry 16 live tails (authoring agents cannot
    //    self-run) — held out with their flags; Pass-15 fixes forward.
    //    KEY probe finding: the media SECTION never mounts at /admin/media
    //    under the stub session (zero testids, no component) — route/guard
    //    investigation first.
    'pwa.spec.ts', // pwa_manifest_full (root file — basename ok, no twin)
    'webhook/webhooks.spec.ts', // outbound_webhooks
    '_fortress/unified_inbox/happy-path.spec.ts', // unified_inbox
    '_fortress/unified_inbox/adversarial.spec.ts', // unified_inbox
    'admin/analytics.spec.ts', // site_analytics evidence (Pass-15 tails fixed)
    'admin/deliverability.spec.ts', // email_deliverability_wizard evidence
    'site-mcp/site-mcp.spec.ts', // site_mcp_server evidence
    'pseo/pseo-matrix.spec.ts', // pseo_matrix_v2 evidence
    'media/media-coverage.spec.ts', // media API surface (MEDIA-07/08/09) — the Media Library admin UI was removed (/admin/media → admin-404); media survives as the API + media:write token scope. Replaces phantom media-video-studio.spec.ts (never authored).
    // ── Residual-admin triage (2026-07-31) — the remaining 19 unexecuting
    //    e2e/admin twins were audited against frontend routes: 14 DELETED
    //    (covered by admin-*-journey / admin-dashboard / webhook + site-mcp
    //    evidence specs, or asserting REMOVED surfaces — features-hub,
    //    stripe-app-status, trust-center, /admin/webhooks, bare /admin/sites
    //    list, old apps-detail|apps-instances|snapshots-diff|social-analytics
    //    paths). 5 MODERNIZED below to the TDD contract (authedPage, stubs
    //    after helper, ?** glob twins, hard asserts, value domains,
    //    screenshots) — each owns a surface with no other executing coverage.
    //    All 5 are ANCHORED subdir paths (→ '**/admin/<name>.spec.ts').
    'admin/accept-invite.spec.ts', // /admin/accept-invite?token= invite landing (4 tests incl. token value-domains)
    'admin/admin-shell.spec.ts', // SPA no-reload sentinel + network-status banner + toast dedupe (4 tests)
    'admin/apps.spec.ts', // apps/:id deploy panel + subdomain value-domains + apps/instances (4 tests)
    'admin/domain-stack.spec.ts', // domains/:id/stack wizard board / flag-gate / no-hostname (3 tests)
    'admin/social.spec.ts', // social/analytics aggregate + windows + empty + error-retry (4 tests)
  ],
  // (Pass 5: former wave-4 TDD-RED exclusions all greened and re-included.)
  fullyParallel: true,
  // Prod cert runs against the LIVE rate-limited edge from ONE IP under 4 workers,
  // so a ROTATING handful of pure-API/perf tests tarpit (transport timeout) on any
  // given run — all solo-green. A cert (Pass-17) proved the rotation is a broad
  // class, not a fixed trio: run A failed golden-path/ttfr/analytics; run B failed
  // 8 different pure-API probes (health, feature-flags, admin lists, pseo,
  // hostnames). So the fix is a global backstop, not a per-spec serial project:
  // retries:2 gives each failure a fresh context 1-2× more (by when the per-IP
  // tarpit has cleared), ending the "3-6 false fails per cert" churn. A REAL
  // failure is deterministic → fails ALL 3 attempts, never masked; Playwright
  // still marks any retried test "flaky" for audit. (Board Pass-16 queue head.)
  // retries:3 (was 2): the first sharded prod cert (run 31196899625) still leaked 4
  // timeout-class flakes past a 2-retry window when the per-IP tarpit stayed hot across
  // both immediate retries. A third attempt lands after the rate-limit has almost always
  // cleared. A REAL failure is deterministic → fails ALL 4 attempts, never masked;
  // Playwright still marks any retried test "flaky" for audit.
  retries: 3,
  // 45s test timeout (up from Playwright's 30s default) — the sharded cert's failures were
  // "Test timeout of 30000ms exceeded" on slow-under-load navigations against the live edge,
  // not hung pages. The headroom lets a rate-limited-but-progressing nav finish; a truly
  // stuck page still fails at 45s. Only slow/failing tests consume it, so shard runtime is
  // ~unchanged.
  timeout: 45_000,
  reporter: 'line',
  use: {
    baseURL: process.env.PROD_URL ?? 'https://projectsites.dev',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
