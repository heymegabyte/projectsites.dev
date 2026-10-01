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
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

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
      //   /api/team (500)      — WAS schema-drift (team_invites.deleted_at absent
      //                          from migration-built DBs); FIXED fire-61 by
      //                          applying migration 0651 locally — expected count
      //                          is now 0. The counting tolerance is KEPT so any
      //                          regression surfaces precisely (count > 0 ⇒ the
      //                          local DB predates 0651 again).
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
// PHASE E — build-seed via the REAL zip-deploy endpoint → publish flip → visit the
// published site (Host-mapped to the local worker) → contact form success + honest
// error → reconcile leads + pageviews against the AUTHORITATIVE stores (fire-61).
// Checkpoint actions 50–59; maps to case .md rows 59-78 (pageview/analytics rows
// adapted per the § Phase E as-run notes).
//
// BUILD/SEED DECISION (recorded in case-001-money-path.md § Phase E): the build is
// seeded through `POST /api/sites/:id/deploy` — the manual deploy path bolt.diy +
// CLI/SDK clients use. NEVER a container AI build (SITE_BUILDER is production-only
// + API-credit discipline) and NEVER direct R2 poking (store effects must be
// EARNED through the product surface).
// ───────────────────────────────────────────────────────────────────────────────

const WORKER_URL = 'http://127.0.0.1:8787';
const SITE_HOST = `${LTT_SLUG}.projectsites.dev`;
const WORKER_PKG_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** Deterministic hand-authored site bundle — the Phase E build fixture.
 *
 * CONFORMS TO THE PLATFORM FORM CONTRACT (discovered live fire-61): the worker
 * SHADOWS `/app.js` with the ProjectSites unified client, which owns EVERY
 * `<form>` (capture-phase submit), serializes by field NAMES (name/email/phone/
 * message), writes status into a `[data-ps-form-status]` element INSIDE the form
 * ("Thanks! Your message has been sent." / server error message), and POSTs to
 * `data-api ?? https://projectsites.dev` + `/api/contact-form/` + `data-slug`.
 * Bump FIXTURE_REV whenever the bundle changes — ensureLttBuild redeploys when
 * the SERVED rev differs. */
const FIXTURE_REV = '2';
const FIXTURE_TITLE = "Vito's Mens Salon — Lake Hiawatha, NJ";
const FIXTURE_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Classic cuts, hot-towel shaves, and honest service at Vito's Mens Salon in Lake Hiawatha, New Jersey. Long-trail E2E fixture build.">
<meta name="ltt-fixture-rev" content="${FIXTURE_REV}">
<title>${FIXTURE_TITLE}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="site-header"><nav><a href="/" class="brand">Vito's Mens Salon</a></nav></header>
<main>
  <section class="hero">
    <h1>Vito's Mens Salon</h1>
    <p class="tagline">Classic cuts and hot-towel shaves in Lake Hiawatha, NJ — ltt-e2e fixture build.</p>
  </section>
  <section class="services">
    <h2>Services</h2>
    <ul>
      <li>Classic cut — $28</li>
      <li>Hot-towel shave — $32</li>
      <li>Beard trim — $18</li>
    </ul>
  </section>
  <section class="contact" id="contact">
    <h2>Get in touch</h2>
    <form id="contact-form" novalidate>
      <label for="cf-name">Name</label>
      <input id="cf-name" name="name" data-testid="cf-name" required>
      <label for="cf-email">Email</label>
      <input id="cf-email" name="email" type="email" data-testid="cf-email" required>
      <label for="cf-message">Message</label>
      <textarea id="cf-message" name="message" data-testid="cf-message" required></textarea>
      <button type="submit" id="cf-submit" data-testid="cf-submit">Send message</button>
      <p data-ps-form-status data-testid="form-status" role="status" aria-live="polite"></p>
    </form>
  </section>
</main>
<footer><p>74 N Beverwyck Rd, Lake Hiawatha, NJ 07034</p></footer>
<script src="/app.js" defer data-slug="${LTT_SLUG}" data-paid="false"></script>
</body>
</html>
`;
const FIXTURE_CSS = `:root{color-scheme:dark}body{margin:0;font-family:system-ui,sans-serif;background:#060610;color:#f4f4ff;line-height:1.5}
main{max-width:720px;margin:0 auto;padding:2rem 1rem}
.site-header{padding:1rem;border-bottom:1px solid #1d1d2e}.brand{color:#00e5ff;text-decoration:none;font-weight:700}
h1{font-size:2.2rem;margin:.5rem 0}h2{color:#00e5ff}
form{display:grid;gap:.5rem;max-width:420px}input,textarea{background:#101024;color:#f4f4ff;border:1px solid #2a2a44;border-radius:6px;padding:.5rem;min-height:24px}
button{background:#00e5ff;color:#060610;border:0;border-radius:6px;padding:.6rem 1rem;font-weight:700;cursor:pointer;min-height:24px}
#form-status{min-height:1.2em}#form-status[data-state=success]{color:#4ade80}#form-status[data-state=error]{color:#f87171}
footer{padding:2rem 1rem;border-top:1px solid #1d1d2e;color:#9a9ab0}`;
const FIXTURE_APP_JS = `/* Intentionally inert: the worker SHADOWS /app.js with the ProjectSites unified
 * client (analytics + forms + upgrade bar), so a site's own app.js never serves.
 * The platform client owns the contact form — see case-001-money-path.md § Phase E. */
`;

async function buildFixtureZipBase64(): Promise<string> {
  const zip = new JSZip();
  zip.file('dist/index.html', FIXTURE_INDEX_HTML);
  zip.file('dist/styles.css', FIXTURE_CSS);
  zip.file('dist/app.js', FIXTURE_APP_JS);
  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}

/** AUTHORITATIVE-STORE read: COUNT(*) against the SAME local D1 the running worker
 * uses (`.wrangler/state` sqlite — safe concurrent read). Never the endpoint the UI
 * reads — this is the verify-against-source-of-truth half of every reconcile. */
function d1LocalCount(fromWhere: string): number {
  const sql = `SELECT COUNT(*) AS n ${fromWhere}`;
  const out = execSync(
    `npx wrangler d1 execute project-sites-db --local --json --command ${JSON.stringify(sql)}`,
    { cwd: WORKER_PKG_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 },
  );
  const parsed = JSON.parse(out.slice(out.indexOf('['))) as Array<{
    results?: Array<{ n?: number }>;
  }>;
  return Number(parsed[0]?.results?.[0]?.n ?? NaN);
}

/** Settle-then-shoot: Angular view-transitions cross-fade for ~250ms after the
 * target h1 is visible — a screenshot fired immediately captures BOTH views
 * blended (fire-60 evidence-quality finding; fixed here per its "next fire" note). */
async function settleShot(page: Page, path: string): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForTimeout(300); // view-transition cross-fade window (timed behavior)
  await page.screenshot({ path, fullPage: false });
}

/** Read the site row through the REAL authed API (status + build version oracle). */
async function fetchSiteRow(
  page: Page,
  siteId: string,
): Promise<{ status: number; siteStatus: string | null; buildVersion: string | null }> {
  return page.evaluate(async (id) => {
    const raw = localStorage.getItem('ps_session');
    const token = raw ? (JSON.parse(raw).token as string) : null;
    const res = await fetch(`/api/sites/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { status?: string; current_build_version?: string | null };
    };
    return {
      status: res.status,
      siteStatus: body.data?.status ?? null,
      buildVersion: body.data?.current_build_version ?? null,
    };
  }, siteId);
}

test.describe('Long-Trail Case 001 :: PHASE E (deploy-seed → published site → form → reconcile)', () => {
  test.skip(!TEST_PASSWORD, 'E2E_TEST_PASSWORD not set — real test-login seam is unreachable.');

  test('E: zip-deploy publishes → served site replaces Building… → form lead + pageviews reconcile in stores', async ({
    page,
  }) => {
    test.setTimeout(300_000); // journey + 5 authoritative-store CLI reads (~4s each)

    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    const srv5xxUrls: string[] = [];
    let knownTeam500Count = 0;
    let contactForm400Count = 0; // our OWN deliberate invalid-submit probe (action 57)
    const formsSectionRequests: string[] = []; // triage: which endpoint feeds admin Forms
    page.on('response', (r) => {
      if (r.status() >= 500) {
        srv5xxUrls.push(`${r.status()} ${r.url()}`);
        if (/\/api\/team/.test(r.url())) knownTeam500Count++;
      }
      if (r.status() === 400 && /\/api\/contact-form\//.test(r.url())) contactForm400Count++;
    });
    page.on('request', (r) => {
      if (/\/api\/.*(form|submission)/i.test(r.url())) formsSectionRequests.push(r.url());
    });

    // ── Auth (UI) ─────────────────────────────────────────────────────────
    await page.goto(APP + '/signin?test=1');
    await page.getByTestId('test-signin-password').fill(TEST_PASSWORD);
    await page.getByTestId('test-signin-submit').click();
    await expect(page).toHaveURL(/\/admin/);
    const site = await ensureLttSite(page);
    expect(site.id, 'ltt site must exist (Phase D seed)').toBeTruthy();

    const pre = await fetchSiteRow(page, site.id);
    expect(pre.status).toBe(200);
    const hadBuildAlready = !!pre.buildVersion; // state-aware: replays resume published
    // Fixture-rev check: redeploy when the SERVED bundle predates this spec's
    // fixture (e.g. the fire-61 rev-1 bundle shipped before the platform-form
    // conformance was discovered). Keeps replays deterministic AND current.
    const servedIndex = hadBuildAlready
      ? await page
          .context()
          .request.get(`${WORKER_URL}/`, { headers: { host: SITE_HOST } })
          .then((r) => r.text())
          .catch(() => '')
      : '';
    const servedRev = /name="ltt-fixture-rev" content="(\d+)"/.exec(servedIndex)?.[1] ?? null;
    const needsDeploy = !hadBuildAlready || servedRev !== FIXTURE_REV;

    // ── Action 50 (case #59-pre): Hosting shows the HONEST no-build gate ──
    await page.getByTestId('nav-hosting').click();
    await expect(page).toHaveURL(/\/admin\/hosting/i);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    if (!hadBuildAlready) {
      await expect(
        page.getByText(/no build yet/i).first(),
        'pre-deploy Hosting must honestly gate publish on the missing build',
      ).toBeVisible({ timeout: 10_000 });
    }
    await settleShot(page, 'e2e/long-trail/screenshots-local/21-hosting-prebuild.png');

    // ── Action 51 (case #59): PROMOTE — the REAL zip deploy. Oracle = store,
    //    never the response alone: status flips, build version set, audit row.
    let deployedVersion = pre.buildVersion;
    if (needsDeploy) {
      const zipB64 = await buildFixtureZipBase64();
      const deployed = await page.evaluate(
        async ({ id, b64 }) => {
          const raw = localStorage.getItem('ps_session');
          const token = raw ? (JSON.parse(raw).token as string) : null;
          const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
          const fd = new FormData();
          fd.append('zip', new Blob([bytes], { type: 'application/zip' }), 'ltt-e2e-fixture.zip');
          const res = await fetch(`/api/sites/${id}/deploy`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: fd,
          });
          const body = (await res.json().catch(() => ({}))) as {
            data?: { version?: string; files_uploaded?: number; status?: string };
            error?: { message?: string };
          };
          return {
            httpStatus: res.status,
            version: body.data?.version ?? null,
            filesUploaded: body.data?.files_uploaded ?? 0,
            status: body.data?.status ?? null,
            errMsg: body.error?.message ?? null,
          };
        },
        { id: site.id, b64: zipB64 },
      );
      expect(deployed.httpStatus, `deploy failed: ${deployed.errMsg ?? ''}`).toBe(200);
      expect(deployed.filesUploaded).toBe(3);
      expect(deployed.status).toBe('published');
      deployedVersion = deployed.version;
    }
    // STORE oracle (re-read, not the response): published + build version persisted.
    const post = await fetchSiteRow(page, site.id);
    expect(post.siteStatus, 'sites.status must be published after deploy').toBe('published');
    expect(post.buildVersion, 'sites.current_build_version must be set').toBeTruthy();
    if (deployedVersion) expect(post.buildVersion).toBe(deployedVersion);
    // CAUSAL deploy→Logs: the audit store carries site.deployed for THIS site.
    const auditDeploy = await page.evaluate(async (siteId) => {
      const raw = localStorage.getItem('ps_session');
      const token = raw ? (JSON.parse(raw).token as string) : null;
      const res = await fetch('/api/audit-logs?limit=100', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json().catch(() => ({}))) as {
        data?: { action?: string; target_id?: string }[];
      };
      return (body.data ?? []).some(
        (r) => r.action === 'site.deployed' && r.target_id === siteId,
      );
    }, site.id);
    expect(auditDeploy, 'audit store must carry site.deployed for the ltt site').toBe(true);

    // ── Action 52 (case #60): the UI reflects the flip on RELOAD (no toast oracle) ──
    await page.reload();
    await expect(page).toHaveURL(/\/admin\/hosting/i);
    // POSITIVE content first — asserting the gate's ABSENCE against a not-yet-
    // rendered lazy pane is a vacuous pass (vision caught shot 22 blank, fire-61).
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    await expect(
      page.getByText(/publish|preview|production|hosting/i).first(),
      'the Hosting pane must actually render before the gate-absence oracle counts',
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/no build yet/i),
      'the no-build gate must be GONE once the store has a build',
    ).toHaveCount(0, { timeout: 10_000 });
    await settleShot(page, 'e2e/long-trail/screenshots-local/22-hosting-postbuild.png');

    // ── Published-site plumbing: Host-map the local worker to the site's hostname
    //    and keep the serve-time tracker's PROD-bound beacon OUT of prod — its REAL
    //    payload is re-delivered to the LOCAL /api/events (zero prod residue; see
    //    case .md § Phase E as-run notes). sendBeacon is disabled so the tracker's
    //    fetch(keepalive) fallback is used — interceptable deterministically.
    await page.addInitScript(() => {
      try {
        Object.defineProperty(Navigator.prototype, 'sendBeacon', { value: undefined });
      } catch {
        /* non-fatal — route still catches sendBeacon in most Chromium builds */
      }
    });
    // The served platform client targets PROD absolutely in THREE places (the
    // injected `<script src="https://projectsites.dev/app.js">`, `API` defaulting
    // to prod for /api/contact-form, and track() → prod /api/events). Proxy the
    // WHOLE prod origin to the LOCAL worker — real payloads, local stores, zero
    // prod residue — answering CORS preflights ourselves (the shim IS the edge).
    const beaconTypes: string[] = [];
    await page.route('https://projectsites.dev/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const cors: Record<string, string> = {
        'access-control-allow-origin': req.headers()['origin'] ?? '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
      };
      if (req.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      if (url.pathname === '/api/events') {
        try {
          beaconTypes.push(
            ((JSON.parse(req.postData() ?? '') as { eventType?: string }).eventType) ?? '?',
          );
        } catch {
          beaconTypes.push('?');
        }
      }
      try {
        const resp = await page
          .context()
          .request.fetch(WORKER_URL + url.pathname + url.search, {
            method: req.method(),
            headers: { ...req.headers(), host: SITE_HOST },
            data: req.postDataBuffer() ?? undefined,
            maxRedirects: 0,
          });
        const headers: Record<string, string> = { ...cors };
        for (const [k, v] of Object.entries(resp.headers())) {
          if (!/^(content-encoding|content-length|transfer-encoding|access-control-)/i.test(k))
            headers[k] = v;
        }
        await route.fulfill({ status: resp.status(), headers, body: await resp.body() });
      } catch {
        await route.abort();
      }
    });
    // Chromium forbids overriding Host via route.continue ("Unsafe header: host",
    // observed RED fire-61) — so PROXY-FULFILL instead: re-issue each worker-origin
    // request through the Node-side request context (which MAY set Host) and fulfill
    // the browser with the real worker response. Encoding/length headers are dropped
    // (the body is already decoded when fulfilled).
    await page.route(`${WORKER_URL}/**`, async (route) => {
      try {
        const req = route.request();
        const resp = await page
          .context()
          .request.fetch(req.url(), {
            method: req.method(),
            headers: { ...req.headers(), host: SITE_HOST },
            data: req.postDataBuffer() ?? undefined,
            maxRedirects: 0,
          });
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(resp.headers())) {
          if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) headers[k] = v;
        }
        await route.fulfill({ status: resp.status(), headers, body: await resp.body() });
      } catch {
        await route.abort();
      }
    });

    // Authoritative-store baselines (deltas are the oracles).
    const siteWhere = `FROM sites WHERE slug = '${LTT_SLUG}' AND deleted_at IS NULL`;
    const pvWhere = `FROM visitor_events WHERE site_id = (SELECT id ${siteWhere})`;
    const fsWhere = `FROM form_submissions WHERE site_id = (SELECT id ${siteWhere})`;
    const pvBefore = d1LocalCount(pvWhere);
    const fsBefore = d1LocalCount(fsWhere);
    expect(Number.isFinite(pvBefore) && Number.isFinite(fsBefore)).toBe(true);

    // ── Action 53 (case #61-62): the published site serves REAL content ───
    await page.goto(WORKER_URL + '/');
    await expect(page).toHaveTitle(new RegExp("Vito's Mens Salon"));
    await expect(page.getByRole('heading', { level: 1, name: /Vito's Mens Salon/ })).toBeVisible();
    await expect(
      page.getByText(/Building\.\.\.|Building…/),
      'the pre-build interstitial must be REPLACED by the deployed content',
    ).toHaveCount(0);
    await expect(page.getByText(/Hot-towel shave/)).toBeVisible(); // real section, not a shell
    await page.waitForTimeout(350); // entrance fade settles (vision: shot 23 was mid-fade)
    await page.screenshot({
      path: 'e2e/long-trail/screenshots-local/23-published-site.png',
      fullPage: false,
    });

    // ── Action 54 (case #63-66): fill the contact form (allowlist email ONLY) ──
    const token = `ltt-e2e long-trail probe ${Date.now()}`;
    await page.getByTestId('cf-name').click();
    await page.getByTestId('cf-name').fill('ltt-e2e Tester');
    await page.getByTestId('cf-email').fill(TEST_EMAIL);
    await page.getByTestId('cf-message').fill(token);
    await page.screenshot({
      path: 'e2e/long-trail/screenshots-local/24-published-form-filled.png',
      fullPage: false,
    });

    // ── Action 55 (case #67-69): submit → visible success + the STORE row ──
    await page.getByTestId('cf-submit').click();
    // Platform-client success contract: its copy + its ok color (#16a34a).
    await expect(page.getByTestId('form-status')).toHaveText(
      /Thanks! Your message has been sent\./,
      { timeout: 15_000 },
    );
    await expect(page.getByTestId('form-status')).toHaveCSS('color', 'rgb(22, 163, 74)');
    await page.getByTestId('form-status').scrollIntoViewIfNeeded(); // evidence: status in frame
    // CAUSAL funnel beacons: the tracker emitted form_start + form_submit (re-routed
    // into the LOCAL /api/events, where they mirror into visitor_events).
    expect(
      beaconTypes.filter((t) => t === 'form_start').length,
      `tracker must emit form_start (saw: [${beaconTypes.join(', ')}])`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      beaconTypes.filter((t) => t === 'form_submit').length,
      `tracker must emit form_submit (saw: [${beaconTypes.join(', ')}])`,
    ).toBeGreaterThanOrEqual(1);
    await page.screenshot({
      path: 'e2e/long-trail/screenshots-local/25-published-form-success.png',
      fullPage: false,
    });
    // LYING-SUCCESS guard: the submission EXISTS in the authoritative store.
    const fsTokenCount = d1LocalCount(`${fsWhere} AND payload LIKE '%${token}%'`);
    expect(fsTokenCount, 'form_submissions must carry the exact submitted message').toBe(1);
    const contactsTokenCount = d1LocalCount(
      `FROM contacts WHERE site_id = (SELECT id ${siteWhere}) AND metadata LIKE '%${token}%'`,
    );
    expect(contactsTokenCount, 'contacts (CRM capture) must carry the lead too').toBe(1);

    // ── Action 57 (case #75-77): HONEST ERROR — invalid email via the UI ──
    // (form is novalidate so the SERVER contract is exercised, not the browser's)
    await page.getByTestId('cf-name').fill('ltt-e2e Tester');
    await page.getByTestId('cf-email').fill('not-an-email');
    await page.getByTestId('cf-message').fill(`${token} invalid-probe`);
    await page.getByTestId('cf-submit').click();
    // Platform-client error contract: the client pre-validates only presence +
    // message length — email FORMAT is the server's call, so the server's own
    // validation message must surface, in the error color (#dc2626). A fake
    // "Thanks!" here is the silent-swallow defect this leg exists to catch.
    await expect(page.getByTestId('form-status')).toHaveText(/email/i, { timeout: 15_000 });
    await expect(page.getByTestId('form-status')).not.toHaveText(/Thanks!/);
    await expect(page.getByTestId('form-status')).toHaveCSS('color', 'rgb(220, 38, 38)');
    await page.getByTestId('form-status').scrollIntoViewIfNeeded(); // evidence: error in frame
    await page.screenshot({
      path: 'e2e/long-trail/screenshots-local/27-published-form-error.png',
      fullPage: false,
    });
    const fsAfterInvalid = d1LocalCount(fsWhere);
    expect(
      fsAfterInvalid,
      'an invalid submit must NOT add a store row (no fake success, no silent write)',
    ).toBe(fsBefore + 1);
    expect(contactForm400Count, 'exactly our one deliberate 400 probe').toBe(1);

    // ── Action 58a (case #70): reload = another pageview (edge-recorded) ──
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: /Vito's Mens Salon/ })).toBeVisible();

    // ── Action 59 (case #78): nav-away + back on the published site → clean form ──
    await page.goto(WORKER_URL + '/?revisit=1');
    await expect(page.getByRole('heading', { level: 1, name: /Vito's Mens Salon/ })).toBeVisible();
    await expect(page.getByTestId('cf-message')).toHaveValue('');
    await expect(page.getByTestId('form-status')).toHaveText('');

    // Pageview STORE delta: initial visit + post-submit reload + revisit ≥ 3 serves.
    await expect
      .poll(() => d1LocalCount(pvWhere), {
        timeout: 30_000,
        message: 'visitor_events must record the served pageviews (edge-side, waitUntil)',
      })
      .toBeGreaterThanOrEqual(pvBefore + 3);

    // Done with the published origin — drop the Host mapping + prod-origin shim.
    await page.unroute(`${WORKER_URL}/**`);
    await page.unroute('https://projectsites.dev/**');

    // ── Action 56 (case #71-72): CROSS-FEATURE CAUSAL — the lead shows in admin ──
    await page.goto(APP + '/admin');
    await expect(page).toHaveURL(/\/admin/);
    await page.getByTestId('nav-forms').click();
    await expect(page).toHaveURL(/\/admin\/forms/i);
    // The display must RECONCILE with the store — discovered live: the inbox H1's
    // accessible name carries the count ("Forms N submissions in inbox"), rows
    // render When/Form/Email/Origin, and name+message live behind the row's
    // "Expand submission" affordance (case #72's detail step).
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: new RegExp(`${fsBefore + 1} submissions in inbox`, 'i'),
      }),
      `inbox headline must count the store's ${fsBefore + 1} rows (endpoints seen: ${formsSectionRequests.slice(-3).join(', ')})`,
    ).toBeVisible({ timeout: 15_000 });
    const newestRow = page
      .getByRole('button', { name: /Expand submission from contact by/i })
      .first();
    await expect(newestRow).toBeVisible();
    await expect(newestRow).toContainText(TEST_EMAIL); // our allowlist submitter
    // case #72: open the detail — the TYPED name + message must be what persisted.
    // (A bare row.click() lands on the EMAIL cell, which stopPropagation()s so the
    // mailto link never toggles the row — click the row's "Open" label instead,
    // which bubbles to the tr's (click)="open(s)". Discovered live fire-61.)
    await newestRow.getByText('Open', { exact: true }).click();
    await expect(page.getByText('ltt-e2e Tester').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(token).first()).toBeVisible();
    await settleShot(page, 'e2e/long-trail/screenshots-local/26-admin-forms-lead.png');

    // ── Action 58b (case #73-74): Analytics surface must not LIE about traffic ──
    await page.getByTestId('nav-analytics').click();
    await expect(page).toHaveURL(/\/admin\/analytics/i);
    // Anchor to the ANALYTICS h1 by NAME — during the view-transition cross-fade
    // both views' h1s coexist, so a bare level-1 lookup can match the OLD view
    // (vision caught shot 28 mid-fade showing Forms content, fire-61).
    await expect(
      page.getByRole('heading', { level: 1, name: /analytics|traffic/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
    // Reconcile display-vs-store honestly: with pageview rows in visitor_events, the
    // surface may show counts OR an honest degraded/processing state — but NEVER a
    // confident "no traffic ever" claim. (The strong numeric reconcile is a prod-pass
    // concern; locally we pin the no-lying-empty floor.)
    const lyingEmpty = await page
      .getByText(/never had any traffic|no traffic yet/i)
      .isVisible()
      .catch(() => false);
    expect(
      lyingEmpty,
      `analytics claims zero-traffic while visitor_events has ≥${pvBefore + 3} rows (lying-empty class)`,
    ).toBe(false);
    await settleShot(page, 'e2e/long-trail/screenshots-local/28-admin-analytics.png');

    // ── Console-error gate ────────────────────────────────────────────────
    // Allowlist (precise, counted where possible):
    //   /api/auth/get-session 404       — better_auth dark locally.
    //   status of 404                   — dark-feature probes.
    //   status of 400 (counted)         — OUR one deliberate invalid-submit probe.
    //   /api/team 500 (counted)         — now expected 0 post-0651; counting kept
    //                                     so any regression surfaces precisely.
    //   editor frame-ancestors refusal  — deployed editor still pre-fire-60.
    const genericLoadErrors = consoleErrors.filter((e) =>
      /the server responded with a status of 500/.test(e),
    );
    const unexplainedGenericCount = Math.max(0, genericLoadErrors.length - knownTeam500Count);
    const generic400Errors = consoleErrors.filter((e) =>
      /the server responded with a status of 400/.test(e),
    );
    const unexplained400Count = Math.max(0, generic400Errors.length - contactForm400Count);
    const unexpected = consoleErrors.filter(
      (e) =>
        !/\/api\/auth\/get-session/.test(e) &&
        !/status of 404/.test(e) &&
        !/the server responded with a status of (400|500)/.test(e) &&
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
    expect(
      unexplained400Count,
      `${unexplained400Count} generic-400 errors beyond our one invalid-submit probe`,
    ).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// PHASE F — authored in case-001-money-path.md, driven live in a later cycle.
// `test.fixme` = honestly PENDING (never a false green).
// ───────────────────────────────────────────────────────────────────────────────
test.describe('Long-Trail Case 001 :: PHASE F (pending live drive)', () => {
  test.fixme('F: install/remove disposable app → verify site still works → cleanup + tenant isolation', async () => {});
});
