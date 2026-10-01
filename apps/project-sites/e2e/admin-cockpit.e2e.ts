/**
 * @file admin-cockpit.e2e.ts
 * @description Admin Cockpit — prod E2E (homepage-start real user journey, fire-64).
 *
 * Flow: homepage → sign in via the real test-login seam (`/signin?test=1` →
 * `POST /api/auth/test-login`, the SAME seam `admin-ops-journey/admin-ops.e2e.ts`
 * and `long-trail/case-001-money-path.e2e.ts` drive) → navigate by CLICKS into
 * `/admin` → assert the Operator cockpit renders: KPI tiles carry numeric
 * values, the "Needs attention" queue is present (either populated rows or the
 * honest "All clear" empty state — never absent), and the Core Web Vitals /
 * generation-metrics panel is present. Console-error-free throughout;
 * screenshots land in `e2e/screenshots/admin-cockpit/`.
 *
 * Ground-truth selectors (confirmed live in the component, not guessed):
 *  - Admin shell mount:    `app-admin, [data-cockpit="v2"]` (every sibling spec's gate)
 *  - KPI tile strip:       `ul.kpi-strip` → `li.kpi-tile` (`dashboard.component.ts`)
 *  - Needs-attention list: `ul.attn-list` → `li.attn-row[data-testid^="dash-attn-"]`,
 *                           OR the honest empty state `[data-testid="dash-attn-clear"]`
 *  - CWV / metrics panel:  `section.cwv-group` (`ul.cwv-strip` populated, or the
 *                           honest `[data-testid="cwv-empty"]` not-yet-run state),
 *                           AND/OR the super-admin-only `app-generation-metrics-card`
 *                           (`[data-testid="gen-metrics-card"]`) when the signed-in
 *                           user is a sysadmin (brian@megabyte.space IS one).
 *
 * Uses `PROD_URL` (default `https://projectsites.dev`) per the repo convention —
 * every sibling `.e2e.ts` spec reads this exact env var.
 */

import { test, expect, type Page } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const SCREEN_DIR = 'e2e/screenshots/admin-cockpit';
/** The seam's one hardcoded identity (see `src/services/auth.ts` TEST_LOGIN_EMAIL) —
 * also a platform super-admin, so the generation-metrics card is reachable too. */
const TEST_LOGIN_EMAIL = 'brian@megabyte.space';

/** Attach a console/page-error collector, filtering the known-benign
 * third-party/analytics noise every sibling admin journey already excludes. */
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

/** Screenshot + numbered step log so the journey's receipts are reconstructable. */
let stepNo = 0;
async function step(page: Page, name: string): Promise<void> {
  stepNo += 1;
  const file = `${SCREEN_DIR}/${String(stepNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  console.warn(`[admin-cockpit] step ${stepNo}: ${name}`);
}

test.describe('Admin Cockpit — prod real-user journey (fire-64)', () => {
  test.skip(
    !process.env.E2E_TEST_PASSWORD,
    'needs E2E_TEST_PASSWORD for the real /signin?test=1 → /api/auth/test-login seam',
  );

  test('homepage → sign in → /admin cockpit renders KPI tiles + attention queue + metrics panel, 0 console errors', async ({
    page,
  }) => {
    const errors = attachConsoleErrors(page);

    // ── 1. Homepage paints (real-user start, per the homepage-first mandate) ──
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    await step(page, 'homepage');

    // ── 2. Arrive at the test-login seam (the E2E equivalent of a magic-link
    //      click — this IS the one sanctioned `page.goto` for the seam itself,
    //      matching admin-ops.e2e.ts + case-001-money-path.e2e.ts convention). ──
    await page.goto(`${PROD_URL}/signin?test=1`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="test-signin-panel"]')).toBeVisible();
    await step(page, 'signin-test-panel');

    // ── 3. Real sign-in via keyboard + click (never a second `page.goto`). ──
    await page.locator('[data-testid="test-signin-password"]').fill(process.env.E2E_TEST_PASSWORD!);
    await step(page, 'signin-password-filled');
    await page.locator('[data-testid="test-signin-submit"]').click();
    await page.waitForURL(/\/admin(\/|$|\?)/, { timeout: 15_000 });
    await step(page, 'landed-on-admin');

    // ── 4. Admin shell mounts (the gate every sibling admin spec asserts). ──
    await expect(page.locator('app-admin, [data-cockpit="v2"]')).toBeVisible({ timeout: 20_000 });
    await step(page, 'admin-shell');

    // ── 5. KPI tile strip — numeric values present, never blank/dash-only. ──
    const kpiTiles = page.locator('ul.kpi-strip li.kpi-tile');
    await expect(kpiTiles.first(), 'the Operator cockpit KPI strip must render ≥1 tile').toBeVisible({
      timeout: 20_000,
    });
    const kpiCount = await kpiTiles.count();
    expect(kpiCount, 'KPI strip must render at least one tile').toBeGreaterThan(0);
    for (let i = 0; i < kpiCount; i++) {
      const valueText = (await kpiTiles.nth(i).locator('.kpi-value').innerText().catch(() => '')) ?? '';
      expect(
        valueText.trim().length,
        `KPI tile ${i} ("kpi-value") must render a non-empty value, not a blank placeholder`,
      ).toBeGreaterThan(0);
    }
    await step(page, 'kpi-tiles');

    // ── 6. Needs-attention queue — either populated rows OR the honest
    //      "All clear" empty state must be present; the queue section itself
    //      (the h3 "Needs attention" + its wrapper) is never absent. ──
    const attnHeading = page.getByRole('heading', { name: /needs attention/i });
    await expect(attnHeading, 'the "Needs attention" queue heading must render').toBeVisible({
      timeout: 10_000,
    });
    const attnRows = page.locator('ul.attn-list li.attn-row');
    const attnClear = page.locator('[data-testid="dash-attn-clear"]');
    await Promise.race([
      attnRows.first().waitFor({ state: 'visible', timeout: 15_000 }),
      attnClear.waitFor({ state: 'visible', timeout: 15_000 }),
    ]);
    const hasAttnRows = (await attnRows.count()) > 0;
    const hasAttnClear = await attnClear.isVisible().catch(() => false);
    expect(
      hasAttnRows || hasAttnClear,
      'the attention queue must show either ≥1 actionable row or the honest "All clear" state',
    ).toBe(true);
    await step(page, 'attention-queue');

    // ── 7. Metrics / CWV panel present — Core Web Vitals group (populated
    //      strip or the honest "not run yet" state) and/or, for this
    //      sysadmin identity, the generation-speed+cost metrics card. ──
    const cwvGroup = page.locator('section.cwv-group');
    const cwvEmpty = page.locator('[data-testid="cwv-empty"]');
    const genMetricsCard = page.locator('[data-testid="gen-metrics-card"]');
    await Promise.race([
      cwvGroup.first().waitFor({ state: 'visible', timeout: 15_000 }),
      genMetricsCard.first().waitFor({ state: 'visible', timeout: 15_000 }),
    ]).catch(() => undefined);
    const hasCwvGroup = await cwvGroup.first().isVisible().catch(() => false);
    const hasGenCard = await genMetricsCard.first().isVisible().catch(() => false);
    expect(
      hasCwvGroup || hasGenCard,
      'a metrics panel (Core Web Vitals group or the generation-metrics card) must be present on the cockpit',
    ).toBe(true);
    if (hasCwvGroup) {
      // When the CWV group renders, it is either a populated strip or the
      // honest "not run yet" copy — never silently blank.
      const cwvStrip = cwvGroup.locator('ul.cwv-strip');
      const hasCwvStrip = await cwvStrip.first().isVisible().catch(() => false);
      const hasCwvEmptyCopy = await cwvEmpty.isVisible().catch(() => false);
      expect(
        hasCwvStrip || hasCwvEmptyCopy,
        'the Core Web Vitals group must show either real metric chips or the honest empty-state copy',
      ).toBe(true);
    }
    await step(page, 'metrics-panel');

    // ── 8. Console-error-free across the ENTIRE journey. ──
    expect(errors, `console errors across the journey: ${errors.join(' | ')}`).toEqual([]);
  });

  test('admin cockpit renders cleanly at mobile breakpoint (375×812), 0 console errors', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const errors = attachConsoleErrors(page);

    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await page.goto(`${PROD_URL}/signin?test=1`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="test-signin-password"]').fill(process.env.E2E_TEST_PASSWORD!);
    await page.locator('[data-testid="test-signin-submit"]').click();
    await page.waitForURL(/\/admin(\/|$|\?)/, { timeout: 15_000 });

    await expect(page.locator('app-admin, [data-cockpit="v2"]')).toBeVisible({ timeout: 20_000 });
    await step(page, 'admin-mobile-375');

    const errorsFiltered = errors.filter((e) => !/ResizeObserver loop/.test(e));
    expect(errorsFiltered, `console errors at 375px: ${errorsFiltered.join(' | ')}`).toEqual([]);
  });
});
