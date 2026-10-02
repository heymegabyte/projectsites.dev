// Deep UI Explorer — Analytics walk (fire-72, standalone, READ-ONLY on product code).
// Reuses the proven CF Browser Run CDP connect + /signin?test=1 seam + masked-capture
// pattern from explorer.mjs INLINE (imports no product code). Walks /admin/analytics:
// default range → 7d/30d/90d/24h pills → glossary → page/country drilldown → clear.
// Emits the selected site_id + displayed pageviews so a D1 reconcile can run against it.
//
//   node e2e/deep-ui-explorer/analytics-walk.mjs
//
// Provider ladder: CF Browser Run (CLOUD_PASS) → local chromium (FALLBACK, labeled).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

function requirePlaywright() {
  const bases = [resolve(__dirname, '../../frontend/'), resolve(__dirname, '../../')];
  const errors = [];
  for (const base of bases) {
    try {
      return createRequire(base + '/')('playwright-core').chromium;
    } catch (err) {
      errors.push(`${base}: ${String(err?.message || err).slice(0, 60)}`);
    }
  }
  throw new Error(`playwright-core unresolvable:\n ${errors.join('\n ')}`);
}
const chromium = requirePlaywright();

function getSecret(name) {
  if (process.env[name]) return process.env[name];
  try {
    return execFileSync('/Users/Apple/.local/bin/get-secret', [name], {
      encoding: 'utf8',
    }).trim() || null;
  } catch {
    return null;
  }
}

const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const CF_ACCOUNT_ID = '84fa0d1b16ff8086dd958c468ce7fd59';
const CF_TOKEN = getSecret('CF_BROWSER_RUN_TOKEN') || getSecret('CLOUDFLARE_API_TOKEN');
const E2E_TEST_PASSWORD = getSecret('E2E_TEST_PASSWORD');
const VIEWPORT = { width: 1440, height: 900 };
const RUN_ID = `an-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const RUN_DIR = resolve(__dirname, 'runs', RUN_ID);
mkdirSync(RUN_DIR, { recursive: true });

const states = [];
const consoleErrors = [];
const failedRequests = [];
let stepNo = 0;

async function acquireBrowser() {
  if (CF_TOKEN) {
    try {
      const ws = `wss://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/browser-run/devtools/browser?keep_alive=600000`;
      const browser = await chromium.connectOverCDP(ws, {
        headers: { Authorization: `Bearer ${CF_TOKEN}` },
        timeout: 30_000,
      });
      return { browser, provider: 'cloudflare-browser-run', coverage: 'CLOUD_PASS', sessionId: `cf-browser-run:${CF_ACCOUNT_ID.slice(0, 8)}…:${RUN_ID}` };
    } catch (err) {
      console.warn(`  cf-connect failed: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  const browser = await chromium.launch();
  return { browser, provider: 'local-chromium', coverage: 'FALLBACK', sessionId: `local:${process.pid}` };
}

async function capture(page, action, coords = {}) {
  stepNo += 1;
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
  await page
    .waitForFunction(() => !/\bLoading\b[^\n]{0,40}(…|\.\.\.)/.test(document.body?.innerText || ''), { timeout: 8_000 })
    .catch(() => {});
  await page.waitForTimeout(400);
  const n = String(stepNo).padStart(2, '0');
  const slug = action.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const file = `${n}-${slug}.png`;
  await page
    .screenshot({ path: resolve(RUN_DIR, file), mask: [page.locator('input[type="password"]')], maskColor: '#00E5FF' })
    .catch(() => page.screenshot({ path: resolve(RUN_DIR, file) }).catch(() => {}));
  const visibleText = await page
    .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 900))
    .catch(() => '');
  states.push({
    id: stepNo,
    action,
    url: page.url(),
    coords,
    screenshot: file,
    visibleText,
    consoleErrors: consoleErrors.splice(0),
    failedRequests: failedRequests.splice(0),
    ts: new Date().toISOString(),
  });
  console.warn(`  [${n}] ${action}`);
}

const manifest = { runId: RUN_ID, origin: ORIGIN, journey: 'admin-analytics', startedAt: new Date().toISOString(), provider: null, coverage: null, sessionId: null, identity: null, selectedSiteId: null, displayPageviews: null, reconcile: null, status: 'in-progress', blocked: [], states };
function finish(status, extra = {}) {
  manifest.status = status;
  manifest.finishedAt = new Date().toISOString();
  Object.assign(manifest, extra);
  writeFileSync(resolve(RUN_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.warn(`\n∎ ${status} — provider=${manifest.provider} coverage=${manifest.coverage} states=${states.length}\n  manifest: ${resolve(RUN_DIR, 'manifest.json')}`);
}

const acq = await acquireBrowser();
manifest.provider = acq.provider;
manifest.coverage = acq.coverage;
manifest.sessionId = acq.sessionId;
if (!acq.browser) {
  manifest.blocked.push({ phase: 'browser', prerequisite: 'CF_BROWSER_RUN_TOKEN (Browser Run Write)' });
  finish('BLOCKED');
  process.exit(2);
}
console.warn(`▶ provider=${acq.provider} (${acq.coverage}) session=${acq.sessionId}`);
if (!E2E_TEST_PASSWORD) {
  manifest.blocked.push({ phase: 'auth', prerequisite: 'get-secret E2E_TEST_PASSWORD' });
  await acq.browser.close().catch(() => {});
  finish('BLOCKED');
  process.exit(2);
}

const ctx = acq.browser.contexts?.()[0] || (await acq.browser.newContext({ viewport: VIEWPORT }));
const page = ctx.pages?.()[0] || (await ctx.newPage());
await page.setViewportSize(VIEWPORT).catch(() => {});
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)));
page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url().slice(0, 140)} :: ${r.failure()?.errorText || ''}`));
page.on('response', (r) => {
  if (r.status() >= 400 && !/get-session|posthog|browser-intake|sentry/.test(r.url())) {
    failedRequests.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 140)}`);
  }
});

async function clickFirst(candidates, { timeout = 7000 } = {}) {
  for (const make of candidates) {
    try {
      const loc = make().first();
      await loc.waitFor({ state: 'visible', timeout });
      await loc.click();
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

try {
  // Phase 1: public homepage
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await capture(page, 'homepage loads', { surface: 'public-home' });

  // Phase 2: test-approved sign-in seam (password MASKED pre-capture)
  await page.goto(ORIGIN + '/signin?test=1', { waitUntil: 'domcontentloaded' });
  const panelVisible = await page.getByTestId('test-signin-panel').isVisible({ timeout: 10_000 }).catch(() => false);
  await capture(page, 'test seam /signin?test=1', { surface: 'signin-test-seam' });
  if (!panelVisible) {
    manifest.blocked.push({ phase: 'auth', reason: 'test-signin panel absent', prerequisite: 'E2E_TEST_PASSWORD prod worker secret + test panel in bundle' });
    throw new Error('BLOCKED:auth-panel');
  }
  await page.getByTestId('test-signin-password').fill(E2E_TEST_PASSWORD);
  await page.getByTestId('test-signin-submit').click();
  await page.waitForURL(/\/admin/, { timeout: 30_000 });
  await capture(page, 'test login → /admin', { surface: 'admin-dashboard' });

  // Identity oracle — must be the e2e TEST org
  const me = await page.evaluate(async () => {
    let token = null;
    try {
      token = JSON.parse(localStorage.getItem('ps_session') || '{}').token || null;
    } catch {
      /* none */
    }
    const res = await fetch('/api/auth/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const d = (await res.json().catch(() => ({})))?.data || {};
    return { status: res.status, email: d.email || null, orgId: d.org_id || null, isSuperAdmin: !!d.is_super_admin };
  });
  manifest.identity = me;
  if (me.status !== 200 || !me.orgId) {
    manifest.blocked.push({ phase: 'auth-verify', reason: `identity status=${me.status} org=${me.orgId}` });
    throw new Error('BLOCKED:identity');
  }
  console.warn(`  ✓ identity: ${me.email} superAdmin=${me.isSuperAdmin} org=${me.orgId}`);

  // Phase 3: click INTO /admin/analytics via UI
  const navClicked = await clickFirst([
    () => page.getByRole('link', { name: /^Analytics$/i }),
    () => page.getByRole('link', { name: /analytics/i }),
  ]);
  await page.waitForURL(/\/admin\/analytics/, { timeout: 15_000 }).catch(() => {});
  await capture(page, navClicked ? 'nav → Analytics (default range)' : 'Analytics nav NOT FOUND', { surface: 'admin-analytics', overlay: navClicked ? '' : 'missing-nav' });
  if (!navClicked) {
    manifest.blocked.push({ phase: 'analytics-nav', reason: 'Analytics nav link not found' });
  }

  // Read the selected site + displayed pageviews for the reconcile. selectedSite drives
  // GET /api/sites/:id/analytics (.traffic block from visitor_events pageviews).
  const scope = await page.evaluate(() => {
    const kpi = document.querySelector('[data-testid="kpi-pageviews"]');
    const txt = (kpi?.textContent || '').replace(/\s+/g, ' ').trim();
    const num = (txt.match(/[\d,.]+/) || [])[0] || null;
    return { kpiPageviewsText: txt || null, kpiPageviewsNum: num ? Number(num.replace(/,/g, '')) : null };
  });
  manifest.displayPageviews = scope;

  // Grab the selected site id via the authed API (sidebar selection → selectedSite()).
  const sel = await page.evaluate(async () => {
    let token = null;
    try {
      token = JSON.parse(localStorage.getItem('ps_session') || '{}').token || null;
    } catch {
      /* none */
    }
    const res = await fetch('/api/sites', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const body = await res.json().catch(() => ({}));
    const list = body?.data || body?.sites || [];
    return { count: Array.isArray(list) ? list.length : 0, first: Array.isArray(list) && list[0] ? { id: list[0].id, slug: list[0].slug, name: list[0].name } : null };
  });
  manifest.sitesList = sel;
  manifest.selectedSiteId = sel.first?.id || null;

  // Phase 4: range pills — 7d / 30d / 90d / 24h (role=tab chips in .range-chip-strip)
  for (const label of ['7d', '30d', '90d', '24h']) {
    const clicked = await clickFirst([
      () => page.getByRole('tab', { name: new RegExp(`View ${label}`, 'i') }),
      () => page.getByRole('tab', { name: new RegExp(`^${label}$`, 'i') }),
      () => page.locator('.range-chip', { hasText: new RegExp(`^${label}$`, 'i') }),
    ]);
    await capture(page, clicked ? `range pill → ${label}` : `range pill ${label} NOT FOUND`, { surface: 'admin-analytics', overlay: `range-${label}` });
  }

  // Phase 5: glossary (separate component, toggle/disclosure)
  const glossaryOpened = await clickFirst([
    () => page.getByRole('button', { name: /glossary|what do these mean|metrics? explained|definitions/i }),
    () => page.getByRole('link', { name: /glossary/i }),
    () => page.locator('[data-testid*="glossary"]'),
  ]);
  await capture(page, glossaryOpened ? 'open metrics glossary' : 'glossary trigger NOT FOUND', { surface: 'admin-analytics', overlay: 'glossary' });

  // Phase 6: one Top-pages OR country drilldown
  const drilled = await clickFirst([
    () => page.locator('[data-testid="an-page-drill"]'),
    () => page.locator('[data-testid="an-country-drill"]'),
  ]);
  await capture(page, drilled ? 'Top-pages/country drilldown' : 'no drilldown target (honest empty)', { surface: 'admin-analytics', overlay: 'drilldown' });

  // Phase 7: clear filter (the filter-chip strip appears after a drilldown adds a filter)
  const cleared = await clickFirst([
    () => page.getByRole('button', { name: /clear( all)?|reset filters?|remove filter/i }),
    () => page.locator('[data-testid="an-filter-chip"] button'),
    () => page.locator('[data-testid="an-filter-chip"]'),
  ]);
  await capture(page, cleared ? 'clear filter → back to unfiltered' : 'no active filter to clear', { surface: 'admin-analytics', overlay: 'cleared' });

  finish(manifest.blocked.length === 0 ? (acq.coverage === 'CLOUD_PASS' ? 'PASS_CLOUDFLARE' : 'PASS_ON_FALLBACK_PROVIDER') : 'PARTIAL');
  await acq.browser.close().catch(() => {});
  process.exit(manifest.status.startsWith('PASS') ? 0 : 2);
} catch (err) {
  console.warn(`  ✗ ${String(err?.message || err).slice(0, 160)}`);
  manifest.error = String(err?.message || err).slice(0, 300);
  finish(manifest.blocked.length ? 'BLOCKED' : 'ERROR');
  await acq.browser.close().catch(() => {});
  process.exit(2);
}
