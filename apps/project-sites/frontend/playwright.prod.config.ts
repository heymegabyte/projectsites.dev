/**
 * Prod E2E config — runs `*.e2e.ts` specs against the live site with a real
 * Chromium (the default `playwright.config.ts` targets localhost + `*.spec.ts`
 * with mocked fixtures; this is separate so the two never collide).
 *
 * Run: `E2E_API_KEY=$(get-secret E2E_API_KEY) npx playwright test --config=playwright.prod.config.ts`
 * The spec seeds `ps_session` from `E2E_API_KEY` (a real `psk_test_` API key row
 * in prod D1) so the admin shell authenticates without a backdoor.
 *
 * Parallel execution: `fullyParallel: true` + `workers` (default 50% of cores,
 * override via `PW_WORKERS`). Every spec is independent + parallel-safe.
 *
 * Cloudflare Browser Rendering: set `CF_BROWSER_WS_ENDPOINT` to a Browser
 * Rendering Playwright WebSocket endpoint and the run drives a remote CF
 * browser instead of a local Chromium — many parallel cloud sessions, no local
 * browser needed. The remote browser reaches the PUBLIC `baseURL` (that's why
 * CF Browser lives here and not in the localhost dev config). Inert when unset.
 *   CF_BROWSER_WS_ENDPOINT="wss://…browser-rendering…" \
 *   E2E_API_KEY=$(get-secret E2E_API_KEY) \
 *   npx playwright test --config=playwright.prod.config.ts
 */
import { defineConfig, devices } from '@playwright/test';

const cfBrowserWs = process.env.CF_BROWSER_WS_ENDPOINT;

// Playwright's `workers` accepts a NUMBER or a percentage STRING ('50%') — a bare
// non-percentage string ('4') is rejected at config-load. Coerce a numeric override
// to a Number so the documented `PW_WORKERS=4` override actually works.
const rawWorkers = process.env.PW_WORKERS;
const workers = rawWorkers ? (/^\d+$/.test(rawWorkers) ? Number(rawWorkers) : rawWorkers) : '50%';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  workers,
  // 2 retries: this targets the LIVE site whose persistent editor iframe adds
  // first-load network time, so the first attempt can be timing-flaky.
  retries: 2,
  // 60s per-test (vs Playwright's 30s default; the sibling WORKER cert config uses 45s):
  // these are PROD journeys — real edge latency + a persistent WebContainer iframe +
  // full-suite parallel contention. Deep multi-step tests (create → nav → hard-reload →
  // verify → cleanup) legitimately take 20-45s under load and randomly tipped the 30s
  // default (env-vars / ai-endpoints / timeline-notes each flaked on different runs).
  // Inner waits (waitForResponse 12s, toBeVisible 8s, expect 5s) still fail a REAL product
  // hang fast — this only absorbs cumulative-latency-under-load, never masks one. (Bound
  // every in-page fetch with AbortSignal.timeout so a hang fails fast, not at this ceiling.)
  timeout: 60_000,
  // Actions uploads playwright-report/: the terminal reporter alone creates no artifact.
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['line']],
  use: {
    baseURL: process.env.PROD_URL || 'https://projectsites.dev',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Drive a remote Cloudflare Browser Rendering instance when configured;
    // otherwise launch a local Chromium. Connecting to a shared remote browser
    // lets the whole suite fan out across CF's browser fleet in parallel.
    ...(cfBrowserWs ? { connectOptions: { wsEndpoint: cfBrowserWs } } : {}),
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
});
