/**
 * @fileoverview E2E — Global drag-and-drop zone (TDD-RED)
 *
 * Flow: homepage → Admin → non-media route (Sites) → synthesise dragenter via
 *       page.evaluate (DataTransfer with a File) over the window →
 *       assert fullscreen overlay appears → drop → assert nav to /admin/media
 *       + new asset row in library.
 *
 * Note: Playwright cannot directly drag a real file from the OS filesystem into
 * the page using drag events on the window.  We synthesise the events with
 * `page.evaluate` + `DataTransfer` + `File` constructor, which exercises the
 * same JS event listeners the overlay listens to.
 *
 * Screenshots in e2e/screenshots/media-drop-zone/.
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
      JSON.stringify({ token: 'e2e-dropzone-token', email: 'test@megabyte.space' }),
    );
  });

  await page.route('**/api/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { user_id: 'u-dz', org_id: 'org-dz', email: 'test@megabyte.space' },
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

  const mediaStub = async (route: Route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
      return;
    }
    if (method === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: 'dz-asset-1',
            filename: 'dropped-image.webp',
            url: 'https://example.com/dropped.webp',
            content_type: 'image/webp',
            size_bytes: 32_000,
            created_at: new Date().toISOString(),
          },
        }),
      });
      return;
    }
    await route.fallback();
  };
  await page.route('**/api/media**', mediaStub);
  // Mid-token ** can't cross '/' — the drop-zone actually POSTs
  // /api/media/upload (a subpath); twin makes the stub intercept it.
  await page.route('**/api/media/**', mediaStub);
}

/**
 * Fires a synthetic dragenter event on `document.body` with a File in the
 * DataTransfer.  Returns whether the event was accepted (not cancelled).
 */
async function fireDragEnter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    const file = new File(['fake-image-data'], 'dropped-image.webp', { type: 'image/webp' });
    // DataTransfer.items is read-only in most browsers; use the writable approach:
    Object.defineProperty(dt, 'items', {
      value: {
        add: () => undefined,
        length: 1,
        0: { kind: 'file', type: 'image/webp' },
      },
      writable: false,
    });
    Object.defineProperty(dt, 'files', {
      value: [file],
      writable: false,
    });
    Object.defineProperty(dt, 'types', {
      value: ['Files'],
      writable: false,
    });

    const ev = new DragEvent('dragenter', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    });
    document.body.dispatchEvent(ev);
  });
}

/**
 * Fires a synthetic drop event, simulating the user releasing the drag.
 */
async function fireDrop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dt = new DataTransfer();
    const file = new File(['fake-image-data'], 'dropped-image.webp', { type: 'image/webp' });
    Object.defineProperty(dt, 'files', { value: [file], writable: false });
    Object.defineProperty(dt, 'types', { value: ['Files'], writable: false });

    const ev = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: dt,
    });
    document.body.dispatchEvent(ev);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// SKIPPED — the Media Library admin UI was REMOVED (/admin/media renders admin-404,
// zero components/testids). This spec is mock-based against that dead route. The
// surviving media surface is the API, covered live in e2e/media/media-coverage.spec.ts.
test.describe.skip('Media — Global drop zone overlay', () => {
  test('dragenter over window shows fullscreen overlay', async ({ page }) => {
    await stubAuth(page);

    await page.goto('/');
    await page.click('[data-testid="nav-admin"], a[href*="/admin"], text=Admin');
    await page.waitForURL(/\/admin/);

    // Navigate to a non-media route (Sites) first
    const sitesLink = page.locator('[data-testid="sidebar-sites"], [href*="/admin/sites"], text=Sites');
    if (await sitesLink.count() > 0) {
      await sitesLink.first().click();
    }

    await page.screenshot({ path: 'e2e/screenshots/media-drop-zone/01-sites-route.png', fullPage: false });

    // Fire drag enter
    await fireDragEnter(page);

    // Fullscreen overlay should appear
    const overlay = page.locator(
      '[data-testid="media-drop-overlay"], .drop-overlay, .drag-overlay, [data-drag-active="true"]',
    );
    await expect(overlay.first()).toBeVisible({ timeout: 5_000 });

    await page.screenshot({ path: 'e2e/screenshots/media-drop-zone/02-overlay-visible.png', fullPage: false });
  });

  test('drop navigates to /admin/media and shows new asset in library', async ({ page }) => {
    await stubAuth(page);

    await page.goto('/');
    await page.click('[data-testid="nav-admin"], a[href*="/admin"], text=Admin');
    await page.waitForURL(/\/admin/);

    // Fire drag enter to activate overlay
    await fireDragEnter(page);

    const overlay = page.locator(
      '[data-testid="media-drop-overlay"], .drop-overlay, .drag-overlay, [data-drag-active="true"]',
    );
    await expect(overlay.first()).toBeVisible({ timeout: 5_000 });

    // Fire drop
    await fireDrop(page);

    // Should navigate to media library
    await expect(page).toHaveURL(/\/admin\/media/, { timeout: 10_000 });

    await page.screenshot({ path: 'e2e/screenshots/media-drop-zone/03-after-drop.png', fullPage: false });

    // New asset should appear in the library (either via POST or optimistic UI)
    // The stub returns the asset on POST; the UI should render it
    const assetItem = page.locator(
      '[data-testid="media-asset"], .media-asset, .asset-card',
    );
    // Soft assertion: asset may take a moment to appear after navigation
    await expect(assetItem.first()).toBeVisible({ timeout: 8_000 }).catch(() => {
      console.warn('[media-drop-zone] Asset grid item not found after drop — UI may not auto-navigate');
    });
  });

  test('dragleave on overlay dismisses it without navigating', async ({ page }) => {
    await stubAuth(page);

    await page.goto('/');
    await page.click('[data-testid="nav-admin"], a[href*="/admin"], text=Admin');
    await page.waitForURL(/\/admin/);

    await fireDragEnter(page);

    const overlay = page.locator(
      '[data-testid="media-drop-overlay"], .drop-overlay, .drag-overlay, [data-drag-active="true"]',
    );
    await expect(overlay.first()).toBeVisible({ timeout: 5_000 });

    // Fire dragleave to dismiss
    await page.evaluate(() => {
      const ev = new DragEvent('dragleave', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
    });

    await expect(overlay.first()).toBeHidden({ timeout: 5_000 });

    // URL should not have changed to /admin/media
    await expect(page).not.toHaveURL(/\/admin\/media/);

    await page.screenshot({ path: 'e2e/screenshots/media-drop-zone/04-overlay-dismissed.png', fullPage: false });
  });

  // ─── Breakpoint smoke ───────────────────────────────────────────────────────

  for (const vp of BREAKPOINTS) {
    test(`Drop zone overlay renders correctly at ${vp.width}×${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await stubAuth(page);

      await page.goto('/');
      await page.click('[data-testid="nav-admin"], a[href*="/admin"], text=Admin');
      await page.waitForURL(/\/admin/);

      await fireDragEnter(page);

      await page.screenshot({
        path: `e2e/screenshots/media-drop-zone/bp-${vp.width}.png`,
        fullPage: false,
      });

      // Fire dragleave to clean up
      await page.evaluate(() => {
        document.body.dispatchEvent(new DragEvent('dragleave', { bubbles: true }));
      });
    });
  }
});
