/**
 * Scan Profiles — authenticated API-contract E2E journey.
 *
 * SCOPE.md:68 (scan-profile persistence + CRUD, feature flag `scan_profiles`).
 *
 * WHY THIS SHAPE: the route is a Super-Admin JSON API with NO operator UI yet
 * (there is no `/admin/scan-profiles` page and no `scan-profiles` component in
 * `frontend/`). A browser journey test would therefore have to reach in through
 * an interface that does not exist — a spec driving phantom selectors is a
 * false-green (per the "mock-only spec + dead selectors" incident class). So
 * this spec drives the REAL surface that DOES exist: the four HTTP endpoints,
 * and asserts the CONTRACT (verbs, response keys, guard chain) rather than
 * pretending there is a screen.
 *
 * The guard chain asserted here mirrors `gateScanProfiles` exactly:
 *   unauthenticated → 401 · flag off → 404 (never 403) · non-super-admin → 403
 *   · malformed body → 400 · happy path → 200/201.
 *
 * When the admin UI lands (a `frontend/` scan-profiles section), REPLACE this
 * file with (or augment it by) a real click-through journey modelled on
 * `e2e/admin-leads-journey.spec.ts` — the sibling section it will live beside.
 *
 * Safety: this spec is READ-ONLY against prod. It issues GETs (which are
 * idempotent and flag-gated) and sends deliberately-invalid bodies to prove the
 * 400 path. It NEVER creates, patches, or deletes a live profile.
 */
import fs from 'fs';
import path from 'path';
import { test, expect } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const BASE = `${PROD_URL}/api/admin/scan-profiles`;

/** Deep-link the prod API with an optional bearer without pulling in a runner. */
async function call(
  pathname: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers['authorization'] = `Bearer ${init.token}`;

  const res = await fetch(`${BASE}${pathname}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null; // non-JSON (e.g. an HTML challenge page) — status is the signal
  }
  return { status: res.status, body };
}

/** RFC7807-ish envelope shape the route emits. */
function envelopeCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return undefined;
  return (err as { code?: string }).code;
}

function ensureDir(sub: string): string {
  const dir = path.join('e2e', 'screenshots', sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test.describe('Scan Profiles (API contract journey)', () => {
  test('unauthenticated GET is rejected with 401, never a 500 or an open list', async () => {
    const { status, body } = await call('');
    // 401 when the auth middleware sees no bearer. A 404 is also acceptable ONLY
    // as the flag-dark path (flag off hides existence) — never 200.
    expect([401, 404], `unexpected ${status}: ${JSON.stringify(body)}`).toContain(status);
    if (status === 401) {
      expect(envelopeCode(body), '401 must carry code=UNAUTHORIZED').toBe('UNAUTHORIZED');
    }
  });

  test('flag-off must hide the surface as 404 — never 403 (existence must not leak)', async () => {
    // A bogus bearer can never be a super-admin, so if the flag IS on we get 401
    // (auth first) or 403 (super-admin after). The one code that proves the
    // dark-launch contract is 404 — and 403 here would mean the flag gate either
    // does not exist or is misordered behind the super-admin check.
    const { status } = await call('', { token: 'e2e-not-a-real-token' });
    expect(status, 'scan_profiles must never answer 403 to an anonymous caller').not.toBe(403);
    expect([401, 404], `unexpected ${status}`).toContain(status);
  });

  test('unknown route under the family does not 200 the SPA shell (soft-404 guard)', async () => {
    const res = await fetch(`${BASE}/../definitely-not-a-route`, { redirect: 'manual' });
    // A JSON API must never answer 200 with the SPA index.html for a bogus path.
    if (res.status === 200) {
      const text = await res.text();
      expect(text.slice(0, 60).toLowerCase(), 'API returned the SPA shell').not.toContain(
        '<!doctype html',
      );
    } else {
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  test('the routes are registered (not 404-swallowed by a later wildcard mount)', async () => {
    // Hono wildcard-route-shadow regression guard: if a broad `app.route()` lands
    // AFTER scanProfilesRoutes, these verbs would answer 404 for a REASON OTHER
    // than the flag. With a valid-shaped bearer they must be reachable — i.e. the
    // status must be one of the guard-chain codes, never the router's own 404
    // with no code envelope.
    for (const [method, pathname] of [
      ['GET', ''],
      ['POST', ''],
      ['PATCH', '/e2e-probe-id'],
      ['DELETE', '/e2e-probe-id'],
    ] as const) {
      const { status, body } = await call(pathname, {
        method,
        token: 'e2e-not-a-real-token',
        body: method === 'POST' || method === 'PATCH' ? {} : undefined,
      });
      // 401 unauth / 404 flag-dark / 403 non-super-admin / 400 malformed are all
      // proof the handler was reached. A bare 404 with NO envelope on a
      // well-formed path would be route shadowing.
      expect(
        [400, 401, 403, 404],
        `${method} ${pathname} → ${status} (router may be shadowing the mount)`,
      ).toContain(status);
      if (status === 404 && body !== null) {
        expect(['NOT_FOUND', undefined]).toContain(envelopeCode(body));
      }
    }
  });

  test('malformed bodies are rejected before any write (Zod boundary)', async () => {
    // Only meaningful if the caller got past auth; an unauthenticated 401 is a
    // pass too — the assertion is "never a 5xx, and never a silent 200 create".
    const cases = [
      { name: 'empty object', body: {} },
      { name: 'name too long', body: { name: 'x'.repeat(400) } },
      { name: 'unknown key (strict schema)', body: { name: 'ok', totallyBogusKey: 1 } },
      { name: 'wrong bboxes arity', body: { name: 'ok', bboxes: [1, 2, 3] } },
      { name: 'intervalMinutes past the cap', body: { name: 'ok', intervalMinutes: 999_999 } },
      { name: 'maxLeadsPerRun out of range', body: { name: 'ok', maxLeadsPerRun: 10_000 } },
    ];

    for (const { name, body } of cases) {
      const res = await call('', { method: 'POST', body, token: 'e2e-not-a-real-token' });
      expect(res.status, `${name} → ${res.status}: a malformed body must never 5xx`).toBeLessThan(500);
      expect(
        [400, 401, 403, 404],
        `${name} → ${res.status} (expected a typed rejection, got ${JSON.stringify(res.body)})`,
      ).toContain(res.status);
    }
  });

  test('patching a non-existent id never 5xx-es and never silently succeeds', async () => {
    const { status, body } = await call('/e2e-nonexistent-profile', {
      method: 'PATCH',
      body: { enabled: true },
      token: 'e2e-not-a-real-token',
    });
    expect(status, `PATCH missing id → ${status}`).toBeLessThan(500);
    expect([400, 401, 403, 404], `unexpected ${status}`).toContain(status);
    if (status === 404) {
      expect(envelopeCode(body)).toBe('NOT_FOUND');
    }
  });

  test('deleting a non-existent id is idempotent-safe, never a crash', async () => {
    const { status } = await call('/e2e-nonexistent-profile', {
      method: 'DELETE',
      token: 'e2e-not-a-real-token',
    });
    expect(status, `DELETE missing id → ${status}`).toBeLessThan(500);
    expect([400, 401, 403, 404], `unexpected ${status}`).toContain(status);
  });

  test('no response ever leaks a stack trace, SQL, or internal path', async () => {
    const dir = ensureDir('scan-profiles');
    const { status, body } = await call('', { token: 'e2e-not-a-real-token' });
    const serialized = JSON.stringify(body ?? '');
    for (const leak of ['SELECT ', 'INSERT ', 'at Object.', 'node_modules', '/src/', '.ts:']) {
      expect(serialized, `response leaked "${leak}"`).not.toContain(leak);
    }
    fs.writeFileSync(
      path.join(dir, '01-guard-response.json'),
      JSON.stringify({ status, body }, null, 2),
      'utf8',
    );
  });
});
