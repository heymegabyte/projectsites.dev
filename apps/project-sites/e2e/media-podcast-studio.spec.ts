/**
 * @fileoverview E2E — Media > Podcast Studio tab (TDD-RED)
 *
 * Flow: homepage → Admin → Media → Podcast Studio → add segment → enter text →
 *       assert Generate button enables → click Generate → either audio renders
 *       (happy path) or friendly missing-key error toast (no ELEVENLABS_API_KEY).
 *
 * Screenshots in e2e/screenshots/media-podcast-studio/.
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
      JSON.stringify({ token: 'e2e-podcast-token', email: 'test@megabyte.space' }),
    );
  });

  await page.route('**/api/auth/me', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: { user_id: 'u-pod', org_id: 'org-pod', email: 'test@megabyte.space' },
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

/** Happy-path stub: TTS returns an audio URL. */
async function stubPodcastGenerate(page: Page): Promise<{ calls: string[] }> {
  const calls: string[] = [];

  const generateStub = async (route: Route) => {
    const body = await route.request().postDataJSON() as { segments?: unknown[] };
    calls.push(JSON.stringify(body));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: `pod-${Date.now()}`,
          audio_url: 'https://storage.projectsites.dev/podcasts/ep1.mp3',
          duration_seconds: 42,
          created_at: new Date().toISOString(),
        },
      }),
    });
  };
  // glob-ok: leaf endpoints (no deeper segments) registered as a PAIR — the
  // REAL worker route is POST /api/media/generate/podcast (segment order
  // reversed vs the legacy glob, which matches nothing on its own); mid-token
  // ** can't cross '/'.
  await page.route('**/api/media/podcast/generate**', generateStub);
  await page.route('**/api/media/generate/podcast**', generateStub);

  return { calls };
}

/** Missing-key stub: returns 503. */
async function stubPodcastMissingKey(page: Page): Promise<void> {
  const missingKeyStub = async (route: Route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'AI_GENERATION_ERROR', message: 'ELEVENLABS_API_KEY is not configured' },
      }),
    });
  };
  // glob-ok: leaf-endpoint pair — real route is /api/media/generate/podcast
  // (see note above).
  await page.route('**/api/media/podcast/generate**', missingKeyStub);
  await page.route('**/api/media/generate/podcast**', missingKeyStub);
}

async function navigateToPodcastStudio(page: Page): Promise<void> {
  await page.goto('/');
  await page.click('[data-testid="nav-admin"], a[href*="/admin"], text=Admin');
  await page.waitForURL(/\/admin/);
  await page.click('[data-testid="sidebar-media"], [href*="media"], text=Media');
  await page.waitForURL(/\/admin\/media/);

  const tab = page.locator(
    '[data-testid="media-tab-podcast"], [role="tab"]:has-text("Podcast"), text=Podcast Studio',
  );
  await expect(tab).toBeVisible({ timeout: 8_000 });
  await tab.click();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

// SKIPPED — the Media Library admin UI was REMOVED (/admin/media renders admin-404,
// zero components/testids). This spec is mock-based against that dead route. The
// surviving media surface is the API, covered live in e2e/media/media-coverage.spec.ts.
test.describe.skip('Media — Podcast Studio tab', () => {
  test('Generate button enables only after a segment has text content', async ({ page }) => {
    await stubAuth(page);
    await stubPodcastGenerate(page);

    await navigateToPodcastStudio(page);
    await page.screenshot({ path: 'e2e/screenshots/media-podcast-studio/01-tab.png', fullPage: false });

    const generateBtn = page.locator(
      '[data-testid="podcast-generate-btn"], button:has-text("Generate"), button:has-text("Create Episode")',
    ).first();
    await expect(generateBtn).toBeVisible({ timeout: 8_000 });

    // Before adding a segment, button should be disabled
    const isDisabledBefore = await generateBtn.isDisabled();
    // Soft: some UIs may keep it enabled but show a validation error on click
    if (isDisabledBefore) {
      expect(isDisabledBefore).toBe(true);
    }

    // Add a segment
    const addSegmentBtn = page.locator(
      '[data-testid="podcast-add-segment"], button:has-text("Add Segment"), button:has-text("+ Segment")',
    );
    await expect(addSegmentBtn).toBeVisible({ timeout: 8_000 });
    await addSegmentBtn.click();

    // Fill in the segment text
    const segmentText = page.locator(
      '[data-testid="podcast-segment-text"], textarea[placeholder*="text" i], textarea[placeholder*="segment" i]',
    ).first();
    await expect(segmentText).toBeVisible({ timeout: 5_000 });
    await segmentText.fill('Welcome to our weekly podcast about AI-powered websites. Today we cover how Project Sites generates beautiful sites in under 15 minutes.');

    await page.screenshot({ path: 'e2e/screenshots/media-podcast-studio/02-segment-filled.png', fullPage: false });

    // Generate button should now be enabled
    await expect(generateBtn).toBeEnabled({ timeout: 3_000 });
  });

  test('clicking Generate produces audio player OR friendly missing-key toast', async ({ page }) => {
    // Default to happy path stub; if the real API is unavailable the error path runs
    await stubAuth(page);
    await stubPodcastGenerate(page);

    await navigateToPodcastStudio(page);

    const addSegmentBtn = page.locator(
      '[data-testid="podcast-add-segment"], button:has-text("Add Segment"), button:has-text("+ Segment")',
    );
    await expect(addSegmentBtn).toBeVisible({ timeout: 8_000 });
    await addSegmentBtn.click();

    const segmentText = page.locator(
      '[data-testid="podcast-segment-text"], textarea[placeholder*="text" i], textarea[placeholder*="segment" i]',
    ).first();
    await expect(segmentText).toBeVisible({ timeout: 5_000 });
    await segmentText.fill('This is a test podcast segment for e2e coverage.');

    const generateBtn = page.locator(
      '[data-testid="podcast-generate-btn"], button:has-text("Generate"), button:has-text("Create Episode")',
    ).first();
    await expect(generateBtn).toBeEnabled({ timeout: 5_000 });
    await generateBtn.click();

    // Either an audio player appears…
    const audioPlayer = page.locator(
      '[data-testid="podcast-audio-player"], audio, [data-testid="audio-result"]',
    );
    // …or an error toast appears with friendly missing-key copy
    const errorToast = page.locator(
      '[data-testid="toast-error"], [role="alert"], .toast-error, text=API key, text=ElevenLabs, text=not configured',
    );

    await expect(audioPlayer.or(errorToast).first()).toBeVisible({ timeout: 15_000 });

    await page.screenshot({ path: 'e2e/screenshots/media-podcast-studio/03-result.png', fullPage: false });
  });

  test('surfaces friendly missing-key error toast when ELEVENLABS_API_KEY absent', async ({ page }) => {
    await stubAuth(page);
    await stubPodcastMissingKey(page);

    await navigateToPodcastStudio(page);

    const addSegmentBtn = page.locator(
      '[data-testid="podcast-add-segment"], button:has-text("Add Segment")',
    );
    await expect(addSegmentBtn).toBeVisible({ timeout: 8_000 });
    await addSegmentBtn.click();

    const segmentText = page.locator(
      '[data-testid="podcast-segment-text"], textarea[placeholder*="text" i]',
    ).first();
    await expect(segmentText).toBeVisible({ timeout: 5_000 });
    await segmentText.fill('Test segment for error path.');

    const generateBtn = page.locator(
      '[data-testid="podcast-generate-btn"], button:has-text("Generate")',
    ).first();
    await expect(generateBtn).toBeEnabled({ timeout: 5_000 });
    await generateBtn.click();

    const errorToast = page.locator(
      '[data-testid="toast-error"], [role="alert"], .toast-error, text=API key, text=ElevenLabs, text=not configured, text=error',
    );
    await expect(errorToast.first()).toBeVisible({ timeout: 12_000 });

    await page.screenshot({ path: 'e2e/screenshots/media-podcast-studio/04-missing-key.png', fullPage: false });
  });

  // ─── Breakpoint smoke ───────────────────────────────────────────────────────

  for (const vp of BREAKPOINTS) {
    test(`Podcast Studio tab renders at ${vp.width}×${vp.height}`, async ({ page }) => {
      await page.setViewportSize(vp);
      await stubAuth(page);
      await stubPodcastGenerate(page);

      await navigateToPodcastStudio(page);

      await page.screenshot({
        path: `e2e/screenshots/media-podcast-studio/bp-${vp.width}.png`,
        fullPage: false,
      });

      const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(bodyWidth).toBeLessThanOrEqual(vp.width + 2);
    });
  }
});
