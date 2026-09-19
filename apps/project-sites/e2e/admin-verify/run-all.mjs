#!/usr/bin/env node
/**
 * run-all.mjs — aggregate runner for the CORE per-fire admin-verify suite. One command
 * instead of hand-assembling the batch every loop fire (+ a CI-gateable exit code).
 *
 * Runs, in order: RENDER+A11Y (surf @1280 + @390, incl. the mobile overflow gate) →
 * TRUTHFUL DATA (reconcile-surfaces) → TRUTHFUL MUTATIONS (every verify-*-causal.mjs,
 * globbed so new probes auto-join) → REAL JOURNEYS (billing-checkout mount, editor
 * data/functions tabs). Each child inherits this process's env (E2E_API_KEY /
 * BROWSERBASE_* / E2E_TEST_PASSWORD) and self-skips (`::notice:: skipped`) when its creds
 * are unset — a SKIP is not a failure, so forks + secret-less CI stay green.
 *
 * Exit 0 when every probe PASSED or SKIPPED; exit 1 if any probe FAILED (its own exit≠0).
 *
 * Usage:
 *   E2E_API_KEY=… BROWSERBASE_API_KEY=… BROWSERBASE_PROJECT_ID=… E2E_TEST_PASSWORD=… \
 *     node e2e/admin-verify/run-all.mjs           # full core suite (~25 min, all Browserbase)
 *   node e2e/admin-verify/run-all.mjs api-tokens  # only probes whose label matches the filter
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const filter = (process.argv[2] || '').toLowerCase();

// Causal probes are globbed so a newly-authored verify-*-causal.mjs auto-joins the suite.
const causal = readdirSync(DIR)
  .filter((f) => /^verify-.*-causal\.mjs$/.test(f))
  .sort()
  .map((f) => ({ label: f.replace(/^verify-|-causal\.mjs$/g, ''), file: f, env: {} }));

const PROBES = [
  { label: 'surf @1280', file: 'admin-surf-audit.mjs', env: {} },
  { label: 'surf @390', file: 'admin-surf-audit.mjs', env: { VIEWPORT: '390' } },
  { label: 'sysadmin-render', file: 'verify-sysadmin-render.mjs', env: {} },
  { label: 'admin-cwv', file: 'verify-admin-cwv.mjs', env: {} },
  { label: 'reconcile', file: 'reconcile-surfaces.mjs', env: {} },
  { label: 'reconcile-counts', file: 'reconcile-counts.mjs', env: {} },
  { label: 'dashboard-rollup', file: 'verify-dashboard-status-rollup-causal.mjs', env: {} },
  { label: 'billing-entitlements', file: 'verify-billing-entitlements-display.mjs', env: {} },
  { label: 'notif-badge', file: 'verify-notification-badge-honest.mjs', env: {} },
  { label: 'readiness-badge', file: 'verify-readiness-badge-honest.mjs', env: {} },
  { label: 'social-connect', file: 'verify-social-connect-endpoints.mjs', env: {} },
  { label: 'deliverability-control', file: 'verify-deliverability-control.mjs', env: {} },
  { label: 'focus-obscured', file: 'focus-not-obscured.mjs', env: {} },
  { label: 'target-size', file: 'target-size-scan.mjs', env: {} },
  { label: 'modal-a11y', file: 'modal-a11y-scan.mjs', env: {} },
  { label: 'dragging-alt', file: 'dragging-alternative-scan.mjs', env: {} },
  { label: 'auth-a11y', file: 'verify-auth-a11y.mjs', env: {} },
  { label: 'team-seat-client-gate', file: 'verify-team-seat-client-gate.mjs', env: {} },
  { label: 'auth-guard', file: 'verify-auth-guard.mjs', env: {} },
  { label: 'super-admin-guard', file: 'verify-super-admin-guard.mjs', env: {} },
  { label: 'admin-security-invariants', file: 'verify-admin-security-invariants.mjs', env: {} },
  { label: 'analytics-tabs-live', file: 'verify-analytics-tabs-live.mjs', env: {} },
  { label: 'billing-tabs-live', file: 'verify-billing-tabs-live.mjs', env: {} },
  { label: 'billing-widgets-resolve', file: 'verify-billing-widgets-resolve.mjs', env: {} },
  { label: 'auth-flow', file: 'verify-auth-flow.mjs', env: {} },
  { label: 'auth-return-to', file: 'verify-auth-return-to.mjs', env: {} },
  { label: 'signin-ux', file: 'verify-signin-ux.mjs', env: {} },
  { label: 'signin-magic-link-ui', file: 'verify-signin-magic-link-ui.mjs', env: {} },
  { label: 'signup-flow', file: 'verify-signup-flow.mjs', env: {} },
  { label: 'signin-flow', file: 'verify-signin-flow.mjs', env: {} },
  { label: 'idor-cross-org', file: 'verify-idor-cross-org.mjs', env: {} },
  { label: 'mcp-connect-flow', file: 'verify-mcp-connect-flow.mjs', env: {} },
  { label: 'voice-persite-journey', file: 'verify-voice-persite-journey.mjs', env: {} },
  { label: 'completeness', file: 'completeness-stub-scan.mjs', env: {} },
  { label: 'wordmark-spelling', file: 'verify-wordmark-spelling.mjs', env: {} },
  { label: 'error-edge-states', file: 'verify-error-edge-states.mjs', env: {} },
  { label: 'funnel-reconcile', file: 'verify-funnel-reconcile.mjs', env: {} },
  ...causal,
  { label: 'guest-funnel', file: 'verify-guest-funnel.mjs', env: {} },
  { label: 'guest-funnel-results', file: 'verify-guest-funnel-results.mjs', env: {} },
  { label: 'prebuilt-preview', file: 'verify-prebuilt-preview.mjs', env: {} },
  { label: 'guest-search-osm-fallback', file: 'verify-guest-search-osm-fallback.mjs', env: {} },
  { label: 'guest-funnel-keyboard', file: 'verify-guest-funnel-keyboard.mjs', env: {} },
  { label: 'guest-funnel-a11y', file: 'verify-guest-funnel-a11y.mjs', env: {} },
  { label: 'pivot-speed', file: 'verify-conversion-pivot-speed.mjs', env: {} },
  { label: 'create-wizard', file: 'verify-create-wizard.mjs', env: {} },
  { label: 'owner-site-journey', file: 'verify-owner-site-journey.mjs', env: {} },
  { label: 'delivery-email', file: 'verify-delivery-email.mjs', env: {} },
  { label: 'waiting-page', file: 'verify-waiting-page.mjs', env: {} },
  { label: 'platform-footer-pages', file: 'verify-platform-footer-pages.mjs', env: {} },
  { label: 'lead-claim-funnel', file: 'verify-lead-claim-funnel.mjs', env: {} },
  { label: 'billing-checkout', file: 'verify-billing-checkout.mjs', env: {} },
  { label: 'billing-full-flow', file: 'verify-billing-full-flow.mjs', env: {} },
  { label: 'editor-datatab', file: 'verify-editor-datatab.mjs', env: {} },
  { label: 'editor-roundtrip', file: 'verify-editor-roundtrip.mjs', env: {} },
  { label: 'editor-webcontainer-roundtrip', file: 'verify-editor-webcontainer-roundtrip.mjs', env: {} },
  { label: 'site-delete-envelope', file: 'verify-site-delete-envelope.mjs', env: {} },
  { label: 'domain-provisioning-envelope', file: 'verify-domain-provisioning-envelope.mjs', env: {} },
  { label: 'cinematic-scroll-reveals', file: 'verify-cinematic-scroll-reveals.mjs', env: {} },
].filter((p) => !filter || p.label.toLowerCase().includes(filter) || p.file.toLowerCase().includes(filter));

if (PROBES.length === 0) {
  console.error(`run-all: no probes match filter "${filter}"`);
  process.exit(2);
}

const results = [];
for (const p of PROBES) {
  process.stdout.write(`\n▶ ${p.label} …\n`);
  const r = spawnSync(process.execPath, [resolve(DIR, p.file)], {
    env: { ...process.env, ...p.env },
    encoding: 'utf8',
    timeout: 300_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // A probe SKIPS (not a failure) when it prints a "skipped" notice and exits 0.
  const skipped = r.status === 0 && /::notice::.*skipp?ed|^\s*skip —/im.test(out);
  const status = r.status === 0 ? (skipped ? 'SKIP' : 'PASS') : 'FAIL';
  // Surface the probe's own verdict/summary line for the roll-up.
  const verdict =
    (out.match(/VERDICT:[^\n]*/) || out.match(/\d+ divergence\(s\)[^\n]*/) || out.match(/→ (CLEAN|\d+ section[^\n]*)/) || out.match(/::notice::[^\n]*/) || [''])[0].slice(0, 96);
  results.push({ label: p.label, status, verdict });
  console.log(`${status === 'PASS' ? '✅' : status === 'SKIP' ? '⚠️ ' : '🔴'} ${p.label} — ${verdict || '(no summary line)'}`);
}

const fails = results.filter((r) => r.status === 'FAIL');
const passes = results.filter((r) => r.status === 'PASS').length;
const skips = results.filter((r) => r.status === 'SKIP').length;
console.log(`\n━━ admin-verify suite: ${passes} pass · ${skips} skip · ${fails.length} fail (of ${results.length}) ━━`);
for (const f of fails) console.log(`  🔴 ${f.label}: ${f.verdict}`);
process.exit(fails.length === 0 ? 0 : 1);
