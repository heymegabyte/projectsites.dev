/**
 * @module e2e/ai-workflow
 * @description End-to-end tests for the Cloudflare AI Workflow integration.
 *
 * Validates:
 * - create-from-search triggers a workflow and returns workflow_instance_id
 * - workflow status API returns step progression
 * - workflow completes and site transitions to published
 * - golden-path integration: full flow from search → auth → build → workflow complete
 *
 * Uses the E2E test server which mocks workflow behavior, simulating
 * step progression and completion over time.
 *
 * @packageDocumentation
 */

import { test, expect } from './fixtures.js';
import type { Page } from '@playwright/test';

// ─── Constants ──────────────────────────────────────────────

const BUSINESS = {
  place_id: 'ChIJ_wf_test_business',
  name: 'Workflow Test Bakery',
  address: '100 Baker St, Springfield, IL 62701',
  types: ['bakery', 'food'],
};

const MOCK_TOKEN = 'e2e-wf-token-abc123def456';

// Track workflow steps as they "complete"
const WORKFLOW_STEPS = [
  'research-profile',
  'research-social',
  'research-brand',
  'research-selling-points',
  'research-images',
  'generate-website',
  'generate-privacy-page',
  'generate-terms-page',
  'score-website',
  'upload-to-r2',
  'update-site-status',
];

// ─── Page-Level Mock Helpers ────────────────────────────────

const MOCK_PAGE_SITE_ID = 'site-wf-page-0000-0000-0000-000000000001';
const MOCK_PAGE_SLUG = 'workflow-test-bakery';
const MOCK_PAGE_WORKFLOW_ID = `wf-${MOCK_PAGE_SITE_ID}`;

/**
 * Set up page-level route mocks for the golden path UI test.
 * These intercept fetch() calls made BY the page's JavaScript.
 */
async function setupGoldenPathMocks(page: Page) {
  const apiCalls: Array<{ url: string; method: string; body?: unknown }> = [];
  let workflowStatus = 'running';
  let completedSteps: string[] = ['research-profile'];
  let siteStatus = 'building';

  await page.route('**/api/search/businesses*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [BUSINESS] }),
    }),
  );

  await page.route('**/api/sites/search*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    }),
  );

  await page.route('**/api/sites/lookup*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { exists: false } }),
    }),
  );

  await page.route('**/api/sites/create-from-search', async (route) => {
    const request = route.request();
    let body: unknown;
    try {
      body = JSON.parse(request.postData() ?? '{}');
    } catch {
      body = {};
    }
    apiCalls.push({ url: request.url(), method: request.method(), body });

    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          site_id: MOCK_PAGE_SITE_ID,
          slug: MOCK_PAGE_SLUG,
          status: 'building',
          workflow_instance_id: MOCK_PAGE_WORKFLOW_ID,
        },
      }),
    });
  });

  // Intercept workflow status requests from the page
  await page.route(`**/api/sites/${MOCK_PAGE_SITE_ID}/workflow`, async (route) => {
    apiCalls.push({ url: route.request().url(), method: route.request().method() });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          site_id: MOCK_PAGE_SITE_ID,
          workflow_available: true,
          instance_id: MOCK_PAGE_WORKFLOW_ID,
          workflow_status: workflowStatus,
          workflow_steps_completed: completedSteps,
          workflow_error: null,
          workflow_output:
            workflowStatus === 'complete'
              ? {
                  siteId: MOCK_PAGE_SITE_ID,
                  slug: MOCK_PAGE_SLUG,
                  version: '2026-02-07T00-00-00-000Z',
                  quality: 0.87,
                  pages: ['index.html', 'privacy.html', 'terms.html', 'research.json'],
                }
              : null,
          site_status: siteStatus,
        },
      }),
    });
  });

  await page.route(`**/api/sites/${MOCK_PAGE_SITE_ID}`, (route) => {
    if (route.request().url().includes('/workflow')) {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: MOCK_PAGE_SITE_ID,
        slug: MOCK_PAGE_SLUG,
        status: siteStatus,
      }),
    });
  });

  return {
    apiCalls,
    setWorkflowState: (status: string, steps: string[], site: string) => {
      workflowStatus = status;
      completedSteps = steps;
      siteStatus = site;
    },
  };
}

// ─── Tests: E2E Server API ──────────────────────────────────
// These tests use the `request` fixture, hitting the actual E2E server.

test.describe('AI Workflow: E2E Server Integration', () => {
  test('create-from-search returns workflow_instance_id', async ({ request }) => {
    const createRes = await request.post('/api/sites/create-from-search', {
      data: {
        mode: 'business',
        business: {
          name: 'E2E Server Test Business',
          address: '123 Test St',
          place_id: 'ChIJ_e2e_test',
        },
        additional_context: 'Test bakery specializing in sourdough.',
      },
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MOCK_TOKEN}`,
      },
    });

    expect(createRes.status()).toBe(201);
    const json = await createRes.json();
    expect(json.data).toHaveProperty('site_id');
    expect(json.data).toHaveProperty('slug');
    expect(json.data).toHaveProperty('status', 'building');
    expect(json.data).toHaveProperty('workflow_instance_id');
    expect(json.data.workflow_instance_id).toBeTruthy();
  });

  test('workflow status API shows running state after creation', async ({ request }) => {
    // Create a site first
    const createRes = await request.post('/api/sites/create-from-search', {
      data: {
        mode: 'business',
        business: { name: 'Status Check Business', address: '456 Oak Ave' },
      },
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MOCK_TOKEN}`,
      },
    });

    expect(createRes.status()).toBe(201);
    const createJson = await createRes.json();
    const siteId = createJson.data.site_id;

    // Check workflow status immediately
    const wfRes = await request.get(`/api/sites/${siteId}/workflow`, {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    });
    expect(wfRes.status()).toBe(200);
    const wfJson = await wfRes.json();
    expect(wfJson.data.workflow_available).toBe(true);
    expect(wfJson.data.workflow_status).toBe('running');
    expect(wfJson.data.workflow_steps_completed).toContain('research-profile');
  });

  test('workflow progresses to completion over time', async ({ request }) => {
    const createRes = await request.post('/api/sites/create-from-search', {
      data: {
        mode: 'business',
        business: { name: 'Time Progress Test', address: '789 Progress Ln' },
      },
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MOCK_TOKEN}`,
      },
    });

    const createJson = await createRes.json();
    const siteId = createJson.data.site_id;

    // Wait for workflow to complete (the E2E server simulates ~8s progression)
    await new Promise((r) => setTimeout(r, 9000));

    const wfRes = await request.get(`/api/sites/${siteId}/workflow`, {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    });
    const wfJson = await wfRes.json();
    expect(wfJson.data.workflow_status).toBe('complete');
    expect(wfJson.data.site_status).toBe('published');
    expect(wfJson.data.workflow_output).toBeTruthy();
    expect(wfJson.data.workflow_output.pages).toContain('index.html');
    expect(wfJson.data.workflow_output.quality).toBeGreaterThan(0);
  });

  test('rejects unauthenticated create-from-search', async ({ request }) => {
    const res = await request.post('/api/sites/create-from-search', {
      data: { business: { name: 'No Auth Business' } },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  test('rejects unauthenticated workflow status', async ({ request }) => {
    const res = await request.get('/api/sites/some-id/workflow');
    expect(res.status()).toBe(401);
  });

  test('returns null workflow for unknown site', async ({ request }) => {
    const wfRes = await request.get('/api/sites/unknown-site-id/workflow', {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    });
    expect(wfRes.status()).toBe(200);
    const wfJson = await wfRes.json();
    expect(wfJson.data.workflow_available).toBe(true);
    expect(wfJson.data.instance_id).toBeNull();
    expect(wfJson.data.workflow_status).toBeNull();
  });
});

// ─── Tests: Workflow Step Verification ──────────────────────
// Verifies the complete set of AI workflow steps via server progression.

test.describe('AI Workflow: Step Verification', () => {
  test('workflow includes all 11 expected steps when complete', async ({ request }) => {
    // Create site, wait for completion
    const createRes = await request.post('/api/sites/create-from-search', {
      data: {
        mode: 'business',
        business: { name: 'Step Verify Business', address: '100 Step St' },
      },
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MOCK_TOKEN}`,
      },
    });

    const createJson = await createRes.json();
    const siteId = createJson.data.site_id;

    // Wait for full completion
    await new Promise((r) => setTimeout(r, 9000));

    const wfRes = await request.get(`/api/sites/${siteId}/workflow`, {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    });
    const wfJson = await wfRes.json();

    expect(wfJson.data.workflow_status).toBe('complete');
    const steps = wfJson.data.workflow_steps_completed;

    // Verify all AI-related steps are present
    expect(steps).toContain('research-profile');
    expect(steps).toContain('research-social');
    expect(steps).toContain('research-brand');
    expect(steps).toContain('research-selling-points');
    expect(steps).toContain('research-images');
    expect(steps).toContain('generate-website');
    expect(steps).toContain('generate-privacy-page');
    expect(steps).toContain('generate-terms-page');
    expect(steps).toContain('score-website');
    expect(steps).toContain('upload-to-r2');
    expect(steps).toContain('update-site-status');
    expect(steps).toHaveLength(WORKFLOW_STEPS.length);
  });

  test('workflow step progression follows correct phases', async ({ request }) => {
    const createRes = await request.post('/api/sites/create-from-search', {
      data: {
        mode: 'business',
        business: { name: 'Phase Check Biz', address: '200 Phase Ave' },
      },
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MOCK_TOKEN}`,
      },
    });

    const siteId = (await createRes.json()).data.site_id;

    // Phase 1: Immediately after creation - research-profile should be started
    const wf1 = await request.get(`/api/sites/${siteId}/workflow`, {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    });
    const json1 = await wf1.json();
    expect(json1.data.workflow_status).toBe('running');
    expect(json1.data.workflow_steps_completed).toContain('research-profile');

    // Wait for parallel research to complete (~2s)
    await new Promise((r) => setTimeout(r, 3000));

    const wf2 = await request.get(`/api/sites/${siteId}/workflow`, {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    });
    const json2 = await wf2.json();
    const steps2 = json2.data.workflow_steps_completed;
    expect(steps2.length).toBeGreaterThan(1);

    // Wait for full completion
    await new Promise((r) => setTimeout(r, 7000));

    const wf3 = await request.get(`/api/sites/${siteId}/workflow`, {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    });
    const json3 = await wf3.json();
    expect(json3.data.workflow_status).toBe('complete');
    expect(json3.data.site_status).toBe('published');
  });
});

// ─── Tests: Golden Path with Workflow (UI) ──────────────────
// Full UI flow: Search → Auth → Build → Workflow → Published

// RETIRED 2026-09-20 (AL-839) — this UI test drove the DELETED vanilla `public/index.html` flow
// (#screen-details · #build-btn · window.state · window.redirectTo · #email-input · "building your
// website"), removed 2026-07-31 — a false-green phantom on dead selectors (page.route-mocked, never
// real prod). The REAL search→auth→build→workflow→published journey is now proven end-to-end by the
// golden-journey delivery (`deliver-business.mjs` → poll to published + `verify-delivered-site-
// propagation.mjs` + `golden-path.spec.ts`). The two API describes ABOVE stay LIVE (mock create-from-
// search contract shape + auth-gating). Skipped (not deleted) per e2e-accumulation.
test.describe.skip('AI Workflow: Golden Path with Workflow', () => {
  test('Search → Email Auth → Build → Workflow triggers and creates site', async ({ page }) => {
    const { apiCalls, setWorkflowState } = await setupGoldenPathMocks(page);

    // Mock magic link send
    await page.route('**/api/auth/magic-link', (route) => {
      // Only intercept POST (send), not GET (verify callback)
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            data: { expires_at: new Date(Date.now() + 600000).toISOString() },
          }),
        });
      }
      return route.continue();
    });
    // Mock magic link verify callback
    await page.route('**/api/auth/magic-link/verify*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            token: MOCK_TOKEN,
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            user_id: 'user-wf-001',
            org_id: 'org-wf-001',
          },
        }),
      }),
    );

    await page.goto('/');

    // Stub redirectTo
    await page.evaluate(() => {
      (window as any).redirectTo = (url: string) => {
        (window as any)._lastRedirect = url;
      };
    });

    // ── Step 1: Search and select business ────────────────
    const input = page.getByPlaceholder(/Enter your business name/);
    await input.click();
    await input.pressSequentially('Workflow Test Bakery', { delay: 20 });

    await expect(
      page.locator('.search-result').filter({ hasText: 'Workflow Test Bakery' }),
    ).toBeVisible({ timeout: 15_000 });

    await page
      .locator('.search-result')
      .filter({ hasText: 'Workflow Test Bakery' })
      .first()
      .click();

    // ── Step 2: Details screen → Build → Sign-in → Email Magic Link ──
    await expect(page.locator('#screen-details')).toBeVisible({ timeout: 10_000 });

    const textarea = page.locator('#details-textarea');
    await textarea.fill(
      'Artisan bakery specializing in sourdough, pastries, and custom cakes. ' +
        'Family-owned since 2010.',
    );

    const buildBtn = page.locator('#build-btn');
    await expect(buildBtn).toBeVisible();
    await buildBtn.click();

    // Build triggers sign-in (deferred flow)
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByRole('button', { name: /email/i }).click();
    const emailInput = page.locator('#email-input');
    await expect(emailInput).toBeVisible();
    await emailInput.fill('test@example.com');
    await page.locator('#email-send-btn').click();

    // Simulate magic link callback by setting session directly in page state
    await page.evaluate((token) => {
      (window as any).state = (window as any).state || {};
      (window as any).state.session = { token };
    }, MOCK_TOKEN);

    // After magic link verify: auto-navigates to details → auto-submits build

    // ── Step 4: Waiting screen shows workflow in progress ──
    await expect(page.getByText(/building your website/i)).toBeVisible({ timeout: 10_000 });

    // Verify create-from-search API was called
    const createCall = apiCalls.find((c) => c.url.includes('create-from-search'));
    expect(createCall).toBeTruthy();
    expect(createCall!.method).toBe('POST');

    const body = createCall!.body as Record<string, unknown>;
    expect(body).toHaveProperty('mode', 'business');
    const hasBusiness = (body as any).business?.name || (body as any).business_name;
    expect(hasBusiness).toBeTruthy();

    // ── Step 5: Simulate workflow completion ───────────────
    setWorkflowState('complete', WORKFLOW_STEPS, 'published');

    // Verify the create response included workflow_instance_id
    // (The mock returns it, so the page's JS would have it)
    // The important assertion is that the API was called successfully
    expect(createCall).toBeTruthy();
  });
});
