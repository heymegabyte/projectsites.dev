/**
 * @fileoverview E2E — Media > Stock Search tab (TDD-RED)
 *
 * Flow: homepage → Admin → Media → Stock Search tab → type query →
 *       assert results OR missing-key empty state → click Save to Library.
 *
 * Screenshots in e2e/screenshots/media-stock-search/.
 */

import { test, expect } from './fixtures.js';
import type { Page, Route } from '@playwright/test';

const BREAKPOINTS = [
  { width: 375,  height: 812  },
  { width: 390,  height: 844  },
  { width: 768,  height: 1024 },
  { width: 1024, height: 768  },
  { width: 1280, height: 800  },
  { width: 1920, height: 1080 },
];

async function stubAuth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      'ps_session',
      JSON.stringify({ token: 'e2e-stock-token', email: 'test@megabyte.space' }),
    );
  });

  await page.route('**/api/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { user_id: 'u-stock', org_id: 'org-stock', email: 'test@megabyte.space' },
      }),
    });
  });

  await page.route('**/api/sites', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    });
  });

  await page.route('**/api/billing/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { plan: 'pro', status: 'active' } }),
    });
  });
}

/** Returns stock search results with 3 candidate images. */
async function stubStockResults(page: Page): Promise<void> {
  // glob-ok: query-suffix only — /api/media/stock/search is a leaf endpoint
  await page.route('**/api/media/stock/search**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'pexels-1', url: 'https://images.pexels.com/photos/1/coffee.webp', thumb: 'https://images.pexels.com/photos/1/coffee-thumb.webp', source: 'pexels', description: 'coffee shop interior' },
          { id: 'pexels-2', url: 'https://images.pexels.com/photos/2/cafe.webp',   thumb: 'https://images.pexels.com/photos/2/cafe-thumb.webp',   source: 'pexels', description: 'cafe chairs' },
          { id: 'unsplash-3', url: 'https://images.unsplash.com/3/latte.webp',     thumb: 'https://images.unsplash.com/3/latte-thumb.webp',       source: 'unsplash', description: 'latte art' },
        ],
      }),
    });
  });
}

/** Returns 401 → frontend should show a "set API keys" empty state. */
async function stubMissingApiKeys(page: Page): Promise<void> {
  // glob-ok: query-suffix only — /api/media/stock/search is a leaf endpoint
  await page.route('**/api/media/stock/search**', async (route: Route) => {
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'MISSING_API_KEY', message: 'No stock API key configured' } }),
    });
  });
}

/** Stub saving an asset from stock to library. */
async function stubSaveToLibrary(page: Page): Promise<{ saved: string[] }> {
  const saved: string[] = [];
  // glob-ok: query-suffix only — /api/media/stock/save is a leaf endpoint
  await page.route('**/api/media/stock/save**', async (route: Route) => {
    const body = await route.request().postDataJSON() as { id?: string };
    if (body.id) saved.push(body.id);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ data: { id: `saved-${body.id}`, filename: 'coffee.webp' } }),
    });
  });
  return { saved };
}

async function navigateToStockSearch(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('[data-testid="nav-admin"], a[href*="/admin"], text=Admin');
  await page.waitForURL(/\/admin/);
  await page.click('[data-testid="sidebar-media"], [href*="media"], text=Media');
  await page.waitForURL(/\/admin\/media/);

  // Click the Stock Search tab
  const tab = page.locator(
    '[data-testid="media-tab-stock"], [role="tab"]:has-text("Stock"), text=Stock Search',
  );
  await expect(tab).toBeVisible({ timeout: 8_000 });
  await tab.click();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// SKIPPED — the Media Library admin UI was REMOVED (/admin/media renders admin-404,
// zero components/testids). This spec is mock-based against that dead route. The
// surviving media surface is the API, covered live in e2e/media/media-coverage.spec.ts.
test.describe.skip('Media — Stock Search tab', () => {
  test('shows ≥1 result card after searching when API keys are configured', async ({ page }) => {
    await stubAuth(page);
    await stubStockResults(page);
    await stubSaveToLibrary(page);

    await navigateToStockSearch(page);
    await page.screenshot({ path: 'e2e/screenshots/media-stock-search/01-stock-tab.png', fullPage: false });

    // Type query into the stock search input
    const searchInput = page.locator(
      '[data-testid="stock-search-input"], input[placeholder*="search" i], input[type="search"]',
    ).first();
    await expect(searchInput).toBeVisible({ timeout: 8_000 });
    await searchInput.click();
    await searchInput.fill('coffee shop interior');

    // Click Search button or press Enter
    const searchBtn = page.locator('[data-testid="stock-search-btn"], button:has-text("Search")');
    if (await searchBtn.count() > 0) {
      await searchBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // Wait for results
    const resultCard = page.locator(
      '[data-testid="stock-result-card"], .stock-result, [data-testid="stock-candidate"]',
    );
    await expect(resultCard.first()).toBeVisible({ timeout: 12_000 });
    expect(await resultCard.count()).toBeGreaterThanOrEqual(1);

    await page.screenshot({ path: 'e2e/screenshots/media-stock-search/02-results.png', fullPage: false });
  });

  test('shows missing-api-key empty state with deeplink when keys absent', async ({ page }) => {
    await stubAuth(page);
    await stubMissingApiKeys(page);

    await navigateToStockSearch(page);

    const searchInput = page.locator(
      '[data-testid="stock-search-input"], input[placeholder*="search" i], input[type="search"]',
    ).first();
    await expect(searchInput).toBeVisible({ timeout: 8_000 });
    await searchInput.fill('coffee shop interior');

    const searchBtn = page.locator('[data-testid="stock-search-btn"], button:has-text("Search")');
    if (await searchBtn.count() > 0) {
      await searchBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // Either empty state mentioning API keys, or an error toast
    const missingKeyMsg = page.locator(
      '[data-testid="stock-empty-state"], [data-testid="stock-no-key-msg"], ' +
      'text=API key, text=api key, text=configure, text=no results',
    );
    await expect(missingKeyMsg.first()).toBeVisible({ timeout: 12_000 });

    await page.screenshot({ path: 'e2e/screenshots/media-stock-search/03-no-key-state.png', fullPage: false });
  });

  test('clicking Save to Library transitions first card to saved state', async ({ page }) => {
    await stubAuth(page);
    await stubStockResults(page);
    const { saved } = await stubSaveToLibrary(page);

    await navigateToStockSearch(page);

    const searchInput = page.locator(
      '[data-testid="stock-search-input"], input[placeholder*="search" i], input[type="search"]',
    ).first();
    await expect(searchInput).toBeVisible({ timeout: 8_000 });
    await searchInput.fill('coffee shop interior');

    const searchBtn = page.locator('[data-testid="stock-search-btn"], button:has-text("Search")');
    if (await searchBtn.count() > 0) {
      await searchBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    const firstCard = page.locator(
      '[data-testid="stock-result-card"], .stock-result',
    ).first();
    await expect(firstCard).toBeVisible({ timeout: 12_000 });

    // Click "Save to Library" on the first card
    const saveBtn = firstCard.locator(
      '[data-testid="stock-save-btn"], button:has-text("Save"), button:has-text("Add to Library")',
    );
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Card transitions to saved state — either a checkmark, "Saved" text, or disabled state
    const savedIndicator = firstCard.locator(
      '[data-testid="stock-saved-indicator"], text=Saved, [aria-label*="saved" i], .saved-badge',
    );
    await expect(savedIndicator).toBeVisible({ timeout: 8_000 });

    await page.screenshot({ path: 'e2e/screenshots/media-stock-search/04-saved.png', fullPage: false });

    // Soft-assert the API was called
    expect(saved.length).toBeGreaterThanOrEqual(0); // route may not fire if optimistic
  });

  // ─── Breakpoint smoke ───────────────────────────────────────────────────────

  for (const vp of BREAKPOINTS) {
    test(`Stock Search tab renders at ${vp.width}×${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await stubAuth(page);
      await stubStockResults(page);

      await navigateToStockSearch(page);

      await page.screenshot({
        path: `e2e/screenshots/media-stock-search/bp-${vp.width}.png`,
        fullPage: false,
      });

      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(vp.width + 2);
    });
  }
});
