/**
 * RETIRED 2026-09-20 (AL-831) — tested the DELETED vanilla homepage "Details Modal" (business/custom
 * mode, build submission, upload, AI validation), removed with vanilla `public/index.html` on
 * 2026-07-31. That step is now the Angular `/create` wizard, covered by: `home/create-wizard.spec.ts`,
 * `admin-verify/verify-create-wizard.mjs`, and `golden-path.spec.ts` (the full create→build flow).
 * Skipped (not deleted, per e2e-accumulation) — the old body was a false-green phantom (dead
 * `#screen-*`/`#details-*` selectors, green only vs the stale `sites-staging.megabyte.space` shard).
 * A 1:1 rewrite would duplicate the modern create-wizard coverage above.
 */
import { test, expect } from './fixtures.js';

test.describe.skip('Details Modal Opening', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#screen-search')).toBeVisible({ timeout: 10_000 });
  });

  test('details modal overlay exists in DOM', async ({ page }) => {
    const modal = page.locator('#details-modal');
    await expect(modal).toBeAttached();
  });

  test('details modal is hidden by default', async ({ page }) => {
    const modal = page.locator('#details-modal');
    const cls = await modal.getAttribute('class');
    expect(cls).not.toContain('visible');
  });

  test('selecting a search result opens details modal', async ({ page }) => {
    const input = page.locator('#search-input');
    await input.fill('Pizza');

    const dropdown = page.locator('#search-dropdown');
    await expect(dropdown).toHaveClass(/open/, { timeout: 5_000 });

    const result = dropdown.locator('.search-result').first();
    await result.click();

    const modal = page.locator('#details-modal.visible');
    await expect(modal.first()).toBeVisible({ timeout: 5_000 });
  });

  test('selecting Custom Website opens details modal in custom mode', async ({ page }) => {
    const input = page.locator('#search-input');
    await input.fill('My Business');

    const dropdown = page.locator('#search-dropdown');
    await expect(dropdown).toHaveClass(/open/, { timeout: 5_000 });

    const customOption = dropdown.locator('.search-result-custom');
    await customOption.click();

    const modal = page.locator('#details-modal.visible');
    await expect(modal.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe.skip('Details Modal Content', () => {
  async function openDetailsModal(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.locator('#screen-search')).toBeVisible({ timeout: 10_000 });

    const input = page.locator('#search-input');
    await input.fill('Pizza');

    const dropdown = page.locator('#search-dropdown');
    await expect(dropdown).toHaveClass(/open/, { timeout: 5_000 });

    const result = dropdown.locator('.search-result').first();
    await result.click();

    await expect(page.locator('#details-modal.visible').first()).toBeVisible({ timeout: 5_000 });
  }

  test('details modal has title heading', async ({ page }) => {
    await openDetailsModal(page);
    const nameEl = page.locator('#details-title');
    await expect(nameEl).toBeAttached();
  });

  test('details modal has description/context textarea', async ({ page }) => {
    await openDetailsModal(page);
    const textarea = page.locator('#details-textarea, #business-context, textarea');
    await expect(textarea.first()).toBeAttached();
  });

  test('details modal has build/submit button', async ({ page }) => {
    await openDetailsModal(page);
    const submitBtn = page.locator('#build-btn, [onclick*="submitBuild"], .details-submit-btn');
    await expect(submitBtn.first()).toBeAttached();
  });

  test('details modal has file upload area', async ({ page }) => {
    await openDetailsModal(page);
    // Uppy dashboard or file upload area
    const uploadArea = page.locator('#uppy-dashboard, .uppy-Dashboard, #file-upload, [class*="upload"]');
    await expect(uploadArea.first()).toBeAttached();
  });

  test('details modal can be closed via close button', async ({ page }) => {
    await openDetailsModal(page);

    const closeBtn = page.locator('.details-modal-close');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await page.waitForTimeout(500);

    // Modal should lose the .visible class
    const modalClass = await page.locator('#details-modal').getAttribute('class');
    expect(modalClass).not.toContain('visible');
  });
});

test.describe.skip('Details Modal Business Mode', () => {
  test('business badge appears for Google Places results', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#screen-search')).toBeVisible({ timeout: 10_000 });

    const input = page.locator('#search-input');
    await input.fill('Vito');

    const dropdown = page.locator('#search-dropdown');
    await expect(dropdown).toHaveClass(/open/, { timeout: 5_000 });

    const result = dropdown.locator('.search-result').first();
    await result.click();

    await expect(page.locator('#details-modal.visible').first()).toBeVisible({ timeout: 5_000 });

    // Business badge should be present for Google Places result
    const badge = page.locator('.business-badge, #details-business-badge, [class*="badge"]');
    // May or may not be visible depending on implementation
    await expect(badge.first()).toBeAttached();
  });
});

test.describe.skip('Details Modal Custom Mode', () => {
  async function openCustomDetails(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.locator('#screen-search')).toBeVisible({ timeout: 10_000 });

    const input = page.locator('#search-input');
    await input.fill('My Custom Site');

    const dropdown = page.locator('#search-dropdown');
    await expect(dropdown).toHaveClass(/open/, { timeout: 5_000 });

    const customOption = dropdown.locator('.search-result-custom');
    await customOption.click();

    await expect(page.locator('#details-modal.visible').first()).toBeVisible({ timeout: 5_000 });
  }

  test('custom mode shows business name input field', async ({ page }) => {
    await openCustomDetails(page);
    const nameInput = page.locator('#details-business-name-input, #manual-business-name, input[placeholder*="business name" i]');
    await expect(nameInput.first()).toBeAttached();
  });

  test('custom mode shows address input field', async ({ page }) => {
    await openCustomDetails(page);
    const addrInput = page.locator('#details-address-input, #manual-address, input[placeholder*="address" i]');
    await expect(addrInput.first()).toBeAttached();
  });
});

test.describe.skip('Details Modal AI Features', () => {
  test('improveWithAI function is defined', async ({ page }) => {
    await page.goto('/');
    const hasFn = await page.evaluate(() => {
      return typeof (window as unknown as Record<string, unknown>).improveWithAI === 'function';
    });
    expect(hasFn).toBe(true);
  });

  test('AI validation tooltip functions exist', async ({ page }) => {
    await page.goto('/');
    const fns = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        show: typeof w.showAiValidationTooltip === 'function',
        hide: typeof w.hideAiValidationTooltip === 'function',
      };
    });
    expect(fns.show).toBe(true);
    expect(fns.hide).toBe(true);
  });
});

test.describe.skip('Build Submission', () => {
  test('submitBuild function is defined', async ({ page }) => {
    await page.goto('/');
    const hasFn = await page.evaluate(() => {
      return typeof (window as unknown as Record<string, unknown>).submitBuild === 'function';
    });
    expect(hasFn).toBe(true);
  });

  test('createSiteFromSearch function is defined', async ({ page }) => {
    await page.goto('/');
    const hasFn = await page.evaluate(() => {
      return typeof (window as unknown as Record<string, unknown>).createSiteFromSearch === 'function';
    });
    expect(hasFn).toBe(true);
  });
});
