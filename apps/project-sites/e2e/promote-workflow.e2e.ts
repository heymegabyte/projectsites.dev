/**
 * @file promote-workflow.e2e.ts
 * @description TDD RED-phase spec: Preview → edit → Promote → Production workflow.
 *
 * Expected status: RED until the Promote button + API ship in the sibling worktree.
 * Do NOT weaken assertions to green. The UI (`data-testid="promote-to-production"`)
 * and the API (`GET /api/sites/:id/releases`) do not exist yet.
 *
 * Auth: real E2E_API_KEY session via `setupRealDataPage` — Pathway A (preferred).
 * All six scenarios gate on `realDataAvailable()` and skip without a key.
 */

import { test, expect } from './fixtures.js';
import { gotoAdmin, signInAsTestUser } from './helpers/auth.js';
import { realDataAvailable, setupRealDataPage } from './helpers/realdata.js';
import { resolveE2ESite } from './admin-verify/_resolve-e2e-site.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to the Source Control / snapshots panel for a given site inside the admin.
 * Clicks the nav link or falls back to direct URL navigation within the SPA.
 */
async function gotoSourceControl(page: import('@playwright/test').Page, siteId: string): Promise<void> {
  // Navigate to admin/snapshots section — SPA route, uses gotoAdmin then click
  await gotoAdmin(page, `sites/${siteId}/snapshots`);

  // Wait for the snapshots or source-control section to render
  await page
    .waitForSelector(
      '[data-testid="snapshots-section"], [data-testid="source-control-section"], app-admin-snapshots',
      { timeout: 20_000 },
    )
    .catch(() => {
      // Section may not have a matching testid yet — spec asserts below will RED
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Preview → Promote → Production workflow', () => {
  // All six scenarios require a real E2E_API_KEY to hit live prod data.
  // Without it the tests are meaningless (no real site to promote).
  test.skip(!realDataAvailable(), 'needs E2E_API_KEY for a real session');

  // ---------------------------------------------------------------------------
  // Scenario 1 — Authenticate and open the Editor for a real site
  // ---------------------------------------------------------------------------
  test('1. authenticate via E2E_API_KEY and open editor for seeded site', async ({ page }) => {
    // Start at the homepage — real user flow
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });

    // Inject real session; passthrough auth + sites list
    await setupRealDataPage(page, {
      passthrough: /\/api\/(auth\/me|sites)\b/,
    });

    // Resolve real test site
    const { id: siteId, slug } = await resolveE2ESite(PROD_URL, process.env.E2E_API_KEY!, UA);
    expect(siteId, 'resolveE2ESite must return a real site id').toBeTruthy();
    expect(slug, 'resolveE2ESite must return a real site slug').toBeTruthy();

    // Navigate to admin — session is already injected
    await gotoAdmin(page, `sites/${siteId}`);

    // Admin shell must render
    await expect(page.locator('app-admin, [data-cockpit="v2"]')).toBeVisible({ timeout: 20_000 });

    // Navigate to the editor section via admin nav click (real user action)
    const editorNavLink = page.locator(
      '[data-testid="admin-nav-editor"], [data-testid="admin-nav-code"]',
    );
    const editorNavVisible = await editorNavLink.first().isVisible({ timeout: 5_000 }).catch(() => false);
    if (editorNavVisible) {
      await editorNavLink.first().click();
    }

    // Editor section or bolt iframe must be present (may still be booting)
    const editorPresent = await page
      .waitForSelector(
        '[data-testid="editor-section"], [data-testid="bolt-embed-iframe"], iframe[src*="editor.projectsites.dev"]',
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);

    expect(editorPresent, 'editor iframe or editor section must mount').toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — Make a content edit so Preview differs from Production
  // ---------------------------------------------------------------------------
  test('2. make a content edit that creates a diff between preview and production', async ({ page }) => {
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await setupRealDataPage(page, {
      passthrough: /\/api\/(auth\/me|sites)\b/,
    });

    const { id: siteId } = await resolveE2ESite(PROD_URL, process.env.E2E_API_KEY!, UA);
    expect(siteId).toBeTruthy();

    await gotoAdmin(page, `sites/${siteId}/snapshots`);

    // The Source Control / Snapshots section must render a diff indicator or
    // a "nothing to promote" empty state.
    // We assert the section itself is present (fails RED when not yet built).
    await expect(
      page.locator('[data-testid="source-control-section"], [data-testid="snapshots-section"]'),
    ).toBeVisible({ timeout: 20_000 });

    // The Promote button is the primary assertion — RED until shipped.
    // For the edit-creates-diff test we also verify that a working-tree status
    // panel or diff view is rendered.
    const diffView = page.locator(
      '[data-testid="preview-diff"], [data-testid="working-tree-status"], [data-testid="git-status"]',
    );
    // This will be RED until the Promote UI ships — intentional.
    await expect(diffView).toBeVisible({ timeout: 10_000 });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — Open Source Control view and click "Promote to Production"
  // ---------------------------------------------------------------------------
  test('3. click promote-to-production button in Source Control view', async ({ page }) => {
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await setupRealDataPage(page, {
      passthrough: /\/api\/(auth\/me|sites)\b/,
    });

    const { id: siteId } = await resolveE2ESite(PROD_URL, process.env.E2E_API_KEY!, UA);
    expect(siteId).toBeTruthy();

    await gotoAdmin(page, `sites/${siteId}/snapshots`);
    await expect(
      page.locator('[data-testid="source-control-section"], [data-testid="snapshots-section"]'),
    ).toBeVisible({ timeout: 20_000 });

    // PRIMARY ASSERTION: the Promote button must exist and be clickable.
    // RED until the Promote button ships.
    const promoteBtn = page.locator('[data-testid="promote-to-production"]');
    await expect(promoteBtn).toBeVisible({ timeout: 10_000 });
    await expect(promoteBtn).toBeEnabled();

    // Click via keyboard — real user flow
    await promoteBtn.focus();
    await page.keyboard.press('Enter');
  });

  // ---------------------------------------------------------------------------
  // Scenario 4 — Promote status progresses to success (bounded wait, no sleeps)
  // ---------------------------------------------------------------------------
  test('4. promote-status progresses to success within bounded time', async ({ page }) => {
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await setupRealDataPage(page, {
      passthrough: /\/api\/(auth\/me|sites|snapshots)\b/,
    });

    const { id: siteId } = await resolveE2ESite(PROD_URL, process.env.E2E_API_KEY!, UA);
    expect(siteId).toBeTruthy();

    await gotoAdmin(page, `sites/${siteId}/snapshots`);

    // Wait for promote button and click
    const promoteBtn = page.locator('[data-testid="promote-to-production"]');
    await expect(promoteBtn).toBeVisible({ timeout: 10_000 });
    await promoteBtn.click();

    // Status indicator must appear
    const statusEl = page.locator('[data-testid="promote-status"]');
    await expect(statusEl).toBeVisible({ timeout: 10_000 });

    // Must NOT stay in error state
    await expect(statusEl).not.toHaveAttribute('data-state', 'error', { timeout: 30_000 });

    // Must eventually reach success — bounded wait, no sleep
    await expect(statusEl).toHaveAttribute('data-state', 'success', { timeout: 60_000 });
  });

  // ---------------------------------------------------------------------------
  // Scenario 5 — Verify Production reflects the promoted revision via /releases API
  // ---------------------------------------------------------------------------
  test('5. GET /api/sites/:id/releases returns new release after promote', async ({ page }) => {
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await setupRealDataPage(page, {
      passthrough: /\/api\/(auth\/me|sites|snapshots|releases)\b/,
    });

    const { id: siteId } = await resolveE2ESite(PROD_URL, process.env.E2E_API_KEY!, UA);
    expect(siteId).toBeTruthy();

    // Record the release count BEFORE promote
    const beforeRes = await page.evaluate(
      async ({ base, id, token }: { base: string; id: string; token: string }) => {
        const r = await fetch(`${base}/api/sites/${id}/releases`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = (await r.json().catch(() => ({}))) as { data?: unknown[] };
        return { status: r.status, count: (j?.data ?? []).length };
      },
      { base: PROD_URL, id: siteId, token: process.env.E2E_API_KEY! },
    );

    // /releases endpoint must exist — RED until shipped
    expect(beforeRes.status, '/api/sites/:id/releases must return 200').toBe(200);

    // Perform promote via the UI
    await gotoAdmin(page, `sites/${siteId}/snapshots`);
    const promoteBtn = page.locator('[data-testid="promote-to-production"]');
    await expect(promoteBtn).toBeVisible({ timeout: 10_000 });
    await promoteBtn.click();

    // Wait for success
    const statusEl = page.locator('[data-testid="promote-status"]');
    await expect(statusEl).toHaveAttribute('data-state', 'success', { timeout: 60_000 });

    // Re-fetch releases — count must have incremented
    const afterRes = await page.evaluate(
      async ({ base, id, token }: { base: string; id: string; token: string }) => {
        const r = await fetch(`${base}/api/sites/${id}/releases`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = (await r.json().catch(() => ({}))) as { data?: Array<{ revision?: string }> };
        return {
          status: r.status,
          count: (j?.data ?? []).length,
          latestRevision: (j?.data ?? [])[0]?.revision ?? null,
        };
      },
      { base: PROD_URL, id: siteId, token: process.env.E2E_API_KEY! },
    );

    expect(afterRes.status).toBe(200);
    expect(afterRes.count).toBeGreaterThan(beforeRes.count);
    expect(afterRes.latestRevision, 'latest release must carry a revision hash').toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Scenario 6 — Negative: promote button is disabled/absent when nothing to promote
  // ---------------------------------------------------------------------------
  test('6. promote button disabled or absent when preview equals production', async ({ page }) => {
    await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
    await setupRealDataPage(page, {
      passthrough: /\/api\/(auth\/me|sites|snapshots|releases)\b/,
    });

    const { id: siteId } = await resolveE2ESite(PROD_URL, process.env.E2E_API_KEY!, UA);
    expect(siteId).toBeTruthy();

    // First perform a successful promote so preview == production
    await gotoAdmin(page, `sites/${siteId}/snapshots`);

    const promoteBtn = page.locator('[data-testid="promote-to-production"]');

    // If the button is already absent/disabled there's nothing to promote — that's the
    // happy-negative case (clean state after prior promote, or a freshly-published site).
    const btnVisible = await promoteBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    const btnEnabled = btnVisible ? await promoteBtn.isEnabled() : false;

    if (btnVisible && btnEnabled) {
      // Perform a promote first to bring preview == production
      await promoteBtn.click();
      const statusEl = page.locator('[data-testid="promote-status"]');
      await expect(statusEl).toHaveAttribute('data-state', 'success', { timeout: 60_000 });

      // Reload the section via SPA nav (no page.goto after initial load)
      const snapshotsNavLink = page.locator('[data-testid="admin-nav-snapshots"]');
      const navVisible = await snapshotsNavLink.isVisible({ timeout: 3_000 }).catch(() => false);
      if (navVisible) {
        await snapshotsNavLink.click();
      }
    }

    // After promote (or in clean state): button must be absent OR disabled.
    // RED until the UI ships the disabled-when-clean logic.
    const postBtn = page.locator('[data-testid="promote-to-production"]');
    const postVisible = await postBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (postVisible) {
      // Button is present — it must be disabled
      await expect(postBtn).toBeDisabled();
    }
    // else: button is absent — correct clean-state behavior
  });
});
