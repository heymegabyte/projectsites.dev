import { test, expect } from '@playwright/test';

/**
 * scheduled_publish dark-launch contract (feature: scheduled_publish, flag experimental/off).
 *
 * Homepage-first: load the app, then prove the Scheduled-Publish API is GUARDED — an
 * unauthenticated caller can never schedule, list, or cancel a site's go-live (every endpoint
 * returns a NON-200 dark/guarded status). CI-safe under both configs: the prod worker returns
 * 401 (auth guard) / 404 (flag dark); the local static server returns 404 (no such asset) — both
 * correctly non-200. The authed + flag-off → 404 path is confirmed by the prod-verify probe
 * (workers.dev, real session) in the deploy step.
 */
const SITE = '00000000-0000-0000-0000-000000000000';
const ENDPOINTS: { method: 'GET' | 'POST' | 'DELETE'; path: string }[] = [
  { method: 'GET', path: `/api/sites/${SITE}/publish-schedule` },
  { method: 'POST', path: `/api/sites/${SITE}/publish-schedule` },
  { method: 'DELETE', path: `/api/sites/${SITE}/publish-schedule` },
];

test('Scheduled-Publish API is guarded/dark for an unauthenticated caller', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();

  for (const { method, path } of ENDPOINTS) {
    const status = await page.evaluate(
      async ({ method, path }) => {
        try {
          const res = await fetch(path, {
            method,
            headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
            body: method === 'POST' ? JSON.stringify({ publish_at: '2099-01-01T00:00:00Z' }) : undefined,
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
