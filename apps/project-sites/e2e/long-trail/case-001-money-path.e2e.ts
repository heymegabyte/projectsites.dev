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
// PHASE C — Settings → API Tokens (mint-dialog open/cancel, NO real mint) →
// Editor shell surface (fire-58).
// Promoted from test.fixme in fire-58; driven live against the real local stack.
// ───────────────────────────────────────────────────────────────────────────────
test.describe('Long-Trail Case 001 :: PHASE C (Settings + API Tokens + Editor shell)', () => {
  test.skip(!TEST_PASSWORD, 'E2E_TEST_PASSWORD not set — real test-login seam is unreachable.');

  test(
    'C: Settings nav → API Tokens tab → mint-dialog open/cancel → Editor shell',
    async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      // Diagnostic: capture server 5xx URLs so allowlist entries are precise.
      // Each 5xx response fires a browser console error "Failed to load resource: the
      // server responded with a status of 500" — the error text has no URL, only the
      // response listener captures the URL. We correlate by counting.
      const srv5xxUrls: string[] = [];
      let knownTeam500Count = 0;
      page.on('response', (r) => {
        if (r.status() >= 500) {
          srv5xxUrls.push(`${r.status()} ${r.url()}`);
          if (/\/api\/team/.test(r.url())) knownTeam500Count++;
        }
      });

      // ── Auth ──────────────────────────────────────────────────────────────
      await page.goto(APP + '/signin?test=1');
      await page.getByTestId('test-signin-password').fill(TEST_PASSWORD);
      await page.getByTestId('test-signin-submit').click();
      await expect(page).toHaveURL(/\/admin/);

      // ── Action 27: Navigate to Settings via left nav ──────────────────────
      await page.getByRole('link', { name: /^Settings$/i }).click();
      await expect(page).toHaveURL(/\/admin\/settings/i);
      await page.screenshot({
        path: 'e2e/long-trail/screenshots-local/08-settings.png',
        fullPage: false,
      });

      // ── Action 28: API Tokens tab renders ─────────────────────────────────
      // The tab is identified by its visible label; fragment navigation activates it.
      const apiTokensTab = page
        .getByRole('tab', { name: /API Tokens/i })
        .or(page.getByRole('button', { name: /API Tokens/i }))
        .or(page.getByText(/API Tokens/i).first());
      await apiTokensTab.click();
      // Wait for the section to activate — the "New Token" button must be visible.
      await expect(page.getByTestId('at-create-open')).toBeVisible({ timeout: 5000 });
      await page.screenshot({
        path: 'e2e/long-trail/screenshots-local/09-api-tokens.png',
        fullPage: false,
      });

      // ── Action 29: "New Token" button is present + visible ─────────────────
      const newTokenBtn = page.getByTestId('at-create-open');
      await expect(newTokenBtn).toBeVisible();

      // ── Action 30: Click "New Token" → mint dialog opens ──────────────────
      await newTokenBtn.click();
      // The dialog renders a name input (data-testid="at-name-input").
      await expect(page.getByTestId('at-name-input')).toBeVisible({ timeout: 3000 });
      await page.screenshot({
        path: 'e2e/long-trail/screenshots-local/10-api-tokens-dialog.png',
        fullPage: false,
      });

      // ── Action 31: Type into the name field (real keyboard) ───────────────
      await page.getByTestId('at-name-input').fill('ltt-e2e-test-token');
      await expect(page.getByTestId('at-name-input')).toHaveValue('ltt-e2e-test-token');

      // ── Action 32: Cancel → dialog closes (NO mint, per safety contract) ──
      // The dialog has a "Cancel" button (DialogShellComponent or inline).
      const cancelBtn = page
        .getByRole('button', { name: /Cancel/i })
        .or(page.getByTestId('at-create-cancel'));
      await cancelBtn.click();
      // Dialog must close — name input goes away.
      await expect(page.getByTestId('at-name-input')).not.toBeVisible({ timeout: 3000 });
      await page.screenshot({
        path: 'e2e/long-trail/screenshots-local/11-api-tokens-dialog-closed.png',
        fullPage: false,
      });

      // ── Action 33: Hard-refresh on Settings → still authed + correct page ──
      await page.reload();
      await expect(page).toHaveURL(/\/admin\/settings/i);
      const meAfterRefresh = await fetchMe(page);
      expect(meAfterRefresh.status, 'Session must survive hard-refresh on Settings').toBe(200);
      expect(meAfterRefresh.email).toBe(TEST_EMAIL);

      // ── Action 34: Navigate to Editor via left nav ────────────────────────
      await page.getByRole('link', { name: /^Editor$/i }).click();
      await expect(page).toHaveURL(/\/admin\/editor/i);
      await page.screenshot({
        path: 'e2e/long-trail/screenshots-local/12-editor.png',
        fullPage: false,
      });

      // ── Action 35: Editor shell H1 present (sr-only "Site editor") ────────
      // The component always renders <h1 class="sr-only">Site editor</h1>.
      const srH1 = page.locator('h1.sr-only');
      await expect(srH1).toHaveText(/Site editor/i, { timeout: 5000 });

      // ── Action 36: Editor empty/onboarding state visible ─────────────────
      // With no site selected, the editor shows an onboarding / empty-state surface.
      // Accept any of: the "Welcome" heading OR the site-not-found placeholder.
      const editorEmptyState = page
        .getByText(/Welcome to your admin/i)
        .or(page.getByTestId('editor-site-not-found'))
        .or(page.getByText(/Pick a site/i));
      await expect(editorEmptyState.first()).toBeVisible({ timeout: 5000 });

      // ── Action 37: Hard-refresh on Editor → session persists ─────────────
      await page.reload();
      await expect(page).toHaveURL(/\/admin\/editor/i);
      const meEditorRefresh = await fetchMe(page);
      expect(meEditorRefresh.status, 'Session must survive hard-refresh on Editor').toBe(200);
      expect(meEditorRefresh.email).toBe(TEST_EMAIL);

      // ── Console-error gate ────────────────────────────────────────────────
      // Known-broken allowlist (do NOT expand without a DISCOVERIES.md entry):
      //   /api/auth/get-session — 404 on test env (known, non-blocking)
      //   status of 404        — generic 404 resources expected in test env
      //   /api/team (500)      — schema-drift: team_invites.deleted_at column missing;
      //                          no migration adds it (migration 0013 excludes it);
      //                          real product defect at src/routes/ai_admin.ts:73-78.
      //                          These 500s produce generic "Failed to load resource …
      //                          500" console errors (no URL in message text). We
      //                          correlate by counting via the response listener.
      const genericLoadErrors = consoleErrors.filter((e) =>
        /the server responded with a status of 500/.test(e),
      );
      // Allow up to knownTeam500Count generic 500 errors (attributed to /api/team).
      const unexplainedGenericCount = Math.max(0, genericLoadErrors.length - knownTeam500Count);
      const unexpected = consoleErrors.filter(
        (e) =>
          !/\/api\/auth\/get-session/.test(e) &&
          !/status of 404/.test(e) &&
          !/the server responded with a status of 500/.test(e),
      );
      // Attach diagnostic 5xx URL list to any console-error failure for easier triage.
      const diagSuffix =
        srv5xxUrls.length > 0 ? ` | srv-5xx-urls: [${srv5xxUrls.join(', ')}]` : '';
      expect(
        unexpected,
        `unexpected console errors: ${unexpected.join(' | ')}${diagSuffix}`,
      ).toHaveLength(0);
      expect(
        unexplainedGenericCount,
        `${unexplainedGenericCount} generic-500 errors not attributed to /api/team${diagSuffix}`,
      ).toBe(0);
    },
  );
});

// ───────────────────────────────────────────────────────────────────────────────
// PHASES D–F — authored in case-001-money-path.md, driven live in later cycles.
// `test.fixme` = honestly PENDING (never a false green). Each promotes to a real
// test when its surface is exercised against the live local stack.
// ───────────────────────────────────────────────────────────────────────────────
test.describe('Long-Trail Case 001 :: PHASES D–F (pending live drive)', () => {
  test.fixme('D: Bolt editor — Code edit + Preview live-reload + per-site D1 Data tab isolation', async () => {});
  test.fixme('E: promote → visit published → submit form → reconcile lead + pageview in stores', async () => {});
  test.fixme('F: install/remove disposable app → verify site still works → cleanup + tenant isolation', async () => {});
});
