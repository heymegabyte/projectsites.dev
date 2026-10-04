/**
 * _local-browser.mjs — the shared LOCAL-headless-browser helper for the admin-verify
 * causal / reconcile probe suite. Replaces the DEAD Browserbase coupling
 * (`_browserbase-creds.mjs` + `fetch('…browserbase.com/v1/sessions')` + `connectOverCDP`):
 * Browserbase credit returns 402 (session create fails), so every probe that gated on it
 * SKIPPED — a standing coverage gap. fire-122 proved a cf_clearance'd LOCAL headless Chromium
 * POSTs the `/api/auth/test-login` seam fine (load `/` first → in-page fetch carries the
 * clearance cookie; a node/curl POST does not). This helper is the one place that knowledge
 * lives so each probe migrates by swapping two lines, not re-deriving the auth recipe.
 *
 * Plain ESM (.mjs), zero TS, zero external deps beyond @playwright/test (already a dep).
 * Creds: E2E_TEST_PASSWORD (env → get-secret). Never throws on a missing secret (returns null
 * so the caller can SKIP), never logs a secret value.
 */
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';

/**
 * Launch a LOCAL headless Chromium (never Browserbase). The single launch primitive the
 * migrated probes share — keeps the launch flags in one place.
 * @returns {Promise<import('@playwright/test').Browser>}
 */
export async function launchLocalBrowser() {
  return chromium.launch({ headless: true });
}

/**
 * Resolve the E2E test-login password: env `E2E_TEST_PASSWORD` first, else `get-secret`.
 * Fail-open: returns null (NOT throw) when neither is available so callers SKIP in CI/forks.
 * @returns {string|null}
 */
export function getTestPassword() {
  if (process.env.E2E_TEST_PASSWORD) return process.env.E2E_TEST_PASSWORD;
  try {
    const v = execSync('/Users/Apple/.local/bin/get-secret E2E_TEST_PASSWORD', {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * Authenticate the page AS BRIAN against prod via the test-login seam, then seed the
 * frontend session so a subsequent `/admin` navigation does NOT bounce to `/signin`.
 *
 * The CRITICAL recipe (memory `golden-path-test-login-seam-cf-bot-challenged`, fire-122):
 *   1. `goto('/')` FIRST → acquires the `cf_clearance` cookie (a direct curl/node POST 403s).
 *   2. in-page `fetch('/api/auth/test-login', …)` → the token is wrapped at `j.data.token`.
 *   3. seed `localStorage['ps_session']` with `{ token, identifier, createdAt: Date.now() }` —
 *      `createdAt` (NOT `issuedAt`); `AuthService.setSession` runs a TTL check on reload and
 *      treats a session WITHOUT `createdAt` as EXPIRED → clears it → /admin bounces to /signin.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} pw  the E2E test-login password (from getTestPassword()).
 * @param {string} [prodUrl='https://projectsites.dev']  the prod origin to authenticate against.
 * @returns {Promise<{ ok: boolean, bounced: boolean }>}
 *   `ok` — a token was obtained + seeded. `bounced` — a probe after this should re-check, but
 *   `ok:false` means the seam returned no token (treat as auth failure, NOT a divergence).
 */
export async function authSeedBrian(page, pw, prodUrl = 'https://projectsites.dev') {
  await page.goto(`${prodUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // CF managed-challenge solve → cf_clearance cookie

  const token = await page.evaluate(async (password) => {
    try {
      const res = await fetch('/api/auth/test-login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'brian@megabyte.space', password }),
      });
      const j = await res.json().catch(() => ({}));
      const tok = j?.data?.token ?? '';
      if (tok) {
        localStorage.setItem(
          'ps_session',
          JSON.stringify({
            token: tok,
            identifier: j?.data?.email ?? 'brian@megabyte.space',
            createdAt: Date.now(),
          }),
        );
      }
      return tok;
    } catch {
      return '';
    }
  }, pw);

  return { ok: Boolean(token), bounced: !token };
}
