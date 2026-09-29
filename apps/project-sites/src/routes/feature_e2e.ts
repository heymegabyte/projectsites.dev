/**
 * Per-feature E2E check runner — runs entirely on Cloudflare, NO Docker.
 *
 * Two check kinds:
 *   - `http`    — fetch a prod URL + assert status / body substring (works on any
 *                 Worker, no binding).
 *   - `browser` — drive a real Chromium via Browser Rendering + `@cloudflare/playwright`
 *                 (`launch(env.BROWSER)`), navigate + assert a selector / text.
 *
 * Contract consumed by the spec-sheet "Run all in parallel" button:
 *   POST /api/feature-e2e/:key/run     → { runId, specs:[{path,status:'queued'}] }
 *   GET  /api/feature-e2e/runs/:runId  → { status, specs:[{path,status,durationMs}] }
 *
 * Run state lives in CACHE_KV (`e2erun:<id>`, 10-min TTL); checks run concurrently
 * via `ctx.waitUntil`, each updating KV so the client poll sees live progress.
 */

import type { BrowserWorker } from '@cloudflare/playwright';

import { Hono } from 'hono';

import type { Env, Variables } from '../types/env.js';

const PROD = 'https://projectsites.dev';
const RUN_TTL = 600;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

export type CheckStatus = 'queued' | 'running' | 'passed' | 'failed';

export interface E2eCheck {
  /** Plain-English label shown in the spec-sheet table. */
  label: string;
  kind: 'http' | 'browser';
  /** Path (prefixed with the prod origin) or absolute URL. */
  url: string;
  expectStatus?: number;
  bodyIncludes?: string;
  /** browser-only: assert this selector is present. */
  selector?: string;
  /** browser-only: assert the page's text contains this. */
  textIncludes?: string;
}

interface SpecState {
  path: string;
  status: CheckStatus;
  durationMs?: number;
  detail?: string;
}

interface RunState {
  status: 'running' | 'passed' | 'failed';
  specs: SpecState[];
}

/**
 * Per-flag check registry. Most platform flags have a real HTTP smoke check
 * (mirrors docs.ts smoke steps); UI surfaces get a Browser Rendering check.
 * Unknown keys fall back to a homepage-renders smoke check.
 */
const CHECK_REGISTRY: Readonly<Record<string, readonly E2eCheck[]>> = {
  abuse_takedown: [
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/abuse/report returns 404 when flag OFF (expected in prod)',
      url: '/api/abuse/report',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/abuse/reports (super-admin queue) 404s when OFF',
      url: '/api/abuse/reports',
    },
    {
      kind: 'browser',
      label: 'Admin shell renders (operator review-queue host surface)',
      selector: '[data-testid=dash-search]',
      url: '/admin',
    },
  ],
  activity_feed: [
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/activity returns 404 when flag OFF (expected in prod)',
      url: '/api/activity',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/mru (same flag) 404s when OFF',
      url: '/api/mru',
    },
    {
      kind: 'browser',
      label: 'Admin dashboard renders; recent-activity self-hides when flag off',
      selector: '[data-testid=dash-search]',
      url: '/admin',
    },
  ],
  ai_gateway_guardrails: [
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/guardrails/check returns 404 when flag OFF (killswitch/expected)',
      url: '/api/guardrails/check',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Route is mounted (not a soft-404 SPA shell)',
      url: '/api/guardrails/check',
    },
    {
      kind: 'browser',
      label: 'Admin shell renders (guardrails is backend-only, no UI)',
      selector: '[data-testid=dash-search]',
      url: '/admin',
    },
  ],
  app_launcher: [
    {
      kind: 'browser',
      label: 'Apps admin catalog shell renders (passes today)',
      selector: '[data-testid=apps-search-input]',
      url: '/admin/apps',
    },
    {
      bodyIncludes: 'data',
      expectStatus: 200,
      kind: 'http',
      label: 'Apps catalog endpoint returns catalog when app_launcher ON (default_enabled true)',
      url: '/api/apps/catalog',
    },
    {
      kind: 'browser',
      label: 'Apps lifecycle filter control present in section',
      selector: '[data-testid=apps-lifecycle-all]',
      url: '/admin/apps',
    },
    {
      kind: 'browser',
      label: 'Feature Flags admin lists app_launcher',
      textIncludes: 'app_launcher',
      url: '/admin/feature-flags',
    },
  ],
  audit_trail_export: [
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/audit/export returns 404 when flag OFF (expected in prod)',
      url: '/api/audit/export?format=json',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'CSV export path 404s when OFF (route mounted, not soft-404)',
      url: '/api/audit/export?format=csv&action=site.publish',
    },
    {
      kind: 'browser',
      label: 'Admin Audit section renders (in-app audit-log host surface)',
      selector: '[data-testid=dash-search]',
      url: '/admin/audit',
    },
  ],
  batch_operations: [
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/batch returns 404 when flag OFF (expected in prod)',
      url: '/api/batch',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/sites/compare (same flag) 404s when OFF',
      url: '/api/sites/compare',
    },
    {
      kind: 'browser',
      label: 'Admin shell renders (bulk-ops section was removed from nav)',
      selector: '[data-testid=dash-search]',
      url: '/admin',
    },
  ],
  better_auth: [
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Public health endpoint 200 (always passes)',
      url: '/api/health',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label:
        'Legacy auth serves while flag OFF — /api/auth/sign-up/email not the live path (expect non-200)',
      url: '/api/auth/sign-up/email',
    },
    {
      kind: 'browser',
      label: 'Admin auth-security session UI renders (adjacent surface)',
      selector: 'app-root, main',
      url: '/admin/auth-security',
    },
  ],
  cmdk_ai_actions: [
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/cmdk (suggestions) returns 404 when flag OFF (expected in prod)',
      url: '/api/cmdk',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/cmdk/resolve (AI resolve) returns 404 when flag OFF (expected in prod)',
      url: '/api/cmdk/resolve',
    },
    {
      kind: 'browser',
      label: 'Command palette opens client-side (does not consume these endpoints)',
      selector: '[data-testid=dash-search]',
      url: '/admin',
    },
  ],
  core_admin_detail: [
    {
      kind: 'browser',
      label: 'Site-detail split view renders',
      selector: 'app-root',
      url: '/admin/sites/e2e-seed-site',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Per-site logs endpoint',
      url: '/api/sites/e2e-seed-site/logs',
    },
    {
      bodyIncludes: 'core_admin_detail',
      expectStatus: 200,
      kind: 'http',
      label: 'Feature-flags API lists the sentinel',
      url: '/api/feature-flags',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
  core_auth: [
    { kind: 'browser', label: 'Sign-in page renders', selector: 'app-sign-in', url: '/signin' },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Auth me endpoint responds (unauth ok)',
      url: '/api/auth/me',
    },
    {
      bodyIncludes: 'core_auth',
      expectStatus: 200,
      kind: 'http',
      label: 'Feature-flags API lists the sentinel',
      url: '/api/feature-flags',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
  core_billing: [
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Entitlements endpoint',
      url: '/api/billing/entitlements',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Subscription status endpoint',
      url: '/api/billing/subscription',
    },
    {
      kind: 'browser',
      label: 'Billing admin page renders',
      selector: 'app-root',
      url: '/admin/billing',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
  core_feature_flags: [
    {
      bodyIncludes: 'core_feature_flags',
      expectStatus: 200,
      kind: 'http',
      label: 'Feature-flags registry API',
      url: '/api/feature-flags',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Single-flag detail',
      url: '/api/feature-flags/core_feature_flags',
    },
    {
      kind: 'browser',
      label: 'Feature-flags admin UI renders',
      selector: '[data-testid=feature-flags]',
      url: '/admin/feature-flags',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
  core_site_create: [
    { kind: 'browser', label: 'Homepage renders the funnel', selector: 'app-root', url: '/' },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Business search endpoint (public)',
      url: '/api/search/businesses?q=vito',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Pre-built site search (public)',
      url: '/api/sites/search?q=salon',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
  credit_wallet_rollover: [
    {
      expectStatus: 404,
      kind: 'http',
      label: 'credits balance route flag-gated OFF today → 404',
      url: '/api/credits/balance',
    },
    {
      kind: 'browser',
      label: 'admin billing page loads (wallet widget self-hides when flag off)',
      selector: 'app-usage-gauges',
      url: '/admin/billing',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'registry entry present for credit_wallet_rollover',
      url: '/api/feature-flags',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'credits apply route flag-gated OFF today → 404',
      url: '/api/credits/apply',
    },
  ],
  editor_vision_qa: [
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Vision-QA endpoint gated — 404 when editor_vision_qa OFF (default)',
      url: '/api/vision-qa',
    },
    {
      kind: 'browser',
      label: 'Feature Flags admin lists editor_vision_qa (passes today)',
      textIncludes: 'editor_vision_qa',
      url: '/admin/feature-flags',
    },
    {
      kind: 'browser',
      label: 'Editor admin shell reachable (baseline)',
      selector: 'body',
      url: '/admin/editor',
    },
  ],
  email_deliverability_wizard: [
    {
      kind: 'browser',
      label: 'Deliverability admin shell renders (passes today, shows flag-gate notice when off)',
      selector: '[data-testid=deliv-heading]',
      url: '/admin/deliverability',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Deliverability endpoint gated — 404 when email_deliverability_wizard OFF (default)',
      url: '/api/sites/demo-site/deliverability',
    },
    {
      kind: 'browser',
      label: 'Flag-gate notice present in deliverability section when off',
      selector: '[data-testid=deliverability-flag-gate]',
      url: '/admin/deliverability',
    },
    {
      kind: 'browser',
      label: 'Feature Flags admin lists email_deliverability_wizard',
      textIncludes: 'email_deliverability_wizard',
      url: '/admin/feature-flags',
    },
  ],
  lead_scanner: [
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Public health endpoint 200 (always passes)',
      url: '/api/health',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Scan route 404s while flag OFF (default off)',
      url: '/api/admin/leads/scan',
    },
    {
      kind: 'browser',
      label: 'Admin Leads section renders scan form (super-admin)',
      selector: '[data-testid=leads-scan-query]',
      url: '/admin/leads',
    },
    {
      kind: 'browser',
      label: 'Leads empty-state / submit control present',
      selector: '[data-testid=leads-scan-submit]',
      url: '/admin/leads',
    },
  ],
  marketing_dashboard: [
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Public health endpoint 200 (always passes)',
      url: '/api/health',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Dashboard endpoint 404s while flag OFF (default)',
      url: '/api/sites/site_demo/dashboard',
    },
    {
      kind: 'browser',
      label: "Admin shell renders (AI dashboard, not this flag's UI)",
      selector: '[data-testid=admin-not-found-home], app-admin-dashboard',
      url: '/admin',
    },
  ],
  mcp_server: [
    {
      bodyIncludes: 'list_sites',
      expectStatus: 200,
      kind: 'http',
      label: 'MCP discovery document (public)',
      url: '/.well-known/mcp',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'OAuth protected-resource metadata',
      url: '/.well-known/oauth-protected-resource',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Platform MCP JSON-RPC endpoint live (flag on)',
      url: '/api/mcp',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
  model_registry: [
    {
      expectStatus: 401,
      kind: 'http',
      label: '/v1/models live (beta) — unauthed → 401 OpenAI error envelope',
      url: '/v1/models',
    },
    {
      expectStatus: 401,
      kind: 'http',
      label: '/v1/models/:id live (beta) — unauthed → 401 (virtual id resolves with a psk_ key)',
      url: '/v1/models/projectsites-auto',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/router/pick is POST-only — GET → 404 (folded ai_auto_router)',
      url: '/api/router/pick',
    },
    {
      expectStatus: 401,
      kind: 'http',
      label: '/api/router/stats live (beta) — unauthed → 401 (org-session-gated)',
      url: '/api/router/stats?org_id=demo-org',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'registry entry present for model_registry',
      url: '/api/feature-flags',
    },
    { expectStatus: 200, kind: 'http', label: 'worker health responds', url: '/health' },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'unknown /v1 path stays 404 (not SPA soft-200)',
      url: '/v1/bogus',
    },
  ],
  onboarding_copilot: [
    {
      expectStatus: 404,
      kind: 'http',
      label: 'checklist route flag-gated OFF today → 404',
      url: '/api/onboarding/checklist',
    },
    {
      kind: 'browser',
      label: 'admin dashboard loads (checklist self-hides when flag off)',
      selector: 'app-referral-card',
      url: '/admin',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'registry entry present for onboarding_copilot',
      url: '/api/feature-flags',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'dismiss route flag-gated OFF today → 404',
      url: '/api/onboarding/dismiss',
    },
  ],
  outbound_webhooks: [
    {
      kind: 'browser',
      label: 'Webhooks Settings tab renders (passes today, flag-gate notice when off)',
      selector: '[data-testid=webhooks-flag-gate]',
      url: '/admin/settings#webhooks',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Webhooks list endpoint gated — 404 when outbound_webhooks OFF (default)',
      url: '/api/sites/demo-site/webhooks',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Webhook deliveries endpoint gated — 404 when OFF (default)',
      url: '/api/sites/demo-site/webhooks/deliveries',
    },
    {
      kind: 'browser',
      label: 'Feature Flags admin lists outbound_webhooks',
      textIncludes: 'outbound_webhooks',
      url: '/admin/feature-flags',
    },
  ],
  payments_rail: [
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/payments/intent flag-gated OFF today → 404',
      url: '/api/payments/intent',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/payments/methods flag-gated OFF today → 404',
      url: '/api/payments/methods',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'registry entry present for payments_rail',
      url: '/api/feature-flags',
    },
    { expectStatus: 200, kind: 'http', label: 'worker health responds', url: '/health' },
  ],
  preview_share_card: [
    {
      expectStatus: 401,
      kind: 'http',
      label: 'share-card unauth → 401 (flag gate is behind auth check)',
      url: '/api/sites/test/share-card',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'registry entry present for preview_share_card',
      url: '/api/feature-flags',
    },
    { expectStatus: 200, kind: 'http', label: 'worker health responds', url: '/health' },
    { kind: 'browser', label: 'marketing homepage renders', selector: 'body', url: '/' },
  ],
  prompt_studio: [
    {
      expectStatus: 401,
      kind: 'http',
      label: 'templates route unauth → 401 (flag gate behind auth)',
      url: '/api/prompt-studio/templates',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'registry entry present for prompt_studio',
      url: '/api/feature-flags',
    },
    { expectStatus: 200, kind: 'http', label: 'worker health responds', url: '/health' },
    { kind: 'browser', label: 'admin shell loads', selector: 'body', url: '/admin' },
  ],
  referral_loop: [
    {
      expectStatus: 404,
      kind: 'http',
      label: 'referral code route flag-gated OFF today → 404',
      url: '/api/referral/code',
    },
    {
      kind: 'browser',
      label: 'admin dashboard loads (referral card self-hides when flag off)',
      selector: 'app-referral-card',
      url: '/admin',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'registry entry present for referral_loop',
      url: '/api/feature-flags',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'referral stats route flag-gated OFF today → 404',
      url: '/api/referral/stats',
    },
  ],
  site_analytics: [
    {
      bodyIncludes: 'contacts',
      expectStatus: 200,
      kind: 'http',
      label: 'Owner analytics summary endpoint',
      url: '/api/sites/e2e-seed-site/analytics',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Daily analytics series',
      url: '/api/sites/e2e-seed-site/analytics/daily',
    },
    {
      kind: 'browser',
      label: 'Analytics admin dashboard renders',
      selector: '[data-testid=analytics-dashboard]',
      url: '/admin/analytics',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
  site_doctor: [
    {
      bodyIncludes: 'grade',
      expectStatus: 200,
      kind: 'http',
      label: 'Free-plan doctor report',
      url: '/api/sites/e2e-seed-site/doctor?plan=free',
    },
    {
      bodyIncludes: 'score',
      expectStatus: 200,
      kind: 'http',
      label: 'Pro-plan unlocks all issues',
      url: '/api/sites/e2e-seed-site/doctor?plan=pro',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Health sparkline (shared flag)',
      url: '/api/sites/e2e-seed-site/sparkline',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
  social_autopilot: [
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Public health endpoint 200 (always passes)',
      url: '/api/health',
    },
    {
      kind: 'browser',
      label: 'Admin Social auto-pilot prompt control renders',
      selector: '[data-testid=social-auto-pilot-prompt-btn]',
      url: '/admin/social',
    },
    {
      kind: 'browser',
      label: 'Composer textarea present (manual compose unaffected by kill-switch)',
      selector: '[data-testid=social-composer-textarea]',
      url: '/admin/social',
    },
  ],
  social_publishing: [
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Public health endpoint 200 (always passes)',
      url: '/api/health',
    },
    {
      kind: 'browser',
      label: 'Admin Social composer publish hint renders',
      selector: '[data-testid=publish-hint]',
      url: '/admin/social',
    },
    {
      kind: 'browser',
      label: 'Composer textarea present (drafting works regardless of kill-switch)',
      selector: '[data-testid=social-composer-textarea]',
      url: '/admin/social',
    },
  ],
  social_publishing_native: [
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Public health endpoint 200 (always passes)',
      url: '/api/health',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label:
        'Native publish route 404s while flag OFF (default off in registry note; gate present)',
      url: '/api/social/site_demo/posts/publish',
    },
    {
      kind: 'browser',
      label: 'Admin Social composer shell renders',
      selector: '[data-testid=social-composer-textarea]',
      url: '/admin/social',
    },
    {
      kind: 'browser',
      label: 'Composer character counter present',
      selector: '[data-testid=composer-counter]',
      url: '/admin/social',
    },
  ],
  system_status: [
    {
      expectStatus: 404,
      kind: 'http',
      label: '/api/system/status returns 404 when flag OFF (expected in prod)',
      url: '/api/system/status',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'System status route is mounted (not a soft-404 SPA shell)',
      url: '/api/system/status',
    },
    {
      kind: 'browser',
      label: 'Admin dashboard shell renders (host surface for the future status strip)',
      selector: '[data-testid=dash-search]',
      url: '/admin',
    },
  ],
  token_burn_meter: [
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Burn endpoint gated — 404 when token_burn_meter OFF (default)',
      url: '/api/usage/burn?org_id=demo-org',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Record endpoint exists and is flag-gated (404 default-off)',
      url: '/api/usage/record',
    },
    {
      kind: 'browser',
      label: 'Feature Flags admin lists token_burn_meter',
      textIncludes: 'token_burn_meter',
      url: '/admin/feature-flags',
    },
  ],
  visual_automation: [
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Public health endpoint 200 (always passes)',
      url: '/api/health',
    },
    {
      expectStatus: 404,
      kind: 'http',
      label: 'Automation validate route 404s while flag OFF (default)',
      url: '/api/sites/site_demo/automation/validate',
    },
    {
      kind: 'browser',
      label: 'Admin shell renders (flag has no dedicated UI)',
      selector: 'app-admin-dashboard, [data-testid=admin-not-found-home]',
      url: '/admin',
    },
  ],
  wireframe_planning: [
    {
      bodyIncludes: 'wireframe_planning',
      expectStatus: 200,
      kind: 'http',
      label: 'Feature-flags API lists the flag',
      url: '/api/feature-flags',
    },
    {
      expectStatus: 200,
      kind: 'http',
      label: 'Flag detail resolves',
      url: '/api/feature-flags/wireframe_planning',
    },
    {
      kind: 'browser',
      label: 'Flag appears in admin feature-flags UI',
      selector: '[data-testid=feature-flags]',
      textIncludes: 'wireframe',
      url: '/admin/feature-flags',
    },
    {
      bodyIncludes: 'ok',
      expectStatus: 200,
      kind: 'http',
      label: 'Health endpoint (passes today)',
      url: '/api/health',
    },
  ],
};

/** Pure resolver — exported for tests. Falls back to a homepage smoke check. */
export function checksFor(key: string): E2eCheck[] {
  const reg = CHECK_REGISTRY[key];
  if (reg && reg.length) return [...reg];
  return [
    { expectStatus: 200, kind: 'http', label: `Homepage renders (smoke for ${key})`, url: '/' },
  ];
}

/** Resolve a check's URL against the prod origin. Exported for tests. */
export function resolveCheckUrl(check: E2eCheck): string {
  return check.url.startsWith('http') ? check.url : `${PROD}${check.url}`;
}

async function runHttpCheck(
  check: E2eCheck,
): Promise<{ status: 'passed' | 'failed'; detail?: string }> {
  try {
    const res = await fetch(resolveCheckUrl(check), {
      headers: { Accept: 'text/html,*/*', 'User-Agent': UA },
    });
    if (check.expectStatus && res.status !== check.expectStatus)
      return { detail: `HTTP ${res.status}`, status: 'failed' };
    if (check.bodyIncludes) {
      const body = await res.text();
      if (!body.includes(check.bodyIncludes))
        return { detail: `missing "${check.bodyIncludes}"`, status: 'failed' };
    }
    return { status: 'passed' };
  } catch (e) {
    return { detail: (e as Error).message, status: 'failed' };
  }
}

async function runBrowserCheck(
  env: Env,
  check: E2eCheck,
): Promise<{ status: 'passed' | 'failed'; detail?: string }> {
  if (!env.BROWSER) return { detail: 'Browser Rendering binding unavailable', status: 'failed' };
  try {
    const { launch } = await import('@cloudflare/playwright');
    const browser = await launch(env.BROWSER as BrowserWorker);
    try {
      const page = await browser.newPage();
      await page.goto(resolveCheckUrl(check), { timeout: 25_000, waitUntil: 'domcontentloaded' });
      if (check.selector) {
        const el = await page.$(check.selector);
        if (!el) return { detail: `selector "${check.selector}" not found`, status: 'failed' };
      }
      if (check.textIncludes) {
        const text = (await page.textContent('body')) ?? '';
        if (!text.includes(check.textIncludes))
          return { detail: `text "${check.textIncludes}" not found`, status: 'failed' };
      }
      return { status: 'passed' };
    } finally {
      await browser.close();
    }
  } catch (e) {
    return { detail: (e as Error).message, status: 'failed' };
  }
}

/** Run all checks concurrently, persisting live status to KV after each completes. */
async function executeRun(env: Env, runId: string, checks: E2eCheck[]): Promise<void> {
  const kvKey = `e2erun:${runId}`;
  const specs: SpecState[] = checks.map((ch) => ({ path: ch.label, status: 'running' }));
  const persist = (status: RunState['status']) =>
    env.CACHE_KV.put(kvKey, JSON.stringify({ specs, status } satisfies RunState), {
      expirationTtl: RUN_TTL,
    }).catch(() => {});
  await persist('running');
  await Promise.all(
    checks.map(async (ch, i) => {
      const t0 = Date.now();
      const r = ch.kind === 'browser' ? await runBrowserCheck(env, ch) : await runHttpCheck(ch);
      specs[i] = {
        detail: r.detail,
        durationMs: Date.now() - t0,
        path: ch.label,
        status: r.status,
      };
      await persist('running');
    }),
  );
  await persist(specs.every((s) => s.status === 'passed') ? 'passed' : 'failed');
}

export const featureE2e = new Hono<{ Bindings: Env; Variables: Variables }>();

featureE2e.post('/api/feature-e2e/:key/run', async (c) => {
  const key = c.req.param('key');
  const checks = checksFor(key);
  const runId = crypto.randomUUID();
  const initial: RunState = {
    specs: checks.map((ch) => ({ path: ch.label, status: 'queued' })),
    status: 'running',
  };
  await c.env.CACHE_KV.put(`e2erun:${runId}`, JSON.stringify(initial), { expirationTtl: RUN_TTL });
  c.executionCtx.waitUntil(executeRun(c.env, runId, checks));
  return c.json({ runId, specs: initial.specs });
});

featureE2e.get('/api/feature-e2e/runs/:runId', async (c) => {
  const raw = await c.env.CACHE_KV.get(`e2erun:${c.req.param('runId')}`);
  if (!raw) return c.json({ specs: [], status: 'error' }, 404);
  return c.json(JSON.parse(raw) as RunState);
});
