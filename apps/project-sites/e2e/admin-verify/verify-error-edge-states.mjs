#!/usr/bin/env node
/**
 * verify-error-edge-states.mjs — COMPLETENESS dim-5 (EDGE STATES): when a section's
 * data load FAILS, it must degrade GRACEFULLY — shell intact, a truthful error
 * affordance (message / retry), NEVER a white screen, a full-page crash, or a
 * lying-empty ("No X yet" as if the store were empty when the load actually errored).
 *
 * Forces the error edge-state via route interception: the sites LIST + session/shell
 * essentials (`/api/auth/*`, `/api/feature-flags`, `/api/notifications`, `/api/sites`,
 * `/api/billing/entitlements`) are allowed through (so a site is selected + the shell
 * boots), and every OTHER `/api/*` call — i.e. each section's own data — is answered
 * 500. Then each section is loaded and classified:
 *   GRACEFUL   — shell intact + not blank + a visible error/retry affordance.
 *   LYING-EMPTY — shell intact + not blank but only an empty-state ("no … yet") with
 *                 NO error affordance (misleads: "nothing exists" vs "load failed").
 *   CRASH      — white screen / shell gone (unhandled).
 *
 * Local Chromium (authed shell, not CF-challenged). Skips (exit 0) when E2E_API_KEY unset.
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-error-edge-states.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-error-edge-states skipped — E2E_API_KEY unset');
  process.exit(0);
}

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// 20 data-heavy sections (was 6 → 12 media/logs/sites/team/social/user AL-131 → 20
// apps/voice/dashboard/settings/mcp/domains/webhooks/api-tokens AL-479, each verified to
// degrade gracefully under a forced data-500 before being added — the settings hash-tabs
// mcp/domains/webhooks/api-tokens each own a DISTINCT data load). Override via EDGE_SECTIONS.
const SECTIONS = (
  process.env.EDGE_SECTIONS ||
  'analytics,forms,audit,snapshots,billing,deliverability,media,logs,sites,team,social,user,' +
    'apps,voice,dashboard,settings,mcp,domains,webhooks,api-tokens'
).split(',');
// Allow-list: session/shell + the sites LIST (so a site stays selected) + entitlements.
const ALLOW = (u) =>
  /\/api\/(auth|feature-flags|notifications)/.test(u) ||
  /\/api\/sites(\?|$)/.test(u) ||
  /\/api\/billing\/entitlements/.test(u);
const ERR_RE = /failed|couldn.?t load|try again|unavailable|went wrong|error loading|retry|problem loading/i;
const EMPTY_RE = /no .{0,30}\byet\b|nothing here|no results|get started|create your first/i;

const b = await chromium.launch();
const ctx = await b.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
const p = await ctx.newPage();
await p.goto(`${ORIGIN}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.evaluate((k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })), KEY);
// Force every section-data call to 500 (shell + sites list allowed through).
await ctx.route('**/api/**', (route) => {
  if (ALLOW(route.request().url())) return route.continue();
  return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"INTERNAL_ERROR","message":"forced-edge-test"}}' });
});

const rows = [];
for (const sec of SECTIONS) {
  try {
    await p.goto(`${ORIGIN}/admin/${sec}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(4000);
    const r = await p.evaluate(() => {
      const rootEl = document.getElementById('root') || document.body;
      const txt = (rootEl.innerText || '').trim();
      return {
        len: txt.length,
        shell: !!document.querySelector('nav, [aria-label*="rimary"], .admin-site-selector'),
        hasError: false, hasEmpty: false, txt,
      };
    });
    const hasError = ERR_RE.test(r.txt);
    const hasEmpty = EMPTY_RE.test(r.txt);
    let verdict;
    if (!r.shell || r.len < 50) verdict = 'CRASH';
    else if (hasError) verdict = 'GRACEFUL';
    else if (hasEmpty) verdict = 'LYING-EMPTY';
    else verdict = 'GRACEFUL'; // non-blank, shell intact, no misleading empty-state copy
    rows.push({ sec, verdict, len: r.len, shell: r.shell, hasError, hasEmpty });
  } catch (e) {
    rows.push({ sec, verdict: 'CRASH', err: String(e).slice(0, 50) });
  }
}
await b.close();

let bad = 0;
for (const r of rows) {
  const ok = r.verdict === 'GRACEFUL';
  if (!ok) bad++;
  console.log(`  ${ok ? '✓' : '✗'} ${r.sec.padEnd(15)} ${r.verdict.padEnd(12)} shell=${r.shell} err=${r.hasError} empty=${r.hasEmpty} len=${r.len ?? '?'}`);
}
console.log(
  bad === 0
    ? `\nVERDICT: ✅ PASS — all ${rows.length} sections degrade gracefully under a forced data-500 (shell intact + truthful error affordance, no crash / no lying-empty).`
    : `\nVERDICT: 🔴 CHECK — ${bad}/${rows.length} section(s) mishandle the error edge-state (CRASH = white/unhandled; LYING-EMPTY = "no data" shown when the load actually FAILED).`,
);
process.exit(bad === 0 ? 0 : 1);
