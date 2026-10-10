import { expect, test } from '@playwright/test';

import { resilientGet } from './helpers/api-request.js';

/**
 * Per-site OWN-R2 "Buckets" surface (`/api/sites/:siteId/r2/buckets[/:bucket[/objects/*]]`) —
 * the R2 analog of the per-site D1 Tables surface (flag `r2_buckets`, handlers in
 * libs/features/r2_buckets/handlers.ts).
 *
 * Every route is auth-gated FIRST (401 when unauthenticated), then flag-gated (404 DARK when off,
 * never 403 / leak) + IDOR-guarded (ownsSiteData). What's verifiable on prod without a session — and
 * what proves the surface is mounted + hard-gated, not a soft-404 SPA shell — is that an
 * UNAUTHENTICATED caller is rejected with a JSON 401 and a bogus bearer never yields anonymous data
 * access. Authed create/list + object CRUD are covered by the worker unit tests in
 * libs/features/r2_buckets/__tests__.
 */
const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';

test.describe('Per-site R2 Buckets API (auth + dark-launch contract)', () => {
  test('GET /r2/buckets requires auth (401 JSON, route mounted, no 5xx)', async ({ request }) => {
    const res = await resilientGet(request, '/api/sites/any-site/r2/buckets');
    expect(res.status()).toBe(401);
    expect(res.headers()['content-type'] ?? '').toContain('application/json');
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('UNAUTHORIZED');
  });

  test('GET /r2/buckets/:bucket/objects requires auth (JSON, never the SPA shell)', async ({
    request,
  }) => {
    const res = await resilientGet(request, '/api/sites/any-site/r2/buckets/demo/objects');
    expect(res.status()).toBe(401);
    const ct = res.headers()['content-type'] ?? '';
    expect(ct).toContain('application/json');
    expect(ct).not.toContain('text/html');
  });

  test('a bogus bearer token is still rejected (no anonymous R2 access)', async ({ request }) => {
    const res = await request.get(`${PROD_URL}/api/sites/any-site/r2/buckets`, {
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.status()).toBe(401);
  });
});

/**
 * Object-browser VIEW-MODE toggle (list ⇄ grid).
 *
 * The Buckets object browser (editor Resources → Buckets) toggles its object surface between a list
 * and a grid. In `BucketsPanel.tsx` the SAME body container flips its `data-testid` between
 * `buckets-object-list` and `buckets-object-grid` based on `viewMode`, driven by the
 * `buckets-view-list` / `buckets-view-grid` segmented control (and persisted across remounts in
 * sessionStorage). That toggle is AUTHED-editor UI behind Cloudflare Access — this API-contract spec
 * runs with no session and no stable prod selector for it, so the toggle has no live assertion HERE.
 * Its coverage lives where it is reachable:
 *   - UNIT (green): `app/components/workbench/BucketsPanel.spec.tsx` §"B1-polish: Files list/grid
 *     view toggle" — defaults to list, both toggle controls present, clicking grid swaps
 *     `buckets-object-list` → `buckets-object-grid` with two `buckets-object-tile`s, persists across
 *     remounts.
 *   - E2E (populated, headless): once the sibling's `/_preview` populated sample renders both the
 *     `buckets-object-list` and `buckets-object-grid`, `e2e/r2-buckets/populated-gallery.spec.ts`
 *     asserts both testids live. That is the headless home for the toggle's rendered output; this
 *     seam records the inventory so the toggle is never left unaccounted-for.
 */
test.describe('Per-site R2 Buckets — object-browser view toggle (list ⇄ grid)', () => {
  test.fixme(
    'list ⇄ grid toggle swaps buckets-object-list ⇄ buckets-object-grid (authed editor; Vitest-covered, headless via /_preview populated sample)',
    async () => {
      // Intentionally a seam: covered by BucketsPanel.spec.tsx (unit) + populated-gallery.spec.ts
      // (headless). No stable unauthenticated prod selector exists for the authed toggle control.
    },
  );
});
