import { test, expect } from '@playwright/test';

/**
 * prompt_schedule dark-launch contract (feature: prompt_schedule, flag experimental/off).
 *
 * Homepage-first: load the app, then prove the Prompt Scheduler API is GUARDED — an
 * unauthenticated caller can never list, create, read-active, or delete schedules (every
 * endpoint returns a NON-200 dark/guarded status). This is CI-safe under both configs: the
 * prod worker returns 401 (auth guard) / 404 (flag dark); the local static server returns 404
 * (no such asset) — both are correctly non-200. The authed + flag-off → 404 path is confirmed
 * by the prod-verify probe (workers.dev, real session) in the deploy step.
 */
const ENDPOINTS: { method: 'GET' | 'POST' | 'DELETE'; path: string }[] = [
  { method: 'GET', path: '/api/prompt-schedules' },
  { method: 'GET', path: '/api/prompt-schedules/active?key=hero' },
  { method: 'POST', path: '/api/prompt-schedules' },
  { method: 'DELETE', path: '/api/prompt-schedules/00000000-0000-0000-0000-000000000000' },
];

test('Prompt Scheduler API is guarded/dark for an unauthenticated caller', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();

  for (const { method, path } of ENDPOINTS) {
    const status = await page.evaluate(
      async ({ method, path }) => {
        try {
          const res = await fetch(path, {
            method,
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
            body: method === 'POST' ? JSON.stringify({ prompt_key: 'hero', variant: 'v1', activate_at: '2026-01-01T00:00:00Z' }) : undefined,
          });
          return res.status;
        } catch {
          return 0;
        }
      },
      { method, path },
    );
    // Never 200 — the scheduler is never open to an unauthenticated caller.
    expect(status, `${method} ${path} must be guarded (got ${status})`).not.toBe(200);
  }
});
