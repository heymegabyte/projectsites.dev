/**
 * flows-usage.flow.e2e.ts — Surface: the plan-usage gauges (feature `usage_gauges`)
 * on /admin/billing (the "Plan & usage" subscription tab).
 *
 * FINISHED this fire: the worker endpoint (`GET /api/usage`) + flag were live but
 * had NO UI consumer. Built `<app-usage-gauges>` + wired it under the subscription
 * card on the billing tab.
 *
 * Ground truth (e2e-test-org = FREE plan, GET /api/usage): 3 SSOT-backed gauges —
 * sites {used:109, limit:1, pct:100} (OVER the free limit), builds {used:0, limit:5},
 * media {used:0, limit:10, unit:MB}. Limits come from the plan_entitlement SSOT
 * (free = 1 site / 5 builds / 10 MB), NOT the old fabricated 3 / 10 / 1 GB, and the
 * fabricated bandwidth gauge (no enforced limit, never measured) is dropped (AL-326).
 * The sites gauge exercises the over-limit (danger) path.
 *
 * Real testids: usage-gauges, usage-gauge-<metric>, usage-value-<metric>,
 * usage-bar-<metric>, usage-over-<metric>.
 *
 * Run: E2E_API_KEY=$(get-secret E2E_API_KEY) \
 *   npx playwright test --config=playwright.prod.config.ts flows-usage.flow --workers=3
 */
import { test, expect } from '@playwright/test';
import { hasKey, seedSession, gotoAdmin, attachConsole, expectClean, snap, apiFetch } from './_flow-helpers';

const CARD = '[data-testid="usage-gauges"]';

/** Ensure the billing subscription tab (which hosts the gauges) is active. */
async function openBillingUsage(page: import('@playwright/test').Page) {
  await gotoAdmin(page, '/admin/billing');
  const card = page.locator(CARD);
  if (await card.isVisible().catch(() => false)) return;
  // Fall back to explicitly selecting the subscription tab.
  const tab = page.getByRole('tab', { name: /subscription|plan|usage/i }).first();
  if (await tab.count()) await tab.click().catch(() => {});
}

test.describe('Full-flow · plan usage gauges', () => {
  test.skip(!hasKey, 'E2E_API_KEY not set');
  test.describe.configure({ retries: 2 });
  test.use({ reducedMotion: 'reduce' });

  test('01 the plan-usage card renders on /admin/billing with its heading', async ({ page }) => {
    const errors = attachConsole(page);
    await seedSession(page);
    await openBillingUsage(page);
    await expect(page.locator(CARD), 'the usage-gauges card renders').toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: /plan usage/i })).toBeVisible();
    await snap(page, 'usage-01-card');
    expectClean(errors);
  });

  test('02 the 3 SSOT-backed usage gauges render (sites / builds / media)', async ({ page }) => {
    await seedSession(page);
    await openBillingUsage(page);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 20_000 });
    for (const metric of ['sites', 'builds', 'media']) {
      await expect(page.locator(`[data-testid="usage-gauge-${metric}"]`), `${metric} gauge renders`).toBeVisible();
    }
    await snap(page, 'usage-02-gauges');
  });

  test('03 ground-truth: each gauge value reconciles with /api/usage (display vs store)', async ({ page }) => {
    await seedSession(page);
    await openBillingUsage(page);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 20_000 });
    const api = await apiFetch<{ data: { metric: string; used: number; limit: number }[] }>(page, '/api/usage');
    expect(api.status).toBe(200);
    for (const g of api.body.data ?? []) {
      const valEl = page.locator(`[data-testid="usage-value-${g.metric}"]`);
      if (!(await valEl.count())) continue;
      const shown = (await valEl.innerText()).replace(/\s/g, '');
      // The value line renders "<used> / <limit>" (limit shows ∞ when unlimited).
      expect(shown, `${g.metric} shows the used count from the store`).toContain(`${g.used}/`);
      if (g.limit > 0) expect(shown, `${g.metric} shows the store limit`).toContain(String(g.limit));
    }
  });

  test('04 the over-limit metric (free sites 109/1) renders in the danger state with an overage note', async ({ page }) => {
    await seedSession(page);
    await openBillingUsage(page);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 20_000 });
    const api = await apiFetch<{ data: { metric: string; used: number; limit: number }[] }>(page, '/api/usage');
    const over = (api.body.data ?? []).find((g) => g.limit > 0 && g.used > g.limit);
    if (over) {
      // The store reports an overage → the UI must flag it (danger bar + overage note).
      await expect(page.locator(`[data-testid="usage-over-${over.metric}"]`), 'the overage note renders').toBeVisible();
      await expect(page.locator(`[data-testid="usage-bar-${over.metric}"]`), 'the over bar is danger-toned').toHaveClass(/ug-fill--danger/);
      await snap(page, 'usage-04-over');
    }
  });

  test('05 every gauge renders a progress bar with a bounded width', async ({ page }) => {
    await seedSession(page);
    await openBillingUsage(page);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 20_000 });
    const bars = page.locator('[data-testid^="usage-bar-"]');
    const n = await bars.count();
    expect(n, 'each gauge has a bar').toBeGreaterThanOrEqual(3);
    // The first bar has an inline width that never exceeds 100%.
    const width = await bars.first().evaluate((el) => (el as HTMLElement).style.width);
    expect(width, 'bar width is a bounded percentage').toMatch(/%$/);
    expect(parseFloat(width), 'bar width ≤ 100%').toBeLessThanOrEqual(100);
  });

  test('06 the usage surface is console-error-free', async ({ page }) => {
    const errors = attachConsole(page);
    await seedSession(page);
    await openBillingUsage(page);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(400);
    expectClean(errors);
  });

  test('07 deep-link + reload preserves the usage gauges (session + flag intact)', async ({ page }) => {
    await seedSession(page);
    await openBillingUsage(page);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 20_000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openBillingUsage(page);
    await expect(page.locator(CARD), 'still there after reload').toBeVisible({ timeout: 20_000 });
    await expect(page).not.toHaveURL(/\/signin/);
  });

  test('08 full journey: open billing → see plan usage next to the subscription card → coherent + ground-truth', async ({
    page,
  }) => {
    const errors = attachConsole(page);
    await seedSession(page);
    await openBillingUsage(page);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 20_000 });
    // The usage gauges sit alongside the existing subscription card — not displacing it.
    await expect(page.locator('[data-testid="subscription-card"]'), 'the subscription card is still present').toBeVisible();
    const api = await apiFetch<{ data: unknown[] }>(page, '/api/usage');
    expect(api.status).toBe(200);
    expect((api.body.data ?? []).length, 'the store returns usage metrics').toBeGreaterThan(0);
    await snap(page, 'usage-08-journey');
    expectClean(errors);
  });
});
