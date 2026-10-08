/**
 * Shared admin test-login helper for prod golden-path E2E (`*.e2e.ts`).
 *
 * This encodes the HARD-WON auth recipe (fire-122, GOLDEN-AUTH-1) so no spec ever re-discovers
 * the 3 bugs that bounced every browser golden-path to /signin for ~4 fires:
 *   1. Load `/` FIRST — that acquires the Cloudflare `cf_clearance` cookie; the IN-PAGE fetch then
 *      carries it. A node/curl POST to /api/auth/test-login has no clearance → 403 "Just a moment".
 *   2. The token is at `.data.token`, NOT the top level — the worker wraps it:
 *      `c.json({ data: { token, email, user_id, org_id } })` (src/routes/api.ts → authenticateTestLogin).
 *   3. Seed `localStorage['ps_session']` with the EXACT `Session` shape `{token, identifier, createdAt}`
 *      — AuthService.setSession (SESSION_KEY='ps_session') stamps `createdAt` and runs a TTL check on
 *      reload; a session WITHOUT createdAt is treated as EXPIRED and cleared → /admin bounces to /signin.
 *
 * Ref memory: `golden-path-test-login-seam-cf-bot-challenged` (the working recipe).
 */
import { execFileSync } from 'node:child_process';

import type { Page } from '@playwright/test';

export const TEST_EMAIL = 'brian@megabyte.space';

/** Console noise filter shared by golden-path specs — platform third-party chatter, never product errors. */
export const CONSOLE_NOISE = [
  'favicon',
  'posthog',
  'Failed to load resource',
  'stackblitz',
  'editor.projectsites.dev',
  'cdn-cgi',
  'cloudflareinsights',
];

export function filterConsoleNoise(errors: string[]): string[] {
  return errors.filter((e) => !CONSOLE_NOISE.some((n) => e.includes(n)));
}

/** E2E test password: env first, then `get-secret`. Returns null when unobtainable (caller skips). */
export function getTestPassword(): string | null {
  const fromEnv = process.env.E2E_TEST_PASSWORD || process.env.TEST_USER_PASSWORD;
  if (fromEnv) return fromEnv;
  try {
    const out = execFileSync('get-secret', ['E2E_TEST_PASSWORD'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // unavailable
  }
  return null;
}

export interface AdminAuthResult {
  ok: boolean;
  status?: number;
  bouncedToSignin?: boolean;
}

/**
 * Authenticate into /admin via the test-login seam. Call AFTER the page is created; it navigates to
 * `prodUrl` (for cf_clearance), POSTs the seam in-page, seeds the session, then lands on /admin.
 *
 * @returns `{ ok: true }` on a seeded session landing in /admin; `{ ok: false, ... }` otherwise.
 *          Pass `password` explicitly or rely on {@link getTestPassword}; a null password → `ok:false`.
 */
export async function authenticateAdmin(
  page: Page,
  opts: { prodUrl: string; email?: string; password?: string | null },
): Promise<AdminAuthResult> {
  const email = opts.email ?? TEST_EMAIL;
  const password = opts.password === undefined ? getTestPassword() : opts.password;
  if (!password) return { ok: false };

  await page.goto(opts.prodUrl, { waitUntil: 'domcontentloaded' });

  const seeded = await page.evaluate(
    async ({ email: em, pwd, base }: { email: string; pwd: string; base: string }) => {
      const r = await fetch(`${base}/api/auth/test-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: em, password: pwd }),
        credentials: 'include',
      });
      if (!r.ok) return { ok: false as const, status: r.status };
      const json = (await r.json()) as {
        data?: { token?: string; email?: string; user_id?: string; org_id?: string };
        token?: string;
      };
      const result = json.data ?? json;
      const token = result.token;
      if (!token) return { ok: false as const, status: 0 };
      localStorage.setItem(
        'ps_session',
        JSON.stringify({ token, identifier: em, createdAt: Date.now() }),
      );
      localStorage.setItem('ps_user', JSON.stringify(result));
      localStorage.setItem('ps_feedback_dismissed', 'true');
      return { ok: true as const };
    },
    { email, pwd: password, base: opts.prodUrl },
  );

  if (!seeded.ok) return { ok: false, status: seeded.status };

  await page.goto(`${opts.prodUrl}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('domcontentloaded');
  const bouncedToSignin = page.url().includes('/signin');
  return { ok: !bouncedToSignin, bouncedToSignin };
}
