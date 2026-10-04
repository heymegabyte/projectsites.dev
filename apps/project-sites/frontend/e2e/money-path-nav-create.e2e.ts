/**
 * Money-path spec: nav-create CTA opens the /admin/create overlay.
 *
 * Auth: Pathway B — real credentials via POST /api/auth/test-login.
 * Password source: E2E_TEST_PASSWORD env → TEST_USER_PASSWORD env → get-secret.
 * If no password obtainable: test.skip() with BLOCKED reason.
 *
 * Journey (UI clicks only after initial load):
 *   1. Goto prod URL (gets CF clearance)
 *   2. POST /api/auth/test-login → seed token → navigate to /admin
 *   3. Assert [data-testid="nav-create"] is visible
 *   4. Click nav-create → URL contains /create
 *   5. Assert .ps-create-canvas-title text, right panel, close button
 *   6. Click close → URL back to /admin
 *
 * Screenshots captured at each step to e2e/screenshots/nav-create/.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const TEST_EMAIL = 'brian@megabyte.space';

const CONSOLE_NOISE = [
  'favicon',
  'posthog',
  'Failed to load resource',
  'stackblitz',
  'editor.projectsites.dev',
  'cdn-cgi',
  'cloudflareinsights',
];

const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots/nav-create');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterNoise(errors: string[]): string[] {
  return errors.filter((e) => !CONSOLE_NOISE.some((n) => e.includes(n)));
}

function mkScreenshotDir(): void {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
}

function getPassword(): string | null {
  // 1. Env var primary
  const fromEnv = process.env.E2E_TEST_PASSWORD ?? process.env.TEST_USER_PASSWORD;
  if (fromEnv) return fromEnv;

  // 2. get-secret fallback
  try {
    const result = execSync('/Users/Apple/.local/bin/get-secret E2E_TEST_PASSWORD', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (result) return result;
  } catch {
    // not found
  }

  return null;
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe('money-path: nav-create CTA opens /create overlay', () => {
  test('nav-create opens /admin/create overlay and close returns to /admin', async ({ page }) => {
    // --- Password bootstrap ---
    const password = getPassword();
    if (!password) {
      test.skip(true, 'BLOCKED: E2E_TEST_PASSWORD not set — no auth credentials available');
      return;
    }

    mkScreenshotDir();
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    // --- Step 1: goto prod root (CF clearance + session cookie) ---
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '01-homepage.png'), fullPage: false });
    expect(filterNoise(consoleErrors), 'console errors after homepage').toEqual([]);

    // --- Step 2: Pathway B auth via /api/auth/test-login ---
    const authResult = await page.evaluate(
      async ({ email, pwd, baseUrl }: { email: string; pwd: string; baseUrl: string }) => {
        const resp = await fetch(`${baseUrl}/api/auth/test-login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: pwd }),
          credentials: 'include',
        });
        if (!resp.ok) {
          return { ok: false, status: resp.status, body: await resp.text() };
        }
        const data = (await resp.json()) as { token?: string; session?: string; user?: unknown };
        // Seed the session token in localStorage
        const token = data.token ?? data.session;
        if (token) {
          localStorage.setItem('ps_session', JSON.stringify({ token, identifier: email }));
        }
        if (data.user) {
          localStorage.setItem('ps_user', JSON.stringify(data.user));
        }
        localStorage.setItem('ps_feedback_dismissed', 'true');
        return { ok: true, token };
      },
      { email: TEST_EMAIL, pwd: password, baseUrl: PROD_URL },
    );

    if (!authResult.ok) {
      test.skip(
        true,
        `BLOCKED: /api/auth/test-login returned ${authResult.status} — ${authResult.body}`,
      );
      return;
    }

    // --- Step 3: Navigate to /admin ---
    await page.goto(`${PROD_URL}/admin`, { waitUntil: 'networkidle' });
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '02-admin.png'), fullPage: false });
    expect(filterNoise(consoleErrors), 'console errors after /admin load').toEqual([]);

    // --- Step 4: Assert nav-create is visible ---
    const navCreate = page.locator('[data-testid="nav-create"]');
    await expect(navCreate).toBeVisible({ timeout: 15_000 });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '03-nav-create-visible.png'),
      fullPage: false,
    });

    // --- Step 5: Click nav-create ---
    await navCreate.click();
    await page.waitForURL(`${PROD_URL}/admin/create`, { timeout: 10_000 });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '04-create-overlay-opened.png'),
      fullPage: false,
    });
    expect(filterNoise(consoleErrors), 'console errors after opening /create overlay').toEqual([]);

    // --- Step 6: Assert overlay elements ---
    // URL contains /create
    expect(page.url()).toContain('/create');

    // White canvas headline (only visible md+, so we assert on 1280px-wide viewport)
    const canvasTitle = page.locator('.ps-create-canvas-title');
    // On desktop viewport this should be visible; on mobile it's hidden but still in DOM
    await expect(canvasTitle).toHaveText('Create autonomous website', { timeout: 8_000 });

    // Right input panel
    const panel = page.locator('.ps-create-panel');
    await expect(panel).toBeVisible({ timeout: 8_000 });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '05-overlay-assertions.png'),
      fullPage: false,
    });

    // Close button
    const closeBtn = page.locator('.ps-create-close');
    await expect(closeBtn).toBeVisible({ timeout: 5_000 });

    // --- Step 7: Click close → back to /admin ---
    await closeBtn.click();
    await page.waitForURL(`${PROD_URL}/admin`, { timeout: 10_000 });
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, '06-back-to-admin.png'),
      fullPage: false,
    });
    expect(page.url()).toContain('/admin');
    expect(page.url()).not.toContain('/create');
    expect(filterNoise(consoleErrors), 'console errors after closing overlay').toEqual([]);
  });
});
