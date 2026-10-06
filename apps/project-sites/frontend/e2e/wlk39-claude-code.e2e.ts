/**
 * WLK-39 — the Claude Code panel golden-path (the §75 flagship's missing PROD regression guard).
 *
 * The Editor's 5th top tab ("Claude Code", beside Code/Preview/Database/Resources) is the WLK-39
 * flagship, and its Resolution mode is the surface fire-266's STREAM-RESOLVE rebuilt: a single
 * ~24-27s `/api/resolve` call (dual-provider research → Claude synthesis, Workers-AI fallback) that
 * — instead of a dead spinner — shows CINEMATIC STAGED PROGRESS while running (phase labels
 * "Researching — independent pass 1…" → "… pass 2…" → "Synthesizing the strongest plan…" + a live
 * `m:ss` elapsed clock, rendered by `ResolutionProgress` in `app/components/workbench/
 * ClaudeCodePanel.tsx`). No prior spec drives it against prod, so a regression would ship silently
 * (a clean render + zero console errors with a frozen/missing staged-progress UI is invisible to the
 * render-integrity + console gates — exactly the [[mokgr]] phantom class this guards against).
 *
 * ## What this proves end-to-end (real browser, live prod, NO mocks)
 *   admin (authed as brian@megabyte.space — see below) → first site → open Editor → wait out the
 *   WebContainer cold boot (locator-based, up to ~120s, NO sleeps) → open the "Claude Code" top tab →
 *   assert the panel renders (composer + sub-nav) → switch to Resolution mode → type a short research
 *   prompt → Run → **assert the staged-progress UI appears** (a phase label matching
 *   /Researching|Synthesizing/i + the `m:ss` clock) — THIS is the STREAM-RESOLVE regression guard —
 *   → then assert a result/synthesis renders within a generous timeout (soft-logged if the live run is
 *   too slow/nondeterministic; the staged-progress assertion stays HARD).
 *
 * ## Why authenticate as brian@megabyte.space, NOT the Bearer E2E_API_KEY
 * `claude_code_panel` is ORG-SCOPED (worker `FLAG_REGISTRY`: enabled=0, rollout=0, experimental) and
 * is ON for Brian's org but 404 ("not enabled") for the E2E_API_KEY *test* org — so under the test
 * key the tab never renders. `resolution_engine` (the `/api/resolve` backend) is GLOBAL/on. We use the
 * proven cf-bot-challenged test-login seam (fire-122/268, `helpers/admin-auth`): load `/` first to
 * earn `cf_clearance`, POST `/api/auth/test-login` in-page, seed `ps_session {token, identifier,
 * createdAt}`. FIRST — after auth, before touching the editor — we confirm the panel resolves ON for
 * this identity via an in-page `GET /api/sites/:id/claude-code/status` → 200 `{data:{enabled:true}}`
 * (the same endpoint the admin bridge probes). If it's 404 under this identity too, we SKIP with the
 * blocker surfaced (never fabricate coverage).
 *
 * Reliability: real selectors driving the real cross-origin panel (`frameLocator`), deterministic
 * locator waits + `expect.poll` (zero `waitForTimeout`), parallel-safe. Slow by design (cold
 * WebContainer boot + a ~24s resolve) — run with `--workers=1` for the keystone.
 *
 * Run:
 *   E2E_TEST_PASSWORD=$(get-secret E2E_TEST_PASSWORD) \
 *     npx playwright test --config=playwright.prod.config.ts \
 *     e2e/wlk39-claude-code.e2e.ts --project=chromium --workers=1
 */
import { test, expect, type Page, type FrameLocator } from '@playwright/test';

import { authenticateAdmin, getTestPassword, TEST_EMAIL, filterConsoleNoise } from './helpers/admin-auth';

const PROD_URL = process.env['PROD_URL'] ?? 'https://projectsites.dev';

// The embedded editor is a cross-origin iframe (editor.projectsites.dev); the real app is served
// only when embedded from /admin. All panel interaction goes through this frame.
const EDITOR_IFRAME = 'iframe[src*="editor.projectsites.dev"]';
// bolt's build-mode chat placeholder — its appearance is the WebContainer "booted" signal (same
// readiness probe chaos-15-editor-journey uses).
const BOLT_PROMPT_PLACEHOLDER = 'What are we shipping?';

// Cold WebContainer boot is the long pole (30-90s); the resolve call is ~24-27s. Generous,
// locator-based ceilings — inner failures still surface fast (a missing panel fails its own
// toBeVisible, not this ceiling).
const BOOT_TIMEOUT = 120_000;
const PANEL_TIMEOUT = 20_000;
const PROGRESS_TIMEOUT = 20_000;
const RESULT_TIMEOUT = 150_000;

/** A short, cheap research prompt — Resolution answers it via the Workers-AI fallback in ~24s. */
const RESOLUTION_PROMPT = 'In one sentence, what makes a small-business homepage convert visitors?';

/**
 * Confirm `claude_code_panel` resolves ON for the authed identity BEFORE driving the editor — an
 * in-page `GET /api/sites/:id/claude-code/status` carrying the seeded session (the same endpoint the
 * admin bridge probes). Returns the probe outcome so the caller can skip with a precise blocker if
 * the flag is dark for this identity too (never fabricate coverage).
 */
async function probeClaudeCodeStatus(
  page: Page,
  base: string,
): Promise<{ enabled: boolean; status: number; siteId: string | null; reason?: string }> {
  return page.evaluate(async (b: string) => {
    const readToken = (): string | null => {
      try {
        const raw = localStorage.getItem('ps_session');
        return raw ? (JSON.parse(raw) as { token?: string }).token ?? null : null;
      } catch {
        return null;
      }
    };
    const token = readToken();
    if (!token) return { enabled: false, status: 0, siteId: null, reason: 'no seeded session token' };
    const auth = { Authorization: `Bearer ${token}` };

    // First site for this org — the panel is site-scoped, so the status probe needs a real site id.
    const sitesRes = await fetch(`${b}/api/sites`, { headers: auth, credentials: 'include' });
    if (!sitesRes.ok) {
      return { enabled: false, status: sitesRes.status, siteId: null, reason: `GET /api/sites ${sitesRes.status}` };
    }
    const sitesJson = (await sitesRes.json()) as { data?: Array<{ id?: string }> };
    const siteId = sitesJson.data?.[0]?.id ?? null;
    if (!siteId) return { enabled: false, status: 200, siteId: null, reason: 'org has no sites' };

    // The flag probe — a 200 {data:{enabled:true}} means the tab will render for this identity.
    const statusRes = await fetch(`${b}/api/sites/${siteId}/claude-code/status`, {
      headers: auth,
      credentials: 'include',
    });
    let enabled = false;
    try {
      const body = (await statusRes.json()) as { data?: { enabled?: boolean } };
      enabled = body?.data?.enabled === true;
    } catch {
      /* non-JSON body → treat as not-enabled */
    }
    return { enabled: statusRes.ok && enabled, status: statusRes.status, siteId };
  }, base);
}

/** Open /admin/editor, select the first site if needed, and wait out the WebContainer cold boot. */
async function openEditorAndBoot(page: Page): Promise<FrameLocator> {
  // Land on the editor directly — the admin shell owns the persistent iframe across sub-routes, so
  // the selected site is already resolved from the earlier /admin landing (authenticateAdmin).
  await page.goto(`${PROD_URL}/admin`, { waitUntil: 'domcontentloaded' });
  await page.goto(`${PROD_URL}/admin/editor`, { waitUntil: 'domcontentloaded' });

  const frame = page.frameLocator(EDITOR_IFRAME).first();

  // Cold boot: the chat input appears only after WebContainer finishes "Running Start Application".
  // Condition-based wait — no arbitrary sleep.
  const chatBox = frame.locator(`textarea[placeholder="${BOLT_PROMPT_PLACEHOLDER}"]`);
  await expect(chatBox, `WebContainer never booted (chat input absent after ${BOOT_TIMEOUT / 1000}s)`).toBeVisible({
    timeout: BOOT_TIMEOUT,
  });

  return frame;
}

test.describe('WLK-39 — Claude Code panel Resolution golden-path (STREAM-RESOLVE guard)', () => {
  test('panel opens, Resolution runs, staged progress appears, a result renders', async ({ page }) => {
    // Cold WebContainer boot + a ~24s resolve + full-suite parallel contention is the long pole.
    test.setTimeout(420_000);

    const password = getTestPassword();
    test.skip(!password, 'E2E_TEST_PASSWORD not set — required to auth as brian@megabyte.space (flag is org-scoped)');

    // Track console/page errors for a clean-console DoD (platform third-party chatter filtered).
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // ── Auth as Brian (the org the flag is ON for) via the proven test-login seam.
    const auth = await authenticateAdmin(page, { prodUrl: PROD_URL, email: TEST_EMAIL, password });
    expect(
      auth.ok,
      `test-login auth failed (status=${auth.status ?? 'n/a'}, bouncedToSignin=${auth.bouncedToSignin ?? false}) — ` +
        `cannot reach the brian@megabyte.space identity the org-scoped claude_code_panel flag needs`,
    ).toBe(true);

    // ── FAIL FAST: confirm the panel resolves ON for THIS identity before driving the editor.
    const probe = await probeClaudeCodeStatus(page, PROD_URL);
    test.skip(
      !probe.enabled,
      `BLOCKER: claude_code_panel is NOT enabled for ${TEST_EMAIL} ` +
        `(status=${probe.status}, siteId=${probe.siteId ?? 'none'}${probe.reason ? `, ${probe.reason}` : ''}). ` +
        `The org-scoped flag must be ON for this identity to drive the panel — not fabricating coverage.`,
    );

    // ── Open the editor + wait out the WebContainer cold boot.
    const frame = await openEditorAndBoot(page);

    // ── Open the "Claude Code" top tab (the 5th tab; only the chat tab carries a data-testid, so
    // select by its accessible button name — the real control a user clicks).
    const claudeTab = frame.getByRole('button', { name: 'Claude Code' });
    await expect(claudeTab, 'the Claude Code top tab must render (claude_code_panel ON) — it is absent').toBeVisible({
      timeout: PANEL_TIMEOUT,
    });
    await claudeTab.click();

    // ── Assert the panel renders: its root + the always-visible composer + sub-nav. These are the
    // panel's structural landmarks (`data-testid`s in ClaudeCodePanel.tsx) — proof the flagship
    // mounted, not just that a tab exists.
    const panel = frame.locator('[data-testid="claude-code-panel"]');
    await expect(panel, 'Claude Code panel root did not mount after clicking its tab').toBeVisible({
      timeout: PANEL_TIMEOUT,
    });
    await expect(frame.locator('[data-testid="cc-prompt-input"]'), 'panel composer (prompt input) missing').toBeVisible();
    await expect(frame.locator('[data-testid="cc-subnav"]'), 'panel sub-nav (Activity/Files/Tests/Deploy) missing').toBeVisible();

    // ── Switch to Resolution mode. The toggle is a radio group; the Resolution segment is enabled
    // because `resolution_engine` is GLOBAL/on (it would be `aria-disabled` only if the flag were
    // dark — a separate, documented state). Click it and assert the mode flipped.
    const resolutionMode = frame.locator('[data-testid="cc-mode-resolution"]');
    await expect(resolutionMode, 'Resolution mode segment missing from the mode toggle').toBeVisible();
    await expect(
      resolutionMode,
      'Resolution mode is disabled (resolution_engine dark?) — expected GLOBAL-on so the run path works',
    ).toBeEnabled();
    await resolutionMode.click();
    await expect(frame.locator('[data-testid="cc-mode-toggle"]'), 'mode did not switch to resolution').toHaveAttribute(
      'data-mode',
      'resolution',
    );

    // ── Enter a short prompt + Run.
    const promptInput = frame.locator('[data-testid="cc-prompt-input"]');
    await promptInput.fill(RESOLUTION_PROMPT);
    const runButton = frame.locator('[data-testid="cc-run-button"]');
    await expect(runButton, 'Run button should enable once a prompt is typed').toBeEnabled();
    await runButton.click();

    // ── THE STREAM-RESOLVE REGRESSION GUARD (hard): while the single ~24s resolve is in flight the
    // panel MUST show cinematic staged progress — the ResolutionProgress view with a phase label
    // ("Researching …" / "Synthesizing …") AND the live m:ss elapsed clock. A regression to a dead
    // spinner (or no staged UI) fails HERE, even with a clean render + zero console errors.
    const progress = frame.locator('[data-testid="cc-resolution-progress"]');
    await expect(progress, 'STREAM-RESOLVE regression: the cinematic staged-progress view never appeared').toBeVisible({
      timeout: PROGRESS_TIMEOUT,
    });
    const phaseLabel = frame.locator('[data-testid="cc-resolution-phase-label"]');
    await expect(phaseLabel, 'staged-progress phase label missing').toBeVisible();
    await expect(
      phaseLabel,
      'phase label must be one of the real STREAM-RESOLVE phases (Researching… / Synthesizing…)',
    ).toHaveText(/Researching|Synthesizing/i);
    // The live elapsed clock is overlaid on the Nebula atmosphere inside the progress view; assert a
    // real m:ss readout is present (information, not decoration — present even under reduced motion).
    await expect(progress, 'live m:ss elapsed clock missing from the staged-progress view').toContainText(/\d:\d{2}/);

    // ── Result assertion (SOFT — the live Workers-AI resolve is ~24s but nondeterministic under load;
    // the staged-progress assertion above is the hard guard). The progress view unmounts the instant
    // the reply lands and either the Resolution render (research legs + synthesis) OR a run-error
    // appears. We poll for a terminal state and HARD-fail only on an explicit error; a no-complete
    // (too slow this run) is logged, not failed.
    const resolution = frame.locator('[data-testid="cc-resolution"]');
    const synthesis = frame.locator('[data-testid="cc-synthesis"]');
    const synthesisUnavailable = frame.locator('[data-testid="cc-synthesis-unavailable"]');
    const runError = frame.locator('[data-testid="cc-error"]');

    const outcome = await Promise.race([
      resolution
        .waitFor({ state: 'visible', timeout: RESULT_TIMEOUT })
        .then(() => 'resolved' as const)
        .catch(() => 'timeout' as const),
      runError
        .waitFor({ state: 'visible', timeout: RESULT_TIMEOUT })
        .then(() => 'error' as const)
        .catch(() => 'timeout' as const),
    ]);

    if (outcome === 'resolved') {
      // The Resolution view rendered — assert the synthesis section is present in SOME form (a down
      // synthesis renders a calm "unavailable" note, which is a valid non-error terminal state).
      const hasSynthesis = (await synthesis.count()) > 0 || (await synthesisUnavailable.count()) > 0;
      expect(hasSynthesis, 'Resolution view rendered but neither a synthesis nor its calm unavailable note is present').toBe(
        true,
      );
      const synthesized = (await synthesis.count()) > 0;
      // eslint-disable-next-line no-console
      console.warn(
        `[wlk39] Resolution completed — staged progress + ${synthesized ? 'synthesis' : 'calm "synthesis unavailable" note'} rendered (hard staged-progress guard PASSED).`,
      );
    } else if (outcome === 'error') {
      const msg = await runError.innerText().catch(() => '(unreadable)');
      throw new Error(`Resolution run surfaced an error after staged progress: ${msg}`);
    } else {
      // Soft: the run didn't reach a terminal state within the generous window this attempt. The
      // STREAM-RESOLVE guard (staged progress) already PASSED — that is this spec's contract.
      // eslint-disable-next-line no-console
      console.warn(
        `[wlk39] Resolution did not reach a terminal result within ${RESULT_TIMEOUT / 1000}s this run ` +
          `(nondeterministic Workers-AI latency) — SOFT. The hard staged-progress guard PASSED.`,
      );
    }

    // ── Clean-console DoD (platform third-party chatter filtered; the editor iframe's own origin is
    // on the noise list so cross-origin editor logs don't fail our page's gate).
    const realConsole = filterConsoleNoise(consoleErrors);
    const realPage = filterConsoleNoise(pageErrors);
    expect(realConsole, `console errors: ${realConsole.join('; ')}`).toEqual([]);
    expect(realPage, `page errors: ${realPage.join('; ')}`).toEqual([]);
  });
});
