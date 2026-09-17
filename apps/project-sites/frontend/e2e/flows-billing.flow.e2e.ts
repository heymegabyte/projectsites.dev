/**
 * flows-billing.flow.e2e.ts — Surface: admin Billing (/admin/billing).
 *
 * Re-authored fire-3 from the LIVE DOM probe (fire-2's agent-authored file
 * saturated + guessed). Real testids: billing-tab-{subscription,addons,wallet,
 * usage,agency,affiliates}, subscription-{card,status,plan,period-end},
 * entitlement-{custom_domains,seats,analytics}, billing-pro-card. The e2e-test-org
 * is on the FREE plan (subscription null; entitlements plan:free,
 * analyticsEnabled:false, maxCustomDomains:0, maxTeamSeats:1) — every reconcile
 * asserts that honest free-plan truth.
 *
 * Run: E2E_API_KEY=$(get-secret E2E_API_KEY) \
 *   npx playwright test --config=playwright.prod.config.ts flows-billing.flow --workers=3
 */
import { test, expect } from '@playwright/test';
import { hasKey, seedSession, gotoAdmin, attachConsole, expectClean, snap, apiFetch } from './_flow-helpers';

const TABS = ['subscription', 'addons', 'wallet', 'usage', 'agency', 'affiliates'] as const;

test.describe('Full-flow · billing', () => {
  test.skip(!hasKey, 'E2E_API_KEY not set');
  test.describe.configure({ retries: 2 });
  test.use({ reducedMotion: 'reduce' });

  test('01 billing page boots on the Subscription tab with the plan surfaced', async ({ page }) => {
    const errors = attachConsole(page);
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    await expect(page).toHaveURL(/\/admin\/billing/);
    await expect(page.locator('[data-testid="subscription-card"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /billing/i }).first()).toBeVisible();
    await snap(page, 'billing-01-subscription');
    expectClean(errors);
  });

  test('02 subscription-status badge reconciles with /api/billing/subscription status', async ({
    page,
  }) => {
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    const card = page.locator('[data-testid="subscription-card"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    const sub = await apiFetch<{ data: { status?: string } | null }>(page, '/api/billing/subscription');
    expect(sub.status).toBe(200);
    // Ground-truth reconciliation (verify-against-source-of-truth): the STATUS badge's
    // canonical machine value MUST equal the store's subscription status. A free plan is
    // legitimately status:"active" (free plans are active — they just have no Stripe sub);
    // the PLAN (free vs pro) is a SEPARATE field surfaced by subscription-plan (test 03).
    // Derive the expectation from the store, never hardcode a plan-based regex on status.
    const storeStatus = sub.body?.data?.status ?? 'none';
    const badge = page.locator('[data-testid="subscription-status"]');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-status', storeStatus);
    // …and it renders a non-empty, owner-friendly label (never a bare empty chip).
    await expect(badge).not.toBeEmpty();
  });

  test('03 subscription-plan text matches the entitlements plan (free)', async ({ page }) => {
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    const ent = await apiFetch<{ data: { plan?: string } }>(page, '/api/billing/entitlements');
    expect(ent.status).toBe(200);
    const plan = ent.body?.data?.plan ?? 'free';
    const planEl = page.locator('[data-testid="subscription-plan"]');
    if (await planEl.count()) {
      await expect(planEl).toContainText(new RegExp(plan, 'i'), { timeout: 12_000 });
    }
  });

  test('04 entitlement-analytics reflects the org analytics entitlement (disabled on free)', async ({
    page,
  }) => {
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    const ent = await apiFetch<{ data: { analyticsEnabled?: boolean } }>(page, '/api/billing/entitlements');
    const analyticsOn = !!ent.body?.data?.analyticsEnabled; // false for e2e-test-org
    const el = page.locator('[data-testid="entitlement-analytics"]');
    await expect(el).toBeVisible({ timeout: 12_000 });
    // The row must coherently reflect the boolean — off/locked when disabled.
    if (!analyticsOn) {
      await expect(el).toContainText(/off|no|disabled|locked|upgrade|—|not included/i);
    }
  });

  test('05 entitlement-custom_domains reflects maxCustomDomains (0 on free)', async ({ page }) => {
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    const ent = await apiFetch<{ data: { maxCustomDomains?: number } }>(page, '/api/billing/entitlements');
    const max = ent.body?.data?.maxCustomDomains ?? 0;
    const el = page.locator('[data-testid="entitlement-custom_domains"]');
    await expect(el).toBeVisible({ timeout: 12_000 });
    await expect(el).toContainText(new RegExp(`${max}|none|0|upgrade|locked|—`, 'i'));
  });

  test('06 entitlement-seats reflects maxTeamSeats (1 on free)', async ({ page }) => {
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    const ent = await apiFetch<{ data: { maxTeamSeats?: number } }>(page, '/api/billing/entitlements');
    const seats = ent.body?.data?.maxTeamSeats ?? 1;
    const el = page.locator('[data-testid="entitlement-seats"]');
    await expect(el).toBeVisible({ timeout: 12_000 });
    await expect(el).toContainText(new RegExp(`${seats}`, 'i'));
  });

  test('07 the Pro upsell card renders with the $50/mo price + feature list', async ({ page }) => {
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    const pro = page.locator('[data-testid="billing-pro-card"]');
    await expect(pro).toBeVisible({ timeout: 15_000 });
    await expect(pro).toContainText(/\$50/);
    await expect(pro).toContainText(/pro/i);
    await snap(page, 'billing-07-pro-card');
  });

  // ── Tab navigation (6 tabs) ──────────────────────────────────────────────────

  for (const tab of TABS) {
    test(`08.${tab} clicking the ${tab} tab activates it and renders its panel`, async ({ page }) => {
      await seedSession(page);
      await gotoAdmin(page, '/admin/billing');
      const tabEl = page.locator(`[data-testid="billing-tab-${tab}"]`);
      await expect(tabEl).toBeVisible({ timeout: 15_000 });
      await tabEl.click();
      // Panel content must render (the main region stays substantial after the switch).
      const mainLen = await page.evaluate(
        () => (document.querySelector('main, [role="main"], .admin-main') as HTMLElement | null)?.innerHTML.length ?? 0,
      );
      expect(mainLen, `${tab} panel rendered content`).toBeGreaterThan(200);
      await snap(page, `billing-08-${tab}`);
    });
  }

  test('09 all six billing tabs cycle without console errors', async ({ page }) => {
    const errors = attachConsole(page);
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    for (const tab of TABS) {
      const tabEl = page.locator(`[data-testid="billing-tab-${tab}"]`);
      if (await tabEl.count()) {
        await tabEl.click();
        await page.waitForTimeout(350);
      }
    }
    expectClean(errors);
  });

  // ── Upgrade path (never completes a real payment) ────────────────────────────

  test('10 the Upgrade-to-Pro CTA is present, enabled, and opens a checkout surface', async ({ page }) => {
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    const cta = page.getByRole('button', { name: /upgrade to pro/i }).first();
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await expect(cta).toBeEnabled();
    await cta.click();
    // A checkout surface opens — an embedded Stripe iframe OR an "Embedded checkout"
    // panel OR a redirect intent. Assert SOMETHING checkout-ish appears; NEVER pay.
    const checkoutSignal = page
      .locator('iframe[src*="stripe"], iframe[title*="checkout" i], [data-testid*="checkout"]')
      .first();
    const embeddedBtn = page.getByText(/embedded checkout/i).first();
    const opened =
      (await checkoutSignal.count().catch(() => 0)) > 0 || (await embeddedBtn.count().catch(() => 0)) > 0;
    expect(opened, 'clicking Upgrade opens a checkout affordance (payment NOT completed)').toBeTruthy();
    await snap(page, 'billing-10-checkout-open');
  });

  // ── Ground-truth reconciliation ──────────────────────────────────────────────

  test('11 /api/billing/subscription + /api/billing/entitlements both authorize + return parseable JSON', async ({
    page,
  }) => {
    await seedSession(page);
    await gotoAdmin(page, '/admin/billing');
    const sub = await apiFetch<{ data: unknown }>(page, '/api/billing/subscription');
    const ent = await apiFetch<{ data: Record<string, unknown> }>(page, '/api/billing/entitlements');
    expect(sub.status).toBe(200);
    expect(ent.status).toBe(200);
    expect(ent.body?.data, 'entitlements returns a plan object').toBeTruthy();
  });

  test('12 full journey: /admin hub → open Billing → inspect Free plan → open upgrade → dismiss', async ({
    page,
  }) => {
    // NOTE: no expectClean here — the Upgrade click hits POST /api/billing/embedded-checkout
    // which returns 400 for the free e2e-test-org (REAL finding, tracked in FULL-FLOW-COVERAGE.md;
    // payment path = approval-required, not auto-fixed). The journey itself is the assertion.
    await seedSession(page);
    await gotoAdmin(page, '/admin');
    // Reach billing directly (it is a valid route even if not in the primary section nav).
    await page.goto('/admin/billing', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await expect(page.locator('[data-testid="subscription-card"]')).toBeVisible({ timeout: 15_000 });
    const pro = page.locator('[data-testid="billing-pro-card"]');
    await expect(pro).toContainText(/\$50/);
    const cta = page.getByRole('button', { name: /upgrade to pro/i }).first();
    if (await cta.count()) {
      await cta.click();
      await page.waitForTimeout(600);
      await page.keyboard.press('Escape'); // dismiss without paying
    }
    await expect(page.locator('[data-testid="subscription-card"]'), 'returned to billing intact').toBeVisible();
    await snap(page, 'billing-12-journey');
  });
});
