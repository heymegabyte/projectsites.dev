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

    // Console-error gate — tolerate ONLY the known dark-feature probe (better_auth off locally)
    // + the editor-prewarm frame-ancestors refusal (deployed editor pre-dates the
    // fire-60 public/_headers fix; prewarm fires on /admin once a site exists).
    const unexpected = consoleErrors.filter(
      (e) =>
        !/\/api\/auth\/get-session/.test(e) &&
        !/status of 404/.test(e) &&
        !/(Refused to (frame|display)|Framing)\s+'?https:\/\/editor\.projectsites\.dev/i.test(e),
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

    // Full cockpit nav groups — asserted by collapse-proof testid (`nav-<id>`):
    // on current HEAD the sidebar renders as an icon rail at 1280px, so
    // role-name lookups are state-fragile; testids are the stable contract.
    await expect(page.getByTestId('nav-dashboard')).toBeVisible();
    await expect(page.getByTestId('nav-editor')).toBeVisible();
    await expect(page.getByTestId('nav-forms')).toBeVisible();
    // 14. Super-admin nav entry reflects is_super_admin.
    await expect(page.getByTestId('nav-super-admin')).toBeVisible();

    // 15. STATE-AWARE dashboard honesty (the long trail is STATEFUL — Phase D
    //     creates `ltt-e2e-vitos`, so a replayed run has ≥1 site):
    //     0 sites  → the honest empty state IS a first-action launchpad;
    //     ≥1 site  → the cockpit reflects the real store (selected-site pill).
    //     Either way: never a lying-empty, never a dead end.
    const emptyLaunchpad = page.getByText(/No sites yet/i);
    const sitePill = page.getByText(/\.projectsites\.dev/).first();
    await expect(emptyLaunchpad.or(sitePill).first()).toBeVisible({ timeout: 10_000 });
    if (await emptyLaunchpad.isVisible().catch(() => false)) {
      await expect(page.getByRole('button', { name: /Create Site/i })).toBeVisible();
    }
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

      // ── Console-error gate (editor-prewarm refusal allowlisted — see Phase D) ──
      const unexpected = consoleErrors.filter(
        (e) =>
          !/\/api\/auth\/get-session/.test(e) &&
          !/status of 404/.test(e) &&
          !/(Refused to (frame|display)|Framing)\s+'?https:\/\/editor\.projectsites\.dev/i.test(e),
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

      // ── Action 36: Editor surface is STATE-AWARE (stateful long trail) ────
      // No site selected → the onboarding/empty launchpad renders.
      // Site selected (Phase D created `ltt-e2e-vitos` on replays) → the bolt
      // iframe host mounts for the selected site instead. Both are honest.
      const editorEmptyState = page
        .getByText(/Welcome to your admin/i)
        .or(page.getByTestId('editor-site-not-found'))
        .or(page.getByText(/Pick a site/i));
      const editorIframeHost = page.locator('iframe[src*="editor.projectsites.dev"]');
      await expect(editorEmptyState.first().or(editorIframeHost.first())).toBeVisible({
        timeout: 5000,
      });

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
          !/the server responded with a status of 500/.test(e) &&
          !/(Refused to (frame|display)|Framing)\s+'?https:\/\/editor\.projectsites\.dev/i.test(e),
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
// PHASE D — site seed → editor iframe → Data-tab honesty → operations inspectors
// (fire-60). Checkpoint actions 38–47; maps to case .md rows 27-34/36/38-46/56-58.
// ───────────────────────────────────────────────────────────────────────────────

const LTT_SLUG = 'ltt-e2e-vitos';

/** Create (or idempotently resume) the disposable `ltt-e2e-` site via the REAL authed API,
 * exactly as the case sanctions ("seeds a disposable ltt-e2e- site row via the create
 * endpoint"). Runs in the page context so the request is the browser's own. */
async function ensureLttSite(page: Page): Promise<{ id: string; slug: string }> {
  return page.evaluate(async (slug) => {
    const raw = localStorage.getItem('ps_session');
    const token = raw ? (JSON.parse(raw).token as string) : null;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    // Check-first so a resumed run is a clean no-op (a duplicate POST would 4xx,
    // polluting the console-error gate with an EXPECTED failure — fire-60).
    const listRes = await fetch('/api/sites', { headers });
    const list = (await listRes.json()) as { data?: { id: string; slug: string }[] };
    const existing = (list.data ?? []).find((s) => s.slug === slug);
    if (existing) return { id: existing.id, slug: existing.slug };

    const createRes = await fetch('/api/sites', {
      method: 'POST',
      headers,
      body: JSON.stringify({ business_name: slug, slug }),
    });
    if (!createRes.ok) throw new Error(`POST /api/sites → ${createRes.status}`);
    const body = (await createRes.json()) as { data?: { id?: string; slug?: string } };
    return { id: body.data?.id ?? '', slug: body.data?.slug ?? slug };
  }, LTT_SLUG);
}

test.describe('Long-Trail Case 001 :: PHASE D (site seed → editor → data honesty → inspectors)', () => {
  test.skip(!TEST_PASSWORD, 'E2E_TEST_PASSWORD not set — real test-login seam is unreachable.');

  test('D: seed ltt site → editor iframe mounts → per-site-data honest dark-404 → inspectors + logs causal', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
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

    // ── Action 38 (case #30-31): create the disposable site via the REAL API;
    //    oracle = the RELOADED dashboard + /api/sites list, never the response alone.
    const site = await ensureLttSite(page);
    expect(site.id, 'create/resume must yield a site id').toBeTruthy();
    await page.goto(APP + '/admin');
    // VISIBLE oracle: the site-switcher host pill shows the selected site's hostname.
    // (`getByText(slug).first()` matched a hidden dropdown span — discovered live fire-60.)
    const hostPill = page.getByText(`${LTT_SLUG}.projectsites.dev`).first();
    await expect(hostPill).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: 'e2e/long-trail/screenshots-local/13-dashboard-with-site.png',
      fullPage: false,
    });

    // ── Action 39 (case #32-33): nav-away (Forms) and back — the site survives
    //    as the selection after SPA navigation (store-backed, not a toast artifact).
    //    Nav items are clicked by their collapse-proof `data-testid` (`nav-<id>`) —
    //    the sidebar renders as an icon rail on this HEAD at 1280px.
    await page.getByTestId('nav-forms').click();
    await expect(page).toHaveURL(/\/admin\/forms/i);
    await page.getByTestId('nav-dashboard').click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByText(`${LTT_SLUG}.projectsites.dev`).first()).toBeVisible({
      timeout: 10_000,
    });

    // ── Action 40 (case #41-43): open the Editor. The shell must mount the
    //    bolt iframe host pointing at the editor origin. (Boot itself is pinned
    //    by the dedicated test below — blocked on the frame-ancestors deploy.)
    await page.getByTestId('nav-editor').click();
    await expect(page).toHaveURL(/\/admin\/editor/i);
    const iframe = page.locator('iframe[src*="editor.projectsites.dev"]');
    await expect(iframe).toHaveCount(1, { timeout: 15_000 });
    await page.screenshot({
      path: 'e2e/long-trail/screenshots-local/14-editor-iframe-blocked.png',
      fullPage: false,
    });

    // ── Action 41: RED evidence capture — until editor.projectsites.dev redeploys
    //    with the fixed frame-ancestors (public/_headers, this fire), Chromium
    //    refuses the document. Record the refusal precisely; the boot test below
    //    owns the hard assertion.
    await expect
      .poll(
        () => {
          const editorFrameLoaded = page
            .frames()
            .some((f) => f.url().startsWith('https://editor.projectsites.dev'));
          // Chromium wordings across versions: "Refused to frame 'URL' …",
          // "Refused to display 'URL' in a frame …", "Framing 'URL' violates …".
          const refusalSeen = consoleErrors.some((e) =>
            /(Refused to (frame|display)|Framing)\s+'?https:\/\/editor\.projectsites\.dev/i.test(e),
          );
          return editorFrameLoaded ? 'loaded' : refusalSeen ? 'refused' : `neither (console: ${consoleErrors.slice(-5).join(' | ').slice(0, 400)})`;
        },
        {
          timeout: 15_000,
          message:
            'editor frame must either load (post-deploy) or surface the precise frame-ancestors refusal (pre-deploy) — anything else is a NEW failure mode',
        },
      )
      .toMatch(/^(loaded|refused)$/);

    // ── Action 42 (case #46): per-site Data API honesty — flag `per_site_data`
    //    is DARK locally → the endpoint must 404 with the structured envelope,
    //    never crash, never lie 200-empty.
    const dataProbe = await page.evaluate(async (siteId) => {
      const raw = localStorage.getItem('ps_session');
      const token = raw ? (JSON.parse(raw).token as string) : null;
      const res = await fetch(`/api/sites/${siteId}/db/tables`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; request_id?: string };
      };
      return { status: res.status, code: body.error?.code ?? null, msg: body.error?.message ?? null };
    }, site.id);
    expect(dataProbe.status, 'per_site_data dark → honest 404 (never 5xx/200-lie)').toBe(404);
    expect(dataProbe.code).toBe('NOT_FOUND');
    expect((dataProbe.msg ?? '').length).toBeGreaterThan(0);

    // ── Action 43 (case #34): readiness endpoint answers HONESTLY for the fresh
    //    site. The `prod_readiness_score` module is flag-gated (404 dark when the
    //    flag is off — the local stack's state, since local D1 carries no flag
    //    seeds). Pin the envelope either way; 5xx or a shapeless body = RED.
    const readiness = await page.evaluate(async (siteId) => {
      const raw = localStorage.getItem('ps_session');
      const token = raw ? (JSON.parse(raw).token as string) : null;
      const res = await fetch(`/api/sites/${siteId}/readiness`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json().catch(() => ({}))) as {
        data?: unknown;
        error?: { code?: string };
      };
      return { status: res.status, code: body.error?.code ?? null, hasData: body.data != null };
    }, site.id);
    expect(
      [200, 404].includes(readiness.status),
      `readiness must be 200 (graded) or flag-dark 404 — got ${readiness.status}`,
    ).toBe(true);
    if (readiness.status === 404) expect(readiness.code).toBe('NOT_FOUND');
    else expect(readiness.hasData).toBe(true);

    // ── Action 44 (case #36): Hosting renders for the selected site.
    await page.getByTestId('nav-hosting').click();
    await expect(page).toHaveURL(/\/admin\/hosting/i);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.screenshot({
      path: 'e2e/long-trail/screenshots-local/15-hosting.png',
      fullPage: false,
    });

    // ── Actions 45-48 (case #40/56-58): super-admin operations inspectors all
    //    render honestly (local = honest empty / honest unsupported, never crash).
    const inspectors: ReadonlyArray<{ testid: string; url: RegExp; shot: string }> = [
      { testid: 'nav-kv-inspector', url: /\/admin\/kv-inspector/i, shot: '16-kv-inspector.png' },
      { testid: 'nav-r2-inspector', url: /\/admin\/r2-inspector/i, shot: '17-r2-inspector.png' },
      {
        testid: 'nav-vectorize-inspector',
        url: /\/admin\/vectorize-inspector/i,
        shot: '18-vectorize-inspector.png',
      },
      {
        testid: 'nav-queues-inspector',
        url: /\/admin\/queues-inspector/i,
        shot: '19-queues-inspector.png',
      },
    ];
    for (const ins of inspectors) {
      await page.getByTestId(ins.testid).click();
      await expect(page).toHaveURL(ins.url);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.screenshot({ path: `e2e/long-trail/screenshots-local/${ins.shot}`, fullPage: false });
    }

    // ── Action 49 (case #38-39): Logs + the cross-feature CAUSAL check — the
    //    test-login from this very session must exist in the audit STORE.
    await page.getByTestId('nav-logs').click();
    await expect(page).toHaveURL(/\/admin\/logs/i);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await page.screenshot({
      path: 'e2e/long-trail/screenshots-local/20-logs.png',
      fullPage: false,
    });
    const auditProbe = await page.evaluate(async () => {
      const raw = localStorage.getItem('ps_session');
      const token = raw ? (JSON.parse(raw).token as string) : null;
      const res = await fetch('/api/audit-logs?limit=100', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json().catch(() => ({}))) as {
        data?: { action?: string }[];
      };
      return {
        status: res.status,
        hasTestLogin: (body.data ?? []).some((r) => r.action === 'auth.test_login'),
      };
    });
    expect(auditProbe.status).toBe(200);
    expect(
      auditProbe.hasTestLogin,
      'the login performed in THIS journey must appear in the audit store (causal login→audit)',
    ).toBe(true);

    // ── Console-error gate ────────────────────────────────────────────────
    // Known-broken allowlist (do NOT expand without a DISCOVERIES entry):
    //   /api/auth/get-session 404  — better_auth dark locally.
    //   status of 404              — dark-feature probes (per_site_data etc).
    //   /api/team 500 (counted)    — team_invites.deleted_at schema drift (known).
    //   Refused to frame editor.projectsites.dev — the DEPLOYED editor still
    //     carries the pre-fix frame-ancestors; fixed in public/_headers this
    //     fire (see src/__tests__/editor_frame_ancestors.test.ts). Remove this
    //     entry when the editor Pages deploy lands.
    const genericLoadErrors = consoleErrors.filter((e) =>
      /the server responded with a status of 500/.test(e),
    );
    const unexplainedGenericCount = Math.max(0, genericLoadErrors.length - knownTeam500Count);
    const unexpected = consoleErrors.filter(
      (e) =>
        !/\/api\/auth\/get-session/.test(e) &&
        !/status of 404/.test(e) &&
        !/the server responded with a status of 500/.test(e) &&
        !/(Refused to (frame|display)|Framing)\s+'?https:\/\/editor\.projectsites\.dev/i.test(e),
    );
    const diagSuffix = srv5xxUrls.length > 0 ? ` | srv-5xx-urls: [${srv5xxUrls.join(', ')}]` : '';
    expect(
      unexpected,
      `unexpected console errors: ${unexpected.join(' | ')}${diagSuffix}`,
    ).toHaveLength(0);
    expect(
      unexplainedGenericCount,
      `${unexplainedGenericCount} generic-500 errors not attributed to /api/team${diagSuffix}`,
    ).toBe(0);
  });

  test('D-boot: editor iframe DOCUMENT loads in the local composition (case #43)', async ({
    page,
  }) => {
    // Hard assertion of the REQUIRED behavior: the editor document loads when the
    // local admin embeds it. Observed RED in fire-60: Chromium refuses the frame
    // because the DEPLOYED editor's frame-ancestors lacks http://localhost:4200
    // (public/_headers fixed in-repo this fire; needs an editor Pages deploy).
    // UNFIXME when editor.projectsites.dev redeploys with the fire-60 _headers —
    // verify first: `curl -sI https://editor.projectsites.dev | grep -i frame-ancestors`
    // shows http://localhost:4200. Regression lock: src/__tests__/editor_frame_ancestors.test.ts.
    test.fixme(
      true,
      'blocked-on-deploy: editor.projectsites.dev still serves pre-fire-60 frame-ancestors (no localhost:4200) — fix is in repo public/_headers, awaiting editor Pages deploy',
    );
    await page.goto(APP + '/signin?test=1');
    await page.getByTestId('test-signin-password').fill(TEST_PASSWORD);
    await page.getByTestId('test-signin-submit').click();
    await expect(page).toHaveURL(/\/admin/);

    await ensureLttSite(page);
    await page.goto(APP + '/admin');
    await page.getByTestId('nav-editor').click();
    await expect(page).toHaveURL(/\/admin\/editor/i);

    await expect
      .poll(
        () =>
          page.frames().some((f) => f.url().startsWith('https://editor.projectsites.dev')),
        { timeout: 20_000, message: 'editor frame document never loaded (frame-ancestors refusal?)' },
      )
      .toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// PHASES E–F — authored in case-001-money-path.md, driven live in later cycles.
// `test.fixme` = honestly PENDING (never a false green). Each promotes to a real
// test when its surface is exercised against the live local stack.
// ───────────────────────────────────────────────────────────────────────────────
test.describe('Long-Trail Case 001 :: PHASES E–F (pending live drive)', () => {
  test.fixme('E: promote → visit published → submit form → reconcile lead + pageview in stores', async () => {});
  test.fixme('F: install/remove disposable app → verify site still works → cleanup + tenant isolation', async () => {});
});
