/**
 * API coverage — data-surface routes (env-vars / media / inbox / internal).
 *
 * The highest-risk data surfaces in the worker:
 *  - `/api/env-vars/*` stores ENCRYPTED SECRETS — an ungated read is worse than
 *    the Pass-25 code-export leak. Unauth MUST hit 401/403/404, never a 2xx.
 *  - `/api/media/*` — the asset library + `assets/:id/raw` streams R2 objects.
 *  - `/api/inbox/*` — support conversations + agent tasks (tenant data).
 *  - `/api/internal/build-status` — HMAC-signed container callback; an unsigned
 *    caller must be rejected [400,401,403], never processed.
 *
 * Authenticates nothing; `request` fixture only — never mutates prod.
 *
 * @see {@link ../../src/routes/env_vars.ts}
 * @see {@link ../../src/routes/api.ts}
 */
import { test, expect } from '@playwright/test';
import { resilientGet, resilientPost } from '../helpers/api-request.js';

const PROD = process.env.PROD_URL ?? 'https://projectsites.dev';

/** The only leak-free responses for an unauthenticated caller. */
const GATE = [401, 403, 404];
/** A forged/unsigned callback must land here — never a 2xx. */
const SIG_GATE = [400, 401, 403];

const ID = 'e2e-probe-1';

test.describe('env-vars (encrypted secrets) — unauth safety gate (P10 coverage)', () => {
  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['get', '/api/env-vars', undefined],
    ['get', '/api/env-vars/export?scope=org', undefined],
    ['post', '/api/env-vars', { scope: 'org', key: 'K', value: 'v' }],
    ['patch', `/api/env-vars/${ID}`, { value: 'v' }],
    ['delete', `/api/env-vars/${ID}`, undefined],
    ['post', '/api/env-vars/import', { scope: 'org', dotenv: 'A=b' }],
  ];
  for (const [method, path, data] of cases) {
    test(`${method.toUpperCase()} ${path} — unauth never leaks/mutates secrets`, async ({
      request,
    }) => {
      const res = await request[method as 'get'](`${PROD}${path}`, data ? { data } : undefined);
      expect(GATE, `unauth must be gated — got ${res.status()}`).toContain(res.status());
    });
  }
});

test.describe('media library — unauth safety gate (P10 coverage)', () => {
  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['get', '/api/media/assets', undefined],
    ['get', `/api/media/assets/${ID}`, undefined],
    ['get', `/api/media/assets/${ID}/raw`, undefined],
    ['delete', `/api/media/assets/${ID}`, undefined],
    ['post', '/api/media/stock/search', { query: 'x' }],
    ['post', '/api/media/generate/image', { prompt: 'x' }],
    ['post', '/api/media/generate/video', { prompt: 'x' }],
    ['post', '/api/media/generate/podcast', { text: 'x' }],
  ];
  for (const [method, path, data] of cases) {
    test(`${method.toUpperCase()} ${path} — unauth is gated`, async ({ request }) => {
      const res = await request[method as 'get'](`${PROD}${path}`, data ? { data } : undefined);
      expect(GATE, `unauth must be gated — got ${res.status()}`).toContain(res.status());
    });
  }
});

test.describe('inbox (support conversations + tasks) — unauth safety gate (P10 coverage)', () => {
  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['get', `/api/inbox/conversations/${ID}`, undefined],
    ['post', `/api/inbox/conversations/${ID}/draft-with-ai`, { prompt: 'x' }],
    ['get', '/api/inbox/tasks', undefined],
    ['post', `/api/inbox/tasks/${ID}/resolve`, {}],
  ];
  for (const [method, path, data] of cases) {
    test(`${method.toUpperCase()} ${path} — unauth is gated`, async ({ request }) => {
      const res = await request[method as 'get'](`${PROD}${path}`, data ? { data } : undefined);
      expect(GATE, `unauth must be gated — got ${res.status()}`).toContain(res.status());
    });
  }

  // The conversations LIST is org-scoped (services/inbox.ts `WHERE c.org_id = ?`):
  // an unauth caller (orgId='') gets an EMPTY list — safe-by-design, never a leak.
  // Accept a gate OR a 200 whose conversations are empty (a populated 200 = FAIL).
  test('GET /api/inbox/conversations — unauth gated or empty (no leak)', async ({ request }) => {
    const res = await resilientGet(request, `${PROD}/api/inbox/conversations`);
    const s = res.status();
    if (!GATE.includes(s)) {
      expect(s, `must be a gate or an empty 200 — got ${s}`).toBe(200);
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      const conv = (body?.conversations ?? []) as unknown[];
      expect(Array.isArray(conv) ? conv.length : 1, 'unauth 200 must not leak conversations').toBe(0);
    }
  });
});

test.describe('analytics ingestion plane — cross-tenant IDOR gate (AL-789)', () => {
  // `/api/analytics-data`, `/api/analytics-debug`, `/api/test-event` each accept a CLIENT
  // `siteId` (slug OR id) and touch that site's data; authMiddleware is populate-only. Before
  // the fix an unauth caller could read ANY tenant's visitor_events (session ids, visitor geo,
  // UA) by naming a public subdomain slug, and inject synthetic events into a foreign feed —
  // PROVEN LIVE. An unauth caller naming a REAL site MUST now be gated. (A CF bot-challenge 403
  // also satisfies the gate — either way no cross-tenant analytics is served.)
  const REAL = 'franklin-barbecue'; // a real public slug — the exact exploit vector
  const cases: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['get', `/api/analytics-data?siteId=${REAL}&limit=3`, undefined],
    ['get', `/api/analytics-debug?siteId=${REAL}`, undefined],
    ['post', `/api/test-event?siteId=${REAL}&provider=sentry`, undefined],
  ];
  for (const [method, path] of cases) {
    test(`${method.toUpperCase()} ${path} — unauth never reads/writes a foreign site's analytics`, async ({
      request,
    }) => {
      const res = await request[method as 'get'](`${PROD}${path}`);
      expect(GATE, `unauth must be gated (no cross-tenant analytics) — got ${res.status()}`).toContain(
        res.status(),
      );
    });
  }
});

test.describe('internal build-status callback — forgery gate (P10 coverage)', () => {
  test('POST /api/internal/build-status — unsigned callback is rejected, never processed', async ({
    request,
  }) => {
    const res = await resilientPost(request, `${PROD}/api/internal/build-status`, {
      data: { siteId: ID, status: 'published' },
    });
    expect(SIG_GATE, `unsigned build callback must reject — got ${res.status()}`).toContain(
      res.status(),
    );
  });
});
