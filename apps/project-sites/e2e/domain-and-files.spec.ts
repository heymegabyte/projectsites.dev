/**
 * @module e2e/domain-and-files
 * @description E2E tests for domain management and R2 file browser features.
 *
 * Covers:
 *   1. Domain search API with various query types
 *   2. File browser API authentication gates
 *   3. Toast notification rendering
 *   4. Build terminal / workflow log display elements
 *
 * @packageDocumentation
 */

import { test, expect } from './fixtures.js';

// ─── Domain Search API Tests ─────────────────────────────────

test.describe('Domain Search API', () => {
  test('returns empty results for short queries', async ({ request }) => {
    const res = await request.get('/api/domains/search?q=ab');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  test('returns empty results for missing query', async ({ request }) => {
    const res = await request.get('/api/domains/search');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });

  test('returns results for valid domain queries', async ({ request }) => {
    const res = await request.get('/api/domains/search?q=testbusiness');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const result of body.data) {
      expect(result).toHaveProperty('domain');
      expect(result).toHaveProperty('available');
      expect(typeof result.domain).toBe('string');
      expect(typeof result.available).toBe('boolean');
    }
  });

  test('sanitizes special characters in queries', async ({ request }) => {
    const res = await request.get('/api/domains/search?q=test%3Cscript%3E');
    expect(res.status()).toBe(200);
    const body = await res.json();
    for (const result of body.data) {
      expect(result.domain).not.toContain('<');
      expect(result.domain).not.toContain('>');
    }
  });

  test('returns TLD variants for dotless queries', async ({ request }) => {
    const res = await request.get('/api/domains/search?q=mybusiness');
    expect(res.status()).toBe(200);
    const body = await res.json();
    const domains = body.data.map((d: { domain: string }) => d.domain);
    expect(domains.some((d: string) => d.endsWith('.com'))).toBe(true);
    expect(domains.some((d: string) => d.endsWith('.net'))).toBe(true);
  });
});

// ─── File Browser API Auth Gates ────────────────────────────

test.describe('File Browser API Authentication', () => {
  test('GET /api/sites/:id/files requires auth', async ({ request }) => {
    const res = await request.get('/api/sites/fake-site-id/files');
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/sites/:id/files/:path requires auth', async ({ request }) => {
    const res = await request.get('/api/sites/fake-site-id/files/index.html');
    expect([401, 403]).toContain(res.status());
  });

  test('PUT /api/sites/:id/files/:path requires auth', async ({ request }) => {
    const res = await request.put('/api/sites/fake-site-id/files/index.html', {
      data: { content: '<html>test</html>' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── Workflow Status API ─────────────────────────────────────

test.describe('Workflow Status API', () => {
  test('GET /api/sites/:id/workflow requires auth', async ({ request }) => {
    const res = await request.get('/api/sites/fake-site-id/workflow');
    expect([401, 403]).toContain(res.status());
  });
});

// ─── UI Element Rendering ────────────────────────────────────

// RETIRED 2026-09-20 (AL-839) — these assert DELETED vanilla `public/index.html` globals
// (`window.WORKFLOW_STEP_LABELS`/`WORKFLOW_STEP_ORDER`/`showToast`/`formatFileSize`, `#toast-container`),
// removed 2026-07-31. False-green phantoms (green only vs the mock/stale shard, never prod). The Angular
// admin owns toasts + workflow status now (admin-verify probes). The 3 API describes ABOVE stay LIVE
// (real endpoint contracts: domain-search + files-auth + workflow-auth). Skipped per e2e-accumulation.
test.describe.skip('UI Elements: Toast Container and Build Terminal', () => {
  test('Toast container exists on page load', async ({ page }) => {
    await page.goto('/');
    const toastContainer = page.locator('#toast-container');
    await expect(toastContainer).toBeAttached();
    await expect(toastContainer).toHaveClass(/toast-container/);
  });

  test('Build terminal step labels are defined', async ({ page }) => {
    await page.goto('/');

    const stepLabels = await page.evaluate(() => {
      return (window as unknown as Record<string, unknown>).WORKFLOW_STEP_LABELS as Record<string, string> | undefined;
    });

    // WORKFLOW_STEP_LABELS should be defined as a global
    expect(stepLabels).toBeDefined();
    if (stepLabels) {
      expect(stepLabels['research-profile']).toContain('business profile');
      expect(stepLabels['generate-website']).toContain('website');
      expect(stepLabels['upload-to-r2']).toContain('CDN');
    }
  });

  test('Build terminal step order is correct', async ({ page }) => {
    await page.goto('/');

    const stepOrder = await page.evaluate(() => {
      return (window as unknown as Record<string, unknown>).WORKFLOW_STEP_ORDER as string[] | undefined;
    });

    expect(stepOrder).toBeDefined();
    if (stepOrder) {
      expect(stepOrder[0]).toBe('research-profile');
      expect(stepOrder[stepOrder.length - 1]).toBe('update-site-status');
      expect(stepOrder.length).toBe(11);
    }
  });

  test('showToast function exists and creates toasts', async ({ page }) => {
    await page.goto('/');

    // Call showToast via evaluate
    await page.evaluate(() => {
      const fn = (window as unknown as Record<string, (...args: unknown[]) => void>).showToast;
      if (fn) fn('Test toast message', 'info', 3000);
    });

    // Verify toast was created
    const toast = page.locator('.toast');
    await expect(toast).toBeVisible({ timeout: 2000 });
    await expect(toast).toContainText('Test toast message');
    await expect(toast).toHaveClass(/toast-info/);
  });

  test('formatFileSize function formats sizes correctly', async ({ page }) => {
    await page.goto('/');

    const results = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, (n: number) => string>).formatFileSize;
      if (!fn) return null;
      return {
        zero: fn(0),
        bytes: fn(512),
        kb: fn(2048),
        mb: fn(1048576),
      };
    });

    expect(results).toBeDefined();
    if (results) {
      expect(results.zero).toBe('0 B');
      expect(results.bytes).toBe('512 B');
      expect(results.kb).toContain('KB');
      expect(results.mb).toContain('MB');
    }
  });
});

// ─── Search → Build Terminal Flow ────────────────────────────

// RETIRED 2026-09-20 (AL-839) — the DELETED vanilla search→details→signin→waiting flow
// (#screen-details · #build-btn · #screen-signin · window.state · `?token=` · #build-terminal-body).
// False-green phantom (dead selectors, mock/stale-only). The live build terminal is the Angular
// waiting.component streaming path (waiting-and-terminal.spec.ts + streaming-build-theater). Skipped.
test.describe.skip('Build Terminal Integration', () => {
  test('Build terminal renders step lines after build starts', async ({ page }) => {
    await page.goto('/');

    // Search and select a business
    const input = page.getByPlaceholder(/Enter your business name/);
    await input.click();
    await input.pressSequentially('Terminal Test', { delay: 30 });

    const firstResult = page.locator('.search-result').first();
    await expect(firstResult).toBeVisible({ timeout: 15_000 });
    await firstResult.click();

    // Fill details and build
    await expect(page.locator('#screen-details')).toBeVisible({ timeout: 10_000 });
    await page.locator('#details-textarea').fill('Testing build terminal display');
    await page.locator('#build-btn').click();

    // Sign in with email
    await expect(page.locator('#screen-signin')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /email/i }).click();
    await page.locator('#email-input').fill('terminal@test.com');
    await page.locator('#email-send-btn').click();
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 10_000 });

    // Save state and simulate callback
    await page.evaluate(() => {
      const s = (window as unknown as Record<string, unknown>).state as Record<string, unknown>;
      if (s.selectedBusiness) {
        sessionStorage.setItem('ps_selected_business', JSON.stringify(s.selectedBusiness));
        sessionStorage.setItem('ps_mode', s.mode as string);
      }
      sessionStorage.setItem('ps_pending_build', '1');
    });

    await page.goto('/?token=e2e-terminal-token&email=terminal@test.com&auth_callback=email');

    // Verify waiting screen appears with build terminal
    const waitingScreen = page.locator('#screen-waiting');
    await expect(waitingScreen).toBeVisible({ timeout: 15_000 });

    // Build terminal body should contain step lines
    const terminalBody = page.locator('#build-terminal-body');
    await expect(terminalBody).toBeVisible({ timeout: 5_000 });

    // Should have multiple terminal lines (context + steps)
    const terminalLines = terminalBody.locator('.build-terminal-line');
    const lineCount = await terminalLines.count();
    expect(lineCount).toBeGreaterThan(5); // At least init + some steps

    // First line should be initialization
    await expect(terminalLines.first()).toContainText(/initializ|pipeline/i);
  });
});
