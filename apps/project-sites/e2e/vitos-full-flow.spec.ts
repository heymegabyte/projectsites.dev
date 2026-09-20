/**
 * @module e2e/vitos-full-flow
 * @description End-to-end test for the full Vito's Men's Salon flow:
 *   1. Open projectsites.dev
 *   2. Enter "Vito's" in the search input
 *   3. Select "Vito's Men's Salon" from results
 *   4. Fill out the "Tell us about your website" form with sample details
 *   5. Attach sample markdown and text files
 *   6. Submit and trigger the AI enrichment workflow
 *   7. Verify the logs show granular progress with step timing
 *   8. Verify the workflow completes with enrichment data
 *
 * @packageDocumentation
 */

import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

/** Stub redirects so external navigations are captured. */
async function stubRedirects(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__redirects = [] as string[];
    (window as unknown as Record<string, (...args: unknown[]) => void>).redirectTo = (url: string) => {
      ((window as unknown as Record<string, unknown>).__redirects as string[]).push(url);
    };
  });
  return async () => page.evaluate(() => (window as unknown as Record<string, unknown>).__redirects as string[]);
}

// RETIRED 2026-09-20 (AL-839) — this whole describe drove the DELETED vanilla `public/index.html`
// 4-screen flow (#screen-search/details/signin/waiting · window.state · redirectTo · `?token=` magic
// callback), removed with the vanilla homepage on 2026-07-31. A false-green PHANTOM: green ONLY vs the
// mock `scripts/e2e_server.cjs` / the stale `sites-staging.megabyte.space` CI shard on dead `#screen-*`
// selectors — it never ran against real prod (absent from playwright.prod.config.ts testMatch). Modern
// coverage: `golden-path.spec.ts` + `home/create-wizard.spec.ts` + `verify-interactive-journey.mjs` +
// the REAL golden-journey delivery (`deliver-business.mjs` → published, this session's Strand/olympia).
// Skipped (not deleted) per e2e-accumulation. The "API Integration" describe below stays LIVE (it tests
// real endpoint contracts — search/health/auth-gating — not the dead UI).
test.describe.skip('Vito\'s Men\'s Salon — Full Flow', () => {
  test('Search → Select → Details → Auth → Build → Logs', async ({ page }) => {
    // ── Step 1: Open the page ──────────────────────────────
    await page.goto('/');
    await stubRedirects(page);

    const searchScreen = page.locator('#screen-search');
    await expect(searchScreen).toBeVisible();
    await expect(searchScreen).toHaveClass(/active/);

    // ── Step 2: Enter "Vito's" in the search input ──────────
    const searchInput = page.locator('#search-input');
    await expect(searchInput).toBeVisible();
    await searchInput.click();
    await searchInput.pressSequentially("Vito's", { delay: 40 });
    await expect(searchInput).toHaveValue("Vito's");

    // ── Step 3: Wait for dropdown and verify results ────────
    const dropdown = page.locator('#search-dropdown');
    await expect(dropdown).toHaveClass(/open/, { timeout: 15_000 });

    const results = dropdown.locator('.search-result');
    // E2E server returns "{query} Pizza" and "{query} Plumbing" + Custom
    await expect(results).toHaveCount(3, { timeout: 5_000 });

    // First result should contain "Vito's" text
    const firstResult = results.nth(0);
    await expect(firstResult.locator('.search-result-name')).toContainText("Vito's");
    await expect(firstResult.locator('.search-result-address')).toBeVisible();

    // ── Step 4: Select the first result ─────────────────────
    const lookupPromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/sites/lookup') && resp.status() === 200,
    );
    await firstResult.click();
    await expect(dropdown).not.toHaveClass(/open/, { timeout: 3_000 });
    await lookupPromise;

    // ── Step 5: Verify Details screen ───────────────────────
    const detailsScreen = page.locator('#screen-details');
    await expect(detailsScreen).toBeVisible({ timeout: 10_000 });
    await expect(detailsScreen).toHaveClass(/active/);
    await expect(searchScreen).not.toHaveClass(/active/);
    await expect(page.locator('#details-title')).toContainText(/tell us/i);

    // Business badge should show selected business
    const badge = page.locator('#details-business-badge');
    await expect(badge).toBeVisible();
    await expect(page.locator('#badge-biz-name')).toContainText("Vito's");

    // Textarea should be empty and ready
    await expect(page.locator('#details-textarea')).toHaveValue('');
    await expect(page.locator('#details-textarea')).toHaveAttribute('placeholder', /Tell us about your business/);

    // Back link should be visible
    await expect(detailsScreen.getByText('Back to search')).toBeVisible();

    // ── Step 6: Fill in details with sample context ─────────
    const textarea = page.locator('#details-textarea');
    await textarea.fill(
      "Vito's Men's Salon is a premium barber shop in Morristown, NJ. " +
      "We specialize in classic and modern haircuts, straight razor shaves, " +
      "beard trims, and hot towel treatments. Open since 2005. " +
      "Family-owned with experienced barbers. Walk-ins welcome."
    );
    await expect(textarea).toHaveValue(/premium barber shop/);

    // Build button should be visible and enabled
    const buildBtn = page.locator('#build-btn');
    await expect(buildBtn).toBeEnabled();
    await expect(buildBtn).toContainText(/build/i);

    // ── Step 7: Click Build → goes to Sign-In ───────────────
    await buildBtn.click();

    const signinScreen = page.locator('#screen-signin');
    await expect(signinScreen).toBeVisible({ timeout: 10_000 });
    await expect(signinScreen).toHaveClass(/active/);

    // ── Step 8: Sign in with Email ──────────────────────────
    const emailBtn = page.getByRole('button', { name: /email/i });
    await expect(emailBtn).toBeVisible();
    await emailBtn.click();

    await expect(page.locator('#signin-email-panel')).toHaveClass(/active/);
    const emailInput = page.locator('#email-input');
    await expect(emailInput).toBeVisible();
    await emailInput.fill('vito@example.com');

    // Intercept magic link API
    const magicLinkPromise = page.waitForResponse(
      (resp) => resp.url().includes('/api/auth/magic-link') && resp.status() === 200,
    );
    const sendBtn = page.locator('#email-send-btn');
    await sendBtn.click();

    await magicLinkPromise;
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 5_000 });

    // ── Step 9: Save state and simulate magic link callback ──
    await page.evaluate(() => {
      const s = (window as unknown as Record<string, unknown>).state as Record<string, unknown>;
      const biz = s.selectedBusiness;
      if (biz) {
        sessionStorage.setItem('ps_selected_business', JSON.stringify(biz));
        sessionStorage.setItem('ps_mode', s.mode as string);
      }
      sessionStorage.setItem('ps_pending_build', '1');
    });

    await page.goto('/?token=e2e-vito-token&email=vito@example.com&auth_callback=email');

    // ── Step 10: Verify Waiting screen appears ──────────────
    const waitingScreen = page.locator('#screen-waiting');
    await expect(waitingScreen).toBeVisible({ timeout: 15_000 });
    await expect(waitingScreen).toHaveClass(/active/);
    await expect(signinScreen).not.toHaveClass(/active/);

    // Waiting screen elements
    await expect(page.locator('.waiting-title')).toContainText(/building/i);
    await expect(page.locator('.waiting-subtitle')).toContainText(/few minutes/i);
    await expect(page.locator('.waiting-status')).toContainText(/build in progress/i);
    await expect(page.locator('#waiting-contact')).toContainText('vito@example.com');

    // Animated elements
    await expect(page.locator('.status-dot')).toBeVisible();
    await expect(page.locator('.waiting-anim')).toBeVisible();
    await expect(page.locator('.waiting-anim-ring')).toHaveCount(3);

    // Build terminal should be visible with step lines
    const terminalBody = page.locator('#build-terminal-body');
    await expect(terminalBody).toBeVisible({ timeout: 5_000 });
    const terminalLines = terminalBody.locator('.build-terminal-line');
    const lineCount = await terminalLines.count();
    expect(lineCount).toBeGreaterThan(5);

    // First line should reference initialization
    await expect(terminalLines.first()).toContainText(/initializ|pipeline/i);

    // ── Step 11: Verify internal state ──────────────────────
    const appState = await page.evaluate(() => {
      const s = (window as unknown as Record<string, unknown>).state as Record<string, unknown>;
      return {
        screen: s.screen,
        mode: s.mode,
        hasSession: !!(s.session && (s.session as Record<string, unknown>).token),
        pendingBuild: s._pendingBuild,
      };
    });

    expect(appState.screen).toBe('waiting');
    expect(appState.mode).toBe('business');
    expect(appState.hasSession).toBe(true);
    expect(appState.pendingBuild).toBeFalsy();
  });
});

test.describe('Vito\'s Flow — API Integration', () => {
  test('Search API returns results for Vito query', async ({ request }) => {
    const res = await request.get("/api/search/businesses?q=Vito's");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data.length).toBeGreaterThan(0);
  });

  test('Health endpoint confirms service is running', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('version');
  });

  test('Logs endpoint requires authentication', async ({ request }) => {
    const res = await request.get('/api/sites/fake-id/logs');
    expect([401, 403]).toContain(res.status());
  });

  test('Files endpoint requires authentication', async ({ request }) => {
    const res = await request.get('/api/sites/fake-id/files');
    expect([401, 403]).toContain(res.status());
  });
});
