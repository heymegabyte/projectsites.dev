#!/usr/bin/env node
/**
 * apps-visual-sweep-local.mjs — FAST local visual sweep of the Apps admin section.
 *
 * The Browserbase harness (`../../e2e/admin-verify/visual-sweep.mjs`) verifies PROD; this one
 * drives a LOCAL `ng serve` (default http://localhost:4200) with a real Chromium so the
 * apps-section inner-loop (fix → screenshot → look → fix) doesn't pay the Browserbase +
 * prod-deploy cost each iteration. The Apps catalog/detail render from STATIC frontend data,
 * so they render fully without the prod API — we just seed a fake `ps_session` so the admin
 * auth guard passes. Instances need the API and will show their empty/error state locally
 * (that surface is verified against prod via the Browserbase sweep).
 *
 * Captures, per route × breakpoint: a screenshot, h1, main text length, a caught-render-crash
 * flag (the section error boundary logs via console.warning, NOT console.error — a
 * console.error-only sweep is blind to a fully-crashed section, cost a fire 2026-08-03), and
 * console errors (PostHog `/ingest` + analytics beacons filtered — they fail in automation by
 * design and are not app bugs).
 *
 * Usage:
 *   node scripts/apps-visual-sweep-local.mjs                       # default routes, desktop+mobile
 *   BASE_URL=http://localhost:4200 node scripts/apps-visual-sweep-local.mjs /admin/apps
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
// Optional axe-core a11y (PSVIS_AXE=1) — objective WCAG violations the eye can miss.
let AxeBuilder = null;
if (process.env.PSVIS_AXE) {
  try {
    ({ AxeBuilder } = await import('@axe-core/playwright'));
  } catch {
    /* axe optional */
  }
}

const BASE = process.env.BASE_URL || 'http://localhost:4200';
const OUT = process.env.PSVIS_OUT || '/tmp/psvis-apps';
mkdirSync(OUT, { recursive: true });

const DEFAULT = [
  '/admin/apps',
  '/admin/apps/instances',
  '/admin/apps/payload',
  '/admin/apps/listmonk',
  '/admin/apps/open-webui',
];
const paths = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
const BPS = [
  { tag: 'desktop', width: 1440, height: 900 },
  { tag: 'mobile', width: 390, height: 844 },
];
// Flatten nested routes (apps/instances) → a single filename token.
const nameOf = (p) => (p.replace(/^\/admin\/?/, '') || 'dashboard').replace(/\//g, '_');
const isBeacon = (u) =>
  /google-analytics|\/g\/collect|\/ingest\/|posthog|sentry|gtag|googletagmanager/i.test(u);

const browser = await chromium.launch({ headless: true });
const report = {};
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Auth stub — the admin auth guard is client-side (ps_session), but on bootstrap the app
  // calls GET /api/auth/me and CLEARS the session on 401/404 (api.service.ts:135). With no
  // local API that fails → we'd bounce to the guest homepage. Stub /auth/me with the canonical
  // shape ({data:{user_id,org_id,email,display_name,is_super_admin,org_name}}) so the session
  // survives; every other /api/* returns an empty-but-valid body so nothing throws (the Apps
  // catalog + detail render from STATIC frontend data — instances/live data verify via prod).
  await ctx.route('**/api/**', async (route) => {
    const url = route.request().url();
    const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    if (/\/api\/auth\/me\b/.test(url)) {
      return json({
        user_id: 'usr_local_sweep',
        org_id: 'org_local_sweep',
        email: 'brian@megabyte.space',
        display_name: 'Brian',
        is_super_admin: 1,
        org_name: 'Local Sweep',
      });
    }
    // A selected site is the precondition for the Apps catalog rendering (else the admin shell
    // shows its "No sites yet" empty state). One fake published site unlocks the catalog + detail.
    if (/\/api\/sites(\?|$)/.test(url) && route.request().method() === 'GET') {
      return json([
        {
          id: 'site_local_sweep',
          slug: 'lone-mount',
          name: 'Local Sweep Site',
          business_name: 'Local Sweep Site',
          status: 'published',
          org_id: 'org_local_sweep',
          primary_hostname: null,
          plan: 'pro',
          created_at: new Date(Date.now() - 864e5).toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"data":[]}' });
  });

  let current = 'boot';
  const errors = {};
  page.on('console', (m) => {
    const t = m.type();
    const txt = m.text();
    if (isBeacon(txt)) return;
    if (t === 'error' || (t === 'warning' && /Unhandled error|GlobalErrorHandler|ran into a problem/i.test(txt))) {
      (errors[current] ??= []).push(`[${t}] ${txt.slice(0, 160)}`);
    }
  });
  page.on('pageerror', (e) => {
    (errors[current] ??= []).push(`[pageerror] ${(e.message || String(e)).slice(0, 160)}`);
  });

  // Seed a fake session on the app origin so the admin auth guard passes for static surfaces.
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(() => {
    try {
      localStorage.setItem(
        'ps_session',
        JSON.stringify({ token: 'local-visual-sweep', identifier: 'brian@megabyte.space', issuedAt: Date.now() }),
      );
    } catch {
      /* private mode */
    }
  });

  for (const bp of BPS) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    for (const p of paths) {
      const name = `${nameOf(p)}-${bp.tag}`;
      current = name;
      try {
        await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2600); // let lazy chunk + reveal animations settle
        await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: !!process.env.PSVIS_FULLPAGE });
        const info = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';
          return {
            url: location.pathname,
            h1: (document.querySelector('h1')?.innerText || '').slice(0, 60),
            mainLen: (document.querySelector('main')?.innerText || bodyText).trim().length,
            crashed: /ran into a problem/i.test(bodyText),
            // horizontal overflow tell: does any element bleed past the viewport width?
            overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
          };
        });
        report[name] = { ...info, errors: errors[name] ?? [] };
        if (AxeBuilder) {
          try {
            const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
            report[name].axe = res.violations
              .filter((v) => v.impact === 'serious' || v.impact === 'critical')
              .map((v) => `${v.impact[0]}:${v.id}×${v.nodes.length}`);
          } catch (e) {
            report[name].axe = 'axe-failed: ' + String(e).slice(0, 60);
          }
        }
      } catch (e) {
        report[name] = { shot: 'FAIL', error: String(e).slice(0, 140) };
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nScreenshots → ${OUT}/*.png`);
} finally {
  await browser.close();
}
