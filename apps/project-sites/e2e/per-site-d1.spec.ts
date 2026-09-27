import { expect, test } from '@playwright/test';

import { resilientGet } from './helpers/api-request.js';

/**
 * Per-site OWN-D1 "Tables" surface (`/api/sites/:siteId/db/tables[/:table]`) — Data Platform
 * foundation. The feature ships DARK (flag `per_site_data` default-off), so the OWNER path can't be
 * exercised on prod yet; what IS verifiable — and what proves "isolation ships BEFORE owner access"
 * — is that the routes are mounted and hard-gated: an UNAUTHENTICATED caller is rejected with a JSON
 * 401 (not a 500, and not the 200 SPA shell a soft-404 would serve). With auth + flag-off the routes
 * return a DARK 404 (covered by the worker unit tests in `libs/features/site_data_api/__tests__`).
 */
const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

test.describe('Per-site D1 Tables API (dark-launch contract)', () => {
  test('GET /db/tables requires auth (401 JSON, route mounted, no 5xx)', async ({ request }) => {
    const res = await resilientGet(request, '/api/sites/any-site/db/tables');
    expect(res.status()).toBe(401);
    expect(res.headers()['content-type'] ?? '').toContain('application/json');
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  test('GET /db/tables/:table requires auth (401 JSON, never the SPA shell)', async ({ request }) => {
    const res = await resilientGet(request, '/api/sites/any-site/db/tables/customers');
    expect(res.status()).toBe(401);
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toContain('application/json');
    expect(ct).not.toContain('text/html');
  });

  test('a bogus bearer token is still rejected (no anonymous data access)', async ({ request }) => {
    const res = await request.get(`${PROD_URL}/api/sites/any-site/db/tables`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status()).toBe(401);
  });
});
