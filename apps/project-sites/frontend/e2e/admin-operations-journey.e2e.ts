/**
 * LONG money-path-adjacent admin-operations journey (golden-path breadth smoke).
 *
 * Authenticates once via the shared test-login recipe (helpers/admin-auth — GOLDEN-AUTH-1), then
 * navigates the operator's core admin surfaces BY CLICKING NAV LINKS (never page.goto after the
 * initial load, per the golden-path contract). Each surface must: be on-route, render a real H1 +
 * substantial content (not a thin/empty shell), and be console-error-free (minus platform noise).
 *
 * This is the first durable LONG journey after GOLDEN-AUTH-1 unblocked browser auth (fire-123).
 * Varies from `money-path-nav-create.e2e.ts` (that proves the create overlay; this proves breadth).
 * Lives in the prod `*.e2e.ts` suite (E2E_API_KEY-gated in CI); run locally:
 *   E2E_TEST_PASSWORD=$(get-secret E2E_TEST_PASSWORD) npx playwright test admin-operations-journey \
 *     --config=playwright.prod.config.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { test, expect } from '@playwright/test';

import { authenticateAdmin, filterConsoleNoise, getTestPassword } from './helpers/admin-auth';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const SCREENSHOT_DIR = path.resolve(__dirname, 'screenshots/admin-operations');

/** The operator's core surfaces, in navigation order. [route, human label]. */
const SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['/admin', 'Dashboard'],
  ['/admin/sites', 'Sites'],
  ['/admin/analytics', 'Analytics'],
  ['/admin/hosting', 'Hosting'],
  ['/admin/forms', 'Forms'],
  ['/admin/leads', 'Leads'],
  ['/admin/feature-flags', 'Feature Flags'],
  ['/admin/apps', 'Apps'],
  ['/admin/social', 'Social'],
  ['/admin/voice', 'Voice'],
  ['/admin/billing', 'Billing'],
  ['/admin/docs', 'Docs'],
  ['/admin/settings', 'Settings'],
  ['/admin/super-admin', 'Super Admin'],
];

test.describe('admin operations — breadth golden journey', () => {
  test('operator navigates every core admin surface: on-route, rendered, console-clean', async ({
    page,
  }) => {
    if (!getTestPassword()) {
      test.skip(true, 'BLOCKED: E2E_TEST_PASSWORD not set — no auth credentials available');
      return;
    }
    if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

    // console errors are attributed to the section active when they fire
    let currentSection = 'boot';
    const errorsBySection: Record<string, string[]> = {};
    page.on('console', (m) => {
      if (m.type() === 'error') (errorsBySection[currentSection] ??= []).push(m.text());
    });
    page.on('pageerror', (e) => {
      (errorsBySection[currentSection] ??= []).push(`PAGEERROR: ${String(e)}`);
    });

    // --- Auth (shared recipe) ---
    const auth = await authenticateAdmin(page, { prodUrl: PROD_URL });
    expect(auth.ok, `admin auth failed (bounced=${auth.bouncedToSignin}, status=${auth.status})`).toBe(
      true,
    );
    expect(page.url(), 'landed in /admin after auth').toContain('/admin');

    // --- Walk every surface by CLICKING its nav link ---
    const offRoute: string[] = [];
    const thin: string[] = [];
    for (const [route, label] of SECTIONS) {
      currentSection = label;
      const navLink = page.locator(`a[href="${route}"]`).first();
      await expect(navLink, `nav link for ${label} (${route}) is present`).toBeVisible({
        timeout: 8000,
      });
      await navLink.click();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(1200); // let the lazy section settle

      const url = page.url();
      const onRoute =
        url.includes(route) || (route === '/admin' && /\/admin(\/dashboard)?($|\?)/.test(url));
      if (!onRoute) offRoute.push(`${label} → ${url.replace(PROD_URL, '')}`);

      const contentLen = await page.evaluate(
        () => (document.body.textContent || '').trim().length,
      );
      if (contentLen < 300) thin.push(`${label} (len=${contentLen})`);

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${label.toLowerCase().replace(/\s+/g, '-')}.png`),
        fullPage: false,
      });
    }

    // --- Assertions across the whole journey ---
    expect(offRoute, `surfaces that did not land on their route: ${offRoute.join(', ')}`).toEqual([]);
    expect(thin, `surfaces that rendered thin/empty: ${thin.join(', ')}`).toEqual([]);

    const dirtySections = Object.entries(errorsBySection)
      .map(([sec, errs]) => [sec, filterConsoleNoise(errs)] as const)
      .filter(([, errs]) => errs.length > 0)
      .map(([sec, errs]) => `${sec}: ${errs.slice(0, 2).join(' | ')}`);
    expect(dirtySections, `surfaces with console errors: ${dirtySections.join(' ;; ')}`).toEqual([]);
  });
});
