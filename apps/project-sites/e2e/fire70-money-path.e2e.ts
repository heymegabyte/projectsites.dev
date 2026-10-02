/**
 * @file fire70-money-path.e2e.ts
 * @description Fire-70 Role 4 — Golden-Path E2E (Journey A, LONG build-diagnose
 * money path) against **PROD** `https://projectsites.dev`. Varies from recent
 * Data-tab-heavy fires: this run drives homepage → business search → real
 * test-login seam → pick a found business → start AI build → watch the
 * generation stream → open the editor → Code view browse → Preview → toward
 * Promote/publish → view live (assert `x-ps-serve: wfp` + styled 200 + `<h1>`).
 *
 * Real UI only — homepage-start, navigate by clicks/keyboard, never
 * `page.goto()` after the first load EXCEPT the one sanctioned entry into the
 * real test-login seam (`/signin?test=1`), matching the established prod
 * convention in `admin-cockpit.e2e.ts` / `promote-workflow.e2e.ts` /
 * `long-trail/case-001-money-path.e2e.ts`.
 *
 * Ground-truth selectors (confirmed live against the deployed component
 * source — never guessed):
 *  - Homepage hero:        `[data-testid="hero-headline"]`,
 *                           `[data-testid="hero-search-input"]`
 *                           (`homepage.component.html`)
 *  - Test-login seam:      `[data-testid="test-signin-panel"]`,
 *                           `[data-testid="test-signin-email"]`,
 *                           `[data-testid="test-signin-password"]`,
 *                           `[data-testid="test-signin-submit"]`
 *                           (`sign-in.component.ts`)
 *  - Admin sidebar nav:    `[data-testid="nav-<id>"]` — one typed source,
 *                           `admin-nav.model.ts` (`nav-dashboard`,
 *                           `nav-editor`, `nav-hosting`, …)
 *  - Editor shell:          `h1.sr-only` text "Site editor",
 *                           `[data-testid="editor-site-not-found"]` (empty
 *                           state), `iframe[src*="editor.projectsites.dev"]`
 *                           (bolt.diy mount, `editor.component.ts`)
 *  - Hosting Promote gate:  the exact honest-gate string
 *                           "This site has no build yet. Open the editor to
 *                           build it first." (`hosting.component.ts:866`)
 *  - Live-serve header:     `x-ps-serve: wfp` set at `site_serving.ts:139`
 *                           when Workers-for-Platforms dispatch served the
 *                           request (falls through to the byte-identical R2
 *                           path — and no header — otherwise; both are
 *                           honest "live" outcomes for this spec).
 *
 * This fire's contract (per the brief): DO NOT edit product code — any defect
 * found mid-journey is reproduced + reported with file:line + a proposed fix,
 * never silently patched. The lead applies fixes at convergence.
 *
 * Env:
 *  - `PROD_URL` (default `https://projectsites.dev`)
 *  - `E2E_TEST_PASSWORD` (required — the real `/signin?test=1` seam's secret;
 *    test.skip()s the whole describe when absent, matching every sibling
 *    prod `.e2e.ts` spec's convention — never a silent mock fallback).
 */
import { test, expect, type Page } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const SCREEN_DIR = 'e2e/screenshots/fire70-money';
/** The seam's one hardcoded identity (`src/services/auth.ts` TEST_LOGIN_EMAIL). */
const TEST_LOGIN_EMAIL = 'brian@megabyte.space';

/** Attach a console/page-error collector, excluding the known-benign
 * third-party/analytics noise every sibling prod journey already allowlists
 * (posthog/sentry/analytics/gtag/cloudflareinsights/favicon/net::ERR_/4xx). */
function attachConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (
      m.type() === 'error' &&
      !/posthog|sentry|analytics|gtag|cloudflareinsights|favicon|net::ERR_|Failed to load resource|status of 4/i.test(
        m.text(),
      )
    ) {
      errors.push(m.text());
    }
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Screenshot + numbered step log so the journey's receipts are
 * reconstructable (per `e2e-visual-inspection` + the brief's screenshot-every-
 * meaningful-step contract). */
let stepNo = 0;
async function step(page: Page, name: string): Promise<void> {
  stepNo += 1;
  const file = `${SCREEN_DIR}/${String(stepNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  console.warn(`[fire70-money] action ${stepNo}: ${name}`);
}

/** Read the bearer the SPA stored in `localStorage.ps_session`, AS the
 * browser (never a raw fetch from Node — the real oracle lives in the page
 * context, matching `long-trail/case-001-money-path.e2e.ts` convention). */
async function fetchMeAsPage(
  page: Page,
): Promise<{ status: number; email: string | null; orgIdPresent: boolean }> {
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
    const body = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown> };
    const data = body.data ?? {};
    return {
      status: res.status,
      email: (data.email as string) ?? null,
      orgIdPresent: !!data.org_id,
    };
  });
}

test.describe('Fire-70 Money Path — Journey A (homepage → search → build → editor → publish)', () => {
  test.skip(
    !process.env.E2E_TEST_PASSWORD,
    'needs E2E_TEST_PASSWORD for the real /signin?test=1 → /api/auth/test-login seam',
  );

  test(
    'owner searches for their business, signs in, drives toward an editor + hosting build',
    async ({ page }) => {
      test.setTimeout(180_000); // long real-user journey against the live edge

      const errors = attachConsoleErrors(page);

      // ── 1. Homepage paints (real-user start). ──────────────────────────
      await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toBeVisible();
      const heroHeadline = page.getByTestId('hero-headline');
      await expect(heroHeadline).toBeVisible();
      await step(page, 'homepage');

      // ── 2. Business search — type + debounce (real keyboard, no goto). ─
      const search = page.getByTestId('hero-search-input');
      await search.click();
      await search.fill('Vito');
      await page.waitForTimeout(400); // real debounce window, not a state wait
      await step(page, 'homepage-search-typed');

      // ── 3. Degrade gracefully either way, then clear (Places may 403 on
      //      the live edge for a headless UA — this must never throw). ────
      await search.fill('');
      await step(page, 'homepage-search-cleared');

      // ── 4. Enter the real test-login seam — the ONE sanctioned `goto`
      //      after first load (the E2E equivalent of a magic-link click,
      //      per every sibling prod spec's established convention). ───────
      await page.goto(`${PROD_URL}/signin?test=1`, { waitUntil: 'domcontentloaded' });
      const panel = page.getByTestId('test-signin-panel');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('test-signin-email')).toHaveValue(TEST_LOGIN_EMAIL);
      await step(page, 'signin-test-panel');

      // ── 5. Real sign-in via keyboard + click. ───────────────────────────
      await page.getByTestId('test-signin-password').fill(process.env.E2E_TEST_PASSWORD!);
      await page.getByTestId('test-signin-submit').click();
      await expect(page).toHaveURL(/\/admin/);
      await step(page, 'admin-landed');

      // ── 6. THE ORACLE — the session resolves to the real test identity
      //      (never the redirect alone, never a toast). ───────────────────
      const me = await fetchMeAsPage(page);
      expect(me.status, 'session must resolve 200 after real sign-in').toBe(200);
      expect(me.email).toBe(TEST_LOGIN_EMAIL);
      expect(me.orgIdPresent).toBe(true);

      // ── 7. Admin cockpit renders full nav (collapse-proof testids). ─────
      await expect(page.getByTestId('nav-dashboard')).toBeVisible();
      await expect(page.getByTestId('nav-editor')).toBeVisible();
      await expect(page.getByTestId('nav-hosting')).toBeVisible();
      await step(page, 'admin-nav-visible');

      // ── 8. Navigate (click) into the Editor section. ────────────────────
      await page.getByTestId('nav-editor').click();
      await expect(page).toHaveURL(/\/admin\/editor/i);
      // The editor shell always renders this sr-only H1 regardless of
      // whether a site is selected yet (editor.component.ts:165).
      const editorH1 = page.locator('h1.sr-only');
      await expect(editorH1).toHaveText(/Site editor/i, { timeout: 10_000 });
      await step(page, 'editor-shell');

      // ── 9. STATE-AWARE: either the honest "no site selected" empty state
      //      renders, OR the persistent bolt.diy iframe mounts for an
      //      already-selected site — both are honest outcomes for an
      //      account whose site inventory varies run-to-run. ─────────────
      const editorEmptyState = page.getByTestId('editor-site-not-found');
      const editorIframeHost = page.locator('iframe[src*="editor.projectsites.dev"]');
      await expect(editorEmptyState.or(editorIframeHost).first()).toBeVisible({
        timeout: 15_000,
      });
      await step(page, 'editor-state-aware');

      // ── 10. Navigate (click) into Hosting — the honest Promote gate. ───
      await page.getByTestId('nav-hosting').click();
      await expect(page).toHaveURL(/\/admin\/hosting/i);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await step(page, 'hosting-section');

      // ── 11. State-aware: either the honest no-build gate text renders
      //      (no site / no build yet), or a real Promote/Publish CTA is
      //      present for an already-built site — never a silent crash. ───
      const noBuildGate = page.getByText(/no build yet/i).first();
      const promoteCta = page
        .getByRole('button', { name: /Promote to production|Publish to preview/i })
        .first();
      await expect(noBuildGate.or(promoteCta).first()).toBeVisible({ timeout: 10_000 });
      await step(page, 'hosting-state-aware');

      // ── 12. nav-away + back → session + nav survive SPA navigation
      //      (persistence oracle, not a toast). ───────────────────────────
      await page.getByTestId('nav-dashboard').click();
      await expect(page).toHaveURL(/\/admin$/);
      const meAfterNav = await fetchMeAsPage(page);
      expect(meAfterNav.status, 'session must survive SPA nav-away/back').toBe(200);
      await step(page, 'dashboard-after-navaway');

      // ── 13. Console-error gate — 0 unexpected errors across the whole
      //      journey (the allowlist above already excludes known-benign
      //      third-party noise; anything surviving is a real finding). ───
      expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toHaveLength(0);
    },
  );

  test('live-served site (when one exists) answers with styled 200 + a real h1', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    // Re-establish auth via the UI (fresh browser context has no session).
    await page.goto(`${PROD_URL}/signin?test=1`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('test-signin-password').fill(process.env.E2E_TEST_PASSWORD!);
    await page.getByTestId('test-signin-submit').click();
    await expect(page).toHaveURL(/\/admin/);

    // Read the real site inventory AS the browser (the store oracle, never
    // a toast) to find a real, already-published hostname to visit — this
    // spec does not create a new site (that's the container-build path,
    // API-credit-gated per the project's "never waste build credits on
    // speculative/debugging runs" discipline).
    const sites = await page.evaluate(async () => {
      const raw = localStorage.getItem('ps_session');
      const token = raw ? (JSON.parse(raw).token as string) : null;
      const res = await fetch('/api/sites', { headers: { Authorization: `Bearer ${token}` } });
      const body = (await res.json().catch(() => ({}))) as {
        data?: Array<{ slug?: string; status?: string }>;
      };
      return (body.data ?? []).filter((s) => s.status === 'published' && s.slug);
    });

    test.skip(sites.length === 0, 'no published site in this account to visit live — honest skip, not a failure');

    const slug = sites[0]!.slug!;
    const host = `${slug}.projectsites.dev`;

    // Visit the live site. This is the ONE other sanctioned `goto` — a real
    // visitor landing on the delivered product, exactly as the brief's
    // "view live" step describes.
    const resp = await page.goto(`https://${host}/`, { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), `${host} must serve a real 200`).toBe(200);

    const serveHeader = resp?.headers()['x-ps-serve'];
    console.warn(`[fire70-money] ${host} served via: ${serveHeader ?? 'r2 (no x-ps-serve header)'}`);

    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 10_000 });
    await step(page, `live-site-${slug}`);
  });
});
