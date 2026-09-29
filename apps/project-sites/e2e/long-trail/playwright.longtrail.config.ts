/**
 * @file Playwright config for the Long-Trail LIVE-stack suite.
 *
 * Unlike the frontend's default `playwright.config.ts` (which serves the built SPA statically
 * on :4300 with NO worker proxy — it cannot reach the real API), this config targets the LIVE
 * local dev stack: `ng serve` on :4200 proxying `/api` → `wrangler dev` on :8787. Both servers
 * must already be running (see `apps/project-sites/docs/local-dev-longtrail.md`); this config does
 * NOT start them (a long-trail journey needs the real worker + real D1, not a static shell).
 *
 * LOCAL Chromium only — a remote browser can't reach localhost.
 */
import { defineConfig, devices } from '@playwright/test';

const APP = process.env.LTT_APP_URL ?? 'http://localhost:4200';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false, // stateful money-path journey — keep ordered within a file
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: APP,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-local',
      use: {
        ...devices['Desktop Chrome'],
        // Prefer the installed Chrome locally; fall back to bundled Chromium in CI.
        ...(process.env.CI ? {} : { channel: 'chrome' }),
      },
    },
  ],
});
