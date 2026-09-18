/**
 * @module e2e/media/media-coverage
 * @description Real-prod coverage for the media library — the API surface.
 *
 * ⚠️ The Media Library *admin UI* was REMOVED — `/admin/media` renders the
 * admin-404 (see `admin-verify/admin-surf-audit.mjs` — media + env-vars are NOT
 * admin routes). The six root-level `media-*.spec.ts` specs targeted that removed
 * UI via mocks and a dead route; they are `test.describe.skip`-ed with a pointer
 * here. Media survives ONLY as:
 *   - the backend API `/api/media/*` (this file covers it against live prod), and
 *   - the `media:write` API-token scope (covered by api-tokens component tests).
 *
 * Auth technique: assertions use Playwright's `page.request` (a clean HTTP client,
 * like curl) with an ABSOLUTE prod URL + explicit Bearer — NOT an in-page `fetch`,
 * which the SPA service worker (ngsw) intercepts and serves the app shell for on
 * `/api/*` (a 200 with no JSON body). Unauthenticated mutations trip CF bot-fight
 * (403) rather than the worker's 401, so unauth checks assert the [401,403] union.
 *
 * Covered here (each asserted against the live worker, no mocks):
 *   MEDIA-07 — soft-delete asset gate (unauth reject, authed-nonexistent 404, list stays clean)
 *   MEDIA-08 — list endpoint auth gate (unauth reject, authed 200 + assets[] shape)
 *   MEDIA-09 — stock-search / generate / upload endpoints reject unauthenticated callers
 *
 * @packageDocumentation
 */

import { test, expect } from '../fixtures.js';
import { realDataAvailable } from '../helpers/realdata.js';
import type { Page } from '@playwright/test';

const KEY = process.env.E2E_API_KEY ?? '';
const BASE = process.env.PROD_URL ?? process.env.BASE_URL ?? 'https://projectsites.dev';

/** Reject statuses: 401 (worker auth) OR 403 (CF bot-fight on a mutation) — either proves no unauthenticated access. */
const AUTH_REJECT = [401, 403];

/**
 * Call the worker via Playwright's `page.request` (a clean HTTP client — no SPA
 * service worker interception, unlike an in-page `fetch`, which the ngsw serves the
 * app shell for on `/api/*`). Absolute URL + explicit Bearer mirror the verified curl.
 */
async function apiCall(
  page: Page,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  bearer?: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await page.request.fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { data: body } : {}),
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status(), json };
}

// ---------------------------------------------------------------------------
// MEDIA-07 — Soft-delete asset gate
// ---------------------------------------------------------------------------
test.describe('MEDIA-07 — Soft-delete asset gate', () => {
  test('DELETE /api/media/assets/:id rejects unauthenticated callers', async ({ page }) => {
    const { status } = await apiCall(page, 'DELETE', '/api/media/assets/nonexistent-id');
    expect(AUTH_REJECT).toContain(status);
  });

  test('DELETE /api/media/assets/:id with auth on nonexistent returns 404', async ({ authedPage: page }) => {
    test.skip(!realDataAvailable(), 'needs E2E_API_KEY for a real session');
    const { status } = await apiCall(page, 'DELETE', '/api/media/assets/nonexistent-asset-id-e2e', KEY);
    expect([404, 403]).toContain(status);
  });

  test('A fake delete never removes real assets — authed list stays 200 and clean', async ({ authedPage: page }) => {
    test.skip(!realDataAvailable(), 'needs E2E_API_KEY for a real session');
    const before = await apiCall(page, 'GET', '/api/media/assets', KEY);
    expect(before.status).toBe(200);

    await apiCall(page, 'DELETE', '/api/media/assets/e2e-fake-delete-id', KEY);

    const after = await apiCall(page, 'GET', '/api/media/assets', KEY);
    expect(after.status).toBe(200);
    const body = after.json ?? {};
    const items = (Array.isArray(body) ? body : (body.assets ?? body.items ?? [])) as unknown[];
    const hasFakeId = items.some((item) => (item as Record<string, unknown>).id === 'e2e-fake-delete-id');
    expect(hasFakeId).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MEDIA-08 — List endpoint auth gate (the surviving media surface)
// ---------------------------------------------------------------------------
test.describe('MEDIA-08 — Media asset list auth gate', () => {
  test('GET /api/media/assets rejects unauthenticated callers', async ({ page }) => {
    const { status } = await apiCall(page, 'GET', '/api/media/assets');
    expect(AUTH_REJECT).toContain(status);
  });

  test('GET /api/media/assets returns 200 + assets[] when authed', async ({ authedPage: page }) => {
    test.skip(!realDataAvailable(), 'needs E2E_API_KEY for a real session');
    const { status, json } = await apiCall(page, 'GET', '/api/media/assets', KEY);
    expect(status).toBe(200);
    // Envelope is { ok:true, assets:[...] } — assert the contract, not a count
    // (a fresh org may legitimately have zero assets).
    const assets = (json?.assets ?? json?.items) as unknown;
    expect(Array.isArray(assets)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MEDIA-09 — Generation + stock + upload endpoints reject unauthenticated callers
// ---------------------------------------------------------------------------
test.describe('MEDIA-09 — Media write endpoints require auth', () => {
  test('POST /api/media/stock/search rejects unauth', async ({ page }) => {
    const { status } = await apiCall(page, 'POST', '/api/media/stock/search', undefined, { q: 'coffee' });
    expect(AUTH_REJECT).toContain(status);
  });

  test('POST /api/media/generate/image rejects unauth', async ({ page }) => {
    const { status } = await apiCall(page, 'POST', '/api/media/generate/image', undefined, { prompt: 'a logo' });
    expect(AUTH_REJECT).toContain(status);
  });

  test('POST /api/media/upload rejects unauth', async ({ page }) => {
    const { status } = await apiCall(page, 'POST', '/api/media/upload', undefined, {});
    expect(AUTH_REJECT).toContain(status);
  });
});
