/**
 * @fileoverview E2E — Media > Image Studio tab (TDD-RED)
 *
 * Flow: homepage → Admin → Media → Image Studio → type prompt → set size →
 *       click Generate → assert spinner copy → assert image OR graceful error.
 *
 * When OPENAI_API_KEY is absent from the worker env, the API returns 503.
 * The test covers both the happy path (mocked) and the graceful-error path.
 *
 * Screenshots in e2e/screenshots/media-image-studio/.
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
      JSON.stringify({ token: 'e2e-studio-token', email: 'test@megabyte.space' }),
    );
  });

  await page.route('**/api/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { user_id: 'u-img', org_id: 'org-img', email: 'test@megabyte.space' },
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

/** Stubs image generation to return a generated image URL. */
async function stubGenerateSuccess(page: Page): Promise<void> {
  const successStub = async (route: Route) => {
    // Simulate a 1s delay to exercise the loading spinner
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: 'gen-img-1',
          url: 'https://oaidalleapiprodscus.blob.core.windows.net/generated/img.png',
          prompt: 'minimalist logo for a tea house',
          size: '1024x1024',
          model: 'dall-e-3',
        },
      }),
    });
  };
  await page.route('**/api/media/generate**', successStub);
  // Mid-token ** can't cross '/' — the studio actually POSTs
  // /api/media/generate/image (a subpath); twin makes the stub intercept it.
  await page.route('**/api/media/generate/**', successStub);
}

/** Stubs image generation to return a 502 (missing API key scenario). */
async function stubGenerateError(page: Page): Promise<void> {
  const errorStub = async (route: Route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'AI_GENERATION_ERROR', message: 'OPENAI_API_KEY is not configured' },
      }),
    });
  };
  await page.route('**/api/media/generate**', errorStub);
  // Mid-token ** can't cross '/' — twin covers /api/media/generate/image
  await page.route('**/api/media/generate/**', errorStub);
}

async function navigateToImageStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('[data-testid="nav-admin"], a[href*="/admin"], text=Admin');
  await page.waitForURL(/\/admin/);
  await page.click('[data-testid="sidebar-media"], [href*="media"], text=Media');
  await page.waitForURL(/\/admin\/media/);

  const tab = page.locator(
    '[data-testid="media-tab-image-studio"], [role="tab"]:has-text("Image Studio"), text=Image Studio',
  );
  await expect(tab).toBeVisible({ timeout: 8_000 });
  await tab.click();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// SKIPPED — the Media Library admin UI was REMOVED (/admin/media renders admin-404,
// zero components/testids). This spec is mock-based against that dead route. The
// surviving media surface is the API, covered live in e2e/media/media-coverage.spec.ts.
test.describe.skip('Media — Image Studio tab', () => {
  test('Generate button triggers loading spinner then shows generated image', async ({ page }) => {
    await stubAuth(page);
    await stubGenerateSuccess(page);

    await navigateToImageStudio(page);
    await page.screenshot({ path: 'e2e/screenshots/media-image-studio/01-studio-tab.png', fullPage: false });

    // Locate the prompt textarea
    const promptInput = page.locator(
      '[data-testid="image-studio-prompt"], textarea[placeholder*="prompt" i], textarea[placeholder*="describe" i]',
    ).first();
    await expect(promptInput).toBeVisible({ timeout: 8_000 });
    await promptInput.click();
    await promptInput.fill('minimalist logo for a tea house');

    // Set size if selector exists
    const sizeSelect = page.locator(
      '[data-testid="image-studio-size"], select[name*="size" i], [aria-label*="size" i]',
    );
    if (await sizeSelect.count() > 0) {
      await sizeSelect.selectOption('1024x1024');
    }

    // Click Generate
    const generateBtn = page.locator(
      '[data-testid="image-studio-generate"], button:has-text("Generate"), button:has-text("Create")',
    ).first();
    await expect(generateBtn).toBeEnabled();
    await generateBtn.click();

    // Spinner / loading copy should appear
    const spinner = page.locator(
      '[data-testid="image-studio-spinner"], [aria-label*="generating" i], text=Generating, text=generating',
    );
    // Spinner is transient — soft-check (may have already resolved by the time we assert)
    const spinnerVisible = await spinner.isVisible({ timeout: 3_000 }).catch(() => false);

    // If spinner text contains "DALL-E 3", great; but the key assertion is the result
    if (spinnerVisible) {
      const spinnerText = await spinner.first().textContent();
      expect(spinnerText?.toLowerCase()).toMatch(/generat|dall|loading/);
    }

    // Final state: generated image appears
    const generatedImg = page.locator(
      '[data-testid="image-studio-result"] img, .generated-image, [data-testid="generated-image"]',
    );
    await expect(generatedImg.first()).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: 'e2e/screenshots/media-image-studio/02-generated.png', fullPage: false });
  });

  test('surfaces a graceful error toast when API key is missing (502/503 scenario)', async ({ page }) => {
    await stubAuth(page);
    await stubGenerateError(page);

    await navigateToImageStudio(page);

    const promptInput = page.locator(
      '[data-testid="image-studio-prompt"], textarea[placeholder*="prompt" i], textarea[placeholder*="describe" i]',
    ).first();
    await expect(promptInput).toBeVisible({ timeout: 8_000 });
    await promptInput.fill('minimalist logo for a tea house');

    const generateBtn = page.locator(
      '[data-testid="image-studio-generate"], button:has-text("Generate"), button:has-text("Create")',
    ).first();
    await generateBtn.click();

    // Error toast or inline error should surface — not a blank crash
    const errorIndicator = page.locator(
      '[data-testid="toast-error"], [role="alert"], .toast-error, text=API key, ' +
      'text=not configured, text=failed, text=error',
    );
    await expect(errorIndicator.first()).toBeVisible({ timeout: 12_000 });

    await page.screenshot({ path: 'e2e/screenshots/media-image-studio/03-error-toast.png', fullPage: false });
  });

  test('Generate button is disabled while a generation is in progress', async ({ page }) => {
    await stubAuth(page);
    // Slow response to catch the in-flight disabled state
    const slowStub = async (route: Route) => {
      await new Promise((r) => setTimeout(r, 3_000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { id: 'gen-2', url: 'https://example.com/img.png' } }),
      });
    };
    await page.route('**/api/media/generate**', slowStub);
    // Mid-token ** can't cross '/' — twin covers /api/media/generate/image
    await page.route('**/api/media/generate/**', slowStub);

    await navigateToImageStudio(page);

    const promptInput = page.locator(
      '[data-testid="image-studio-prompt"], textarea[placeholder*="prompt" i]',
    ).first();
    await promptInput.fill('abstract mountain range');

    const generateBtn = page.locator(
      '[data-testid="image-studio-generate"], button:has-text("Generate"), button:has-text("Create")',
    ).first();
    await generateBtn.click();

    // Button should become disabled during generation
    await expect(generateBtn).toBeDisabled({ timeout: 5_000 });
  });

  // ─── Breakpoint smoke ───────────────────────────────────────────────────────

  for (const vp of BREAKPOINTS) {
    test(`Image Studio tab renders at ${vp.width}×${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await stubAuth(page);
      await stubGenerateSuccess(page);

      await navigateToImageStudio(page);

      await page.screenshot({
        path: `e2e/screenshots/media-image-studio/bp-${vp.width}.png`,
        fullPage: false,
      });

      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(vp.width + 2);
    });
  }
});
