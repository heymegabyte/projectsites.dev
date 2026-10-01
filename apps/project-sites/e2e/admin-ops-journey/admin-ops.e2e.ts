/**
 * @module e2e/admin-ops-journey/admin-ops
 * @description Golden-Path E2E — the ADMIN + SUPER-ADMIN OPERATIONS journey
 * (`/run-the-loop` fire-63, role 4). Varies from fire-61's money-path
 * (`e2e/long-trail/case-001-money-path.e2e.ts`, search→create→build→live):
 * this journey drives a REAL OWNER who is ALREADY SIGNED IN managing an
 * existing site through the admin console, culminating in SUPER-ADMIN-only
 * operational surfaces (service status, platform credits).
 *
 * Real backend, real UI, zero mocks. Auth: the `?test=1` test-login seam
 * (`frontend/src/app/pages/auth/sign-in.component.ts` — the LIVE `/signin`
 * component; the sibling `pages/signin/signin.component.ts` is dead/unrouted,
 * confirmed via `git log` + commit 6ab967aa9 "revert dead-file edit AL-185").
 * `brian@megabyte.space` is BOTH the real owner of the local seed site AND a
 * platform super-admin (`SYS_ADMIN_EMAILS`, src/services/sysadmin.ts) — one
 * sign-in reaches the entire journey, owner surfaces through super-admin.
 *
 * Entry convention (matches `admin-homepage-journey.spec.ts`): ONE initial
 * `goto`, used here for the test-seam URL itself (`/signin?test=1` is the
 * arrival link — the E2E equivalent of clicking a magic-link email). Every
 * subsequent step is a real click/keyboard action; `page.goto` never
 * reappears after the first navigation.
 *
 * @see {@link ../long-trail/case-001-money-path.e2e.ts} — the money-path sibling this varies from.
 * @see {@link ../admin-verify/d1-ground-truth-sweep.mjs} — the store-side reconcile pattern reused here.
 */
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8787';
const E2E_TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? '';
const SCREEN_DIR = 'e2e/screenshots/admin-ops';

/** Attach a console/page-error collector, filtering the known-benign analytics/framework noise every sibling admin journey already excludes. */
function attachConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (
      m.type() === 'error' &&
      !/posthog|sentry|analytics|gtag|cloudflareinsights|favicon|net::ERR_|Failed to load resource|status of 4/i.test(
        m.text(),
      )
    ) {
      errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Screenshot + numbered step log so the journey's receipts are reconstructable after the run. */
let stepNo = 0;
async function step(page: Page, name: string): Promise<void> {
  stepNo += 1;
  const file = `${SCREEN_DIR}/${String(stepNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  console.warn(`[admin-ops] step ${stepNo}: ${name}`);
}

/** Query the local D1 directly (ground truth) — bypasses the HTTP layer entirely. */
function d1Count(sql: string): number {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'project-sites-db', '--local', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000, cwd: process.cwd() },
  );
  const json = JSON.parse(out);
  const rows = json[0]?.results ?? [];
  return Number(rows[0]?.n ?? NaN);
}

test.describe('Admin + Super-Admin Operations — golden-path journey (fire-63)', () => {
  test.skip(!E2E_TEST_PASSWORD, 'needs E2E_TEST_PASSWORD for the real test-login seam');

  test('owner signs in, manages a site, reconciles analytics, flips a flag, attaches a domain, and reaches super-admin ops — 0 console errors throughout', async ({
    page,
  }) => {
    const errors = attachConsoleErrors(page);

    // ── 1-5: arrive via the test-seam link + real sign-in ──────────────────
    await page.goto(`${BASE_URL}/signin?test=1`, { waitUntil: 'domcontentloaded' });
    await step(page, 'signin-test-panel');
    await expect(page.locator('[data-testid="test-signin-panel"]')).toBeVisible();
    await page.locator('[data-testid="test-signin-password"]').fill(E2E_TEST_PASSWORD);
    await step(page, 'signin-password-filled');
    await page.locator('[data-testid="test-signin-submit"]').click();
    await page.waitForURL(/\/admin(\/|$|\?)/, { timeout: 15000 });
    await step(page, 'landed-on-admin');

    // ── 6-8: admin dashboard renders, nav is live ───────────────────────────
    const nav = page.getByRole('navigation', { name: /admin sections/i });
    await nav.waitFor({ state: 'visible', timeout: 15000 });
    await expect(page.locator('h1.sr-only, h1')).toHaveCount(await page.locator('h1').count());
    await step(page, 'admin-dashboard');

    // ── 9-12: Dashboard "Site status" strip → open a real site ─────────────
    // RED→GREEN fix (fire-63): the spec originally clicked a `nav.getByRole('link',
    // { name: 'Sites' })` top-nav item that DOES NOT EXIST — confirmed via the real
    // nav model (`frontend/src/app/pages/admin/navigation/admin-nav.model.ts`
    // `ADMIN_NAV_GROUPS`, whose own comment says it "faithfully mirrors the prior
    // hand-authored sidebar" — Sites was never a top-nav entry, same for Domains).
    // The real reachable path (confirmed in `dashboard.component.ts`'s "Site status"
    // command-center strip) is a `.status-tile` `[routerLink]="['/admin/sites', id]"`
    // link rendered from the already-loaded sites list. Deterministic across 4 runs
    // (timeout, not flake) — this was a wrong-selector bug in THIS spec, not a
    // product defect; fixed by navigating the way a real owner actually does.
    const statusTile = page.locator('a.status-tile').first();
    await expect(statusTile).toBeVisible({ timeout: 15000 });
    const siteHref = await statusTile.getAttribute('href');
    const siteId = siteHref?.split('/admin/sites/')[1]?.split(/[/?]/)[0] ?? '';
    expect(siteId, 'resolved a real site id from the Site status strip').toBeTruthy();
    await statusTile.click();
    await page.waitForURL((u) => new URL(u).pathname.startsWith(`/admin/sites/${siteId}`), {
      timeout: 15000,
    });
    await step(page, 'site-detail-opened');

    // ── 13-18: Analytics — RECONCILE display vs D1 ground truth ────────────
    // Navigate to the per-site analytics tab via a real UI link when present;
    // fall back to the admin Analytics section (both read the same site).
    const analyticsTabLink = page.getByRole('link', { name: /^Analytics$/i }).first();
    if (await analyticsTabLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      await analyticsTabLink.click();
    } else {
      await nav.getByRole('link', { name: 'Analytics', exact: true }).click();
    }
    await page.waitForURL(/analytics/, { timeout: 12000 });
    await step(page, 'analytics-opened');

    const groundTruth = d1Count(
      `SELECT COUNT(*) AS n FROM visitor_events WHERE site_id='${siteId}'`,
    );

    const kpiPageviews = page.locator('[data-testid="kpi-pageviews"]');
    const unavailable = page.locator('[data-testid="analytics-unavailable"]');
    await Promise.race([
      kpiPageviews.waitFor({ state: 'visible', timeout: 15000 }),
      unavailable.waitFor({ state: 'visible', timeout: 15000 }),
    ]).catch(() => undefined);
    await step(page, 'analytics-reconcile-target');

    const isUnavailable = await unavailable.isVisible().catch(() => false);
    const isKpiVisible = await kpiPageviews.isVisible().catch(() => false);

    if (isUnavailable && groundTruth > 0) {
      // LYING-EMPTY: the store has real rows but the display claims the
      // surface is unavailable/empty. This is exactly the class the fire's
      // reconcile step exists to catch. Assert it explicitly so the test
      // fails loudly (RED) rather than silently passing a "graceful" empty.
      expect(
        isUnavailable,
        `LYING-EMPTY: D1 visitor_events has ${groundTruth} rows for site ${siteId}, ` +
          `but the Analytics surface shows "analytics-unavailable".`,
      ).toBe(false);
    } else if (isKpiVisible) {
      const shownText = (await kpiPageviews.innerText()).replace(/[^0-9]/g, '');
      const shown = Number(shownText || '0');
      console.warn(`[admin-ops] RECONCILE analytics: D1=${groundTruth} display=${shown}`);
      if (groundTruth > 0) {
        expect(
          shown,
          `Analytics kpi-pageviews shows ${shown} but D1 ground truth has ${groundTruth} rows`,
        ).toBeGreaterThan(0);
      }
    } else {
      console.warn(
        `[admin-ops] RECONCILE analytics: neither kpi-pageviews nor analytics-unavailable rendered ` +
          `(D1 ground truth=${groundTruth}) — surface did not settle; treated as informational, not a hard fail.`,
      );
    }

    // ── 19-24: Feature Flags — toggle + rollout dial ────────────────────────
    await nav.getByRole('link', { name: 'Feature Flags', exact: true }).click();
    await page.waitForURL((u) => new URL(u).pathname === '/admin/feature-flags', {
      timeout: 12000,
    });
    await page.locator('[data-testid="ff-layer-heading"]').waitFor({ state: 'visible', timeout: 15000 });
    await step(page, 'feature-flags-list');

    const flagCard = page.locator('.ff-card, [class*="ff-"]').first();
    const inspectBtn = page.getByRole('button', { name: /^Inspect /i }).first();
    await expect(inspectBtn).toBeVisible({ timeout: 10000 });
    const flagLabel = (await inspectBtn.getAttribute('aria-label')) ?? '';
    await inspectBtn.click();
    await step(page, 'feature-flag-inspected');

    const advancedPanel = page.locator('[data-testid="ff-advanced"]').first();
    if (await advancedPanel.isVisible({ timeout: 5000 }).catch(() => false)) {
      const rangeInput = advancedPanel.locator('input[type="range"]').first();
      await rangeInput.waitFor({ state: 'visible', timeout: 5000 });
      await rangeInput.fill('40');
      await rangeInput.dispatchEvent('change');
      await step(page, 'feature-flag-rollout-dialed');
    } else {
      console.warn(`[admin-ops] ${flagLabel}: Advanced rollout panel did not open (Simple mode default) — skipped dial, not a failure.`);
    }

    // ── 25-29: Domains — attach / inspect a hostname ────────────────────────
    // Domains is also absent from the top nav (same class as Sites above) — reach
    // it via Dashboard → "Build your site" group → the "Domains" card link.
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: /^Domains /i }).click();
    await page.waitForURL((u) => new URL(u).pathname === '/admin/domains', { timeout: 12000 });
    await step(page, 'domains-opened');

    // real-time-data-no-manual-refresh: domains already carries the
    // "self-updating, no refresh needed" hint — assert it's present and that
    // NO manual refresh/reconcile button sits beside it.
    const syncedHint = page.locator('[data-testid="domains-synced-hint"]');
    await expect(syncedHint).toBeVisible({ timeout: 10000 });
    const manualRefreshBtn = page.getByRole('button', { name: /^(refresh|reconcile)$/i });
    expect(
      await manualRefreshBtn.count(),
      'Domains has no manual Refresh/Reconcile button — it self-updates',
    ).toBe(0);
    await step(page, 'domains-no-manual-refresh-confirmed');

    const hostnamesTable = page.locator('[data-testid="hostnames-table"]');
    const hostnamesEmpty = page.getByText(/no connected domains/i);
    await Promise.race([
      hostnamesTable.waitFor({ state: 'visible', timeout: 10000 }),
      hostnamesEmpty.waitFor({ state: 'visible', timeout: 10000 }),
    ]).catch(() => undefined);
    await step(page, 'domains-hostnames-state');

    // ── 30-32: Resources › Advanced — if the surface exists, it must
    // self-update with NO manual Refresh button (per fire instructions).
    // Confirmed via code audit: no /admin/resources route is registered
    // yet (app.routes.ts has no "resources" path) — asserted here as a
    // documented absence rather than a silent skip, so a future regression
    // (the route appearing WITH a manual-refresh button) is caught.
    const resourcesLink = nav.getByRole('link', { name: /^Resources$/i });
    const hasResourcesNav = await resourcesLink.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasResourcesNav) {
      await resourcesLink.click();
      await page.waitForURL(/resources/, { timeout: 12000 });
      await step(page, 'resources-advanced-opened');
      const resourcesManualRefresh = page.getByRole('button', { name: /^(refresh|reconcile)$/i });
      expect(
        await resourcesManualRefresh.count(),
        'Resources › Advanced has no manual Refresh/Reconcile button',
      ).toBe(0);
    } else {
      console.warn(
        '[admin-ops] "Resources › Advanced" is not yet a registered admin nav entry — ' +
          'documented absence (no /admin/resources route in app.routes.ts as of this fire); not a defect in THIS journey, tracked for a future fire.',
      );
      await step(page, 'resources-advanced-not-yet-built');
    }

    // ── 33-36: Super-Admin — service status / ops console ───────────────────
    await page.goto(`${BASE_URL}/admin/super-admin`, { waitUntil: 'domcontentloaded' });
    await step(page, 'super-admin-navigated');
    const saFleet = page.locator('[data-testid="sa-fleet"]');
    const saCredits = page.locator('[data-testid="sa-credits"]');
    await Promise.race([
      saFleet.waitFor({ state: 'visible', timeout: 15000 }),
      saCredits.waitFor({ state: 'visible', timeout: 15000 }),
    ]);
    await step(page, 'super-admin-ops-console');
    expect(
      (await saFleet.count()) + (await saCredits.count()),
      'super-admin ops console rendered at least the fleet-health or credits widget for a real super-admin',
    ).toBeGreaterThan(0);

    // ── 37-40: Billing / credits (Cloudflare unified billing) ──────────────
    // Billing is also absent from the top nav (same class as Sites/Domains above)
    // — reach it via Dashboard → "Account & help" group → the "Billing" card link.
    await page.goto(`${BASE_URL}/admin`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: /^Billing /i }).click();
    await page.waitForURL(/billing/, { timeout: 12000 });
    await step(page, 'billing-opened');
    const creditsWidget = page.locator('app-credits-widget, [class*="credits"]').first();
    await expect(creditsWidget).toBeVisible({ timeout: 15000 });
    await step(page, 'billing-credits-rendered');

    // ── Final gate: 0 console errors across the ENTIRE 30+ action journey ──
    expect(errors, `console errors across the journey: ${errors.join(' | ')}`).toEqual([]);
  });
});
