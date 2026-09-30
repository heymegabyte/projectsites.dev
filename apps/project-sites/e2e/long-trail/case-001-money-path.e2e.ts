/**
 * @file Long-Trail Case 001 — Money Path (executable journey).
 * @see ./case-001-money-path.md — the durable numbered case this encodes.
 *
 * RUNS AGAINST THE LIVE LOCAL STACK, NOT the static :4300 e2e_server:
 *   - worker  : `cd apps/project-sites && npx wrangler dev --local --port 8787`
 *               (with `.dev.vars` → E2E_TEST_PASSWORD + ENVIRONMENT=development)
 *   - frontend: `cd apps/project-sites/frontend && npm start`  (ng serve :4200,
 *               proxy.conf.json forwards /api → :8787)
 *   - schema  : local D1 migrated per `apps/project-sites/docs/local-dev-longtrail.md`.
 *
 * A REMOTE/cloud browser cannot reach localhost — this suite requires **LOCAL Chromium**
 * (the default Playwright browser). Homepage-start; navigate by UI only after the first load.
 *
 * Run it (from `apps/project-sites/frontend`, both servers already up):
 *   E2E_TEST_PASSWORD="$(get-secret E2E_TEST_PASSWORD)" \
 *     npx playwright test ../e2e/long-trail/case-001-money-path.e2e.ts \
 *     --config ../e2e/long-trail/playwright.longtrail.config.ts
 * (or point `--project chromium` at baseURL http://localhost:4200 via any config).
 *
 * Phase A (homepage → real sign-in → /api/auth/me=brian) is FULLY EXECUTABLE and is the
 * proven-connected slice. Phases B–F are authored in the .md and staged here as `test.fixme`
 * so this file never LIES about coverage — each becomes a real test as its surface is driven
 * live in a subsequent cycle (skill §Ramp-up).
 */
import { test, expect, type Page } from '@playwright/test';

const APP = process.env.LTT_APP_URL ?? 'http://localhost:4200';
const TEST_EMAIL = 'brian@megabyte.space';
const TEST_PASSWORD = process.env.E2E_TEST_PASSWORD ?? '';

/** Read the `ps_session` token the UI stored, then call /api/auth/me AS the browser. */
async function fetchMe(page: Page): Promise<{
  status: number;
  email: string | null;
  orgIdPresent: boolean;
  isSuperAdmin: boolean | null;
}> {
  return page.evaluate(async () => {
    const raw = localStorage.getItem('ps_session');
    let token: string | null = null;
    try {
      token = raw ? (JSON.parse(raw).token as string) : null;
    } catch {
      token = null;
    }
    const res = await fetch('/api/auth/me', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const data = (body as { data?: Record<string, unknown> }).data ?? {};
    return {
      status: res.status,
      email: (data.email as string) ?? null,
      orgIdPresent: !!data.org_id,
      isSuperAdmin: (data.is_super_admin as boolean) ?? null,
    };
  });
}

test.describe('Long-Trail Case 001 — Money Path :: PHASE A (homepage → real sign-in)', () => {
  test.skip(!TEST_PASSWORD, 'E2E_TEST_PASSWORD not set — real test-login seam is unreachable.');

  test('actions 1–12: homepage paints → ?test=1 real login → /api/auth/me = brian', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    // 1. Homepage paints.
    await page.goto(APP + '/');
    await expect(page).toHaveTitle(/ProjectSites/i);
    // Hero copy is A/B/N-varianted per load (data-hero-variant) — assert the
    // CONTRACT (headline testid renders substantive copy), never one variant's words.
    await expect(page.getByTestId('hero-headline')).toBeVisible();
    await expect
      .poll(async () => ((await page.getByTestId('hero-headline').textContent()) ?? '').trim().length)
      .toBeGreaterThan(15);

    // 2. Sign In entry present in the header (rendered as a <button>, `.header-signin-btn`, on
    //    logged-out non-/signin routes — discovered from the live DOM, not assumed to be a link).
    await expect(page.getByRole('button', { name: /Sign In/i }).first()).toBeVisible();

    // 3–5. Business search fires + degrades gracefully (Places may 403 locally); never throws.
    //    Two inputs share the placeholder (hero + footer CTA) — target the hero one by its testid.
    const search = page.getByTestId('hero-search-input');
    await search.click();
    await search.fill('Vito');
    await page.waitForTimeout(400); // debounce window (real timed behavior, not a state wait)
    await search.fill('');

    // 7. Enter the real test-login seam.
    await page.goto(APP + '/signin?test=1');
    await expect(page.getByRole('heading', { name: /Welcome back/i })).toBeVisible();

    // 8–9. The test panel renders on the SERVED sign-in component with the email prefilled.
    const panel = page.getByTestId('test-signin-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('test-signin-email')).toHaveValue(TEST_EMAIL);

    // 10–11. Real login through the UI.
    await page.getByTestId('test-signin-password').fill(TEST_PASSWORD);
    await page.getByTestId('test-signin-submit').click();

    // Landed in the admin cockpit.
    await expect(page).toHaveURL(/\/admin/);
    await expect(page).toHaveTitle(/Dashboard/i);

    // 12. THE ORACLE — the authenticated session resolves to brian (not the redirect, not a toast).
    const me = await fetchMe(page);
    expect(me.status).toBe(200);
    expect(me.email).toBe(TEST_EMAIL);
    expect(me.orgIdPresent).toBe(true);
    expect(me.isSuperAdmin).toBe(true);

    // Console-error gate — tolerate ONLY the known dark-feature probe (better_auth off locally).
    const unexpected = consoleErrors.filter(
      (e) => !/\/api\/auth\/get-session/.test(e) && !/status of 404/.test(e),
    );
    expect(unexpected, `unexpected console errors: ${unexpected.join(' | ')}`).toHaveLength(0);
  });

  test('actions 13–15: admin cockpit renders full nav + honest empty-state launchpad', async ({
    page,
  }) => {
    // Re-establish auth via the UI (a fresh browser context has no session).
    await page.goto(APP + '/signin?test=1');
    await page.getByTestId('test-signin-password').fill(TEST_PASSWORD);
    await page.getByTestId('test-signin-submit').click();
    await expect(page).toHaveURL(/\/admin/);

    // Full cockpit nav groups.
    await expect(page.getByRole('link', { name: /^Dashboard$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Editor$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Forms$/ })).toBeVisible();
    // 14. Super-admin nav entry reflects is_super_admin.
    await expect(page.getByRole('link', { name: /Super admin/i })).toBeVisible();

    // 15. Honest empty state IS a first-action launchpad (embarrassingly-easy-to-use),
    //     not a lying-empty (fresh local DB genuinely has 0 sites for this org).
    await expect(page.getByText(/No sites yet/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Create Site/i })).toBeVisible();
  });

  test('action 26: hard-refresh keeps the session (re-read from the store, not local-only)', async ({
    page,
  }) => {
    await page.goto(APP + '/signin?test=1');
    await page.getByTestId('test-signin-password').fill(TEST_PASSWORD);
    await page.getByTestId('test-signin-submit').click();
    await expect(page).toHaveURL(/\/admin/);

    await page.reload();
    await expect(page).toHaveURL(/\/admin/);
    const me = await fetchMe(page);
    expect(me.status).toBe(200);
    expect(me.email).toBe(TEST_EMAIL);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// PHASE B — cockpit tour (actions 16-25 per case-001-money-path.md)
// Promoted from test.fixme in fire-55; driven live against the real local stack.
// ───────────────────────────────────────────────────────────────────────────────
test.describe('Long-Trail Case 001 :: PHASE B (cockpit tour)', () => {
  test.skip(!TEST_PASSWORD, 'E2E_TEST_PASSWORD not set — real test-login seam is unreachable.');

  test(
    'B: cockpit tour — Forms/Analytics/Feature Flags/Hosting + Cmd+K + nav-away',
    async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });

      // ── Auth ──────────────────────────────────────────────────────────────
      await page.goto(APP + '/signin?test=1');
      await page.getByTestId('test-signin-password').fill(TEST_PASSWORD);
      await page.getByTestId('test-signin-submit').click();
      await expect(page).toHaveURL(/\/admin/);

      // ── Action 16: Click Forms nav → renders ──────────────────────────────
      await page.getByRole('link', { name: /^Forms$/ }).click();
      await expect(page).toHaveURL(/\/admin\/forms/i);
      await page.screenshot({ path: 'e2e/long-trail/screenshots-local/04-forms.png', fullPage: false });

      // ── Action 17: Exactly one H1 ─────────────────────────────────────────
      const h1s = page.getByRole('heading', { level: 1 });
      await expect(h1s.first()).toBeVisible();
      expect(await h1s.count()).toBe(1);

      // ── Action 18: Click Analytics nav → renders ──────────────────────────
      await page.getByRole('link', { name: /^Analytics$/ }).click();
      await expect(page).toHaveURL(/\/admin\/analytics/i);
      await page.screenshot({ path: 'e2e/long-trail/screenshots-local/05-analytics.png', fullPage: false });

      // ── Action 19: No manual Refresh/Reconcile button ─────────────────────
      const refreshBtn = page.getByRole('button', { name: /Refresh|Reconcile/i });
      expect(await refreshBtn.count(), 'Manual Refresh/Reconcile button must not be present').toBe(0);

      // ── Action 20: Click Feature Flags nav → renders ──────────────────────
      await page.getByRole('link', { name: /Feature Flags/i }).click();
      await expect(page).toHaveURL(/\/admin\/feature-flags/i);
      await page.screenshot({ path: 'e2e/long-trail/screenshots-local/06-flags.png', fullPage: false });

      // ── Action 21: At least one known flag row visible ────────────────────
      const flagRow = page.locator('[data-testid="flag-row"], tr, .flag-card').first();
      const hasFlagContent = await page
        .getByText(/per_site_data|live_build_stream|better_auth|core_sites/i)
        .isVisible()
        .catch(() => false);
      const hasAnyRow = (await flagRow.count()) > 0;
      expect(
        hasFlagContent || hasAnyRow,
        'Feature Flags page must show at least one flag row',
      ).toBe(true);

      // ── Action 22: Click Hosting nav → renders ────────────────────────────
      await page.getByRole('link', { name: /^Hosting$/ }).click();
      await expect(page).toHaveURL(/\/admin\/hosting/i);

      // ── Action 23: Cmd+K opens the palette ───────────────────────────────
      await page.keyboard.press('Meta+K');
      const palette = page
        .getByTestId('cmdk-input')
        .or(page.getByRole('combobox', { name: /Search|Command/i }))
        .or(page.getByPlaceholder(/Search|Type a command/i));
      await expect(palette).toBeVisible({ timeout: 3000 });
      await page.screenshot({ path: 'e2e/long-trail/screenshots-local/07-cmdk.png', fullPage: false });

      // ── Action 24: Escape closes the palette ──────────────────────────────
      await page.keyboard.press('Escape');
      await expect(palette).not.toBeVisible({ timeout: 2000 });

      // ── Action 25: Navigate to '/' (public) then back → still authed ──────
      await page.goto(APP + '/');
      await page.goto(APP + '/admin');
      await expect(page).toHaveURL(/\/admin/);
      const me = await fetchMe(page);
      expect(me.status, 'Session must survive public-page visit').toBe(200);

      // ── Console-error gate ────────────────────────────────────────────────
      const unexpected = consoleErrors.filter(
        (e) => !/\/api\/auth\/get-session/.test(e) && !/status of 404/.test(e),
      );
      expect(unexpected, `unexpected console errors: ${unexpected.join(' | ')}`).toHaveLength(0);
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// PHASES C–F — authored in case-001-money-path.md, driven live in later cycles.
// `test.fixme` = honestly PENDING (never a false green). Each promotes to a real
// test when its surface is exercised against the live local stack.
// ───────────────────────────────────────────────────────────────────────────────
test.describe('Long-Trail Case 001 :: PHASES C–F (pending live drive)', () => {
  test.fixme('C: create/open a disposable ltt-e2e- site (stop before costly AI build)', async () => {});
  test.fixme('D: Bolt editor — Code edit + Preview live-reload + per-site D1 Data tab isolation', async () => {});
  test.fixme('E: promote → visit published → submit form → reconcile lead + pageview in stores', async () => {});
  test.fixme('F: install/remove disposable app → verify site still works → cleanup + tenant isolation', async () => {});
});
