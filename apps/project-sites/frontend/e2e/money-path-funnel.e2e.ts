/**
 * Money-path funnel golden journey (TDD — E2E against production)
 *
 * Steps:
 *  1. Homepage loads — hero headline + search input visible
 *  2. Type "coffee" in search — results dropdown appears
 *  3. Search UI responds (results or degraded notice)
 *  4. Seed auth via in-page POST /api/auth/test-login + localStorage
 *  5. Navigate to /admin — shell loads, nav-create CTA visible + enabled
 *  6. Click nav-create → /admin/create overlay appears
 *     (DO NOT trigger a real AI build — stop here)
 *
 * Runs with: npx playwright test money-path-funnel --config=playwright.prod.config.ts
 *            --project=chromium --retries=0 --reporter=line
 */
import path from 'path';
import { getTestPassword } from './helpers/admin-auth';
import { test, expect, type Page } from '@playwright/test';

// ── Config ──────────────────────────────────────────────────────────────────
const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const TEST_EMAIL = 'brian@megabyte.space';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots', 'money-path-funnel');

const CONSOLE_NOISE = [
  'favicon',
  'posthog',
  'Failed to load resource',
  'stackblitz',
  'editor.projectsites.dev',
  'cdn-cgi',
  'cloudflareinsights',
  'beacon.min.js',
  'gtm',
  'googletagmanager',
  'googleanalytics',
];

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}.png`),
    fullPage: false,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────
test.describe('Money-path funnel: homepage → search → signin → create entry', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(({ page }) => {
    consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        const isNoise = CONSOLE_NOISE.some((n) => text.includes(n));
        if (!isNoise) consoleErrors.push(text);
      }
    });
  });

  // ── STEP 1-3: public path, no auth ──────────────────────────────────────
  test('step 1-3: homepage renders and search responds', async ({ page }) => {
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });

    // Step 1: hero is visible
    await expect(page.locator('[data-testid="hero-headline"]')).toBeVisible();
    await screenshot(page, '01-homepage');

    // Step 2: search input is visible
    const searchInput = page.locator('[data-testid="hero-search-input"]');
    await expect(searchInput).toBeVisible();

    // Type a query — triggers the 300ms debounced search
    await searchInput.click();
    await page.keyboard.type('coffee');
    await screenshot(page, '02-search-typed');

    // Wait for EITHER results OR the degraded/unavailable notice (Places may be down)
    const resultsOrUnavailable = page.locator(
      '[data-testid="search-result"], [data-testid="business-search-unavailable"]',
    );
    await expect(resultsOrUnavailable.first()).toBeVisible({ timeout: 10_000 });
    await screenshot(page, '03-search-responded');

    // Assert search UI responded — either a result or a degraded notice
    const resultCount = await page.locator('[data-testid="search-result"]').count();
    const unavailable = await page
      .locator('[data-testid="business-search-unavailable"]')
      .isVisible();
    expect(resultCount > 0 || unavailable).toBeTruthy();

    expect(consoleErrors).toEqual([]);
  });

  // ── STEP 4-6: authenticated path ────────────────────────────────────────
  test('step 4-6: auth seeds and admin create-entry reached', async ({ page }) => {
    const password = getTestPassword();
    if (!password) {
      test.skip(true, 'E2E_TEST_PASSWORD not available');
      return;
    }

    // Step 4a: load homepage first — acquires CF clearance cookie
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="hero-search-input"]')).toBeVisible();
    await screenshot(page, '04-homepage-for-cf-clearance');

    // Step 4b: in-page POST /api/auth/test-login + seed localStorage
    const authResult = await page.evaluate(
      async ({
        email,
        pwd,
        baseUrl,
      }: {
        email: string;
        pwd: string;
        baseUrl: string;
      }) => {
        try {
          const resp = await fetch(`${baseUrl}/api/auth/test-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: pwd }),
            credentials: 'include',
          });
          if (!resp.ok) return { ok: false, status: resp.status, error: `HTTP ${resp.status}` };
          const json = await resp.json();
          const result = (json.data ?? json) as Record<string, unknown>;
          const token = result.token as string | undefined;
          if (!token) return { ok: false, error: 'no token in response', json };
          localStorage.setItem(
            'ps_session',
            JSON.stringify({ token, identifier: email, createdAt: Date.now() }),
          );
          localStorage.setItem('ps_user', JSON.stringify(result));
          localStorage.setItem('ps_feedback_dismissed', 'true');
          return { ok: true, token };
        } catch (e: unknown) {
          return { ok: false, error: String(e) };
        }
      },
      { email: TEST_EMAIL, pwd: password, baseUrl: PROD_URL },
    );

    expect(authResult.ok, `Auth failed: ${JSON.stringify(authResult)}`).toBe(true);
    await screenshot(page, '05-auth-seeded');

    // Step 5: navigate to /admin
    await page.goto(`${PROD_URL}/admin`, { waitUntil: 'networkidle' });
    await screenshot(page, '06-admin-loaded');

    // Angular admin shell must render — assert the nav-create button is present
    const navCreate = page.locator('[data-testid="nav-create"]');
    await expect(navCreate).toBeVisible({ timeout: 20_000 });
    await expect(navCreate).toBeEnabled();
    await screenshot(page, '07-nav-create-visible');

    // Step 6: click nav-create → create overlay appears
    await navCreate.click();

    // Wait for the create overlay/canvas
    const createPanel = page.locator(
      '.ps-create-canvas-title, .ps-create-panel, [data-testid="create-overlay"]',
    );
    await expect(createPanel.first()).toBeVisible({ timeout: 15_000 });
    await screenshot(page, '08-create-overlay-open');

    // Assert the overlay opened — DO NOT click build CTA (real build = ~$2)
    const overlayVisible = await createPanel.first().isVisible();
    expect(overlayVisible).toBe(true);

    // If a specific build button is present, assert it's visible (but don't click)
    const buildCta = page
      .locator('button, [role="button"]')
      .filter({ hasText: /build|generate|create|start|get started/i })
      .first();
    const buildCtaCount = await buildCta.count();
    if (buildCtaCount > 0) {
      await expect(buildCta).toBeVisible();
      await screenshot(page, '09-create-cta-visible');
    }

    expect(consoleErrors).toEqual([]);
  });
});
