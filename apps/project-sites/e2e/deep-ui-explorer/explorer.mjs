#!/usr/bin/env node
/**
 * explorer.mjs — Deep UI Explorer (loop role 17: Visual Intelligence).
 *
 * An AUTHENTICATED, stateful browser agent that models the admin as a graph of
 * STATES + TRANSITIONS (not URLs): it starts at the public homepage, signs in
 * through the app's real test-approved path (`/signin?test=1` → the secret-gated
 * `POST /api/auth/test-login` seam), verifies the resulting identity + role via
 * `/api/auth/me`, then navigates INTO /admin by clicking the UI — capturing ONE
 * settled screenshot + a full state record after EVERY meaningful action.
 *
 * Provider contract (honest-by-construction):
 *   1. PRIMARY  — Cloudflare Browser Run CDP:
 *      wss://api.cloudflare.com/client/v4/accounts/{acct}/browser-run/devtools/browser
 *      (Authorization: Bearer CLOUDFLARE_API_TOKEN; "Browser Rendering - Edit" perm).
 *   2. FALLBACK — Browserbase (recorded as provider:"browserbase", status FALLBACK).
 *   3. FALLBACK — local Chromium (provider:"local-chromium", status FALLBACK).
 *   A missing credential / failed login / role mismatch is reported as BLOCKED —
 *   NEVER as passed Cloudflare coverage. Force with EXPLORER_PROVIDER=cf|browserbase|local.
 *
 * Deep-path proof (first slice): homepage → sign in → /admin → Editor →
 * Database → Tables → Actions menu → History overlay → close. Each is a
 * separate captured state (incl. the opened menu + the overlay).
 *
 * Artifacts:
 *   - Run manifest  : e2e/screenshots/deep-ui-explorer/<runId>/manifest.json
 *   - Screenshots   : e2e/screenshots/deep-ui-explorer/<runId>/NN-<state>.png (gitignored)
 *   - Coverage ledger: e2e/deep-ui-explorer/coverage-ledger.json (committed, resumable)
 *
 * READ-ONLY: this pass performs zero product mutations (History is opened, never
 * restored). Password fields are masked in screenshots before any capture.
 *
 * Usage:
 *   node e2e/deep-ui-explorer/explorer.mjs                # full deep path vs prod
 *   EXPLORER_PROVIDER=local node e2e/deep-ui-explorer/explorer.mjs
 *   ORIGIN=http://localhost:4200 node e2e/deep-ui-explorer/explorer.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveSecret } from '../admin-verify/_browserbase-creds.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright-core');

// ---------------------------------------------------------------------------
// Config + creds (names only in logs — values never printed)
// ---------------------------------------------------------------------------
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '84fa0d1b16ff8086dd958c468ce7fd59';
const TEST_LOGIN_EMAIL = 'brian@megabyte.space';
const STEP_LIMIT = parseInt(process.env.EXPLORER_STEP_LIMIT || '48', 10);
const TIME_LIMIT_MS = parseInt(process.env.EXPLORER_TIME_MS || String(9 * 60 * 1000), 10);
const KEEP_ALIVE_MS = 600_000; // 10-min CF Browser Run session ceiling
const VIEWPORT = { width: 1440, height: 900 }; // the normal development viewport

// Prefer the dedicated Browser-Run-scoped token (minted 2026-09-29, "Browser Run
// Write" on this account); the general CLOUDFLARE_API_TOKEN lacks that permission.
const CF_TOKEN = resolveSecret('CF_BROWSER_RUN_TOKEN') || resolveSecret('CLOUDFLARE_API_TOKEN');
const E2E_TEST_PASSWORD = resolveSecret('E2E_TEST_PASSWORD');
const BB_KEY = resolveSecret('BROWSERBASE_API_KEY');
const BB_PROJECT = resolveSecret('BROWSERBASE_PROJECT_ID');

const RUN_ID = `dux-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const RUN_DIR = resolve(__dirname, '../screenshots/deep-ui-explorer', RUN_ID);
const LEDGER_PATH = resolve(__dirname, 'coverage-ledger.json');
mkdirSync(RUN_DIR, { recursive: true });

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// Browser acquisition ladder — CF Browser Run PRIMARY, everything else FALLBACK
// ---------------------------------------------------------------------------
/**
 * Acquire a browser per the provider ladder. Returns provider proof alongside
 * the browser so the manifest can never claim CF coverage it didn't get.
 */
async function acquireBrowser() {
  const forced = process.env.EXPLORER_PROVIDER; // cf | browserbase | local
  const attempts = [];

  const tryCf = async () => {
    if (!CF_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN unavailable (get-secret + env both empty)');
    const ws = `wss://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-run/devtools/browser?keep_alive=${KEEP_ALIVE_MS}`;
    const browser = await chromium.connectOverCDP(ws, {
      headers: { Authorization: `Bearer ${CF_TOKEN}` },
      timeout: 30_000,
    });
    return {
      browser,
      provider: 'cloudflare-browser-run',
      coverage: 'CLOUD_PASS_ELIGIBLE',
      sessionId: `cf-browser-run:${CF_ACCOUNT_ID.slice(0, 8)}…:${RUN_ID}`,
      endpoint: ws.replace(/accounts\/[0-9a-f]{32}/, 'accounts/<acct>'),
    };
  };

  const tryBrowserbase = async () => {
    if (!BB_KEY || !BB_PROJECT) throw new Error('BROWSERBASE_API_KEY / _PROJECT_ID unavailable');
    const res = await fetch('https://api.browserbase.com/v1/sessions', {
      method: 'POST',
      headers: { 'x-bb-api-key': BB_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: BB_PROJECT }),
    });
    if (!res.ok) throw new Error(`browserbase session create ${res.status}`);
    const session = await res.json();
    const browser = await chromium.connectOverCDP(
      `wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB_KEY)}&sessionId=${encodeURIComponent(session.id)}`,
    );
    return {
      browser,
      provider: 'browserbase',
      coverage: 'FALLBACK', // never counts as Cloudflare Browser Run coverage
      sessionId: session.id,
      endpoint: 'wss://connect.browserbase.com',
    };
  };

  const tryLocal = async () => {
    const browser = await chromium.launch();
    return {
      browser,
      provider: 'local-chromium',
      coverage: 'FALLBACK',
      sessionId: `local:${process.pid}`,
      endpoint: 'local',
    };
  };

  const ladder =
    forced === 'cf' ? [tryCf]
    : forced === 'browserbase' ? [tryBrowserbase]
    : forced === 'local' ? [tryLocal]
    : [tryCf, tryBrowserbase, tryLocal];

  for (const step of ladder) {
    try {
      const got = await step();
      got.attempts = attempts;
      return got;
    } catch (err) {
      attempts.push({ step: step.name, error: String(err?.message || err).slice(0, 300) });
    }
  }
  return { browser: null, provider: 'none', coverage: 'BLOCKED', attempts };
}

// ---------------------------------------------------------------------------
// State graph capture
// ---------------------------------------------------------------------------
const states = [];
const consoleErrors = [];
const failedRequests = [];
let stepNo = 0;

/** Stable state key from the interface coordinates (route+panel+overlay), not the URL alone. */
function stateKey(parts) {
  const norm = JSON.stringify(parts);
  return `${parts.route || 'unknown'}::${parts.surface || ''}::${parts.overlay || ''}::${createHash('sha1').update(norm).digest('hex').slice(0, 8)}`;
}

function budgetExceeded() {
  return stepNo >= STEP_LIMIT || Date.now() - startedAt > TIME_LIMIT_MS;
}

/**
 * Settle → screenshot → record ONE state after a meaningful action.
 * @param page   Playwright page.
 * @param action Human description of the action that PRODUCED this state.
 * @param coords {route,surface,overlay,iframe} interface coordinates for the key.
 */
async function capture(page, action, coords = {}) {
  stepNo += 1;
  // Bounded settle: network quiet + no "Loading …" text; fail-open (never hang).
  // Tunable: persistent analytics beacons keep networkidle from EVER resolving,
  // so every state otherwise pays the full timeout — breadth runs shrink it.
  const NET_MS = parseInt(process.env.EXPLORER_SETTLE_NET_MS || '12000', 10);
  const LOAD_MS = parseInt(process.env.EXPLORER_SETTLE_LOAD_MS || '8000', 10);
  await page.waitForLoadState('networkidle', { timeout: NET_MS }).catch(() => {});
  await page
    .waitForFunction(
      () => !/\bLoading\b[^\n]{0,40}(…|\.\.\.)/.test(document.body?.innerText || ''),
      { timeout: LOAD_MS },
    )
    .catch(() => {});
  await page.waitForTimeout(350); // paint settle for animations

  const n = String(stepNo).padStart(2, '0');
  const slug = action.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const file = `${n}-${slug}.png`;
  // Mask every password field — redaction happens BEFORE bytes exist on disk.
  await page
    .screenshot({
      path: resolve(RUN_DIR, file),
      mask: [page.locator('input[type="password"]')],
      maskColor: '#00E5FF',
    })
    .catch(async () => page.screenshot({ path: resolve(RUN_DIR, file) }));

  const url = page.url();
  const title = await page.title().catch(() => '');
  const visibleText = await page
    .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 1200))
    .catch(() => '');
  const coordsFull = { route: new URL(url).pathname, ...coords };
  const record = {
    id: stepNo,
    key: stateKey(coordsFull),
    prevId: stepNo - 1 || null,
    action,
    url,
    title,
    coords: coordsFull,
    screenshot: file,
    visibleText,
    consoleErrors: consoleErrors.splice(0),
    failedRequests: failedRequests.splice(0),
    ts: new Date().toISOString(),
  };
  states.push(record);
  console.warn(`  [${n}] ${action}`);
  return record;
}

/** Try locators in order inside a page or frame; return the first that clicked. */
async function clickFirst(scope, candidates, { timeout = 8000 } = {}) {
  for (const make of candidates) {
    try {
      const loc = make(scope).first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click();
      return true;
    } catch {
      /* next candidate */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Coverage ledger (resumable cursor across fires)
// ---------------------------------------------------------------------------
function updateLedger(runSummary) {
  let ledger = { states: {}, runs: [] };
  if (existsSync(LEDGER_PATH)) {
    try {
      ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    } catch {
      /* corrupt → rebuild */
    }
  }
  for (const s of states) {
    const prev = ledger.states[s.key] || { discovered: s.ts, visits: 0 };
    ledger.states[s.key] = {
      ...prev,
      status: 'visited',
      lastAction: s.action,
      lastVisited: s.ts,
      visits: (prev.visits || 0) + 1,
      lastRun: RUN_ID,
    };
  }
  for (const [key, why] of Object.entries(runSummary.blockedStates || {})) {
    if (!ledger.states[key] || ledger.states[key].status !== 'visited') {
      ledger.states[key] = { status: 'blocked', reason: why, lastRun: RUN_ID };
    }
  }
  ledger.runs.unshift(runSummary);
  ledger.runs = ledger.runs.slice(0, 30);
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const manifest = {
  runId: RUN_ID,
  origin: ORIGIN,
  viewport: VIEWPORT,
  startedAt: new Date(startedAt).toISOString(),
  provider: null,
  providerCoverage: null,
  sessionId: null,
  identity: null,
  deepPath: 'homepage → sign-in → /admin → Editor → Database → Tables → Actions → History',
  status: 'in-progress',
  blocked: [],
  states,
};

function finish(status, extra = {}) {
  manifest.status = status;
  manifest.finishedAt = new Date().toISOString();
  manifest.elapsedMs = Date.now() - startedAt;
  Object.assign(manifest, extra);
  writeFileSync(resolve(RUN_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  updateLedger({
    runId: RUN_ID,
    status,
    provider: manifest.provider,
    coverage: manifest.providerCoverage,
    statesVisited: states.length,
    blockedStates: extra.blockedStates || {},
    finishedAt: manifest.finishedAt,
  });
  console.warn(
    `\n∎ ${status} — provider=${manifest.provider} coverage=${manifest.providerCoverage} states=${states.length}\n  manifest: ${resolve(RUN_DIR, 'manifest.json')}`,
  );
}

const acq = await acquireBrowser();
manifest.provider = acq.provider;
manifest.providerCoverage = acq.coverage;
manifest.sessionId = acq.sessionId || null;
manifest.providerEndpoint = acq.endpoint || null;
manifest.providerAttempts = acq.attempts || [];

if (!acq.browser) {
  manifest.blocked.push({
    phase: 'browser-acquisition',
    reason: 'no provider available',
    attempts: acq.attempts,
    prerequisite:
      'CLOUDFLARE_API_TOKEN with "Browser Rendering - Edit" permission (get-secret CLOUDFLARE_API_TOKEN)',
  });
  finish('BLOCKED');
  process.exit(2);
}
console.warn(`▶ provider=${acq.provider} (${acq.coverage}) session=${acq.sessionId}`);

if (!E2E_TEST_PASSWORD) {
  manifest.blocked.push({
    phase: 'auth',
    reason: 'E2E_TEST_PASSWORD unavailable — real test-login seam unreachable',
    prerequisite: 'get-secret E2E_TEST_PASSWORD (worker secret must also be provisioned on prod)',
  });
  await acq.browser.close().catch(() => {});
  finish('BLOCKED');
  process.exit(2);
}

const ctx = await (acq.browser.contexts?.()[0]
  ? Promise.resolve(acq.browser.contexts()[0])
  : acq.browser.newContext({ viewport: VIEWPORT }));
const page = ctx.pages?.()[0] || (await ctx.newPage());
await page.setViewportSize(VIEWPORT).catch(() => {});
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
});
page.on('requestfailed', (r) => {
  failedRequests.push(`${r.method()} ${r.url().slice(0, 160)} :: ${r.failure()?.errorText || ''}`);
});
page.on('response', (r) => {
  if (r.status() >= 400 && !/get-session|posthog|browser-intake/.test(r.url())) {
    failedRequests.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 160)}`);
  }
});

try {
  // ---- Phase 1: public homepage --------------------------------------------
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await capture(page, 'homepage loads (initial state)', { surface: 'public-home' });

  // ---- Journey: create-funnel (public, read-only, stops before any submit) --
  if ((process.env.EXPLORER_JOURNEY || '') === 'create-funnel') {
    const search = page.getByTestId('hero-search-input');
    await search.click();
    await search.fill('Vito');
    await page.waitForTimeout(700); // debounce + results settle
    await capture(page, 'hero search "Vito" → results state', {
      surface: 'public-home',
      overlay: 'search-results',
    });
    await search.fill('Vito Mens Salon Lake Hiawatha');
    await page.waitForTimeout(900);
    await capture(page, 'full business query → suggestion list', {
      surface: 'public-home',
      overlay: 'search-results-full',
    });
    await page.keyboard.press('Escape');
    // Enter the create wizard via its public CTA (renders form states; no mutation).
    const cta = await clickFirst(page, [
      (p) => p.getByRole('link', { name: /get started|create|build/i }),
      (p) => p.getByRole('button', { name: /get started|create your|build/i }),
    ]);
    await page.waitForTimeout(1200);
    await capture(page, cta ? 'create wizard entry state' : 'create CTA NOT FOUND', {
      surface: 'create-wizard',
      overlay: cta ? '' : 'missing-cta',
    });
    if (cta) {
      // Walk visible wizard fields WITHOUT submitting: focus/blur the first
      // required field to exercise the WCAG 3.3.1 error-on-blur behavior.
      const firstField = page.locator('input:visible').first();
      if (await firstField.isVisible().catch(() => false)) {
        await firstField.click();
        await page.keyboard.press('Tab');
        await capture(page, 'required-field blur-empty → inline error state', {
          surface: 'create-wizard',
          overlay: 'blur-validation',
        });
      }
    }
    finish(
      manifest.blocked.length === 0
        ? acq.coverage === 'CLOUD_PASS_ELIGIBLE'
          ? 'PASS_CLOUDFLARE'
          : 'PASS_ON_FALLBACK_PROVIDER'
        : 'PARTIAL',
    );
    await acq.browser.close().catch(() => {});
    process.exit(manifest.status.startsWith('PASS') ? 0 : 2);
  }

  // ---- Phase 2: real test-approved sign-in --------------------------------
  await clickFirst(page, [
    (p) => p.getByRole('button', { name: /sign in/i }),
    (p) => p.getByRole('link', { name: /sign in/i }),
  ]);
  await page.waitForURL(/\/signin/, { timeout: 15_000 }).catch(() => {});
  await capture(page, 'click Sign In (header) → /signin', { surface: 'signin' });

  // The documented test-approved seam renders only with ?test=1 (secret-gated
  // POST /api/auth/test-login behind it). This URL entry is part of the seam.
  await page.goto(ORIGIN + '/signin?test=1', { waitUntil: 'domcontentloaded' });
  const panelVisible = await page
    .getByTestId('test-signin-panel')
    .isVisible({ timeout: 10_000 })
    .catch(() => false);
  await capture(page, 'enter test seam (/signin?test=1) — panel render', {
    surface: 'signin-test-seam',
  });
  if (!panelVisible) {
    manifest.blocked.push({
      phase: 'auth',
      reason: 'test-signin panel absent on served signin (seam dark or frontend drift)',
      prerequisite: 'E2E_TEST_PASSWORD provisioned as prod Worker secret + test panel in served bundle',
    });
    throw new Error('BLOCKED:auth-panel');
  }

  await page.getByTestId('test-signin-password').fill(E2E_TEST_PASSWORD);
  await page.getByTestId('test-signin-submit').click();
  await page.waitForURL(/\/admin/, { timeout: 30_000 });
  await capture(page, 'test login submit → lands /admin', { surface: 'admin-dashboard' });

  // Identity + role oracle — the session must resolve to the expected account.
  const me = await page.evaluate(async () => {
    const raw = localStorage.getItem('ps_session');
    let token = null;
    try {
      token = raw ? JSON.parse(raw).token : null;
    } catch {
      token = null;
    }
    const res = await fetch('/api/auth/me', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await res.json().catch(() => ({}));
    const d = body?.data || {};
    return {
      status: res.status,
      email: d.email || null,
      orgId: d.org_id || null,
      isSuperAdmin: !!d.is_super_admin,
      orgName: d.org_name || null,
    };
  });
  manifest.identity = { ...me, expectedEmail: TEST_LOGIN_EMAIL };
  if (me.status !== 200 || me.email !== TEST_LOGIN_EMAIL || !me.orgId) {
    manifest.blocked.push({
      phase: 'auth-verify',
      reason: `identity mismatch (status=${me.status} email=${me.email})`,
      prerequisite: 'test-login seam must mint a session resolving to brian@megabyte.space',
    });
    throw new Error('BLOCKED:identity');
  }
  console.warn(`  ✓ identity: ${me.email} superAdmin=${me.isSuperAdmin} org=${me.orgId.slice(0, 8)}…`);

  // create-funnel runs PRE-AUTH (public money-path front door) — it branches
  // before the sign-in phases below via this early check.
  // ---- Journey switch (coverage-ledger rotation across fires) --------------
  // EXPLORER_JOURNEY=admin-breadth walks the Angular admin's nav sections
  // (no editor iframe — fast, wide); default database-history grinds the
  // deep editor path. Rotate per fire via the coverage ledger.
  const JOURNEY = process.env.EXPLORER_JOURNEY || 'database-history';
  if (JOURNEY === 'admin-breadth') {
    const SECTIONS = (
      process.env.EXPLORER_SECTIONS ||
      'Snapshots,Analytics,Forms,Apps,Hosting,Features,Social,Voice,Logs,Feature Flags,System Services,Settings,Super admin'
    ).split(',');
    for (const name of SECTIONS) {
      if (budgetExceeded()) {
        manifest.blocked.push({ phase: 'breadth', reason: `budget exhausted before "${name}"` });
        break;
      }
      const clicked = await clickFirst(page, [
        (p) => p.getByRole('link', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }),
        (p) => p.getByRole('link', { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }),
      ]);
      await capture(page, clicked ? `nav → ${name}` : `nav link "${name}" NOT FOUND`, {
        surface: `admin-${name.toLowerCase().replace(/\s+/g, '-')}`,
        overlay: clicked ? '' : 'missing-nav-link',
      });
      if (!clicked) {
        manifest.blocked.push({ phase: 'breadth', reason: `nav link "${name}" not found` });
      }
    }
    // Return-to-dashboard closes the tour; proves nav persistence both ways.
    await clickFirst(page, [(p) => p.getByRole('link', { name: /^Dashboard$/ })]);
    await capture(page, 'nav → Dashboard (tour closes)', { surface: 'admin-dashboard' });
    finish(
      manifest.blocked.length === 0
        ? acq.coverage === 'CLOUD_PASS_ELIGIBLE'
          ? 'PASS_CLOUDFLARE'
          : 'PASS_ON_FALLBACK_PROVIDER'
        : 'PARTIAL',
    );
    await acq.browser.close().catch(() => {});
    process.exit(manifest.status.startsWith('PASS') ? 0 : 2);
  }

  if (JOURNEY === 'resources-deep') {
    // Editor → Resources tab → every subview pill (discovered from the LIVE
    // tablist, not hardcoded) — doubles as the live probe that fire-54's
    // real-time contract holds: NO manual Refresh/Reconcile control anywhere.
    await clickFirst(page, [(p) => p.getByRole('link', { name: /^Editor$/ })]);
    await page.waitForURL(/\/admin\/editor/, { timeout: 15_000 }).catch(() => {});
    await capture(page, 'click Editor nav → /admin/editor (iframe mounts)', {
      surface: 'admin-editor-shell',
    });
    const frame = page.frameLocator('iframe[src*="editor."]');
    const resTab = [
      (f) => f.getByRole('tab', { name: /^Resources$/i }),
      (f) => f.getByRole('button', { name: /^Resources$/i }),
    ];
    const bootEnd = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < bootEnd && !ready) {
      for (const mk of resTab) {
        if (await mk(frame).first().isVisible().catch(() => false)) {
          ready = true;
          break;
        }
      }
      if (!ready) await page.waitForTimeout(5_000);
    }
    if (!ready) {
      manifest.blocked.push({ phase: 'editor-boot', reason: 'Resources tab never visible in 120s' });
      throw new Error('BLOCKED:editor-boot');
    }
    await clickFirst(frame, resTab, { timeout: 10_000 });
    await capture(page, 'open Resources tab', { surface: 'editor-resources', iframe: 'editor' });

    const refreshProbe = async () => {
      const n = await frame
        .getByRole('button', { name: /refresh|reconcile/i })
        .count()
        .catch(() => 0);
      const m = await frame
        .getByRole('menuitem', { name: /refresh|reconcile/i })
        .count()
        .catch(() => 0);
      if (n + m > 0) {
        manifest.blocked.push({
          phase: 'real-time-contract',
          reason: `manual Refresh/Reconcile control visible (${n + m}) at state ${stepNo}`,
        });
      }
    };
    await refreshProbe();

    // Discover the Resources subview pills from the panel's OWN tablist (the broad
    // selector matched every workbench tablist — sidebar tabs + Database subnav).
    const pillNames = await frame
      .locator('[role="tablist"][aria-label="Resource sections"] [role="tab"]')
      .allInnerTexts()
      .catch(() => []);
    const subviews = pillNames.map((t) => t.trim()).filter((t) => t && t.length < 30).slice(0, 8);
    console.warn(`  discovered subview pills: ${subviews.join(' · ') || '(none)'}`);
    for (const name of subviews) {
      if (budgetExceeded()) break;
      const ok = await clickFirst(frame, [
        (f) => f.getByRole('tab', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }),
      ]);
      await capture(page, ok ? `Resources › ${name} sub-view` : `Resources pill "${name}" not clickable`, {
        surface: 'editor-resources',
        subview: name.toLowerCase().replace(/\s+/g, '-'),
        iframe: 'editor',
      });
      await refreshProbe();
    }
    // Advanced console — the per-kind CF-resource tiles (fire-55 salvaged the
    // drill-ins for the 5 dark per_site_* surfaces; verify honest flag-dark states).
    // The Buckets subview hides the top chrome (its own header by design), so
    // return to the first subview before reaching for Advanced.
    if (subviews.length) {
      await clickFirst(frame, [
        (f) => f.getByRole('tab', { name: new RegExp(`^${subviews[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }),
      ]);
    }
    const advOpened = await clickFirst(frame, [
      (f) => f.getByTestId('resources-open-console'),
      (f) => f.getByRole('button', { name: /advanced/i }),
    ]);
    await capture(page, advOpened ? 'open Advanced console (ResourceOverview)' : 'Advanced button NOT FOUND', {
      surface: 'editor-resources',
      overlay: advOpened ? 'advanced-console' : 'missing-advanced',
      iframe: 'editor',
    });
    if (advOpened) {
      await refreshProbe();
      const tile = await clickFirst(frame, [
        (f) => f.getByRole('button', { name: /\bKV\b/i }),
        (f) => f.getByRole('button', { name: /key.?value/i }),
      ]);
      await capture(page, tile ? 'KV tile drill-in (expect honest not-enabled/empty state)' : 'KV tile not clickable', {
        surface: 'editor-resources',
        overlay: 'advanced-kv-detail',
        iframe: 'editor',
      });
      await refreshProbe();
      await page.keyboard.press('Escape');
    }
    finish(
      manifest.blocked.length === 0
        ? acq.coverage === 'CLOUD_PASS_ELIGIBLE'
          ? 'PASS_CLOUDFLARE'
          : 'PASS_ON_FALLBACK_PROVIDER'
        : 'PARTIAL',
    );
    await acq.browser.close().catch(() => {});
    process.exit(manifest.status.startsWith('PASS') ? 0 : 2);
  }

  // ---- Phase 3: /admin → Editor (persistent bolt.diy iframe) ---------------
  await clickFirst(page, [
    (p) => p.getByRole('link', { name: /^Editor$/ }),
    (p) => p.getByRole('link', { name: /editor/i }),
  ]);
  await page.waitForURL(/\/admin\/editor/, { timeout: 15_000 }).catch(() => {});
  await capture(page, 'click Editor nav → /admin/editor (iframe mounts)', {
    surface: 'admin-editor-shell',
  });

  const iframeEl = page.locator('iframe[src*="editor."]').first();
  await iframeEl.waitFor({ state: 'attached', timeout: 45_000 });
  const frame = page.frameLocator('iframe[src*="editor."]');

  // The workbench (top tabs incl. Database) renders once files/warm-up settle.
  const dbTabCandidates = [
    (f) => f.getByRole('tab', { name: /^Database$/i }),
    (f) => f.getByRole('button', { name: /^Database$/i }),
    (f) => f.getByText(/^Database$/),
  ];
  let dbTabReady = false;
  const bootDeadline = Date.now() + 120_000;
  while (Date.now() < bootDeadline && !dbTabReady) {
    for (const make of dbTabCandidates) {
      if (await make(frame).first().isVisible().catch(() => false)) {
        dbTabReady = true;
        break;
      }
    }
    if (!dbTabReady) await page.waitForTimeout(5_000);
  }
  await capture(page, dbTabReady ? 'editor workbench booted (Database tab visible)' : 'editor boot state after 120s wait', {
    surface: 'editor-workbench',
    iframe: 'editor',
  });
  if (!dbTabReady) {
    manifest.blocked.push({
      phase: 'editor-boot',
      reason: 'Database tab never became visible in the editor iframe within 120s',
      prerequisite: 'editor workbench needs site files (PS_FILES_READY) + per_site_data flag ON for this org',
    });
    throw new Error('BLOCKED:editor-boot');
  }

  // ---- Phase 4: Database → Tables → Actions → History ----------------------
  await clickFirst(frame, dbTabCandidates, { timeout: 10_000 });
  await capture(page, 'open Database tab', { surface: 'editor-database', iframe: 'editor' });

  const tablesBtn = frame.getByTestId('database-subnav-table');
  if (await tablesBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
    await tablesBtn.click();
  }
  await capture(page, 'Database › Tables sub-view', {
    surface: 'editor-database',
    overlay: '',
    subview: 'tables',
    iframe: 'editor',
  });

  const actionsOpened = await clickFirst(frame, [
    (f) => f.getByRole('button', { name: /^Actions$/i }),
    (f) => f.getByTestId('table-actions-menu'),
    (f) => f.getByRole('button', { name: /actions/i }),
  ]);
  await capture(page, actionsOpened ? 'open Tables › Actions menu' : 'Actions menu trigger NOT FOUND', {
    surface: 'editor-database',
    subview: 'tables',
    overlay: actionsOpened ? 'actions-menu' : 'missing-actions-menu',
    iframe: 'editor',
  });
  if (!actionsOpened) {
    manifest.blocked.push({
      phase: 'deep-path',
      reason: 'Tables Actions menu trigger not found — documented path may differ from real UI',
    });
    throw new Error('BLOCKED:actions-menu');
  }

  const historyClicked = await clickFirst(frame, [
    (f) => f.getByRole('menuitem', { name: /history/i }),
    (f) => f.getByText(/^History$/),
    (f) => f.getByRole('button', { name: /history/i }),
  ]);
  await capture(page, historyClicked ? 'choose History → Time-Travel overlay opens' : 'History item NOT FOUND in Actions menu', {
    surface: 'editor-database',
    subview: 'tables',
    overlay: historyClicked ? 'history-time-travel' : 'missing-history-item',
    iframe: 'editor',
  });
  if (!historyClicked) {
    manifest.blocked.push({
      phase: 'deep-path',
      reason: 'History item not present in Actions menu — documented path differs from real UI',
    });
    throw new Error('BLOCKED:history-item');
  }

  const overlay = frame.getByTestId('database-action-overlay');
  const overlayVisible = await overlay.isVisible({ timeout: 10_000 }).catch(() => false);
  if (overlayVisible) {
    await capture(page, 'History overlay content settled (bookmarks + restore controls)', {
      surface: 'editor-database',
      subview: 'tables',
      overlay: 'history-time-travel-settled',
      iframe: 'editor',
    });
    await page.keyboard.press('Escape');
    await capture(page, 'Escape closes History overlay → back to Tables', {
      surface: 'editor-database',
      subview: 'tables',
      iframe: 'editor',
    });
  } else {
    manifest.blocked.push({
      phase: 'deep-path',
      reason: 'database-action-overlay never became visible after choosing History',
    });
  }

  finish(
    manifest.blocked.length === 0
      ? acq.coverage === 'CLOUD_PASS_ELIGIBLE'
        ? 'PASS_CLOUDFLARE'
        : 'PASS_ON_FALLBACK_PROVIDER'
      : 'PARTIAL',
  );
} catch (err) {
  const msg = String(err?.message || err);
  if (!msg.startsWith('BLOCKED:')) {
    manifest.blocked.push({ phase: 'run', reason: msg.slice(0, 400) });
  }
  await capture(page, `terminal state (${msg.slice(0, 60)})`, { surface: 'terminal' }).catch(() => {});
  finish('BLOCKED');
} finally {
  await acq.browser.close().catch(() => {});
}
process.exit(manifest.status.startsWith('PASS') ? 0 : 2);
