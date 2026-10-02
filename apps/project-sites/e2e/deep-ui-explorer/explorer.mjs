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

/**
 * Resolve `playwright-core` from the first require-base that actually has it.
 * A worktree checkout often lacks `frontend/node_modules` (gotcha: a worktree needs
 * BOTH worker + frontend installs), so we walk candidate bases — this worktree's
 * frontend, then its worker, then the main checkout's frontend/worker — instead of
 * dying when run from an un-installed worktree. The chosen base is logged (names
 * only) so the manifest can show where the driver came from.
 */
function requirePlaywright() {
  const bases = [
    resolve(__dirname, '../../frontend/'), // this checkout's frontend install
    resolve(__dirname, '../../'), // this checkout's worker install
  ];
  // A worktree checkout usually has NO node_modules; fall back to the main checkout's
  // installed trees. Derive the main checkout by stripping any `.claude/worktrees/<id>/`
  // segment from this file's path, then probe its frontend + worker installs.
  const mainRoot = __dirname.replace(/\/\.claude\/worktrees\/[^/]+(?=\/)/, '');
  if (mainRoot !== __dirname) {
    const mainApp = mainRoot.replace(/\/e2e\/deep-ui-explorer$/, '');
    bases.push(resolve(mainApp, 'frontend/'), mainApp);
  }
  // Explicit override — point at any dir whose node_modules has playwright-core.
  if (process.env.PLAYWRIGHT_REQUIRE_BASE) bases.push(process.env.PLAYWRIGHT_REQUIRE_BASE);
  const errors = [];
  for (const base of bases) {
    try {
      const r = createRequire(base.endsWith('/') ? base : base + '/');
      const mod = r('playwright-core');
      return { chromium: mod.chromium, base };
    } catch (err) {
      errors.push(`${base}: ${String(err?.message || err).slice(0, 80)}`);
    }
  }
  throw new Error(
    `playwright-core unresolvable from any base — install it in a frontend/ or worker node_modules.\n  tried:\n   ${errors.join('\n   ')}`,
  );
}
const { chromium, base: PW_BASE } = requirePlaywright();

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
  // ALSO persist the lean manifest (no base64 — screenshots stay gitignored) into the
  // COMMITTED runs/ dir so each fire's evidence travels with the ledger. The manifest
  // carries no secrets (passwords are masked pre-capture; identity is email/org only).
  try {
    const committedRunDir = resolve(__dirname, 'runs', RUN_ID);
    mkdirSync(committedRunDir, { recursive: true });
    writeFileSync(resolve(committedRunDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  } catch {
    /* best-effort — never fail the run on the evidence copy */
  }
  updateLedger({
    runId: RUN_ID,
    journey: manifest.journey,
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
manifest.journey = process.env.EXPLORER_JOURNEY || 'database-history';
manifest.playwrightBase = PW_BASE.replace(/^.*\/(\.claude\/worktrees\/[^/]+|apps)\//, '…/$1/');

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
  // (no editor iframe — fast, wide); settings-api-tokens grinds the Settings ›
  // API Tokens tab (list + mint dialog opened-then-dismissed, zero mutation);
  // database-subtree grinds the UNEXPLORED Database siblings — the SQL console +
  // the KV manager subnav tabs, plus the Schema / AI-Seed / CSV-Import table-action
  // overlays (each opened-then-Escaped, zero submit/exec/seed/import, KV never
  // unlocked); editor-toolbar grinds the workbench TOOLBAR controls that had no live
  // coverage — the four view-mode toggles (sticky scope / minimap / inline-diff /
  // split, each asserted by its aria-pressed FLIP then restored) + the Code/Preview/
  // Database top-tab switch (asserted by aria-pressed becoming true + panel mount),
  // read-only; default database-history grinds the deep editor path (Tables →
  // Actions → History). Rotate per fire via the coverage ledger.
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

  if (JOURNEY === 'settings-api-tokens') {
    // Settings › API Tokens — authenticated, READ-ONLY BY CONSTRUCTION: walks
    // list state → the "New API Token" mint dialog (opened, captured, DISMISSED
    // — at-create-submit is NEVER clicked) → a token row's Revoke confirm (the
    // row's one detail surface; at-revoke-confirm is NEVER clicked) → back to
    // Settings root. Three honest list states handled: flag-dark gate notice /
    // empty launchpad / populated table.
    const navClicked = await clickFirst(page, [
      (p) => p.getByRole('link', { name: /^Settings$/ }),
      (p) => p.getByRole('link', { name: /settings/i }),
    ]);
    await page.waitForURL(/\/admin\/settings/, { timeout: 15_000 }).catch(() => {});
    await capture(page, navClicked ? 'nav → Settings (root, General tab)' : 'Settings nav link NOT FOUND', {
      surface: 'admin-settings',
      subview: 'general',
      overlay: navClicked ? '' : 'missing-nav-link',
    });
    if (!navClicked) {
      manifest.blocked.push({ phase: 'settings-api-tokens', reason: 'Settings nav link not found' });
      throw new Error('BLOCKED:settings-nav');
    }

    // API Tokens is a Settings TAB since 2026-08-12 (standalone /admin/api-tokens
    // 302s to /admin/settings#api-tokens) — enter it via the real tablist click.
    const tabClicked = await clickFirst(page, [
      (p) => p.getByRole('tab', { name: /^API Tokens$/i }),
    ]);
    await page
      .getByTestId('settings-api-tokens-panel')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});
    // Let the token fetch resolve: skeleton (api-tokens-skeleton) → table/empty/gate.
    await page
      .getByTestId('api-tokens-skeleton')
      .waitFor({ state: 'hidden', timeout: 15_000 })
      .catch(() => {});
    const flagDark = await page
      .getByTestId('api-tokens-flag-gate')
      .isVisible()
      .catch(() => false);
    const rowCount = await page.getByTestId('at-revoke-btn').count().catch(() => 0);
    await capture(
      page,
      tabClicked
        ? `Settings › API Tokens tab — list state (${flagDark ? 'flag-dark gate' : `${rowCount} token row(s)`})`
        : 'API Tokens tab NOT FOUND in Settings tablist',
      {
        surface: 'admin-settings',
        subview: 'api-tokens',
        overlay: tabClicked ? (flagDark ? 'flag-gate-notice' : '') : 'missing-tab',
      },
    );
    if (!tabClicked) {
      manifest.blocked.push({ phase: 'settings-api-tokens', reason: 'API Tokens tab not found in Settings tablist' });
      throw new Error('BLOCKED:api-tokens-tab');
    }

    if (flagDark) {
      // Honest dark state: public_api_v1 off for this org → create button is
      // (correctly) absent; nothing to open. Recorded, not fabricated around.
      manifest.blocked.push({
        phase: 'settings-api-tokens',
        reason: 'public_api_v1 flag dark for this org — gate notice shown, mint dialog unreachable (honest state)',
      });
    } else {
      // ---- Mint dialog: open → capture → DISMISS (Escape → DialogShell closes).
      const createOpened = await clickFirst(page, [
        (p) => p.getByTestId('at-create-open'),
        (p) => p.getByRole('button', { name: /create your first token/i }),
      ]);
      if (createOpened) {
        await page.getByTestId('at-name-input').waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
      }
      await capture(page, createOpened ? 'open New API Token dialog (name+scopes+expiry — NO mint)' : 'create-token trigger NOT FOUND', {
        surface: 'admin-settings',
        subview: 'api-tokens',
        overlay: createOpened ? 'create-token-dialog' : 'missing-create-trigger',
      });
      if (createOpened) {
        await page.keyboard.press('Escape'); // document-level DialogShell escape → closeCreateModal()
        const stillOpen = await page.getByTestId('at-name-input').isVisible().catch(() => false);
        if (stillOpen) {
          // Escape SHOULD close the one dialog primitive — a stuck dialog is a real defect.
          await clickFirst(page, [(p) => p.getByRole('button', { name: /^Cancel$/ })]);
          manifest.blocked.push({
            phase: 'settings-api-tokens',
            reason: 'Escape did not dismiss the New API Token dialog (DialogShell escape contract broken)',
          });
        }
        await capture(page, 'dismiss create dialog (Escape, no mint) → list intact', {
          surface: 'admin-settings',
          subview: 'api-tokens',
        });
      } else {
        manifest.blocked.push({
          phase: 'settings-api-tokens',
          reason: 'create-token trigger not found while flag is ON (frontend drift)',
        });
      }

      // ---- Row detail: Revoke's CONFIRM dialog is the row's action surface.
      // Open it read-only, capture, Escape — the destructive confirm is never touched.
      if (rowCount > 0) {
        const revokeOpened = await clickFirst(page, [(p) => p.getByTestId('at-revoke-btn')]);
        if (revokeOpened) {
          await capture(page, `token row → Revoke confirm dialog (read-only; ${rowCount} row(s) present)`, {
            surface: 'admin-settings',
            subview: 'api-tokens',
            overlay: 'revoke-confirm-dialog',
          });
          await page.keyboard.press('Escape');
          await capture(page, 'dismiss revoke confirm (Escape) → token intact', {
            surface: 'admin-settings',
            subview: 'api-tokens',
          });
        }
      } else {
        console.warn('  (0 token rows — revoke-confirm state skipped honestly)');
      }
    }

    // ---- Back to Settings root (General tab) — proves tab nav both ways.
    await clickFirst(page, [(p) => p.getByRole('tab', { name: /^General$/i })]);
    await capture(page, 'tab → General (back to Settings root)', {
      surface: 'admin-settings',
      subview: 'general',
    });

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

  if (JOURNEY === 'settings-depth') {
    // Settings — the SIBLING tabs with zero prior live coverage. Only `general`
    // (nav-visit only) and `api-tokens` (full journey) have ledger entries; the
    // live component (settings.component.ts TABS, verified from source) also
    // renders Team / AI Chat / MCP / AI Env Vars / Webhooks / Email / Domains —
    // seven unvisited states. Discover the tab set LIVE from the panel's OWN
    // tablist (aria-label="Settings sections" — never hardcode), visit every
    // tab EXCEPT api-tokens (already covered by its own journey), capture the
    // settled panel, and probe each for a primary create/add/connect action —
    // opened READ-ONLY (settle → capture → Escape), never submit/save/send/
    // delete/connect. Zero mutation by construction — a breadth drill, not CRUD.
    const navClicked = await clickFirst(page, [
      (p) => p.getByRole('link', { name: /^Settings$/ }),
      (p) => p.getByRole('link', { name: /settings/i }),
    ]);
    await page.waitForURL(/\/admin\/settings/, { timeout: 15_000 }).catch(() => {});
    await capture(page, navClicked ? 'nav → Settings (root, General tab)' : 'Settings nav link NOT FOUND', {
      surface: 'admin-settings',
      subview: 'general',
      overlay: navClicked ? '' : 'missing-nav-link',
    });
    if (!navClicked) {
      manifest.blocked.push({ phase: 'settings-depth', reason: 'Settings nav link not found' });
      throw new Error('BLOCKED:settings-nav');
    }

    // Discover the real tab set from the panel's OWN tablist — the labels drive
    // both the regex match AND the human-readable action string.
    const tabLabels = await page
      .locator('[role="tablist"][aria-label="Settings sections"] [role="tab"]')
      .allInnerTexts()
      .catch(() => []);
    const allTabs = tabLabels.map((t) => t.trim()).filter((t) => t && t.length < 30);
    console.warn(`  discovered Settings tabs: ${allTabs.join(' · ') || '(none)'}`);
    if (!allTabs.length) {
      manifest.blocked.push({
        phase: 'settings-depth',
        reason: 'Settings tablist (aria-label="Settings sections") empty/absent — panel drift',
      });
      throw new Error('BLOCKED:settings-tablist');
    }

    // Visit every tab except General (landing state) and API Tokens (owned by
    // the settings-api-tokens journey — avoid duplicate coverage).
    const unexplored = allTabs.filter((t) => !/^general$/i.test(t) && !/^api tokens$/i.test(t));
    for (const name of unexplored) {
      if (budgetExceeded()) {
        manifest.blocked.push({ phase: 'settings-depth', reason: `budget exhausted before "${name}"` });
        break;
      }
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const clicked = await clickFirst(page, [(p) => p.getByRole('tab', { name: new RegExp(`^${escaped}$`, 'i') })]);
      const subview = name.toLowerCase().replace(/\s+/g, '-');
      await capture(page, clicked ? `Settings › ${name} tab — settled panel` : `Settings tab "${name}" NOT FOUND`, {
        surface: 'admin-settings',
        subview,
        overlay: clicked ? '' : 'missing-tab',
      });
      if (!clicked) {
        manifest.blocked.push({ phase: 'settings-depth', reason: `Settings tab "${name}" not found in tablist` });
        continue;
      }

      // Probe for a primary "create/add/connect/invite" affordance and open it
      // READ-ONLY (capture the settled form/dialog), then Escape — never submit.
      // Covers Team's "Invite member", MCP's provider connect tiles, Webhooks'
      // "Add endpoint", Domains' "Connect domain" / "Search domains".
      const primaryTrigger = await clickFirst(
        page,
        [
          (p) =>
            p.getByRole('button', {
              name: /invite member|add endpoint|connect domain|search domains|add key|create|^add$|^connect$/i,
            }),
        ],
        { timeout: 5_000 },
      );
      if (primaryTrigger) {
        await page.waitForTimeout(400); // dialog/panel mount settle
        const dialogVisible = await page
          .getByRole('dialog')
          .isVisible({ timeout: 4_000 })
          .catch(() => false);
        await capture(page, `Settings › ${name} — primary action opened (read-only; no submit)`, {
          surface: 'admin-settings',
          subview,
          overlay: dialogVisible ? 'primary-action-dialog' : 'primary-action-inline',
        });
        await page.keyboard.press('Escape');
        const stillOpen = dialogVisible
          ? await page.getByRole('dialog').isVisible({ timeout: 2_000 }).catch(() => false)
          : false;
        if (stillOpen) {
          manifest.blocked.push({
            phase: 'settings-depth',
            reason: `Escape did not dismiss the "${name}" primary-action dialog`,
          });
        }
        await capture(page, `Settings › ${name} — dismiss primary action (Escape) → tab intact`, {
          surface: 'admin-settings',
          subview,
        });
      } else {
        console.warn(`  (Settings › ${name} — no primary-action trigger found; list/read-only tab)`);
      }
    }

    // ---- Back to General — proves tab nav returns cleanly after the full sweep.
    await clickFirst(page, [(p) => p.getByRole('tab', { name: /^General$/i })]);
    await capture(page, 'tab → General (settings-depth sweep complete)', {
      surface: 'admin-settings',
      subview: 'general',
    });

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

  if (JOURNEY === 'database-subtree') {
    // Editor → Database tab → the UNEXPLORED siblings: discover the subnav tabs LIVE
    // from the panel's OWN tablist (`aria-label="Database views"` — never hardcode
    // Tables/SQL/KV), capture each (the SQL console + the KV manager), THEN on the
    // Tables view open each table-action overlay (Schema / AI-Seed / CSV-Import) via
    // its card/menu trigger, capture the settled overlay, and Escape. This is
    // open-then-dismiss by construction: NO submit / exec / seed / import is ever
    // clicked, and the KV upsell is observed but NEVER unlocked (zero localStorage/
    // billing mutation). History is already covered by the default journey.
    await clickFirst(page, [
      (p) => p.getByRole('link', { name: /^Editor$/ }),
      (p) => p.getByRole('link', { name: /editor/i }),
    ]);
    await page.waitForURL(/\/admin\/editor/, { timeout: 15_000 }).catch(() => {});
    await capture(page, 'click Editor nav → /admin/editor (iframe mounts)', {
      surface: 'admin-editor-shell',
    });

    const frame = page.frameLocator('iframe[src*="editor."]');
    const dbTab = [
      (f) => f.getByRole('tab', { name: /^Database$/i }),
      (f) => f.getByRole('button', { name: /^Database$/i }),
      (f) => f.getByText(/^Database$/),
    ];
    // Reuse the ~120s workbench boot loop (WebContainer cold-boot) — the Database tab
    // only renders once site files + warm-up settle.
    const bootEnd = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < bootEnd && !ready) {
      for (const mk of dbTab) {
        if (await mk(frame).first().isVisible().catch(() => false)) {
          ready = true;
          break;
        }
      }
      if (!ready) await page.waitForTimeout(5_000);
    }
    if (!ready) {
      manifest.blocked.push({
        phase: 'editor-boot',
        reason: 'Database tab never visible in the editor iframe within 120s',
        prerequisite: 'editor workbench needs site files (PS_FILES_READY) + per_site_data flag ON for this org',
      });
      throw new Error('BLOCKED:editor-boot');
    }
    await clickFirst(frame, dbTab, { timeout: 10_000 });
    await capture(page, 'open Database tab', { surface: 'editor-database', iframe: 'editor' });

    // Discover the subnav tabs from the panel's OWN tablist (never hardcode) — the broad
    // workbench selector would also match the top editor tabs + the Resources subnav.
    const subnavNames = await frame
      .locator('[role="tablist"][aria-label="Database views"] [role="tab"]')
      .allInnerTexts()
      .catch(() => []);
    const subnav = subnavNames.map((t) => t.trim()).filter((t) => t && t.length < 30);
    console.warn(`  discovered Database subnav: ${subnav.join(' · ') || '(none)'}`);
    if (!subnav.length) {
      manifest.blocked.push({
        phase: 'database-subtree',
        reason: 'Database subnav tablist (aria-label="Database views") empty/absent — panel drift or flag-dark',
      });
      throw new Error('BLOCKED:database-subnav');
    }

    // Visit every subnav sibling that ISN'T Tables (Tables is the default + already
    // covered by the Actions/History journey) — the SQL console + the KV manager.
    for (const name of subnav) {
      if (budgetExceeded()) break;
      if (/^tables?$/i.test(name)) continue;
      const kind = name.toLowerCase().replace(/\s+/g, '-');
      const ok = await clickFirst(frame, [
        (f) => f.getByRole('tab', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }),
      ]);
      // KV renders an honest $10/mo locked-upsell (database-kv) until unlocked — we
      // RECORD that honest state and NEVER click database-kv-unlock (no mutation).
      const kvLocked = /kv/i.test(name)
        ? await frame.getByTestId('database-kv').isVisible({ timeout: 6_000 }).catch(() => false)
        : false;
      await capture(
        page,
        ok
          ? `Database › ${name} sub-view${kvLocked ? ' (honest $10/mo locked-upsell — not unlocked)' : ''}`
          : `Database subnav "${name}" not clickable`,
        {
          surface: 'editor-database',
          subview: kind,
          overlay: kvLocked ? 'kv-locked-upsell' : '',
          iframe: 'editor',
        },
      );
      if (!ok) {
        manifest.blocked.push({ phase: 'database-subtree', reason: `Database subnav "${name}" not clickable` });
      }
    }

    // Back to Tables for the action overlays (Schema / AI-Seed / Import).
    await clickFirst(frame, [(f) => f.getByTestId('database-subnav-table')], { timeout: 8_000 });
    // The SiteTablesPanel re-fetches on mount (skeleton → launchpad/grid). WAIT for a
    // real actionable surface — the empty launchpad OR the Actions button — before
    // reaching for any overlay trigger, so we never race the skeleton (the cause of a
    // prior "trigger unreachable" false-negative on a healthy, present launchpad).
    const tablesReady = await Promise.race([
      frame.getByTestId('sitedb-empty').waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'empty'),
      frame.getByTestId('sitedb-actions').waitFor({ state: 'visible', timeout: 20_000 }).then(() => 'grid'),
    ]).catch(() => null);
    console.warn(`  Tables surface ready: ${tablesReady || '(neither launchpad nor Actions appeared)'}`);
    await capture(page, `Database › Tables (${tablesReady === 'empty' ? 'empty launchpad' : tablesReady === 'grid' ? 'populated grid' : 'state unknown'}) — for action overlays`, {
      surface: 'editor-database',
      subview: 'tables',
      overlay: tablesReady === 'empty' ? 'empty-launchpad' : '',
      iframe: 'editor',
    });

    // Open each unexplored table-action surface, capture the SETTLED panel, then Escape.
    // IMPORTANT (verified from the live component): the Tables view routes AI-Seed +
    // CSV-Import to the parent's `database-action-overlay`, but "Create Table"
    // (launchpad tile + Actions › New Table) opens a SEPARATE LOCAL `sitedb-create-table`
    // modal — NOT the SchemaBuilder `database-action-overlay` (kind=schema). The parent's
    // `onCreateTable → setTableAction('schema')` prop is effectively orphaned from the
    // Tables UI. We therefore capture the surface that's ACTUALLY reachable for each
    // action and record the overlay-vs-local-modal reality honestly.
    const overlay = frame.getByTestId('database-action-overlay');
    const createModal = frame.getByTestId('sitedb-create-table');
    const openActionsMenu = async () =>
      clickFirst(frame, [(f) => f.getByTestId('sitedb-actions')], { timeout: 5_000 });

    const overlayTargets = [
      {
        kind: 'seed',
        label: 'AI-Seed',
        // Empty-launchpad tile prefers the parent AiSeedPanel overlay (richer flow, no seed call).
        triggers: [(f) => f.getByTestId('sitedb-empty-seed')],
        needsMenu: false,
        surface: overlay,
        overlayKey: 'action-seed-settled',
      },
      {
        kind: 'import',
        label: 'CSV/JSON Import',
        triggers: [
          (f) => f.getByTestId('sitedb-empty-import'),
          (f) => f.getByTestId('sitedb-action-import'),
        ],
        needsMenu: true,
        surface: overlay,
        overlayKey: 'action-import-settled',
      },
      {
        kind: 'schema',
        label: 'Create Table (local schema modal)',
        // The ACTUALLY-reachable schema surface — the local CreateTableModal, not the overlay.
        triggers: [
          (f) => f.getByTestId('sitedb-empty-newtable'),
          (f) => f.getByTestId('sitedb-action-new-table'),
        ],
        needsMenu: true,
        surface: createModal,
        overlayKey: 'create-table-modal-settled',
      },
    ];

    for (const t of overlayTargets) {
      if (budgetExceeded()) break;
      // Try the direct (launchpad) trigger first; if absent (populated grid), open the
      // Actions dropdown and try the menu item. clickFirst tolerates a missing locator.
      // Generous timeout — the frameLocator resolve through the cross-origin iframe is
      // slower than a same-page locator (racing it caused prior false "unreachable").
      let opened = await clickFirst(frame, t.triggers, { timeout: 8_000 });
      if (!opened && t.needsMenu) {
        await openActionsMenu();
        opened = await clickFirst(frame, t.triggers, { timeout: 8_000 });
      }
      const settled = opened
        ? await t.surface.isVisible({ timeout: 8_000 }).catch(() => false)
        : false;
      await capture(
        page,
        settled
          ? `Tables › ${t.label} settled (open-then-dismiss — no submit/seed/import)`
          : `Tables › ${t.label} trigger NOT reachable`,
        {
          surface: 'editor-database',
          subview: 'tables',
          overlay: settled ? t.overlayKey : `missing-action-${t.kind}`,
          iframe: 'editor',
        },
      );
      if (settled) {
        await page.keyboard.press('Escape'); // overlay + CreateTableModal both close on Escape → grid intact
        const stillOpen = await t.surface.isVisible({ timeout: 2_000 }).catch(() => false);
        if (stillOpen) {
          manifest.blocked.push({
            phase: 'database-subtree',
            reason: `Escape did not dismiss the ${t.kind} surface (escape contract broken)`,
          });
          await clickFirst(frame, [
            (f) => f.getByRole('button', { name: /^Close$/ }),
            (f) => f.getByRole('button', { name: /^Cancel$/ }),
          ]);
        }
        await capture(page, `dismiss ${t.label} (Escape) → Tables intact`, {
          surface: 'editor-database',
          subview: 'tables',
          iframe: 'editor',
        });
      } else {
        manifest.blocked.push({
          phase: 'database-subtree',
          reason: `${t.kind} surface never settled (trigger unreachable or did not open)`,
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

  if (JOURNEY === 'editor-toolbar') {
    // Editor WORKBENCH TOOLBAR — the controls with no prior live coverage:
    //   (a) the four view-mode TOGGLES in the file breadcrumb bar (sticky scope /
    //       minimap / inline-diff / split-pane), each a <button aria-pressed> with NO
    //       data-testid — selected by aria-label;
    //   (b) the top-tab view switch (Code / Preview / Database / Resources — each a
    //       <button aria-pressed> selected by its visible text);
    //   (c) the "Data tab button" = the DATABASE top tab (verified from the live
    //       source: TOP_TABS is Code|Preview|Database|Resources; there is NO separate
    //       "Data" tab and NO separate "Diff" tab — `selectedView==='data'` is a legacy
    //       alias co-rendered with 'database', and "Diff" is the inline-diff TOGGLE, not
    //       a tab). We record that reality honestly rather than hunt a tab that isn't there.
    // For EACH control we assert its DOM EFFECT: a toggle must FLIP aria-pressed
    // false↔true (its observable effect); a tab must become aria-pressed=true AND its
    // panel mount. READ-ONLY: toggles are returned to their original state; zero mutation.
    // The four toggles only render once a FILE is open, so we open one from the tree first.
    await clickFirst(page, [
      (p) => p.getByRole('link', { name: /^Editor$/ }),
      (p) => p.getByRole('link', { name: /editor/i }),
    ]);
    await page.waitForURL(/\/admin\/editor/, { timeout: 15_000 }).catch(() => {});
    await capture(page, 'click Editor nav → /admin/editor (iframe mounts)', {
      surface: 'admin-editor-shell',
    });

    const iframeEl = page.locator('iframe[src*="editor."]').first();
    await iframeEl.waitFor({ state: 'attached', timeout: 45_000 }).catch(() => {});
    const frame = page.frameLocator('iframe[src*="editor."]');

    // Boot wait: the top-tab strip (Code tab) renders once the workbench settles.
    const codeTab = (f) => f.getByRole('button', { name: /^Code$/ });
    const bootEnd = Date.now() + 120_000;
    let booted = false;
    while (Date.now() < bootEnd && !booted) {
      if (await codeTab(frame).first().isVisible().catch(() => false)) {
        booted = true;
        break;
      }
      await page.waitForTimeout(5_000);
    }
    await capture(page, booted ? 'editor workbench booted (Code tab visible)' : 'editor boot state after 120s', {
      surface: 'editor-workbench',
      iframe: 'editor',
    });
    if (!booted) {
      manifest.blocked.push({
        phase: 'editor-boot',
        reason: 'top-tab strip (Code) never visible in the editor iframe within 120s — WebContainer cold-boot or auth embed did not settle headlessly',
        prerequisite: 'editor iframe needs COOP/COEP cross-origin isolation + site files (PS_FILES_READY) to boot the workbench',
      });
      throw new Error('BLOCKED:editor-boot');
    }

    // ---- (b)+(c) Top-tab view switch: Code → Preview → Database → back to Code.
    // Each assertion is the tab's DOM effect: aria-pressed flips to true on click.
    const TOP_TABS = ['Preview', 'Database', 'Code'];
    for (const name of TOP_TABS) {
      if (budgetExceeded()) break;
      const tabBtn = frame.getByRole('button', { name: new RegExp(`^${name}$`) }).first();
      const clicked = await clickFirst(frame, [
        (f) => f.getByRole('button', { name: new RegExp(`^${name}$`) }),
      ]);
      const pressed = clicked
        ? await tabBtn.getAttribute('aria-pressed').catch(() => null)
        : null;
      const effectSeen = pressed === 'true';
      await capture(
        page,
        clicked
          ? `top-tab → ${name} (aria-pressed=${pressed}${effectSeen ? ' ✓ effect-seen' : ''})`
          : `top-tab "${name}" NOT FOUND`,
        {
          surface: 'editor-workbench',
          subview: `tab-${name.toLowerCase()}`,
          overlay: clicked ? (effectSeen ? '' : 'tab-no-aria-pressed') : 'missing-tab',
          iframe: 'editor',
        },
      );
      if (!clicked) {
        manifest.blocked.push({ phase: 'editor-toolbar', reason: `top-tab "${name}" not found` });
      } else if (!effectSeen) {
        manifest.blocked.push({
          phase: 'editor-toolbar',
          reason: `top-tab "${name}" clicked but aria-pressed did not become true (effect unverified)`,
        });
      }
    }

    // ---- (a) The four view-mode toggles live in the file breadcrumb bar, which only
    // renders when a FILE is open. We're on the Code tab now; open the first file from
    // the tree. The file tree rows are buttons/links with the filename as text.
    let fileOpened = false;
    // A FileTree row is a <button> whose label is a path segment; the first leaf file
    // opens the editor. Try a few common entry files, else the first tree button.
    const fileCandidates = [
      (f) => f.getByRole('button', { name: /package\.json/i }),
      (f) => f.getByRole('button', { name: /index\.(html|tsx?|jsx?)/i }),
      (f) => f.getByRole('button', { name: /README/i }),
    ];
    fileOpened = await clickFirst(frame, fileCandidates, { timeout: 6_000 });
    if (!fileOpened) {
      // Fallback: click the first file-looking tree node (has a dot in its label).
      const anyFile = frame.getByRole('button', { name: /\.[a-z0-9]{2,4}$/i }).first();
      if (await anyFile.isVisible({ timeout: 6_000 }).catch(() => false)) {
        await anyFile.click().catch(() => {});
        fileOpened = true;
      }
    }
    await capture(page, fileOpened ? 'open a file from the tree (breadcrumb toolbar renders)' : 'no file opened (toolbar toggles unreachable)', {
      surface: 'editor-workbench',
      subview: 'code',
      overlay: fileOpened ? '' : 'no-file-open',
      iframe: 'editor',
    });

    if (!fileOpened) {
      manifest.blocked.push({
        phase: 'editor-toolbar',
        reason: 'no file could be opened from the FileTree — the 4 view-mode toggles only render with an active file, so they are unreachable this run (honest BLOCKED, not failed)',
      });
    } else {
      // The four toggles, each identified by aria-label (NO data-testid in source).
      const TOGGLES = [
        { label: 'Toggle sticky function/class header', key: 'sticky-scope' },
        { label: 'Toggle scroll-position minimap', key: 'minimap' },
        { label: 'Toggle inline diff against AI original', key: 'inline-diff' },
        { label: 'Toggle split-pane (side-by-side editor)', key: 'split-pane' },
      ];
      for (const t of TOGGLES) {
        if (budgetExceeded()) break;
        const btn = frame.getByRole('button', { name: t.label }).first();
        const present = await btn.isVisible({ timeout: 6_000 }).catch(() => false);
        if (!present) {
          await capture(page, `toggle "${t.key}" NOT FOUND in breadcrumb toolbar`, {
            surface: 'editor-workbench',
            subview: 'code',
            overlay: `missing-toggle-${t.key}`,
            iframe: 'editor',
          });
          manifest.blocked.push({ phase: 'editor-toolbar', reason: `view toggle "${t.key}" (${t.label}) not found` });
          continue;
        }
        const before = await btn.getAttribute('aria-pressed').catch(() => null);
        await btn.click().catch(() => {});
        await page.waitForTimeout(250);
        const after = await btn.getAttribute('aria-pressed').catch(() => null);
        const flipped = before != null && after != null && before !== after;
        await capture(
          page,
          `toggle ${t.key}: aria-pressed ${before}→${after}${flipped ? ' ✓ effect-seen' : ' (NO flip)'}`,
          {
            surface: 'editor-workbench',
            subview: 'code',
            overlay: flipped ? `toggle-${t.key}-on` : `toggle-${t.key}-no-effect`,
            iframe: 'editor',
          },
        );
        // Return to the original state (read-only discipline) + confirm it flips back.
        await btn.click().catch(() => {});
        await page.waitForTimeout(200);
        const restored = await btn.getAttribute('aria-pressed').catch(() => null);
        if (!flipped) {
          manifest.blocked.push({
            phase: 'editor-toolbar',
            reason: `view toggle "${t.key}" clicked but aria-pressed did not flip (${before}→${after}) — effect unverified`,
          });
        } else if (restored !== before) {
          manifest.blocked.push({
            phase: 'editor-toolbar',
            reason: `view toggle "${t.key}" did not restore to its original state (${before}→${after}→${restored})`,
          });
        }
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

  if (JOURNEY === 'money-funnel') {
    // THE MONEY-PATH DESTINATION (authed half) — the surfaces a paying owner lands on
    // right after sign-in, which recent fires (editor Data-tab) never explored as states.
    // The PUBLIC half (homepage → hero search → create wizard) is owned by the
    // `create-funnel` journey; this one grinds the authed funnel floor:
    //   admin dashboard landing (cockpit: attention queue + search) →
    //   Sites list (honest skeleton→empty-launchpad OR populated grid) →
    //   the Sites list's OWN search filter (typed → no-match state → cleared) →
    //   a single site card → its detail route → back to the Sites list.
    // READ-ONLY by construction: the only mutations attempted are a search-box type
    // (then cleared) and NAVIGATION clicks — no create/delete/publish/claim is touched.
    // We are already authenticated + on /admin here (the sign-in seam ran above), so the
    // dashboard landing is the first captured state of this journey.
    await capture(page, 'admin dashboard landing (money-path destination — post-signin cockpit)', {
      surface: 'admin-dashboard',
      subview: 'landing',
    });

    // The dashboard's own search box is a key affordance (busy owner finds a site fast).
    // Type a no-match query → assert the honest no-match panel → clear. Zero mutation.
    const dashSearch = page.getByTestId('dash-search');
    if (await dashSearch.isVisible({ timeout: 6_000 }).catch(() => false)) {
      await dashSearch.click();
      await dashSearch.fill('zzz-no-such-site-zzz');
      await page.waitForTimeout(400);
      const dashNoMatch = await page.getByTestId('dash-no-match').isVisible().catch(() => false);
      await capture(page, `dashboard search → ${dashNoMatch ? 'honest no-match panel' : 'filtered state'}`, {
        surface: 'admin-dashboard',
        subview: 'landing',
        overlay: dashNoMatch ? 'dash-no-match' : 'dash-filtered',
      });
      // Clear via the dedicated clear control (keeps the surface at its true resting state).
      await clickFirst(page, [(p) => p.getByTestId('dash-no-match-clear'), (p) => p.getByTestId('dash-search-clear')]);
      await capture(page, 'clear dashboard search → cockpit intact', {
        surface: 'admin-dashboard',
        subview: 'landing',
      });
    } else {
      console.warn('  (dashboard search box not present — skipping dash-search state honestly)');
    }

    // ---- Sites list — the owner's portfolio at /admin/sites. FIRST probe the way a
    // real user would reach it: a sidebar "Sites" nav link. The admin sidebar nav
    // (admin-nav.model.ts) has Dashboard/Editor/Snapshots/…/Settings but NO "Sites"
    // item, and the sidebar site-PICKER's selectSite() only sets state (no navigation),
    // and the command palette's "Sites" section only offers "Switch to <site>" — so the
    // routed /admin/sites LIST view may be a UI-unreachable orphan. We RECORD that as a
    // finding (not a BLOCKED), then reach the list directly to still exercise its states.
    const sitesNav = await clickFirst(
      page,
      [
        (p) => p.getByRole('link', { name: /^Sites$/ }),
        (p) => p.getByRole('navigation', { name: /admin sections/i }).getByRole('link', { name: /sites/i }),
      ],
      { timeout: 4_000 },
    );
    if (!sitesNav) {
      // CONFIRMED interconnectedness gap: no nav affordance reaches the Sites LIST.
      manifest.blocked.push({
        phase: 'money-funnel',
        reason:
          'NO sidebar "Sites" nav link reaches the /admin/sites LIST — admin-nav.model.ts has no Sites item; the sidebar site-picker selectSite() only sets state (no navigate); the command palette only "Switch to <site>". The routed Sites-list view is a UI-unreachable orphan (interconnectedness + embarrassingly-easy gap). Owner: frontend navigation (admin-nav.model.ts / admin.component).',
      });
      // Reach it directly so we still capture + reconcile its real states this fire.
      await page.goto(ORIGIN + '/admin/sites', { waitUntil: 'domcontentloaded' });
    }
    await page.waitForURL(/\/admin\/sites/, { timeout: 15_000 }).catch(() => {});
    // Let the fetch settle: skeleton → empty launchpad OR populated grid.
    await page.getByTestId('sites-skeleton').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
    const sitesEmpty = await page.getByTestId('sites-empty').isVisible().catch(() => false);
    const cardCount = await page.locator('a.site-card').count().catch(() => 0);
    await capture(
      page,
      `Sites list (${sitesNav ? 'via nav link' : 'direct URL — no nav path'}) — ${sitesEmpty ? 'empty launchpad (first-site CTA)' : `populated grid (${cardCount} site card(s))`}`,
      {
        surface: 'admin-sites',
        subview: 'list',
        overlay: sitesEmpty ? 'empty-launchpad' : sitesNav ? '' : 'reached-by-direct-url',
      },
    );

    if (sitesEmpty) {
      // Honest empty state: 0 sites for this org. The empty-CTA is the one obvious next
      // step (per embarrassingly-easy launchpad doctrine); we OBSERVE it, never click it.
      const emptyCta = await page.getByTestId('sites-empty-cta').isVisible().catch(() => false);
      if (!emptyCta) {
        manifest.blocked.push({
          phase: 'money-funnel',
          reason: 'Sites list empty for this org but NO empty-state launchpad CTA present (empty-state-is-launchpad gap)',
        });
      }
    } else if (cardCount > 0) {
      // ---- Sites list's OWN search filter (distinct from dashboard search).
      const sitesSearch = page.getByTestId('sites-search');
      if (await sitesSearch.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await sitesSearch.click();
        await sitesSearch.fill('zzz-no-such-site-zzz');
        await page.waitForTimeout(400);
        const noMatch = await page.getByTestId('sites-no-match').isVisible().catch(() => false);
        await capture(page, `Sites list search → ${noMatch ? 'honest no-match panel' : 'filtered'}`, {
          surface: 'admin-sites',
          subview: 'list',
          overlay: noMatch ? 'sites-no-match' : 'sites-filtered',
        });
        await clickFirst(page, [(p) => p.getByTestId('sites-search-clear')]);
        await sitesSearch.fill('');
        await page.waitForTimeout(300);
        await capture(page, 'clear Sites search → full grid restored', {
          surface: 'admin-sites',
          subview: 'list',
        });
      }

      // ---- Open ONE site card → its detail route. Pure navigation; read-only.
      const firstCard = page.locator('a.site-card').first();
      const cardName = await firstCard.getAttribute('data-testid').catch(() => null);
      await firstCard.click().catch(() => {});
      await page.waitForURL(/\/admin\/sites\/[^/]+/, { timeout: 15_000 }).catch(() => {});
      const detailH1 = await page.locator('h1').first().innerText().catch(() => '');
      await capture(page, `open site card (${cardName || 'first'}) → site detail route`, {
        surface: 'admin-site-detail',
        subview: 'overview',
        overlay: detailH1 ? '' : 'detail-no-h1',
      });
      if (!detailH1.trim()) {
        manifest.blocked.push({
          phase: 'money-funnel',
          reason: 'site detail route rendered with no <h1> (WCAG 2.4.2 / landing-heading gap)',
        });
      }

      // ---- Back to the dashboard — proves the detail→cockpit round-trip is clean
      // (Dashboard IS a real nav link; Sites list is not, so return to the cockpit).
      await clickFirst(page, [(p) => p.getByRole('link', { name: /^Dashboard$/ })]);
      await page.waitForURL(/\/admin(\?|\/?$)/, { timeout: 15_000 }).catch(() => {});
      await capture(page, 'back to Dashboard (site-detail → cockpit round-trip intact)', {
        surface: 'admin-dashboard',
        subview: 'landing',
      });
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
