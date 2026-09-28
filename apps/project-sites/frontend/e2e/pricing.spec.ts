import { test, expect } from '@playwright/test';

/**
 * Public /pricing page — asserts the exact-cost + flat-$50 model renders (hero
 * promise, the $50 fee, the 10-component breakdown, the competitor comparison)
 * and the CTAs point into the claim funnel. Deterministic, no external calls.
 */
test.describe('pricing page', () => {
  test('renders the exact-cost + $50 model', async ({ page }) => {
    await page.goto('/pricing');

    // One H1 carrying the headline promise.
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('You pay what it costs');

    // The rolling counter lands on 50; the flat-fee copy is present.
    await expect(page.getByText('$50', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('platform fee', { exact: false }).first()).toBeVisible();

    // The 10-component breakdown + a couple of opaque-tier competitors.
    await expect(page.getByRole('heading', { name: /sum of 10 things/i })).toBeVisible();
    await expect(page.getByText('Vercel', { exact: false })).toBeVisible();
    await expect(page.getByText('Squarespace', { exact: false })).toBeVisible();
  });

  test('both CTAs route into the claim funnel', async ({ page }) => {
    await page.goto('/pricing');

    for (const id of ['pricing-cta-hero', 'pricing-cta-footer']) {
      const cta = page.getByTestId(id);
      await expect(cta).toBeVisible();
      await expect(cta).toHaveAttribute('href', /\/search/);
    }
  });
});
