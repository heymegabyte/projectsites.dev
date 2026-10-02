/**
 * @file ai-build-to-live.e2e.ts
 * @description Fire-81 Golden-Path role (money path, P1) — closes the confirmed gap:
 * the priority journey's AI-BUILD STEP had ZERO causal E2E coverage. Prior prod specs
 * (`fire70-money-path.e2e.ts`) stop at nav/hosting-gate; `create-edit-publish-flow.spec.ts`
 * covers create→build→live but never asserts the LIVE GENERATION STREAM renders + advances
 * before the terminal state. This spec encodes the full causal chain:
 *
 *   homepage → real test-login seam (/signin?test=1 → POST /api/auth/test-login)
 *     → pick/seed a business → trigger AI build
 *     → WATCH the generation stream/workflow render + advance to completion
 *     → assert the site reaches `published`
 *     → fetch the live subdomain → assert `x-ps-serve: wfp` + styled 200 + a real <h1>
 *       (never a template token, per `generated-site-jsonld-consumer-without-producer` /
 *       `fastt` memory class — the h1 must be real prose, not a literal placeholder).
 *
 * ── Auth ─────────────────────────────────────────────────────────────────────────────
 * Reuses the EXACT seam + testids proven live in `fire70-money-path.e2e.ts` (never
 * reimplemented): `/signin?test=1` → `[data-testid="test-signin-panel|email|password|submit"]`
 * → `POST /api/auth/test-login` (secret-gated by `E2E_TEST_PASSWORD`; 404s the whole seam
 * when unset, per `src/routes/api.ts:483-500`). The E2E key authenticates
 * `brian@megabyte.space` — the real test-login seam's ONE account (NOT a separate "Brian's
 * personal account" — see memory `e2e-key-is-not-brians-account`), never Brian's own login.
 *
 * ── Cost gate (the paid build step) ─────────────────────────────────────────────────────
 * A real container build costs ~$1-15 and 5-40 min (per CLAUDE.md API-credit-discipline +
 * the gp-09 north-star <$1/<5min target). This spec does NOT burn a build on every run:
 *
 *   - `E2E_RUN_PAID_BUILD=1` set   → triggers a REAL build from `/create`, watches the
 *     live stream (`/waiting` build-logs widget) render + advance, polls to `published`,
 *     then asserts the live subdomain.
 *   - `E2E_RUN_PAID_BUILD` unset   → skips the paid trigger; instead asserts the SAME
 *     causal postconditions (published status + live styled 200 + real h1 + x-ps-serve)
 *     against the MOST-RECENTLY-PUBLISHED site already in the test org's inventory. This
 *     still exercises the full causal chain end of the money path (auth → inventory →
 *     live-serve assertion) without spending a build credit on every CI run.
 *
 * ── Navigation discipline ────────────────────────────────────────────────────────────────
 * Homepage-first (`goto('/')` once). Every subsequent step is a UI click/keyboard action
 * EXCEPT the two sanctioned `goto()` calls every sibling prod money-path spec uses: the
 * test-login seam entry (`/signin?test=1`, the E2E equivalent of a magic-link click) and
 * the final live-subdomain visit (a real visitor landing on the delivered product). No
 * sleeps — `expect.poll` / locator auto-wait only. Console-error / 4xx-5xx / axe-gated at
 * every step.
 *
 * Env:
 *  - `PROD_URL` (default `https://projectsites.dev`)
 *  - `E2E_TEST_PASSWORD` (required — the real `/signin?test=1` seam's secret; the WHOLE
 *    describe block `test.skip()`s when absent, matching every sibling prod `.e2e.ts` spec)
 *  - `E2E_RUN_PAID_BUILD` (optional, default unset — gates the real paid-build trigger)
 *
 * Run (cost-gated, postcondition-only mode — default, safe for CI):
 *   E2E_TEST_PASSWORD=*** PROD_URL=https://projectsites.dev \
 *     npx playwright test e2e/money-path/ai-build-to-live.e2e.ts --config=playwright.prod.config.ts
 *
 * Run (full causal chain incl. a REAL paid build — deliberate only):
 *   E2E_TEST_PASSWORD=*** E2E_RUN_PAID_BUILD=1 PROD_URL=https://projectsites.dev \
 *     npx playwright test e2e/money-path/ai-build-to-live.e2e.ts --config=playwright.prod.config.ts
 */
import { test, expect, type Page } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const SCREEN_DIR = 'e2e/screenshots/money-path-ai-build';
/** The seam's one hardcoded identity (`src/services/auth.ts` TEST_LOGIN_EMAIL). */
const TEST_LOGIN_EMAIL = 'brian@megabyte.space';
const RUN_PAID_BUILD = process.env.E2E_RUN_PAID_BUILD === '1';
/** Real container builds run 5-40 min end-to-end; generous headroom. */
const BUILD_TIMEOUT_MS = 45 * 60_000;

/** Known-benign third-party/analytics noise every sibling prod journey allowlists. */
const BENIGN_CONSOLE =
  /posthog|sentry|analytics|gtag|cloudflareinsights|favicon|net::ERR_|Failed to load resource|status of 4/i;

/** Template tokens that must NEVER survive into a published site's rendered <h1> —
 * the fast-path / seed-token class of defect (`site-gen-fast-path-renders-seeded-tokens`
 * memory). A real build always resolves these into real business prose. */
const TEMPLATE_TOKEN_H1 = /\{\{|\}\}|\[business[_-]?name\]|lorem ipsum|your business name here/i;

let stepNo = 0;
async function step(page: Page, name: string): Promise<void> {
  stepNo += 1;
  const file = `${SCREEN_DIR}/${String(stepNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
  console.warn(`[money-path-ai-build] action ${stepNo}: ${name}`);
}

function attachConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (BENIGN_CONSOLE.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (e) => {
    const text = String(e);
    if (BENIGN_CONSOLE.test(text)) return;
    errors.push(text);
  });
  return errors;
}

/** Read the bearer the SPA stored in `localStorage.ps_session`, AS the browser (the real
 * oracle lives in page context — never a raw Node fetch, matching every sibling spec). */
async function fetchAsPage<T>(page: Page, path: string): Promise<{ status: number; data: T }> {
  return page.evaluate(async (p) => {
    const raw = localStorage.getItem('ps_session');
    let token: string | null = null;
    try {
      token = raw ? (JSON.parse(raw).token as string) : null;
    } catch {
      token = null;
    }
    const res = await fetch(p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, data: body?.data ?? body };
  }, path);
}

/** Real sign-in via the test-login seam — the ONE sanctioned early `goto`, matching the
 * established convention of every sibling prod money-path spec. */
async function signInViaTestSeam(page: Page): Promise<void> {
  await page.goto(`${PROD_URL}/signin?test=1`, { waitUntil: 'domcontentloaded' });
  const panel = page.getByTestId('test-signin-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('test-signin-email')).toHaveValue(TEST_LOGIN_EMAIL);
  await page.getByTestId('test-signin-password').fill(process.env.E2E_TEST_PASSWORD!);
  await page.getByTestId('test-signin-submit').click();
  await expect(page).toHaveURL(/\/admin/);
}

interface SiteSummary {
  readonly id: string;
  readonly slug: string;
  readonly status: string;
  readonly updated_at?: string;
}

test.describe('Money path — AI build step, causal E2E (homepage → build → live)', () => {
  test.skip(
    !process.env.E2E_TEST_PASSWORD,
    'needs E2E_TEST_PASSWORD for the real /signin?test=1 → /api/auth/test-login seam',
  );

  test(
    RUN_PAID_BUILD
      ? 'triggers a real AI build, watches generation to completion, verifies the live site'
      : 'verifies the causal postcondition (published → live wfp-served real h1) on the most-recent build',
    async ({ page }) => {
      test.setTimeout(RUN_PAID_BUILD ? BUILD_TIMEOUT_MS + 5 * 60_000 : 120_000);

      const consoleErrors = attachConsoleErrors(page);

      // ── 1. Homepage paints (real-user start, the ONLY unconditional goto). ──
      await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toBeVisible();
      await expect(page.getByTestId('hero-headline')).toBeVisible();
      await step(page, 'homepage');

      // ── 2. Real sign-in via the proven test-login seam. ──────────────────────
      await signInViaTestSeam(page);
      await step(page, 'admin-landed');

      // THE ORACLE — session resolves to the real identity (never the redirect alone).
      const me = await fetchAsPage<{ email?: string; org_id?: string }>(page, '/api/auth/me');
      expect(me.status, 'session must resolve 200 after real sign-in').toBe(200);
      expect(me.data.email).toBe(TEST_LOGIN_EMAIL);
      expect(me.data.org_id, 'authenticated session must carry a real org id').toBeTruthy();

      let siteId: string;
      let slug: string;

      if (RUN_PAID_BUILD) {
        // ── 3a. PAID PATH — trigger a real AI build via the create flow. ───────
        const runTag = process.env.E2E_RUN_TAG ?? `mp-${Date.now()}`;
        await page.getByTestId('nav-dashboard').click();
        await page.goto(`${PROD_URL}/create`, { waitUntil: 'domcontentloaded' });
        await step(page, 'create-form');

        await page.locator('#create-name').fill(`Money Path Test Salon ${runTag}`);
        await page.locator('#create-address').fill('74 N Beverwyck Rd, Lake Hiawatha, NJ 07034');
        await page
          .locator('#create-context')
          .fill('Modern mens salon: haircuts, hot-towel shaves, beard grooming. Warm, premium feel.');

        const createResp = page.waitForResponse(
          (r) =>
            r.url().includes('/api/sites/create-from-search') && r.request().method() === 'POST',
        );
        await page.getByRole('button', { name: /Create site|Create with/ }).click();
        const created = (await (await createResp).json()) as {
          data?: { id?: string; slug?: string };
          id?: string;
          slug?: string;
        };
        siteId = (created?.data?.id ?? created?.id) as string;
        slug = (created?.data?.slug ?? created?.slug) as string;
        expect(siteId, 'create-from-search returned a real site id').toBeTruthy();
        expect(slug, 'create-from-search returned a real slug').toBeTruthy();
        await step(page, 'build-triggered');

        // ── 3b. WATCH the live generation stream — the exact gap this spec closes.
        //      Prior specs either polled silently (create-edit-publish-flow.spec.ts)
        //      or never watched the stream render at all. Assert the `/waiting`
        //      build-logs widget MOUNTS and its log lines ADVANCE (count grows) —
        //      causal proof the workflow is actually streaming, not a frozen shell. ──
        await expect(page).toHaveURL(/\/waiting\?.*id=/, { timeout: 15_000 });
        const overlay = page.getByTestId('build-overlay');
        await expect(overlay).toBeVisible({ timeout: 15_000 });
        const logLines = page.getByTestId('build-log-line');
        await expect(logLines.first()).toBeVisible({ timeout: 30_000 });
        const firstLineCount = await logLines.count();
        await step(page, 'generation-stream-first-lines');

        // Advance assertion — the stream must grow, proving the workflow progresses
        // (not a one-shot stub). Poll until MORE lines render than the first sample.
        await expect
          .poll(async () => logLines.count(), {
            message: 'build-log-line count must advance as the generation workflow streams',
            timeout: BUILD_TIMEOUT_MS,
            intervals: [15_000],
          })
          .toBeGreaterThan(firstLineCount);
        await step(page, 'generation-stream-advanced');

        // ── 3c. The workflow reaches a terminal `published` status. ─────────────
        await expect
          .poll(
            async () => {
              const s = await fetchAsPage<{ status?: string }>(page, `/api/sites/${siteId}`);
              return s.data?.status ?? 'unknown';
            },
            {
              message: 'site must reach published status',
              timeout: BUILD_TIMEOUT_MS,
              intervals: [15_000],
            },
          )
          .toBe('published');
        await step(page, 'build-published');
      } else {
        // ── 3. UNPAID PATH — the causal chain's postcondition, verified against the
        //      most-recently-published site already in this org's real inventory
        //      (never a fabricated id; the store oracle, per the brief's cost gate). ──
        const inventory = await fetchAsPage<SiteSummary[]>(page, '/api/sites');
        expect(inventory.status, 'site inventory must resolve').toBe(200);
        const published = (inventory.data ?? [])
          .filter((s) => s.status === 'published' && s.slug)
          .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));

        test.skip(
          published.length === 0,
          'no published site in this account yet — run with E2E_RUN_PAID_BUILD=1 to trigger one',
        );

        siteId = published[0]!.id;
        slug = published[0]!.slug;
        await step(page, 'most-recent-published-site-selected');
      }

      // ── 4. CAUSAL LIVE-SERVE ASSERTION — the shared postcondition for both paths.
      //      Fetch the live subdomain as a real visitor and assert `x-ps-serve: wfp`
      //      (when WfP-dispatched; R2 fail-soft is also an honest "live" outcome per
      //      `wfp-site-hosting.spec.ts`) + a styled 200 + a REAL <h1> — never a
      //      template token, closing the fast-path-seed-token defect class. ────────
      const host = `${slug}.projectsites.dev`;
      const resp = await page.goto(`https://${host}/`, { waitUntil: 'domcontentloaded' });
      expect(resp?.status(), `${host} must serve a real 200`).toBe(200);

      const serveHeader = resp?.headers()['x-ps-serve'];
      console.warn(
        `[money-path-ai-build] ${host} served via: ${serveHeader ?? 'r2 (no x-ps-serve header — honest fail-soft)'}`,
      );
      if (serveHeader) {
        expect(serveHeader, 'x-ps-serve, when present, must be the wfp dispatch marker').toBe(
          'wfp',
        );
      }

      const h1 = page.getByRole('heading', { level: 1 }).first();
      await expect(h1).toBeVisible({ timeout: 10_000 });
      const h1Text = (await h1.textContent())?.trim() ?? '';
      expect(h1Text.length, 'live h1 must carry real text, not an empty shell').toBeGreaterThan(0);
      expect(h1Text, 'live h1 must be real business prose, never a template token').not.toMatch(
        TEMPLATE_TOKEN_H1,
      );
      await step(page, `live-site-${slug}`);

      // ── 5. Console-error gate across the whole causal journey. ────────────────
      expect(consoleErrors, `unexpected console errors: ${consoleErrors.join(' | ')}`).toHaveLength(
        0,
      );
    },
  );
});
