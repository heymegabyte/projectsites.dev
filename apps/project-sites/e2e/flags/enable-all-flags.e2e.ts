/**
 * @file enable-all-flags.e2e.ts
 * @description Brian directive — turn ON every (safe, non-sentinel) feature flag
 * by driving the REAL `/admin/feature-flags` Angular UI with headless Chromium
 * against PRODUCTION. This is NOT a SQL write: every enable goes through the
 * operator UI's "Enable globally" button + the dangerous-change confirm panel,
 * so the run also DOGFOODS that the flag UI (and its confirm flow) works end to
 * end on prod.
 *
 * Seam (homepage-start convention, mirrors `fire70-money-path.e2e.ts`): the ONE
 * sanctioned `goto` after first load is the real test-login seam
 * `/signin?test=1` → secret-gated `POST /api/auth/test-login`
 * (`E2E_TEST_PASSWORD`). A raw curl to that endpoint is intercepted by
 * Cloudflare's "Just a moment…" bot challenge — a real browser passes it
 * transparently, which is exactly why this must be browser-driven. The seam's
 * one identity is `brian@megabyte.space`, which resolves `is_super_admin:true`
 * (verified live) — required because the FF component only merges the
 * super-admin override state + renders real toggle state when `isSuperAdmin()`.
 *
 * Ground-truth selectors (read from the deployed component source — never
 * guessed): `feature-flags.component.ts` +
 * `feature-flags/flag-logic.ts#classifyChange`.
 *  - heading            `[data-testid="ff-layer-heading"]`
 *  - a flag card        `li.ff-card` (`[data-testid="flag-row"]`), `data-stage`
 *  - "N on" counter     `enabledCount()` rolling counter inside `.ff-sub`
 *  - Enable button      `.ff-btn-primary` — label "Enable globally" when off,
 *                       "Always on" (disabled) for a `core_*` sentinel, "Disable
 *                       globally" when already on.
 *  - confirm panel      `[data-testid="ff-danger-panel"]` with
 *                       `[data-testid="ff-danger-reason"]` (needs ≥4 chars) +
 *                       `[data-testid="ff-danger-confirm"]`.
 *  - coherence block    `[data-testid="ff-coherence"]` (Advanced-mode warnings;
 *                       `crdt_coedit` requires `tenant_hot_state`).
 *
 * Why EVERY enable hits the confirm panel: `classifyChange` returns 'dangerous'
 * for any `enabled:false → true` transition (flag-logic.ts:37), and `toggle()`
 * sends `{enabled_globally:true, rollout_pct:100}`. So enabling at rollout 100
 * is inherently a dangerous change → the panel is mandatory, not optional.
 *
 * Mutation route the UI calls: `POST /api/super-admin/feature-flags`
 * `{key, enabled_globally, rollout_pct, kill_switch?, reason}` → prod D1 +
 * KV invalidate. (The CLAUDE doc's `/:key/override` is the older route; the live
 * component posts to `/api/super-admin/feature-flags`.)
 *
 * SAFETY HOLDS (never enabled here — each would arm a REAL external action that
 * is NOT additionally secret-gated; see registry descriptions):
 *  - `voice_numbers`        — gates POST /api/voice/numbers/purchase, which buys
 *                             a LIVE Twilio phone number (real carrier money,
 *                             irreversible). The flag IS the money guard;
 *                             enabling it removes the protection.
 *  - `abandoned_build_nudge`— arms a LIVE cron (wired in index.ts scheduled();
 *                             prod crons active) that emails real site owners.
 *                             Real outbound outreach with no extra secret gate.
 * Every other off flag is inert-until-user-action or needs a provider key
 * (`lead_enrichment_paid` ⇒ `LEAD_ENRICHMENT_API_KEY`) / only fires on a real
 * form submit (`lead_notifications`) / 404s dark until a user calls it — safe to
 * enable; they stay inert. The list is data-driven from the live merged state,
 * so a newly-added off flag is covered automatically (minus the explicit holds).
 *
 * Env: `E2E_TEST_PASSWORD` (required — skips whole describe when absent, like
 * every sibling prod `.e2e.ts`). `PROD_URL` optional (default prod).
 */
import { test, expect, type Page } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const SCREEN_DIR = 'e2e/screenshots/enable-all-flags';

/**
 * Flags held back for safety — enabling any of these would arm a real,
 * irreversible external action that is NOT additionally secret-gated.
 */
const SAFETY_HOLDS = new Set<string>(['voice_numbers', 'abandoned_build_nudge']);

/** The seam's one hardcoded identity (`src/services/auth.ts` TEST_LOGIN_EMAIL). */
const TEST_LOGIN_EMAIL = 'brian@megabyte.space';

/** Known-benign third-party/analytics noise every sibling prod journey allowlists. */
const BENIGN_CONSOLE =
  /posthog|sentry|analytics|gtag|cloudflareinsights|favicon|net::ERR_|Failed to load resource|status of 4/i;

let stepNo = 0;
async function shot(page: Page, name: string): Promise<void> {
  stepNo += 1;
  await page
    .screenshot({ path: `${SCREEN_DIR}/${String(stepNo).padStart(2, '0')}-${name}.png`, fullPage: false })
    .catch(() => undefined);
}

/** Read the merged UI state (registry ∪ super-admin overrides) AS the browser. */
async function readMergedState(page: Page): Promise<{
  total: number;
  onCount: number;
  offNonSentinel: { key: string; stage: string }[];
  sentinels: string[];
}> {
  return page.evaluate(async () => {
    const raw = localStorage.getItem('ps_session');
    const token = raw ? (JSON.parse(raw).token as string) : null;
    const [regRes, saRes] = await Promise.all([
      fetch('/api/feature-flags').then((r) => r.json()),
      fetch('/api/super-admin/feature-flags', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }).then((r) => r.json()),
    ]);
    type Reg = { key: string; stage: string; default_enabled: boolean; default_rollout_percent: number };
    type Ov = { key: string; enabled_globally: number | boolean; rollout_pct: number; kill_switch: number | boolean };
    const reg: Reg[] = regRes.flags ?? [];
    const byKey = new Map<string, Ov>((saRes.flags ?? []).map((o: Ov) => [o.key, o]));
    const merged = reg.map((f) => {
      const o = byKey.get(f.key);
      return {
        key: f.key,
        stage: f.stage,
        enabled: o ? !!(o.enabled_globally === true || o.enabled_globally === 1) : f.default_enabled,
        kill: o ? !!(o.kill_switch === true || o.kill_switch === 1) : false,
      };
    });
    const resolvedOn = (m: { enabled: boolean; kill: boolean }): boolean => !m.kill && m.enabled;
    const sentinel = (k: string): boolean => k.startsWith('core_');
    return {
      total: merged.length,
      onCount: merged.filter(resolvedOn).length,
      offNonSentinel: merged
        .filter((m) => !resolvedOn(m) && !sentinel(m.key))
        .map((m) => ({ key: m.key, stage: m.stage })),
      sentinels: merged.filter((m) => sentinel(m.key)).map((m) => m.key),
    };
  });
}

/** Sign in through the real test-login seam; assert a super-admin session. */
async function signIn(page: Page): Promise<void> {
  await page.goto(`${PROD_URL}/signin?test=1`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('test-signin-panel')).toBeVisible();
  await page.getByTestId('test-signin-password').fill(process.env.E2E_TEST_PASSWORD!);
  await page.getByTestId('test-signin-submit').click();
  await expect(page).toHaveURL(/\/admin/);
  const me = await page.evaluate(async () => {
    const token = JSON.parse(localStorage.getItem('ps_session')!).token as string;
    const r = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    const j = (await r.json().catch(() => ({}))) as { data?: Record<string, unknown> };
    const m = j.data ?? {};
    return { status: r.status, email: m.email as string, isSuper: m.is_super_admin as boolean };
  });
  expect(me.status, 'session must resolve 200 after real sign-in').toBe(200);
  expect(me.email).toBe(TEST_LOGIN_EMAIL);
  expect(me.isSuper, 'the FF UI only renders real toggle state for a super-admin').toBe(true);
}

test.describe('Enable every safe feature flag via the real /admin/feature-flags UI', () => {
  test.skip(
    !process.env.E2E_TEST_PASSWORD,
    'needs E2E_TEST_PASSWORD for the real /signin?test=1 → /api/auth/test-login seam',
  );

  test('operator enables all non-sentinel, non-held flags globally at 100% through the UI', async ({ page }) => {
    test.setTimeout(600_000); // up to ~33 UI enables, each a confirm-panel round-trip on live edge

    const adminErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (BENIGN_CONSOLE.test(t)) return;
      const src = m.location()?.url ?? '';
      if (/editor\.projectsites\.dev/i.test(src)) return; // cross-origin editor iframe, not ours
      adminErrors.push(t);
    });

    // ── 1. Real sign-in (super-admin). ─────────────────────────────────────
    await signIn(page);
    await shot(page, 'admin-landed');

    // ── 2. Enter the Feature Flags surface (sanctioned nav; the nav testid is
    //      collapse-proof but a direct route is the operator's deep link). ──
    await page.goto(`${PROD_URL}/admin/feature-flags`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('app-admin-feature-flags')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="ff-layer-heading"]')).toBeVisible();
    // Let the async registry + super-admin merge settle (the file-wide flake class).
    await expect.poll(() => page.locator('li.ff-card').count(), { timeout: 15_000 }).toBeGreaterThan(50);
    await shot(page, 'flags-loaded');

    // ── 3. Ground-truth BEFORE: the merged state the UI renders. ───────────
    const before = await readMergedState(page);
    const toEnable = before.offNonSentinel.filter((f) => !SAFETY_HOLDS.has(f.key));
    const held = before.offNonSentinel.filter((f) => SAFETY_HOLDS.has(f.key)).map((f) => f.key);
    // eslint-disable-next-line no-console
    console.warn(
      `[enable-all] BEFORE: total=${before.total} on=${before.onCount} ` +
        `sentinels=${before.sentinels.length} offNonSentinel=${before.offNonSentinel.length} ` +
        `→ enabling=${toEnable.length} held=[${held.join(', ')}]`,
    );

    // ── 4. Enable each flag through the UI. Every enable is a 'dangerous'
    //      change (classifyChange: false→true), so the confirm panel is
    //      MANDATORY. We detect it, type a reason, confirm. If Advanced-mode
    //      coherence BLOCKS an enable, we record it rather than fighting it. ─
    const result = {
      enabled: [] as string[],
      coherenceBlocked: [] as { key: string; reason: string }[],
      failed: [] as { key: string; reason: string }[],
    };

    for (const { key } of toEnable) {
      // Filter to the single flag by key so its card is the only one in view —
      // the search box filters by key (component `filtered()`), avoiding any
      // ambiguity from 80+ cards / name collisions.
      const search = page.locator('input[type="search"][aria-label="Search feature flags"]');
      await search.fill(key);
      const card = page.locator('li.ff-card').filter({ has: page.getByRole('button', { name: `Copy flag key ${key}` }) });
      await expect(card, `card for ${key} should render after filter`).toHaveCount(1, { timeout: 8_000 });

      const enableBtn = card.locator('.ff-btn-primary');
      const label = (await enableBtn.textContent())?.trim() ?? '';
      if (/Always on/i.test(label)) {
        // Shouldn't happen (sentinels excluded) — defensive.
        continue;
      }
      if (/Disable globally/i.test(label)) {
        // Already on (raced to on by a prior iteration's reload) — count as enabled.
        result.enabled.push(key);
        continue;
      }

      // Click "Enable globally". Every enable is a 'dangerous' change, so the
      // confirm panel opens via a zoneless signal write (needs a microtask —
      // a synchronous isVisible() races it, so we WAIT with a retrying
      // expect.poll for whichever settles first: the panel, a coherence block,
      // or the button flipping to "Disable globally").
      await enableBtn.click();

      const panel = page.locator('[data-testid="ff-danger-panel"]');
      const coherence = page.locator('[data-testid="ff-coherence"]');
      let outcome: 'panel' | 'coherence' | 'applied' | 'none' = 'none';
      await expect
        .poll(
          async () => {
            if (await panel.isVisible().catch(() => false)) return (outcome = 'panel');
            if (await coherence.isVisible().catch(() => false)) return (outcome = 'coherence');
            const lbl = (await enableBtn.textContent().catch(() => ''))?.trim() ?? '';
            if (/Disable globally/i.test(lbl)) return (outcome = 'applied');
            return 'none';
          },
          { timeout: 8_000, intervals: [150, 300, 500] },
        )
        .not.toBe('none')
        .catch(() => undefined);

      if (outcome === 'coherence') {
        const msg = (await coherence.textContent())?.replace(/\s+/g, ' ').trim() ?? 'coherence block';
        result.coherenceBlocked.push({ key, reason: msg.slice(0, 160) });
        continue;
      }
      if (outcome === 'applied') {
        // Non-dangerous direct apply (shouldn't happen for an enable, but honest).
        result.enabled.push(key);
        continue;
      }
      if (outcome === 'none') {
        result.failed.push({ key, reason: 'no confirm panel, no coherence block, no state change' });
        continue;
      }

      // Type the audit reason (≥4 chars) + confirm.
      await page.getByTestId('ff-danger-reason').fill(`Brian directive: enable ${key} globally (dogfood FF UI).`);
      const confirmBtn = page.getByTestId('ff-danger-confirm');
      await expect(confirmBtn).toBeEnabled();

      // Wait for the actual mutation POST so we read real server truth, not optimism.
      const [resp] = await Promise.all([
        page
          .waitForResponse(
            (r) =>
              r.url().includes('/api/super-admin/feature-flags') && r.request().method() === 'POST',
            { timeout: 20_000 },
          )
          .catch(() => null),
        confirmBtn.click(),
      ]);

      await expect(panel, 'confirm panel closes after a committed change').toBeHidden({ timeout: 10_000 });

      if (resp && resp.ok()) {
        result.enabled.push(key);
      } else if (resp) {
        result.failed.push({ key, reason: `POST ${resp.status()}` });
      } else {
        // No POST captured — fall back to reading the card's resolved state.
        const after = (await enableBtn.textContent())?.trim() ?? '';
        if (/Disable globally/i.test(after)) result.enabled.push(key);
        else result.failed.push({ key, reason: 'no POST observed, state unchanged' });
      }
    }

    await page.locator('input[type="search"][aria-label="Search feature flags"]').fill('');
    await shot(page, 'after-enables');

    // ── 5. Ground-truth AFTER (reconcile display-vs-store). Re-read the merged
    //      state from the API, and the UI "N on" rolling counter. ───────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('app-admin-feature-flags')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.locator('li.ff-card').count(), { timeout: 15_000 }).toBeGreaterThan(50);
    const after = await readMergedState(page);

    // The header "N on" counter the operator actually sees.
    const counterText = (await page.locator('.ff-sub').innerText()).replace(/\s+/g, ' ');
    const uiOnMatch = counterText.match(/(\d+)\s*on\./i);
    const uiOnCount = uiOnMatch ? Number(uiOnMatch[1]) : -1;

    const stillOff = after.offNonSentinel.map((f) => f.key);
    const stillOffUnexpected = stillOff.filter((k) => !SAFETY_HOLDS.has(k));

    // eslint-disable-next-line no-console
    console.warn(
      `[enable-all] RESULT ${JSON.stringify({
        total: after.total,
        onCount_api: after.onCount,
        onCount_uiCounter: uiOnCount,
        sentinels: after.sentinels.length,
        newlyEnabled: result.enabled.length,
        newlyEnabledKeys: result.enabled,
        coherenceBlocked: result.coherenceBlocked,
        failed: result.failed,
        heldForSafety: held,
        stillOffNonSentinel: stillOff,
      })}`,
    );
    await shot(page, 'final-state');

    // ── 6. Assertions. ─────────────────────────────────────────────────────
    // (a) No same-origin admin console errors across the whole run (UI health).
    expect(adminErrors, `admin console errors: ${adminErrors.join(' | ')}`).toHaveLength(0);

    // (b) The UI "N on" counter reconciles with the API ground-truth (±0 — the
    //     component derives both from the same merged state).
    if (uiOnCount >= 0) {
      expect(uiOnCount, 'UI "N on" counter must match API-resolved on-count').toBe(after.onCount);
    }

    // (c) Monotonic progress: on-count never regressed.
    expect(after.onCount, 'on-count must not regress').toBeGreaterThanOrEqual(before.onCount);

    // (d) Honest completion: every flag NOT explicitly held is now ON. Any flag
    //     that stayed off for a reason OTHER than a safety hold is surfaced
    //     (coherence block is an acceptable, recorded non-failure; a bare
    //     unexplained off-flag fails the gate so we never claim a false "all on").
    const blockedKeys = new Set(result.coherenceBlocked.map((c) => c.key));
    const unexplainedOff = stillOffUnexpected.filter((k) => !blockedKeys.has(k));
    expect(
      unexplainedOff,
      `flags still OFF with no safety-hold or coherence-block reason: ${unexplainedOff.join(', ')}`,
    ).toHaveLength(0);

    // (e) The safety holds must INDEED still be off (we must not have enabled them).
    for (const k of Array.from(SAFETY_HOLDS)) {
      if (before.offNonSentinel.some((f) => f.key === k)) {
        expect(stillOff, `${k} must remain OFF (safety hold)`).toContain(k);
      }
    }
  });
});
