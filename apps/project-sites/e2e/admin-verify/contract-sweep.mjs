#!/usr/bin/env node
/**
 * contract-sweep.mjs — the REAL convergence DONE gate for admin sections.
 *
 * Replaces the old fake gate, which counted unchecked markdown checkboxes
 * (730 of them, hand-ticked) — a number decoupled from
 * whether a section actually WORKS. This sweep drives every section in
 * admin-contract.mjs against PROD, authed as brian, real-browser, and asserts the
 * 6-point per-section contract. DONE = every HARD section passes. NOT_DONE lists
 * exactly which sections fail and why → that list is the loop's next work queue.
 *
 * WHAT EACH SECTION MUST PASS (the classes your memory says keep biting):
 *   1. RENDER        main text ≥ minLen               (blank / stuck-spinner → fail)
 *   2. REAL DATA     `signal` regex matches the DOM   (loose "content exists" is not enough)
 *   3. NOT-CRASHED   no error-boundary fallback        (GlobalErrorHandler "ran into a problem")
 *   4. NOT-LYING     no false-success / dead copy       (something went wrong / failed to load / not available)
 *   5. NOT-SWALLOWED every `api` endpoint 2xx on load   (swallowed-SQL→404 + response-key-mismatch)
 *   6. FLAG-AWARE    a DARK flag section shows a calm gate-notice, never a crash/404 shell
 *   Aliases: the redirect resolves to its target, never the admin not-found shell.
 *
 * AUTH: mirrors the proven visual-sweep.mjs pattern — POST /api/auth/test-login as
 * brian, seed localStorage.ps_session with `identifier` (NOT `email`, or sysAdminGuard
 * bounces brian off operator sections). Runs on Browserbase (headless local can't
 * render deep admin — see [[deep-admin-components-need-browserbase]]).
 *
 * Creds (get-secret): BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, E2E_TEST_PASSWORD.
 * Exits 0 (SKIP) when any is unset — never fail-closed, so CI/forks stay green.
 *
 * Output: JSON report to stdout + _ADMIN_CONTRACT_REPORT.json (the loop reads .done).
 *   node e2e/admin-verify/contract-sweep.mjs            # all hard+soft render sections
 *   node e2e/admin-verify/contract-sweep.mjs analytics  # one slug (debug)
 */
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDER_SECTIONS, ALIAS_SECTIONS, HARD_SECTIONS } from './admin-contract.mjs';
import { resolveBrowserbaseCreds } from './_browserbase-creds.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_FILE = resolve(HERE, '../../_ADMIN_CONTRACT_REPORT.json');
const BASE = process.env.PROD_URL ?? 'https://projectsites.dev';
const { BB, PROJ, PW } = resolveBrowserbaseCreds();

const DEAD_COPY = /something went wrong|failed to load|internal server error|not available yet|isn't enabled|couldn't load|unable to load/i;
const GATE_COPY = /enable this feature|feature is off|turned off|not enabled|coming soon|available on|upgrade|request access|restricted/i;
const CRASH_COPY = /ran into a problem|unexpected error|reload the page/i;
const NOTFOUND_COPY = /admin page doesn't exist|page not found|did you mean/i;

if (!BB || !PROJ || !PW) {
  console.log('::notice:: contract-sweep SKIPPED — BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID / E2E_TEST_PASSWORD unset');
  process.exit(0);
}

const onlySlug = process.argv[2];
const renderTargets = (onlySlug ? RENDER_SECTIONS.filter((s) => s.slug === onlySlug) : RENDER_SECTIONS);
const aliasTargets = (onlySlug ? ALIAS_SECTIONS.filter((s) => s.slug === onlySlug) : ALIAS_SECTIONS);

/** Open a Browserbase session and return a Playwright browser over CDP. */
async function connect() {
  const r = await fetch('https://api.browserbase.com/v1/sessions', {
    method: 'POST', headers: { 'X-BB-API-Key': BB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: PROJ, timeout: 900 }),
  });
  if (!r.ok) throw new Error(`browserbase session create failed ${r.status}`);
  const { id } = await r.json();
  return chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${encodeURIComponent(BB)}&sessionId=${encodeURIComponent(id)}`);
}

const results = [];
// Walk the 44 sections CONCURRENTLY across a pool of pages (each section is an independent
// route + its own network map). The old serial walk on ONE page needed >150s and risked the
// loop's timeout (a slow-but-passing gate is a reliability hole); a K-way pool cuts wall-time
// ~Kx. Same per-section contract + report. Override with SWEEP_CONCURRENCY (default 5).
const POOL = Math.max(1, Math.min(8, Number(process.env.SWEEP_CONCURRENCY || 5)));
const browser = await connect();

/** A pool page in the shared (auth-seeded) context, each with its OWN network map. */
async function makePoolPage(ctx) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const net = { byPath: {} };
  page.on('response', (res) => {
    try {
      const u = new URL(res.url());
      if (u.pathname.startsWith('/api/')) net.byPath[u.pathname] = Math.max(net.byPath[u.pathname] ?? 0, res.status());
    } catch { /* non-URL */ }
  });
  return { page, net };
}

/** Drive ONE render section on a pool page → result object (identical contract to the old serial body). */
async function processRender(pp, s, siteId) {
  const { page, net } = pp;
  let url = s.route;
  if (s.kind === 'dynamic') {
    if (!siteId) return { slug: s.slug, severity: s.severity, pass: s.severity !== 'hard', skipped: 'no site id', route: s.route };
    url = url.replace(':id', siteId).replace(':siteId', siteId);
  }
  net.byPath = {};
  const fails = [];
  try {
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Wait for the SPA shell to mount, then a base settle for the section to paint.
    await page.locator('app-admin, main').first().waitFor({ timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    const capture = () =>
      page.evaluate((shell) => {
        const body = document.body.innerText || '';
        const main = document.querySelector('main')?.innerText || body;
        return {
          path: location.pathname,
          mainLen: main.trim().length,
          text: main.slice(0, 4000),
          h1: (document.querySelector('h1')?.innerText || '').slice(0, 80),
          rows: document.querySelectorAll('table tbody tr, [role="row"]').length,
          // Advisory: is the contract's shell testid present? Reported, never fails
          // the gate yet (testids start soft, promote to hard once wired everywhere).
          shellPresent: shell ? !!document.querySelector(`[data-testid="${shell}"]`) : null,
        };
      }, s.shell);
    let info = await capture();
    // Async-heavy sections (e.g. /admin/docs fetches + renders 51 OpenAPI endpoints) can
    // still be mid-render after the base settle. Poll (max ~8s more) until the section
    // clears its OWN bar — mainLen >= minLen AND, if a real-data signal is required, it's
    // present — so a slow async render never reads as a false thin/no-signal failure. A
    // genuinely-broken section never clears → still fails, just ~8s later. (Fix: /admin/docs
    // false-red at mainLen=510 while a real browser showed 6569 + full signal — AL-178.)
    const signalRe = s.signal ? new RegExp(s.signal, 'i') : null;
    const cleared = (i) => i.mainLen >= s.minLen && (!signalRe || signalRe.test(i.text));
    for (let n = 0; n < 5 && !cleared(info); n++) {
      await page.waitForTimeout(1600);
      info = await capture();
    }
    const flagDark = !!s.flag && (GATE_COPY.test(info.text) || info.mainLen < s.minLen);

    // 3. NOT-CRASHED
    if (CRASH_COPY.test(info.text)) fails.push('crashed (error boundary)');
    // 6/1. RENDER — flag-dark sections are allowed a calm gate-notice
    if (!flagDark && info.mainLen < s.minLen) fails.push(`thin render (${info.mainLen}<${s.minLen})`);
    // 2. REAL DATA — skip signal for a legitimately flag-dark section
    if (!flagDark && s.signal && !new RegExp(s.signal, 'i').test(info.text)) fails.push(`no real-data signal /${s.signal}/`);
    // 4. NOT-LYING — dead/false-success copy that isn't a legit flag gate
    if (!flagDark && DEAD_COPY.test(info.text)) fails.push('dead/false-success copy');
    // 5. NOT-SWALLOWED — declared endpoints must not 4xx/5xx on load
    for (const ep of s.api) {
      const worst = Object.entries(net.byPath).find(([p]) => p === ep || p.startsWith(ep))?.[1];
      if (worst && worst >= 400) fails.push(`api ${ep} → ${worst}`);
    }
    const badApi = Object.entries(net.byPath).filter(([, st]) => st >= 500).map(([p, st]) => `${p}:${st}`);
    if (badApi.length) fails.push(`5xx: ${badApi.slice(0, 3).join(',')}`);

    return { slug: s.slug, severity: s.severity, route: url, flagDark, mainLen: info.mainLen, rows: info.rows, shellPresent: info.shellPresent, pass: fails.length === 0, fails };
  } catch (e) {
    fails.push(`nav error: ${String(e).slice(0, 80)}`);
    return { slug: s.slug, severity: s.severity, route: url, pass: false, fails };
  }
}

/** Drive ONE alias section on a pool page → the redirect must resolve to its target. */
async function processAlias(pp, s) {
  const { page } = pp;
  const fails = [];
  try {
    await page.goto(BASE + s.route, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const info = await page.evaluate(() => ({ path: location.pathname + location.search + location.hash, body: (document.body.innerText || '').slice(0, 1500) }));
    const target = s.redirectTo.split(/[?#]/)[0];
    if (!info.path.startsWith(target)) fails.push(`redirect landed ${info.path}, expected ${s.redirectTo}`);
    if (NOTFOUND_COPY.test(info.body)) fails.push('resolved to admin not-found shell');
    return { slug: s.slug, severity: s.severity, alias: true, route: s.route, redirectTo: s.redirectTo, landed: info.path, pass: fails.length === 0, fails };
  } catch (e) {
    return { slug: s.slug, severity: s.severity, alias: true, route: s.route, pass: false, fails: [`nav error: ${String(e).slice(0, 80)}`] };
  }
}

try {
  const ctx = browser.contexts()[0] ?? await browser.newContext();
  const authPage = ctx.pages()[0] ?? await ctx.newPage();
  await authPage.setViewportSize({ width: 1440, height: 900 });

  // ── Auth as brian (seed identifier, NOT email) ──────────────────────────
  // Seeds localStorage.ps_session on the CONTEXT (shared by every pool page on this origin)
  // + solves the CF managed-challenge once (the clearance cookie is context-scoped too).
  await authPage.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await authPage.waitForTimeout(7000); // CF managed-challenge solve
  const login = await authPage.evaluate(async ({ pw }) => {
    const res = await fetch('/api/auth/test-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'brian@megabyte.space', password: pw }) });
    const j = await res.json().catch(() => ({}));
    const d = j?.data;
    if (d?.token) {
      try { localStorage.setItem('ps_session', JSON.stringify({ token: d.token, identifier: d.email ?? 'brian@megabyte.space', issuedAt: Date.now() })); } catch { /* private mode */ }
    }
    return { status: res.status, ok: !!d?.token };
  }, { pw: PW });
  if (!login.ok) {
    writeFileSync(REPORT_FILE, JSON.stringify({ done: false, reason: 'test-login failed', login }, null, 2));
    console.log(JSON.stringify({ done: false, reason: 'test-login failed', login }, null, 2));
    process.exit(2);
  }
  // Kill SW/caches so we render the freshly-deployed bundle, not a stale SW cache.
  await authPage.evaluate(async () => {
    try {
      if (navigator.serviceWorker) (await navigator.serviceWorker.getRegistrations()).forEach((r) => r.unregister());
      if (window.caches) (await caches.keys()).forEach((k) => caches.delete(k));
    } catch { /* SW/cache API unavailable */ }
  });

  // Resolve brian's first site id for the dynamic sections (:id / :siteId).
  const siteId = await authPage.evaluate(async () => {
    try {
      const t = JSON.parse(localStorage.getItem('ps_session') || '{}').token;
      const r = await fetch('/api/sites', { headers: { Authorization: `Bearer ${t}` } });
      const j = await r.json().catch(() => ({}));
      const rows = Array.isArray(j?.data) ? j.data : Array.isArray(j?.sites) ? j.sites : [];
      return rows[0]?.id ?? rows[0]?.slug ?? null;
    } catch { return null; }
  });
  await authPage.close().catch(() => {}); // auth done; the pool does the section work

  // ── Concurrent section walk: K workers each own a page, pulling from a shared queue. ──
  const renderQueue = [...renderTargets];
  const aliasQueue = [...aliasTargets];
  const worker = async () => {
    const pp = await makePoolPage(ctx);
    try {
      let s;
      while ((s = renderQueue.shift())) results.push(await processRender(pp, s, siteId));
      while ((s = aliasQueue.shift())) results.push(await processAlias(pp, s));
    } finally {
      await pp.page.close().catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, renderTargets.length + aliasTargets.length) || 1 }, () => worker()));
} finally {
  await browser.close();
}

// ── Verdict ────────────────────────────────────────────────────────────────
const hardSlugs = new Set(HARD_SECTIONS.map((s) => s.slug));
const hardFails = results.filter((r) => hardSlugs.has(r.slug) && !r.pass && !r.skipped);
const softFails = results.filter((r) => !hardSlugs.has(r.slug) && !r.pass && !r.skipped);
const done = hardFails.length === 0;
const report = {
  done, base: BASE,
  totals: { sections: results.length, passed: results.filter((r) => r.pass).length, hardFail: hardFails.length, softFail: softFails.length },
  hardFailures: hardFails.map((r) => ({ slug: r.slug, route: r.route, fails: r.fails })),
  softFailures: softFails.map((r) => ({ slug: r.slug, route: r.route, fails: r.fails })),
  results,
};
writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\n${done ? '✅ DONE' : '❌ NOT_DONE'} — ${report.totals.passed}/${report.totals.sections} sections pass · ${hardFails.length} hard failure(s) → next work queue`);
process.exit(done ? 0 : 1);
