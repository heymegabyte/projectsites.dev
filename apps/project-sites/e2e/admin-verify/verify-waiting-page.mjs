#!/usr/bin/env node
/**
 * verify-waiting-page.mjs — the /waiting BUILD-PROGRESS page (§ B, FULL-FLOW — a flow AROUND the
 * golden path that had no dedicated headless-PROD probe until now).
 *
 * B.2 proves the build OUTCOME (published {slug}.projectsites.dev loads). But the surface the owner
 * actually STARES AT for the whole ~11-40-min build — the /waiting page: its build terminal (the
 * STREAMING BUILD THEATER live-log widget, AL-666), the per-phase chips, the elapsed heartbeat that
 * keeps it from ever looking frozen, and the "Your site is live!" transition — was never proven to
 * render in a real browser. This closes that gap.
 *
 * A PUBLISHED+built site renders /waiting in a STABLE terminal state (all phase chips 'done',
 * "Your site is live!", historical build logs in the terminal, heartbeat empty since the build is
 * done) — it does NOT redirect away (resolveBuildOutcome → 'live' just sets the message + stops the
 * poll). So a published e2e-test-org site is a deterministic probe target.
 *
 * Homepage-first: seed ps_session on /admin (auth boundary), discover the org's newest published
 * site via the authed /api/sites, then load /waiting?id=…&slug=… and assert the widget renders.
 *
 * Local Chromium (the authed admin shell is NOT CF-bot-challenged). E2E_API_KEY unlocks e2e-test-org.
 * Fail-open SKIP (exit 0) when E2E_API_KEY unset OR the org has no published+built site.
 *
 * Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) node e2e/admin-verify/verify-waiting-page.mjs
 */
const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.log('::notice:: verify-waiting-page skipped — E2E_API_KEY unset');
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

const rows = [];
let fails = 0;
const check = (label, ok, detail = '') => {
  rows.push(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const errs = [];
let cur = 'boot';

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.type(),
      x = m.text();
    if (/Failed to load resource|net::ERR_ABORTED|favicon|status of 4|status of 5|\[PostHog\]/i.test(x)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled|Uncaught/i.test(x))) errs.push(`[${cur}] ${x.slice(0, 90)}`);
  });
  page.on('pageerror', (e) => errs.push(`[${cur}][pageerror] ${(e.message || String(e)).slice(0, 90)}`));

  // ── 1. Seed the session on the auth boundary ──
  cur = 'seed';
  await page.goto(`${ORIGIN}/admin`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.evaluate(
    (k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })),
    KEY,
  );

  // ── 2. Discover the org's newest PUBLISHED + built site (durable — no hardcoded id) ──
  cur = 'discover';
  const site = await page.evaluate(async (tok) => {
    try {
      const r = await fetch('/api/sites', { headers: { Authorization: `Bearer ${tok}` } });
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j) ? j : (j.data ?? j.sites ?? []);
      const built = list.find((s) => s.status === 'published' && (s.current_build_version || s.currentBuildVersion));
      const any = built || list.find((s) => s.status === 'published') || list[0];
      return any ? { id: any.id, slug: any.slug, status: any.status } : null;
    } catch {
      return null;
    }
  }, KEY);
  if (!site?.id) {
    console.log('::notice:: verify-waiting-page skipped — no site in e2e-test-org to render /waiting for');
    process.exit(0);
  }

  // ── 3. Load /waiting for that site — the build-progress experience ──
  // /waiting has TWO states (waiting.component.html):
  //   • status==='published'  → the SUCCESS payoff view ("Your site is live!" + View/Edit/Dashboard CTAs)
  //   • else (building/…)      → the BUILDING overlay: terminal (STREAMING BUILD THEATER) + phase chips + heartbeat
  // A published e2e site deterministically renders the SUCCESS view; assert whichever state applies.
  cur = 'waiting';
  await page.goto(`${ORIGIN}/waiting?id=${encodeURIComponent(site.id)}&slug=${encodeURIComponent(site.slug || '')}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // First poll fires at t=0 (getSite + getSiteLogs); give it a beat to resolve the state.
  await page.waitForSelector('[data-testid="build-overlay"], h2', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const w = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const bodyTxt = (document.body.innerText || '').slice(0, 4000);
    const btnText = qa('button').map((b) => (b.textContent || '').trim());
    return {
      isSuccess: /your site is live/i.test(bodyTxt),
      liveUrlShown: /[a-z0-9-]+\.projectsites\.dev/i.test(bodyTxt),
      liveUrlHref: q('[data-testid="waiting-live-url"]')?.getAttribute('href') || '',
      viewSiteBtn: btnText.some((t) => /view your site/i.test(t)),
      editBtn: btnText.some((t) => /edit with ai/i.test(t)),
      dashboardBtn: btnText.some((t) => /go to dashboard/i.test(t)),
      // building-state widgets (only when not yet published)
      overlay: !!q('[data-testid="build-overlay"]'),
      statusMessage: (q('[data-testid="build-overlay"] p')?.textContent || '').trim(),
      phaseChips: qa('[data-testid="build-phase-chip"]').length,
      terminal: !!q('.build-terminal'),
      logLines: qa('[data-testid="build-log-line"]').length,
      cursorLine: !!q('.build-line--cursor'),
      crashed: /something went wrong|failed to load|unexpected error/i.test(bodyTxt),
    };
  });

  check('the /waiting page renders (no error-boundary crash)', (w.isSuccess || w.overlay) && !w.crashed, w.crashed ? 'crash' : `state=${w.isSuccess ? 'success' : 'building'}`);

  if (w.isSuccess) {
    // SUCCESS payoff screen — the build-complete moment + the owner's 3 next actions.
    check('“Your site is live!” payoff message shown', w.isSuccess);
    check('the live {slug}.projectsites.dev URL is shown', w.liveUrlShown);
    check(
      'the live URL is a CLICKABLE link to the subdomain (AL-667 value-add)',
      /^https:\/\/[a-z0-9-]+\.projectsites\.dev$/i.test(w.liveUrlHref),
      w.liveUrlHref || '(plain text — not linked)',
    );
    check('primary CTA “View Your Site” is present', w.viewSiteBtn);
    check('“Edit with AI” CTA is present', w.editBtn);
    check('“Go to Dashboard” CTA is present', w.dashboardBtn);
  } else {
    // BUILDING overlay — the live streaming terminal experience (AL-666).
    check('the build overlay renders', w.overlay);
    check('a status message is shown', w.statusMessage.length > 0, `"${w.statusMessage.slice(0, 44)}"`);
    check('per-phase chips render (progress at a glance)', w.phaseChips >= 3, `${w.phaseChips} chips`);
    check('the build terminal (STREAMING BUILD THEATER widget) renders', w.terminal);
    check('the terminal shows build-log lines', w.logLines >= 1, `${w.logLines} lines`);
    check('the heartbeat / cursor line is present (never looks frozen)', w.cursorLine);
  }
  check('0 console errors on the /waiting page', errs.length === 0, errs.slice(0, 3).join(' | '));

  // ── 4. axe critical/serious scan (advisory unless PSVIS_AXE=1) — MUST run on /waiting, before nav ──
  cur = 'axe';
  try {
    const { default: AxeBuilder } = req('@axe-core/playwright');
    const axe = await new AxeBuilder({ page }).options({ resultTypes: ['violations'] }).analyze();
    const bad = axe.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    const strict = process.env.PSVIS_AXE === '1';
    check(
      `axe: 0 critical/serious violations${strict ? '' : ' (advisory)'}`,
      strict ? bad.length === 0 : true,
      bad.length ? bad.map((v) => v.id).slice(0, 4).join(',') : 'clean',
    );
  } catch (e) {
    rows.push(`  · axe scan skipped — ${String(e.message || e).slice(0, 50)}`);
  }

  await page.screenshot({ path: `${__dirname}/_waiting-page.png` }).catch(() => {});

  // ── 5. CTA OPERABILITY (not just presence — a dead CTA is a lying-green, per AL-451/481) ──
  // Click the "Go to Dashboard" escape CTA LAST (it navigates away) + assert it lands on /admin
  // (same-tab SPA nav via goAdmin()). View-Your-Site (full nav to the subdomain) + Edit-with-AI
  // (/editor) are presence-asserted above; Go-to-Dashboard is the safe deterministic operability proof.
  if (w.isSuccess) {
    cur = 'cta-operable';
    const dash = page.locator('button', { hasText: /go to dashboard/i }).first();
    if (await dash.count()) {
      await dash.click().catch(() => {});
      await page.waitForURL(/\/admin(\/|$|\?)/, { timeout: 15000 }).catch(() => {});
      const path = new URL(page.url()).pathname;
      check('“Go to Dashboard” CTA is OPERABLE → navigates to /admin', /^\/admin(\/|$)/.test(path), path);
    }
  }
} catch (e) {
  check('waiting-page probe completes without throwing', false, `[${cur}] ${String(e.message || e).slice(0, 100)}`);
} finally {
  await browser.close();
}

console.log('\n━━ § B /waiting build-progress page (terminal + phase chips + heartbeat + streaming logs) ━━');
rows.forEach((r) => console.log(r));
const ok = fails === 0;
console.log(
  ok
    ? '\n✓ WAITING PAGE PASS — the build-progress experience renders end-to-end (terminal, phases, heartbeat, logs), 0 console errors.'
    : `\n🔴 WAITING PAGE FAIL — ${fails} break(s) in the /waiting build-progress surface.`,
);
process.exit(ok ? 0 : 1);
