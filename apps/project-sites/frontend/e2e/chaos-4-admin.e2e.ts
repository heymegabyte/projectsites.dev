/**
 * CHAOS 4 — "The Power Admin": authed full-dashboard sweep.
 *
 * Homepage-first, seeds a real `ps_session` from E2E_API_KEY, then walks EVERY
 * admin section asserting each renders alive with no pageerror / no 5xx / no
 * injected-script execution. Then hammers a couple of interactive surfaces.
 * Skips if E2E_API_KEY is absent (fork/secret-less runs).
 *
 * ⚠️ Does NOT touch the sidebar/admin-shell owned by a concurrent session — it
 * only navigates section ROUTES and reads state.
 */
import { test, expect } from '@playwright/test';
import { trackErrors, assertAlive, seedAuth } from './chaos-helpers';

const KEY = process.env.E2E_API_KEY ?? '';

// Section routes (navigate directly; the shell mounts each lazily). EVERY entry
// MUST be a real registered admin child route in app.routes.ts — a route with no
// child renders the admin not-found component, which the render-sweep's assertAlive
// (page has text) CANNOT distinguish from a real section. The `admin-not-found`
// guard below fails on any such dead-end. `/admin/sites` + `/admin/media` were
// REMOVED here (2026-08-16): neither is a registered bare route (only `sites/:id`
// exists; media lived in the reverted admin-v2) so both silently rendered the 404.
const SECTIONS = [
  '/admin',
  '/admin/editor', // the bolt+WebContainer+AI surface — omitted for 20+ fires; render-swept here, INTERACTION-swept by chaos-15 (the editor AI round-trip)
  '/admin/analytics',
  '/admin/domains',
  '/admin/social',
  '/admin/voice',
  '/admin/billing',
  '/admin/settings',
  '/admin/feature-flags',
  '/admin/seo',
  '/admin/docs',
  '/admin/apps',
  '/admin/mcp',
  '/admin/audit',
  '/admin/snapshots',
  // Real registered sections the prior sweep never covered (coverage expansion):
  '/admin/api-tokens',
  '/admin/forms',
  '/admin/site-features',
  '/admin/deliverability',
  '/admin/logs',
  '/admin/team',
  '/admin/auth-security',
  '/admin/user',
];

test.describe('CHAOS 4 — Power Admin (authed dashboard sweep)', () => {
  test.beforeEach(() => {
    test.skip(!KEY, 'E2E_API_KEY not set');
  });

  for (const route of SECTIONS) {
    test(`section ${route} renders alive — no pageerror / 5xx / XSS`, async ({ page }) => {
      const e = trackErrors(page);
      await seedAuth(page, KEY);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500); // Angular lazy chunk + data fetch
      await assertAlive(page);
      // Dead-end guard: a route with no registered child renders the admin
      // not-found component — which assertAlive (text present) passes. This asserts
      // the swept route mounted a REAL section, not the cockpit 404.
      const deadEnd = await page
        .locator('[data-testid="admin-not-found"]')
        .isVisible()
        .catch(() => false);
      expect(deadEnd, `${route} is a DEAD-END — renders the admin 404, not a real section`).toBe(
        false,
      );
      if (
        e.consoleErrors.length ||
        e.pageErrors.length ||
        e.serverErrors.length ||
        e.consoleWarnings.length
      ) {
        console.log(
          `CHAOS4 ${route}:`,
          JSON.stringify({
            err: e.consoleErrors,
            warn: e.consoleWarnings,
            asset404: e.notFoundAssets,
            pageerr: e.pageErrors,
            s5xx: e.serverErrors,
          }),
        );
      }
      expect(await e.xssFired(), `no injected script on ${route}`).toBe(false);
      expect(e.pageErrors, `${route} pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `${route} 5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `${route} console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
      expect(
        e.consoleWarnings,
        `${route} console warnings (mission DoD = 0): ${e.consoleWarnings.join('; ')}`,
      ).toEqual([]);
      expect(
        e.notFoundAssets,
        `${route} missing same-origin assets (404): ${e.notFoundAssets.join('; ')}`,
      ).toEqual([]);
    });
  }

  test('settings form: hostile input round-trip does not crash or 5xx', async ({ page }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const inputs = page.locator('input[type="text"], input:not([type]), textarea');
    const n = Math.min(await inputs.count(), 6);
    for (let i = 0; i < n; i++) {
      const inp = inputs.nth(i);
      if (!(await inp.isVisible().catch(() => false))) continue;
      if (await inp.isDisabled().catch(() => true)) continue;
      await inp.fill('<script>window.__xss__=1</script>А'.repeat(50)).catch(() => {});
      await page.waitForTimeout(150);
    }
    await assertAlive(page);
    expect(await e.xssFired(), 'settings did not execute injected script').toBe(false);
    expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
  });

  test('settings tabs: switching every lazy sub-view stays error-free', async ({ page }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    // The settings surface is tabbed; each tab mounts a DISTINCT lazy sub-view
    // (a different data fetch + component). A render-only sweep never enters them
    // — press every tab and assert none logs an app error / warn / 5xx / pageerror.
    const TABS = [
      'Team',
      'AI Chat',
      'MCP',
      'AI Env Vars',
      'Webhooks',
      'Email',
      'Domains',
      'API Tokens',
      'General',
    ];
    let switched = 0;
    for (const label of TABS) {
      const tab = page
        .getByRole('tab', { name: label })
        .or(page.locator(`button:has-text("${label}"), [role="tab"]:has-text("${label}")`))
        .first();
      if (!(await tab.isVisible().catch(() => false))) continue;
      await tab.click({ timeout: 3000 }).catch(() => {});
      switched++;
      await page.waitForTimeout(600); // lazy chunk + data fetch
      await assertAlive(page);
    }
    console.log(`CHAOS4/settings-tabs switched ${switched}/${TABS.length}`);
    // Selector drift guard: if fewer than 3 tabs were reachable the surface changed.
    expect(switched, 'settings tabs reachable').toBeGreaterThan(2);
    expect(await e.xssFired(), 'no injected script on tab switches').toBe(false);
    expect(e.pageErrors, `tab pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
    expect(e.serverErrors, `tab 5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
    expect(e.consoleErrors, `tab console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
    expect(
      e.consoleWarnings,
      `tab console warnings (DoD=0): ${e.consoleWarnings.join('; ')}`,
    ).toEqual([]);
    expect(e.notFoundAssets, `tab missing assets (404): ${e.notFoundAssets.join('; ')}`).toEqual(
      [],
    );
  });

  // M2 — Settings › General business identity round-trips to the SERVER. The
  // render/tab sweeps never SAVE. saveGeneral writes business_phone via
  // api.updateSite (site record) then calls state.loadData(); loadGeneral reads it
  // back from selectedSite() (i.e. GET /api/sites). Code analysis says the read
  // source = the write source — but only a live prod run proves the full
  // updateSite → /api/sites → loadGeneral round-trip actually persists (verify-
  // against-source-of-truth: correct-looking wiring ≠ a working server round-trip).
  // Mutate → nav away → return → HARD RELOAD → assert the server echoed it, then
  // restore the original value (the E2E org's site is left unchanged).
  test('Settings › General business phone round-trips to the SERVER (save → nav → hard-reload → restore)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);

    const openGeneral = async (): Promise<void> => {
      const tab = page
        .getByRole('tab', { name: 'General' })
        .or(page.locator('[role="tab"]:has-text("General"), button:has-text("General")'))
        .first();
      if (await tab.isVisible().catch(() => false)) {
        await tab.click().catch(() => {});
        await page.waitForTimeout(700);
      }
    };

    await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await openGeneral();

    const phone = page.locator('[data-testid="business-phone"]');
    // The General identity form only renders when the org has a selected site.
    await expect(
      phone,
      'Settings › General business form must be reachable (E2E org has a site)',
    ).toBeVisible({ timeout: 15_000 });

    const original = await phone.inputValue();
    const testVal = `+1555${Date.now().toString().slice(-7)}`;
    const save = page.locator('[data-testid="general-save"]');

    await phone.fill(testVal);
    await expect(save, 'Save un-disables when the form is dirty').toBeEnabled({ timeout: 5000 });
    await save.click();
    await expect(page.getByText(/^Saved$/i).first()).toBeVisible({ timeout: 15_000 });

    // Navigate away → return: the value survives an in-app route change (loadData).
    await page.goto('/admin/analytics', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await openGeneral();
    await expect(
      page.locator('[data-testid="business-phone"]'),
      'business_phone did not survive an in-app navigation',
    ).toHaveValue(testVal, { timeout: 10_000 });

    // HARD RELOAD: proves the value came from the SERVER (GET /api/sites), not
    // in-memory admin state — the write-only / lying-success guard.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await openGeneral();
    await expect(
      page.locator('[data-testid="business-phone"]'),
      'business_phone did NOT persist to the server (write-only / lying-success)',
    ).toHaveValue(testVal, { timeout: 12_000 });

    // Restore the original value so the E2E org's site record is left unchanged.
    const phone2 = page.locator('[data-testid="business-phone"]');
    await phone2.fill(original);
    await expect(save).toBeEnabled({ timeout: 5000 });
    await save.click();
    await page
      .getByText(/^Saved$/i)
      .first()
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {});

    expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
    expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
    expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
  });

  // M2 — Settings › AI Chat system prompt round-trips to the SERVER. The tab sweep
  // enters the AI Chat tab but never SAVES; this drives the per-site `ai-settings`
  // PUT → GET round-trip (chat_system_prompt), the persistence surface for the AI
  // concierge on every published site. Mutate → SAVE (assert PUT 200) → nav away →
  // return → HARD RELOAD → assert the server echoed the prompt back (not a lying
  // local-only save), then RESTORE the original so the E2E org's site is unchanged.
  test('Settings › AI Chat system prompt round-trips to the SERVER (save → nav → hard-reload → restore) (M2)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const openChatTab = async (): Promise<void> => {
      const tab = page
        .getByRole('tab', { name: 'AI Chat' })
        .or(page.locator('[role="tab"]:has-text("AI Chat"), button:has-text("AI Chat")'))
        .first();
      if (await tab.isVisible().catch(() => false)) {
        await tab.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1200);
      }
    };
    // Prefer the testid; fall back to the class so the guard is green whether or
    // not the testid deploy has propagated yet.
    const promptBox = page
      .locator('[data-testid="ai-chat-system-prompt"], textarea.ai-chat-textarea')
      .first();
    const saveBtn = page
      .locator('[data-testid="ai-chat-save"]')
      .or(page.getByRole('button', { name: /Save AI Chat settings/i }))
      .first();

    await openChatTab();
    // If the AI Chat surface isn't reachable for this org, don't vacuously pass —
    // but the tab exists for every authed org, so require the textarea.
    await expect(promptBox, 'AI Chat system-prompt textarea is reachable').toBeVisible({
      timeout: 10_000,
    });
    const original = await promptBox.inputValue();
    const marker = `chaos-aichat-${Date.now()}`;
    const newPrompt = `${marker}\nYou are a concise concierge. Never invent prices.`;

    await promptBox.fill(newPrompt);
    const putP = page
      .waitForResponse((r) => r.url().includes('/ai-settings') && r.request().method() === 'PUT', {
        timeout: 15_000,
      })
      .catch(() => null);
    await saveBtn.click();
    const put = await putP;
    expect(put?.status(), 'ai-settings PUT should be 200').toBe(200);
    await page.waitForTimeout(1200);

    // Navigate away, then HARD RELOAD the settings surface (fresh GET).
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    await openChatTab();
    await expect(promptBox).toBeVisible({ timeout: 10_000 });
    const persisted = await promptBox.inputValue();
    expect(
      persisted.startsWith(marker),
      `AI Chat prompt did NOT persist server-side after hard reload (got len ${persisted.length})`,
    ).toBe(true);

    // Restore the original value so the org's site is left unchanged.
    await promptBox.fill(original);
    await saveBtn.click().catch(() => {});
    await page.waitForTimeout(1200);

    expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
    expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
    expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
  });

  // M2 — the one flow the render/interaction sweeps never exercise: mutate real
  // state → navigate away → return → HARD RELOAD → verify PERSISTENCE. Uses AI Env
  // Vars (org-scoped config — the safest reversible CRUD; namespaced test key,
  // deleted via the API in `finally`). Also regression-guards the null-description
  // 400 bug (the form sends description:null for an empty description).
  test('AI Env Vars create → persists across nav + hard reload → cleanup (M2 persistence)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    const testKey = `E2E_PERSIST_${Date.now()}`;
    let createdId: string | null = null;
    try {
      await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const tab = page
        .getByRole('tab', { name: 'AI Env Vars' })
        .or(page.locator('button:has-text("AI Env Vars"), [role="tab"]:has-text("AI Env Vars")'))
        .first();
      await tab.click({ timeout: 4000 });
      await page.waitForTimeout(1500);

      // Create: Add opens the draft form; fill key + value only (no description →
      // the form posts description:null, the exact payload that used to 400).
      await page.locator('button:has-text("Add")').first().click({ timeout: 4000 });
      await page.waitForTimeout(600);
      await page.locator('input[name="key"]').first().fill(testKey);
      await page.locator('input[name="value"]').first().fill('persist-value');
      const createResp = page.waitForResponse(
        (r) => /\/api\/env-vars\b/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 12_000 },
      );
      await page
        .locator('button[type="submit"]')
        .filter({ hasNotText: /cancel/i })
        .first()
        .click({ timeout: 4000 });
      const cr = await createResp;
      expect(cr.status(), 'env var create must 200 (not 400 on null description)').toBe(200);
      const created = (await cr.json().catch(() => ({}))) as {
        var?: { id?: string };
        data?: { id?: string };
        id?: string;
      };
      // Robust across every create-response shape ({var:{id}} | {data:{id}} | {id}).
      // A null id here is exactly what skipped the finally delete on 6 prior runs →
      // 6 E2E_PERSIST_* vars leaked into the org's exposed-to-AI set (Aug 16→Sep 8).
      createdId = created.var?.id ?? created.data?.id ?? created.id ?? null;
      await expect(page.locator(`text=${testKey}`).first()).toBeVisible({ timeout: 8000 });

      // Persistence 1 — navigate away, come back, re-open the tab.
      await page.goto('/admin/sites', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      await page.goto('/admin/settings', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await tab.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await expect(
        page.locator(`text=${testKey}`).first(),
        'env var persists after nav-away + back',
      ).toBeVisible({ timeout: 8000 });

      // Persistence 2 — HARD RELOAD (fresh document, no SPA state).
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await tab.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await expect(
        page.locator(`text=${testKey}`).first(),
        'env var persists after hard reload',
      ).toBeVisible({ timeout: 8000 });

      await assertAlive(page);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
      expect(
        e.consoleWarnings,
        `console warnings (DoD=0): ${e.consoleWarnings.join('; ')}`,
      ).toEqual([]);
    } finally {
      // Always remove the created row (real D1 in the E2E org) — via the API, which
      // avoids the destructive-confirm dialog and never leaves a stray test var.
      // Belt-and-suspenders: ALSO sweep every stale E2E_PERSIST_* row (from this run if
      // id-capture missed, or any prior run) — else each miss leaks one exposed-to-AI var
      // into the org forever. Self-heals the 6 that accumulated before this guard.
      // GET shape is `{ vars: [...] }`; mirrors verify-envvars-causal.mjs's CAUSAL_ sweep.
      await page
        .evaluate(async (id: string | null) => {
          const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
          const hdr = { Authorization: `Bearer ${s.token}` };
          const del = (vid: string) =>
            fetch(`/api/env-vars/${vid}`, { method: 'DELETE', headers: hdr }).catch(() => {});
          if (id) await del(id);
          const body = await fetch('/api/env-vars', { headers: hdr })
            .then((r) => r.json())
            .catch(() => ({}));
          const rows = (Array.isArray(body) ? body : (body?.vars ?? body?.data ?? [])) as Array<{
            id?: string;
            key?: string;
          }>;
          for (const v of rows) {
            if (typeof v?.key === 'string' && v.key.startsWith('E2E_PERSIST') && v.id && v.id !== id) {
              await del(v.id);
            }
          }
        }, createdId)
        .catch(() => {});
    }
  });

  // M2 (second real CRUD) — API Tokens, flag-aware. `/api/v1-tokens` is gated on the
  // `public_api` flag; the worker returns 404 when off (doctrine: never 403). Two paths:
  //  • flag OFF (the E2E org's reality) — REGRESSION GUARD: the UI must show the graceful
  //    gate notice and MUST NOT show a create button that 404s. (The frontend detected
  //    flag-off via 503, but the worker returns 404 → the gate was dead code + a dead
  //    create button showed + a scary "Failed to load" toast fired.)
  //  • flag ON — exercise the full create → one-time reveal → persist (nav + hard reload)
  //    → revoke (cleanup via API in finally) round-trip.
  test('API Tokens: flag-off org gets the graceful gate (no dead create button), or full CRUD when enabled', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    let createdId: string | null = null;
    try {
      await page.goto('/admin/api-tokens', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500); // loadTokens() completes → flag state resolved

      const gate = page.locator('[data-testid="api-tokens-flag-gate"]');
      const createBtn = page.locator('[data-testid="at-create-open"]');
      const gateVisible = await gate.isVisible().catch(() => false);

      if (gateVisible) {
        // public_api OFF → the worker 404s the list. The graceful gate notice MUST show
        // and the create button MUST be hidden (never a dead button that 404s on click).
        expect(
          await createBtn.isVisible().catch(() => false),
          'flag-off: create button must be hidden (no dead button that 404s)',
        ).toBe(false);
      } else {
        // public_api ON → full create → reveal → persist → revoke.
        const tokenName = `E2E_CHAOS_${Date.now()}`;
        await createBtn.first().click({ timeout: 5000 });
        await page.waitForTimeout(500);
        await page.locator('[data-testid="at-name-input"]').fill(tokenName);
        const createResp = page.waitForResponse(
          (r) => /\/api\/v1-tokens\b/.test(r.url()) && r.request().method() === 'POST',
          { timeout: 12_000 },
        );
        await page.locator('[data-testid="at-create-submit"]').click({ timeout: 5000 });
        const cr = await createResp;
        expect([200, 201], `token create status ${cr.status()}`).toContain(cr.status());
        const created = (await cr.json().catch(() => ({}))) as { token?: { id?: string } };
        createdId = created.token?.id ?? null;

        await expect(page.locator('[data-testid="at-token-reveal"]')).toBeVisible({
          timeout: 8000,
        });
        const plaintext = await page.locator('[data-testid="at-token-plaintext"]').innerText();
        expect(plaintext.trim().length, 'reveal shows a non-empty token').toBeGreaterThan(10);
        await page.locator('[data-testid="at-reveal-done"]').click({ timeout: 5000 });
        await expect(page.locator(`text=${tokenName}`).first()).toBeVisible({ timeout: 8000 });

        // Persist across nav + HARD reload.
        await page.goto('/admin/analytics', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1200);
        await page.goto('/admin/api-tokens', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        await expect(page.locator(`text=${tokenName}`).first()).toBeVisible({ timeout: 8000 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        await expect(
          page.locator(`text=${tokenName}`).first(),
          'token persists after hard reload',
        ).toBeVisible({ timeout: 8000 });
      }

      await assertAlive(page);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
      expect(
        e.consoleWarnings,
        `console warnings (DoD=0): ${e.consoleWarnings.join('; ')}`,
      ).toEqual([]);
    } finally {
      if (createdId) {
        await page
          .evaluate(async (id) => {
            const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
            await fetch(`/api/v1-tokens/${id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${s.token}` },
            }).catch(() => {});
          }, createdId)
          .catch(() => {});
      }
    }
  });

  // M2 (third real CRUD) — Team invite → appears in pending → persists → cancel. Validates
  // the iter-102 auth_org hardening (invite-member seat-cap + cancel-invitation) END-TO-END
  // in a real browser. Reversible: the UI Cancel IS the cleanup (soft-deletes the invite); a
  // finally safety-net cancels via API. Seat-aware: at capacity the invite 409s, which the UI
  // shows as a graceful error (also a valid, asserted business result — never a silent success).
  test('Team: invite a member → appears in pending → persists → cancel (M2, validates auth_org)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    const inviteEmail = `e2e-invite-${Date.now()}@example.com`;
    let inviteId: string | null = null;
    // The cancel/remove flows use a native confirm() — auto-accept every dialog.
    page.on('dialog', (d) => d.accept().catch(() => {}));
    try {
      await page.goto('/admin/team', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await expect(page.locator('[data-testid="team-page"]')).toBeVisible({ timeout: 8000 });

      const row = () =>
        page.locator('[data-testid="team-invitation-row"]').filter({ hasText: inviteEmail });

      // The seat line reflects the AUTHORITATIVE cap (iter-102 surfaced the real limit,
      // not a hardcoded default). Check capacity FIRST — at the cap the invite button is
      // disabled by design, so we must NOT try to POST (a disabled click never fires).
      const seatsFull = await page
        .locator('[data-testid="team-seats-full"]')
        .isVisible()
        .catch(() => false);

      if (seatsFull) {
        // At capacity → the invite button MUST be disabled (no dead button that 409s), and
        // the seat line shows the authoritative "N of N" — the graceful, non-lying state.
        await expect(page.locator('[data-testid="team-invite-submit"]')).toBeDisabled();
        await expect(page.locator('[data-testid="team-seats"]')).toContainText(/seats used/i);
      } else {
        await page.locator('[data-testid="team-invite-email"]').fill(inviteEmail);
        const inviteResp = page.waitForResponse(
          (r) =>
            /\/api\/auth\/organization\/invite-member\b/.test(r.url()) &&
            r.request().method() === 'POST',
          { timeout: 12_000 },
        );
        await page.locator('[data-testid="team-invite-submit"]').click({ timeout: 5000 });
        const ir = await inviteResp;

        if (ir.status() === 409) {
          await expect(page.locator('[data-testid="team-error"]')).toBeVisible({ timeout: 6000 });
          await expect(row()).toHaveCount(0);
        } else {
          expect([200, 201], `invite status ${ir.status()}`).toContain(ir.status());
          inviteId = ((await ir.json().catch(() => ({}))) as { id?: string }).id ?? null;

          // Business result: the invite appears in the pending list.
          await expect(row(), 'invite appears in pending').toHaveCount(1, { timeout: 8000 });

          // Persist across nav + HARD reload.
          await page.goto('/admin/analytics', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(1000);
          await page.goto('/admin/team', { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2500);
          await expect(row(), 'invite persists after nav-away + back').toHaveCount(1, {
            timeout: 8000,
          });
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2500);
          await expect(row(), 'invite persists after hard reload').toHaveCount(1, {
            timeout: 8000,
          });

          // Cancel (the primary reversible action) — the row's Cancel button.
          await row().locator('[data-testid="team-invitation-cancel"]').click({ timeout: 5000 });
          await expect(row(), 'invite removed after cancel').toHaveCount(0, { timeout: 8000 });
          inviteId = null; // cancelled via UI → finally cleanup not needed
        }
      }

      await assertAlive(page);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
      expect(
        e.consoleWarnings,
        `console warnings (DoD=0): ${e.consoleWarnings.join('; ')}`,
      ).toEqual([]);
    } finally {
      if (inviteId) {
        await page
          .evaluate(async (id) => {
            const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
            await fetch('/api/auth/organization/cancel-invitation', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` },
              body: JSON.stringify({ invitationId: id }),
            }).catch(() => {});
          }, inviteId)
          .catch(() => {});
      }
    }
  });

  // M2 (third real edit→persist) — Social Auto-Pilot config. The `Auto-Pilot prompt`
  // dialog edits the org-scoped composer config (cadence / prompt / networks) via
  // `POST /api/social/auto-pilot/config` = worker `upsertAutoPilotConfig`, which was
  // hardened iter-107 to THROW on a dropped D1 write instead of returning a lying
  // "saved". This journey proves the round-trip end-to-end: open dialog → change
  // cadence → Save → 200 → HARD RELOAD → reopen → the new cadence PERSISTED. Also
  // presses the AI "Generate preview" button and asserts it never 5xxes. Self-cleaning:
  // restores the original cadence via the API in `finally`.
  test('Social Auto-Pilot: edit cadence → save → persists across hard reload; preview button no 5xx (M2, validates iter-107)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    let original: string | null = null;
    try {
      await page.goto('/admin/social', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000); // Angular lazy chunk + accounts/config/posts fetch

      const openBtn = page.locator('[data-testid="social-auto-pilot-prompt-btn"]');
      await expect(openBtn, 'auto-pilot dialog trigger present').toBeVisible({ timeout: 8000 });
      await openBtn.click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 6000 });

      // The dialog's first <select> is CADENCE. Capture the current value, flip it.
      const cadence = dialog.locator('select').first();
      original = await cadence.inputValue();
      const options = await cadence
        .locator('option')
        .evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value));
      const target = options.find((o) => o !== original);
      expect(target, 'cadence has ≥2 options to flip between').toBeTruthy();

      await cadence.selectOption(target!);
      const saveResp = page.waitForResponse(
        (r) => /\/api\/social\/auto-pilot\/config/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 12_000 },
      );
      await dialog.getByRole('button', { name: 'Save' }).first().click();
      const sr = await saveResp;
      expect(sr.status(), 'auto-pilot config save must 200 (iter-107: never a lying save)').toBe(
        200,
      );

      // Persistence — HARD RELOAD (fresh document), reopen the dialog, assert the new
      // cadence stuck. This is the real proof the write hit D1, not just optimistic UI.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(4000);
      await openBtn.click({ timeout: 8000 });
      await expect(dialog).toBeVisible({ timeout: 6000 });
      const after = await dialog.locator('select').first().inputValue();
      expect(after, 'cadence persisted across hard reload').toBe(target);

      // Press the AI "Generate preview" button — a meaningful action that calls the
      // model. It may take a while or degrade gracefully (0 connected accounts), but
      // it must NEVER 5xx. We don't block on the (slow) LLM response.
      const preview = dialog.getByRole('button', { name: 'Generate preview' });
      if (await preview.isVisible().catch(() => false)) {
        await preview.click().catch(() => {});
        await page.waitForTimeout(2500);
      }

      await assertAlive(page);
      expect(await e.xssFired(), 'no injected script on the auto-pilot flow').toBe(false);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
      expect(
        e.consoleWarnings,
        `console warnings (DoD=0): ${e.consoleWarnings.join('; ')}`,
      ).toEqual([]);
    } finally {
      // Restore the original cadence via the API (org-scoped, bearer-authed) so the
      // shared E2E org is left exactly as found — no destructive dialog needed.
      if (original) {
        const hours = Number(original.split(':').pop()?.trim());
        if (Number.isFinite(hours)) {
          await page
            .evaluate(async (h) => {
              const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
              await fetch('/api/social/auto-pilot/config', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${s.token}`,
                },
                body: JSON.stringify({ cadence_hours: h }),
              }).catch(() => {});
            }, hours)
            .catch(() => {});
        }
      }
    }
  });

  // M2 — the Social composer's honest-validation + draft-preservation contract.
  // The E2E org has 0 connected accounts, so "Post now" cannot publish. Pressing it
  // must give HONEST feedback ("select a platform") — not a dead button, not a 5xx —
  // and must NOT wipe the draft the user just typed (a failed submit preserves work).
  // "Discard" then clears the composer. Presses 2 real compose buttons + asserts the
  // business result of each, with the full console/network DoD.
  test('Social composer: Post-now with no platform validates honestly + preserves the draft; Discard clears it (M2)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    await page.goto('/admin/social', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    const composer = page.locator('[data-testid="social-composer-textarea"]');
    await expect(composer, 'composer textarea present').toBeVisible({ timeout: 8000 });
    const draft = 'Grand opening this Saturday — fresh coffee on the house. See you there!';
    await composer.fill(draft);

    // Press "Post now" with no platform selected (0 connected accounts).
    await page.getByRole('button', { name: 'Post now', exact: false }).first().click();
    await page.waitForTimeout(2500);

    // Business result: honest validation message (not a dead button, not a silent no-op).
    await expect(
      page.locator('text=/select .* platform|connect .* account|at least one/i').first(),
      'Post-now with no platform shows an honest "select a platform" message',
    ).toBeVisible({ timeout: 6000 });
    // Draft preserved — a failed submit must not wipe the user's typed content.
    expect(await composer.inputValue(), 'composer draft survives a failed post').toBe(draft);

    // "Discard" is an action-armed confirm toast (cockpit pattern), not a one-click
    // wipe: pressing it prompts "Discard this post?" with a Discard action that runs
    // resetComposer(). Press it, confirm via the toast action, assert the draft clears.
    await page.getByRole('button', { name: 'Discard', exact: false }).first().click();
    const confirmToast = page
      .locator('[data-testid="toast-item"]')
      .filter({ hasText: /discard this post/i });
    await expect(confirmToast, 'Discard prompts an action-armed confirm toast').toBeVisible({
      timeout: 6000,
    });
    await confirmToast.locator('button.toast-action').first().click();
    await expect(composer, 'confirming Discard clears the composer draft').toHaveValue('', {
      timeout: 6000,
    });

    await assertAlive(page);
    expect(await e.xssFired(), 'no injected script in the composer flow').toBe(false);
    expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
    expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
    expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
    expect(e.consoleWarnings, `console warnings (DoD=0): ${e.consoleWarnings.join('; ')}`).toEqual(
      [],
    );
  });

  // M2 — cross-device display-name PERSISTENCE (the read-back half). The name saves
  // to BOTH the server (PATCH /api/admin/profile) + localStorage (local-first). The
  // server value must ALSO drive the UI on a FRESH device where localStorage is empty
  // — else the saved name silently reverts to the email-derived default (the server
  // has it, the UI never reads it). Presses Save, asserts the PATCH 2xx + "Saved"
  // affordance + heading, then a local-first reload, then simulates a new device
  // (clears the local cache) and asserts the reload shows the SAVED name from
  // /api/auth/me — not "Test". Restores the original server name in `finally`.
  test('User profile: display name round-trips to the server + shows on a fresh device (M2 persistence)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);

    // App-context fetch (real browser fingerprint → not Bot-Fight challenged, unlike
    // Playwright's `request`) to read + restore the server-persisted name.
    const readServerName = (): Promise<string | null> =>
      page.evaluate(async () => {
        const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
        const r = await fetch('/api/auth/me', { headers: { Authorization: `Bearer ${s.token}` } });
        const j = (await r.json().catch(() => ({}))) as { data?: { display_name?: string | null } };
        return j?.data?.display_name ?? null;
      });
    const patchServerName = (name: string): Promise<void> =>
      page.evaluate(async (nm) => {
        const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
        await fetch('/api/admin/profile', {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nm }),
        }).catch(() => {});
      }, name);

    await page.goto('/admin/user', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const originalName = await readServerName();
    const testName = 'Chaos QA Persist ✓';

    try {
      const input = page.locator('[data-testid="us-display-name-input"]');
      await expect(input, 'display-name input present').toBeVisible({ timeout: 8000 });
      await input.fill(testName);

      const save = page.locator('[data-testid="us-display-name-save"]');
      await expect(save, 'Save enables for a valid name').toBeEnabled({ timeout: 4000 });
      const [patchResp] = await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/admin\/profile\b/.test(r.url()) && r.request().method() === 'PATCH',
          { timeout: 15_000 },
        ),
        save.click(),
      ]);
      expect(patchResp.status(), 'profile PATCH persists to the server (2xx)').toBeLessThan(300);

      // Business result: the "Saved" affordance + the heading updates immediately.
      await expect(
        page.locator('[data-testid="us-display-name-saved"]'),
        'shows the Saved confirmation (no silent save)',
      ).toBeVisible({ timeout: 6000 });
      await expect(
        page.locator('[data-testid="us-display-name-heading"]'),
        'heading reflects the new name',
      ).toHaveText(testName, { timeout: 6000 });

      // Local-first persistence: a hard reload (localStorage intact) keeps the name.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await expect(
        page.locator('[data-testid="us-display-name-heading"]'),
        'name survives a hard reload (local-first)',
      ).toHaveText(testName, { timeout: 8000 });

      // FRESH DEVICE: clear ONLY the local display-name cache (auth stays). The saved
      // name must come back from the server (/api/auth/me), NOT revert to the email
      // default — this is the read-back half the write-only PATCH left incomplete.
      await page.evaluate(() => localStorage.removeItem('ps_display_name'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await expect(
        page.locator('[data-testid="us-display-name-heading"]'),
        'saved name shows on a fresh device from the server (not the email-derived default)',
      ).toHaveText(testName, { timeout: 8000 });

      await assertAlive(page);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
    } finally {
      // Restore the original server name (or a neutral default) so the account stays clean.
      const restore =
        originalName && originalName.trim() && originalName !== testName ? originalName : 'Test';
      await patchServerName(restore);
    }
  });

  // M3 — notification prefs cross-device round-trip (FE toggle → debounced POST
  // /api/admin/notifications → per-user memory store → GET-hydrate on a fresh
  // device). Presses the real "Weekly summary" switch, asserts the POST 2xx + the
  // immediate flip, then a local-first reload, then simulates a NEW device (clears
  // the local cache) and waits for the hydrate GET to prove the SERVER value drives
  // the UI — not the localStorage-seeded default. Restores the state in finally.
  test('User notifications: toggle round-trips to the server + shows on a fresh device (M3)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    await page.goto('/admin/user', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const swName = /Weekly summary/i;
    const sw = page.getByRole('switch', { name: swName });
    await expect(sw, 'the Weekly-summary notification switch is present').toBeVisible({
      timeout: 8000,
    });
    const original = await sw.getAttribute('aria-checked');
    const flipped = original === 'true' ? 'false' : 'true';

    const flipAndSync = async (): Promise<void> => {
      const [postResp] = await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/admin\/notifications\b/.test(r.url()) && r.request().method() === 'POST',
          { timeout: 15_000 },
        ),
        page.getByRole('switch', { name: swName }).click(),
      ]);
      expect(postResp.status(), 'notification pref POST persists to the server (2xx)').toBeLessThan(
        300,
      );
    };

    try {
      await flipAndSync();
      await expect(sw, 'switch reflects the flipped state immediately').toHaveAttribute(
        'aria-checked',
        flipped,
        { timeout: 4000 },
      );

      // Local-first: a hard reload (localStorage intact) keeps the flipped state.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await expect(
        page.getByRole('switch', { name: swName }),
        'flipped state survives a hard reload (local-first)',
      ).toHaveAttribute('aria-checked', flipped, { timeout: 8000 });

      // FRESH DEVICE: clear ONLY the local pref cache (auth stays). The flipped
      // state must return from the server (per-user memory store) via the hydrate
      // GET — NOT revert to the localStorage-seeded default (which is `true`).
      await page.evaluate(() => localStorage.removeItem('ps_notification_prefs'));
      await Promise.all([
        page.waitForResponse(
          (r) => /\/api\/admin\/notifications\b/.test(r.url()) && r.request().method() === 'GET',
          { timeout: 15_000 },
        ),
        page.reload({ waitUntil: 'domcontentloaded' }),
      ]);
      await expect(
        page.getByRole('switch', { name: swName }),
        'flipped state hydrates from the server on a fresh device (not the default)',
      ).toHaveAttribute('aria-checked', flipped, { timeout: 8000 });

      await assertAlive(page);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
    } finally {
      // Restore the original toggle state (flip back) so the account stays clean.
      const cur = await page
        .getByRole('switch', { name: swName })
        .getAttribute('aria-checked')
        .catch(() => null);
      if (cur !== null && cur !== original) {
        await flipAndSync().catch(() => {});
      }
    }
  });

  // M4 — destructive-action guard. The "Delete account" flow must NOT be able to
  // fire without the EXACT confirmation phrase. Opens the dialog, asserts the
  // confirm button is disabled, types a WRONG phrase (stays disabled, no ready
  // state), types the CORRECT phrase (enables + ready), then CANCELS — NEVER
  // clicking "Delete forever" (the E2E account must survive). A guard that enabled
  // without the phrase would be a catastrophic irreversible data-loss bug.
  test('User delete-account: destructive guard requires the exact phrase; Cancel is safe (M4)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    await page.goto('/admin/user', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    await page.locator('[data-testid="delete-account-button"]').click();
    const input = page.locator('[data-testid="delete-account-confirm-input"]');
    const confirmBtn = page.locator('[data-testid="delete-account-confirm"]');
    await expect(input, 'confirm dialog opened').toBeVisible({ timeout: 6000 });

    // Guard 1: disabled with no phrase.
    await expect(confirmBtn, 'Delete is disabled before any phrase').toBeDisabled();

    // Guard 2: a WRONG phrase keeps it disabled + shows no ready state.
    await input.fill('delete');
    await expect(confirmBtn, 'Delete stays disabled on a wrong phrase').toBeDisabled();
    await expect(
      page.locator('[data-testid="delete-confirm-ready"]'),
      'no ready state on a wrong phrase',
    ).toHaveCount(0);

    // Exact phrase: enables + shows the ready affordance.
    await input.fill('delete my account');
    await expect(confirmBtn, 'Delete enables only on the exact phrase').toBeEnabled({
      timeout: 4000,
    });
    await expect(
      page.locator('[data-testid="delete-confirm-ready"]'),
      'ready affordance shows on the exact phrase',
    ).toBeVisible({ timeout: 4000 });

    // NEVER click "Delete forever". Cancel — the account must survive.
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(input, 'Cancel closes the dialog').toHaveCount(0, { timeout: 4000 });

    // Prove the account is intact: reload /admin/user, still authed + profile renders.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    await expect(
      page.locator('[data-testid="us-profile-card"]'),
      'account still exists + admin still authed after the guarded (cancelled) delete',
    ).toBeVisible({ timeout: 8000 });

    await assertAlive(page);
    expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
    expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
    expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
  });

  // M3 (cross-system: an admin action in one subsystem → the audit trail in another).
  // The Cmd+K AI palette (`POST /api/admin/ai/stream/palette`) fires a fire-and-forget
  // `cmdk.ai.answered` audit write. The shared audit schema used to require a UUID
  // `org_id` → `.parse` THREW → `writeAuditLog` silently DROPPED the entry for the E2E
  // org (`org_id: 'e2e-test-org'`, a D1 TEXT id) — a compliance-trail gap invisible to
  // any render/console gate (it's a server-side log). This journey proves the action
  // now REACHES the store: press the AI → a FRESH cmdk.ai.answered row lands.
  test('Cmd+K AI answer lands in the audit trail (M3: non-UUID org audit no longer dropped)', async ({
    page,
  }) => {
    test.skip(!KEY, 'E2E_API_KEY not set');
    await page.goto('/');
    await seedAuth(page, KEY);
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Newest EXISTING cmdk.ai.answered timestamp — a fresh cmdk row must beat this.
    // Scoped to `action=cmdk.ai.answered` (server-side filter): under full-suite
    // parallel load the shared e2e-test-org's audit feed floods with OTHER actions,
    // which pushed the cmdk row past an unfiltered `limit=25` window before the poll
    // saw it (the old flake). The action filter makes the poll immune to that.
    const maxCmdkTs = (): Promise<string> =>
      page.evaluate(async () => {
        const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
        const r = await fetch('/api/audit/rows?action=cmdk.ai.answered&limit=50', {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        if (!r.ok) return 'ERR';
        const j = await r.json();
        const rows = (Array.isArray(j) ? j : (j.data ?? j.rows ?? [])) as Array<{
          created_at?: string;
        }>;
        return rows.reduce((m, x) => (x.created_at && x.created_at > m ? x.created_at : m), '');
      });
    const freshCmdkSince = (since: string): Promise<boolean> =>
      page.evaluate(async (sinceTs) => {
        const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
        const r = await fetch('/api/audit/rows?action=cmdk.ai.answered&limit=50', {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        if (!r.ok) return false;
        const j = await r.json();
        const rows = (Array.isArray(j) ? j : (j.data ?? j.rows ?? [])) as Array<{
          action?: string;
          created_at?: string;
        }>;
        return rows.some((x) => x.action === 'cmdk.ai.answered' && (x.created_at ?? '') > sinceTs);
      }, since);

    const beforeTs = await maxCmdkTs();
    expect(beforeTs, 'audit rows endpoint must be readable').not.toBe('ERR');

    // Press the Cmd+K AI (app-context fetch — a headless POST is Bot-Fight-challenged).
    const answered = await page.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
      const res = await fetch('/api/admin/ai/stream/palette', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'how do I add a custom domain' }),
      });
      const text = await res.text().catch(() => '');
      return { status: res.status, streamed: text.includes('data:') };
    });
    expect(answered.status, 'cmdk AI palette must answer 200').toBe(200);
    expect(answered.streamed, 'cmdk AI must stream a real answer').toBe(true);

    // The audit write is fire-and-forget (ctx.waitUntil) + D1 read replicas can lag
    // under load — poll up to 12s for the FRESH entry (action-scoped, so unrelated
    // rows can't bury it) before failing.
    let landed = false;
    for (let i = 0; i < 12 && !landed; i++) {
      await page.waitForTimeout(1000);
      landed = await freshCmdkSince(beforeTs);
    }
    expect(
      landed,
      `a fresh cmdk.ai.answered audit entry must land after the AI answer (non-UUID org write no longer dropped; beforeTs=${beforeTs})`,
    ).toBe(true);
  });

  // M4 (adversarial dead-end) — the Snapshots create action must NEVER dead-end.
  // A site with no published build has no `current_build_version`, so
  // POST /sites/:id/snapshots 400s ("Site has no published version to snapshot").
  // The UI MUST gate the create button (disabled + a "publish first" affordance)
  // rather than offer an enabled button that 400s on click. When the selected
  // site IS built, the full create flow must succeed (200/201, never 400) — and
  // its snapshot is cleaned up in `finally`. Ground truth (buildable?) is read
  // straight from GET /api/sites so the assertion adapts to whatever the E2E org has.
  test('Snapshots: unbuilt site gets a graceful "publish first" gate — no create button that 400s (M4)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    let createdSnap: { siteId: string; snapId: string } | null = null;
    try {
      await page.goto('/admin/snapshots', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500); // sites + snapshots load → selectedSite() resolved

      // Ground truth: does the section's selected site (the first site) have a build?
      const truth = await page.evaluate(async () => {
        const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
        const r = await fetch('/api/sites', { headers: { Authorization: `Bearer ${s.token}` } });
        const j = (await r.json().catch(() => ({}))) as {
          data?: Array<{ id?: string; current_build_version?: number | null }>;
        };
        const site = Array.isArray(j.data) ? j.data[0] : undefined;
        return {
          hasSite: !!site,
          buildable: !!site?.current_build_version,
          siteId: site?.id ?? null,
        };
      });

      const createBtn = page.locator('[data-testid="snapshot-create-button"]');
      expect(await createBtn.isVisible().catch(() => false), 'create button is rendered').toBe(
        true,
      );

      if (truth.hasSite && !truth.buildable) {
        // Unbuilt → button DISABLED (can't reach the 400) + a "publish first" hint explains why.
        expect(
          await createBtn.isDisabled().catch(() => true),
          'unbuilt site: create-snapshot button MUST be disabled (no 400 dead-end)',
        ).toBe(true);
        expect(
          await page
            .locator('[data-testid="snapshots-build-gate"]')
            .isVisible()
            .catch(() => false),
          'unbuilt site: a "publish first" affordance MUST be shown (never a mysteriously-dead button)',
        ).toBe(true);
      } else if (truth.buildable && truth.siteId) {
        // Built → create must be enabled + the POST must succeed (200/201), never 400.
        expect(await createBtn.isEnabled().catch(() => false), 'built site: create enabled').toBe(
          true,
        );
        await createBtn.click({ timeout: 5000 });
        await page.waitForTimeout(400);
        const name = `e2e-chaos-${Date.now().toString().slice(-6)}`;
        await page.locator('[data-testid="snapshot-name-input"]').fill(name);
        const respP = page.waitForResponse(
          (r) => /\/snapshots\b/.test(r.url()) && r.request().method() === 'POST',
          { timeout: 15_000 },
        );
        await page.locator('[data-testid="snapshot-create-submit"]').click({ timeout: 5000 });
        const cr = await respP;
        expect(
          [200, 201],
          `built site: snapshot create status ${cr.status()} (must not 400)`,
        ).toContain(cr.status());
        const body = (await cr.json().catch(() => ({}))) as { data?: { id?: string } };
        if (body.data?.id) createdSnap = { siteId: truth.siteId, snapId: body.data.id };
      }

      await assertAlive(page);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
    } finally {
      if (createdSnap) {
        await page
          .evaluate(async (c) => {
            const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
            await fetch(`/api/sites/${c.siteId}/snapshots/${c.snapId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${s.token}` },
            }).catch(() => {});
          }, createdSnap)
          .catch(() => {});
      }
    }
  });

  // M2 (core CRUD create→edit→persist) + M4 (destructive delete + confirm) — the AI
  // Endpoints authoring surface (/admin/ai-endpoints) is a rich create/edit/delete CRUD
  // that had ZERO chaos coverage. Drive it end-to-end vs prod: create → row appears →
  // inline-edit the slug → PUT persists across nav-away + HARD reload → UI delete (confirm
  // dialog) → row gone → delete persists. Self-cleans via API in finally. Locks in the
  // "FULLY WORKING" create/edit/delete claim in ai-endpoints.component.ts against regression.
  test('AI Endpoints: create → inline-edit slug → PUT persists across reload → UI delete (M2+M4)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    const A = `e2e-chaos-${Date.now().toString().slice(-7)}`;
    const B = `${A}-edited`;
    let liveSlug = ''; // slug that currently exists on the server, for finally cleanup
    try {
      await page.goto('/admin/ai-endpoints', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);

      // ── Create ──
      await page.locator('[data-testid="ai-endpoint-create-manual"]').click({ timeout: 6000 });
      await page.waitForTimeout(400);
      await page.locator('[data-testid="ai-endpoint-create-slug"]').fill(A);
      await page.waitForTimeout(200);
      const submit = page.locator('[data-testid="ai-endpoint-create-submit"]');
      await expect(submit, 'create submit enables on a valid slug').toBeEnabled({ timeout: 4000 });
      const createResp = page.waitForResponse(
        (r) => /\/ai-endpoints$/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 15000 },
      );
      await submit.click();
      const cr = await createResp;
      expect([200, 201], `create status ${cr.status()}`).toContain(cr.status());
      liveSlug = A;
      await expect(
        page.locator(`[data-testid="ai-endpoint-row-${A}"]`),
        'created endpoint row appears',
      ).toBeVisible({ timeout: 8000 });

      // ── Inline-edit the slug A → B ──
      await page.locator(`[data-testid="ai-endpoint-edit-url-${A}"]`).click({ timeout: 6000 });
      const slugInput = page.locator(`[data-testid="ai-endpoint-slug-input-${A}"]`);
      await expect(slugInput, 'inline slug editor opens').toBeVisible({ timeout: 6000 });
      await slugInput.fill(B);
      const putResp = page.waitForResponse(
        (r) => /\/ai-endpoints\//.test(r.url()) && r.request().method() === 'PUT',
        { timeout: 15000 },
      );
      await page.locator(`[data-testid="ai-endpoint-slug-save-${A}"]`).click();
      const pr = await putResp;
      expect([200, 204], `edit PUT status ${pr.status()}`).toContain(pr.status());
      liveSlug = B;
      await expect(
        page.locator(`[data-testid="ai-endpoint-row-${B}"]`),
        'row shows the edited slug',
      ).toBeVisible({ timeout: 8000 });

      // ── Persist across nav-away + HARD reload (server round-trip, not local state) ──
      await page.goto('/admin/analytics', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      await page.goto('/admin/ai-endpoints', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await expect(
        page.locator(`[data-testid="ai-endpoint-row-${B}"]`),
        'edited slug persists across hard reload (server round-trip)',
      ).toBeVisible({ timeout: 8000 });

      // ── UI delete (destructive confirm dialog) ──
      await page.locator(`[data-testid="ai-endpoint-more-${B}"]`).click({ timeout: 6000 });
      await page.waitForTimeout(300);
      await page.locator(`[data-testid="ai-endpoint-delete-${B}"]`).click({ timeout: 6000 });
      const accept = page.locator('[data-testid="confirm-accept"]');
      await expect(accept, 'delete confirm dialog opens').toBeVisible({ timeout: 6000 });
      const delResp = page.waitForResponse(
        (r) => /\/ai-endpoints\//.test(r.url()) && r.request().method() === 'DELETE',
        { timeout: 15000 },
      );
      await accept.click();
      const dr = await delResp;
      expect([200, 204], `delete status ${dr.status()}`).toContain(dr.status());
      await expect(
        page.locator(`[data-testid="ai-endpoint-row-${B}"]`),
        'deleted endpoint row disappears',
      ).toBeHidden({ timeout: 8000 });
      liveSlug = ''; // deleted — nothing to clean up

      // ── Delete persists across HARD reload ──
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await expect(
        page.locator(`[data-testid="ai-endpoint-row-${B}"]`),
        'delete persists across hard reload',
      ).toBeHidden({ timeout: 8000 });

      await assertAlive(page);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
    } finally {
      if (liveSlug) {
        await page
          .evaluate(async (slug) => {
            const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
            const list = await fetch('/api/sites/e2e-site-3/ai-endpoints', {
              headers: { Authorization: `Bearer ${s.token}` },
            })
              .then((r) => r.json())
              .catch(() => ({}));
            const rows = (list?.data ?? []) as Array<{ id: string; endpoint_slug?: string }>;
            const mine = rows.find((x) => x.endpoint_slug === slug);
            if (mine) {
              await fetch(`/api/sites/e2e-site-3/ai-endpoints/${mine.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${s.token}` },
              }).catch(() => {});
            }
          }, liveSlug)
          .catch(() => {});
      }
    }
  });

  // M2 (create→persist) + M4 (destructive delete + one-time-secret) — Outbound Webhooks
  // (/admin/webhooks) subscribe an https endpoint to site events, the signing secret is
  // shown EXACTLY once, the row persists, and delete goes through a destructive confirm.
  // Zero chaos coverage before. Resilient to the `outbound_webhooks` flag: flag-off → assert
  // the graceful gate (create disabled, no dead-end); flag-on → full create→secret→persist→
  // delete. Self-cleans via API in finally.
  test('Webhooks: subscribe → one-time secret → persists across reload → UI delete (M2+M4), or graceful flag-gate', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    const url = `https://e2e-chaos-${Date.now().toString().slice(-7)}.example.com/hook`;
    let createdViaUi = false;
    try {
      await page.goto('/admin/webhooks', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3500);

      const createBtn = page.locator('[data-testid="webhooks-create-btn"]');
      const gated = await page
        .locator('[data-testid="webhooks-flag-gate"]')
        .isVisible()
        .catch(() => false);

      if (gated) {
        // outbound_webhooks OFF → graceful gate: create MUST be disabled (no dead button).
        expect(
          await createBtn.isDisabled().catch(() => true),
          'flag-off: create-webhook button must be disabled',
        ).toBe(true);
      } else {
        // Flag ON → full CRUD. Empty form → button disabled (no dead-end submit).
        await expect(page.locator('[data-testid="webhooks-url"]'), 'url input present').toBeVisible(
          {
            timeout: 6000,
          },
        );
        expect(await createBtn.isDisabled().catch(() => true), 'empty form: create disabled').toBe(
          true,
        );

        await page.locator('[data-testid="webhooks-url"]').fill(url);
        await page.locator('[data-testid^="webhooks-event-"]').first().check();
        await expect(createBtn, 'valid url + event enables create').toBeEnabled({ timeout: 4000 });

        const cResp = page.waitForResponse(
          (r) => /\/webhooks$/.test(r.url()) && r.request().method() === 'POST',
          { timeout: 15000 },
        );
        await createBtn.click();
        const cr = await cResp;
        expect([200, 201], `create status ${cr.status()}`).toContain(cr.status());
        createdViaUi = true;

        // The signing secret is revealed EXACTLY once.
        await expect(
          page.locator('[data-testid="webhooks-secret"]'),
          'signing secret shown once',
        ).toBeVisible({ timeout: 8000 });
        const row = page.locator(`[data-testid="webhooks-row"]:has-text("${url}")`);
        await expect(row, 'endpoint row appears').toBeVisible({ timeout: 8000 });

        // Persist across HARD reload — and the one-time secret must NOT reappear.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500);
        await expect(
          page.locator(`[data-testid="webhooks-row"]:has-text("${url}")`),
          'endpoint persists across hard reload',
        ).toBeVisible({ timeout: 8000 });
        expect(
          await page
            .locator('[data-testid="webhooks-secret"]')
            .isVisible()
            .catch(() => false),
          'one-time secret must NOT re-show after reload',
        ).toBe(false);

        // UI delete via the destructive confirm dialog.
        await page
          .locator(
            `[data-testid="webhooks-row"]:has-text("${url}") [data-testid="webhooks-delete"]`,
          )
          .click({ timeout: 6000 });
        const accept = page.locator('[data-testid="confirm-accept"]');
        await expect(accept, 'delete confirm dialog opens').toBeVisible({ timeout: 6000 });
        const dResp = page.waitForResponse(
          (r) => /\/webhooks\//.test(r.url()) && r.request().method() === 'DELETE',
          { timeout: 15000 },
        );
        await accept.click();
        const dr = await dResp;
        expect([200, 204], `delete status ${dr.status()}`).toContain(dr.status());
        await expect(
          page.locator(`[data-testid="webhooks-row"]:has-text("${url}")`),
          'endpoint row disappears',
        ).toBeHidden({ timeout: 8000 });
        createdViaUi = false; // deleted via UI
      }

      await assertAlive(page);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
    } finally {
      if (createdViaUi) {
        await page
          .evaluate(async (u) => {
            const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
            const list = await fetch('/api/sites/e2e-site-3/webhooks', {
              headers: { Authorization: `Bearer ${s.token}` },
            })
              .then((r) => r.json())
              .catch(() => ({}));
            const eps = (list?.endpoints ?? list?.data ?? []) as Array<{
              id: string;
              url?: string;
            }>;
            const mine = eps.find((x) => x.url === u);
            if (mine) {
              await fetch(`/api/sites/e2e-site-3/webhooks/${mine.id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${s.token}` },
              }).catch(() => {});
            }
          }, url)
          .catch(() => {});
      }
    }
  });

  // M2 (create→persist→delete) + M4 (lying-success / IDOR regression guard) — Timeline
  // Notes (the `analytics_annotations` feature, `activity_feed` flag, mounted on
  // /admin/snapshots). Drives the real UI create (type → "Add note" → row appears),
  // proves the note PERSISTS across nav + HARD reload (server GET, not optimistic UI),
  // deletes via the row's ✕, then app-context RECONCILES against the store: the store
  // no longer has it, RE-deleting the same id returns 404 (NOT a lying 204), and a
  // foreign/nonexistent id returns 404 (org-scoped WHERE — no cross-org IDOR). This
  // locks in the iter fix at deploy 158a2b79 (createAnnotation throws on a dropped
  // INSERT; deleteAnnotation is org-scoped + returns changes>0 → 404-on-no-match)
  // end-to-end. The UI delete is optimistic+silent, so the store reconciliation — not
  // the vanished row — is what proves the DELETE actually reached D1. Self-cleans in
  // finally. Resilient: if the panel isn't reachable (flag off for this org) it asserts
  // the honest hidden state rather than vacuously passing.
  test('Timeline Notes: create → persists across reload → delete; re-delete + foreign id 404 (M2+M4, validates 158a2b79)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    let createdId: string | null = null;
    const marker = `chaos-tln-${Date.now().toString().slice(-8)}`;
    try {
      await page.goto('/admin/snapshots', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3800); // sites + snapshots + annotations list load → selectedSite resolved

      const panel = page.locator('[data-testid="timeline-notes"]');
      // The panel renders only when GET /sites/:id/annotations 200s (flag on). If it's
      // hidden the feature is dark for this org — assert that honest state, don't fake-pass.
      const panelVisible = await panel.isVisible().catch(() => false);
      if (!panelVisible) {
        // Flag-off contract: the panel stays hidden (no half-rendered dead surface).
        expect(await panel.count(), 'flag-off: timeline-notes panel is fully hidden').toBe(0);
        await assertAlive(page);
        return;
      }

      // ── Create via the real UI (type note → "Add note") ──
      await page.locator('[data-testid="timeline-note-input"]').fill(marker);
      await page.locator('[data-testid="timeline-note-category"]').selectOption('deploy');
      const createResp = page.waitForResponse(
        (r) => /\/annotations$/.test(r.url()) && r.request().method() === 'POST',
        { timeout: 15_000 },
      );
      await page.locator('[data-testid="timeline-note-add"]').click({ timeout: 5000 });
      const cr = await createResp;
      expect(
        cr.status(),
        'annotation create must 201 (not a lying success on a dropped INSERT)',
      ).toBe(201);
      const row = page
        .locator('[data-testid="timeline-note-item"]')
        .filter({ hasText: marker })
        .first();
      await expect(row, 'created note row appears in the timeline').toBeVisible({ timeout: 8000 });
      createdId = await row.getAttribute('data-id');
      expect(createdId, 'created row carries a real annotation id').toBeTruthy();

      // ── Persist across nav-away + HARD reload (server GET, not optimistic prepend) ──
      await page.goto('/admin/analytics', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      await page.goto('/admin/snapshots', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await expect(
        page.locator('[data-testid="timeline-note-item"]').filter({ hasText: marker }).first(),
        'note persists after nav-away + back',
      ).toBeVisible({ timeout: 8000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await expect(
        page.locator('[data-testid="timeline-note-item"]').filter({ hasText: marker }).first(),
        'note persists after HARD reload (proves it hit D1, not just optimistic UI)',
      ).toBeVisible({ timeout: 8000 });

      // ── Delete via the row's ✕ (optimistic+silent in the UI) ──
      await page
        .locator('[data-testid="timeline-note-item"]')
        .filter({ hasText: marker })
        .first()
        .locator('[data-testid="timeline-note-delete"]')
        .click({ timeout: 5000 });
      await expect(
        page.locator('[data-testid="timeline-note-item"]').filter({ hasText: marker }),
        'row disappears from the timeline after delete',
      ).toHaveCount(0, { timeout: 8000 });

      // ── Store reconciliation (the real proof) — the UI delete is optimistic, so query
      // the STORE: the DELETE must have reached D1 (re-delete → 404, never a lying 204),
      // and a foreign/nonexistent id must also 404 (org-scoped WHERE — no cross-org IDOR).
      const reconcile = await page.evaluate(async (id) => {
        const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
        const H = { Authorization: `Bearer ${s.token}` };
        const reDelete = await fetch(`/api/annotations/${id}`, { method: 'DELETE', headers: H });
        const foreign = await fetch('/api/annotations/nonexistent-foreign-id-000', {
          method: 'DELETE',
          headers: H,
        });
        return { reDeleteStatus: reDelete.status, foreignStatus: foreign.status };
      }, createdId);
      expect(
        reconcile.reDeleteStatus,
        're-deleting the just-deleted id → 404 (UI delete reached D1; lying-204 fix holds)',
      ).toBe(404);
      expect(
        reconcile.foreignStatus,
        'deleting a foreign/nonexistent id → 404 (org-scoped WHERE; no cross-org IDOR / lying success)',
      ).toBe(404);
      createdId = null; // deleted + verified — nothing to clean up

      await assertAlive(page);
      expect(await e.xssFired(), 'no injected script in the timeline-notes flow').toBe(false);
      expect(e.pageErrors, `pageerrors: ${e.pageErrors.join('; ')}`).toEqual([]);
      expect(e.serverErrors, `5xx: ${e.serverErrors.join('; ')}`).toEqual([]);
      expect(e.consoleErrors, `console errors: ${e.consoleErrors.join('; ')}`).toEqual([]);
      expect(
        e.consoleWarnings,
        `console warnings (DoD=0): ${e.consoleWarnings.join('; ')}`,
      ).toEqual([]);
    } finally {
      // Safety net: if the run bailed before the UI delete, remove the row via the API
      // (site-agnostic /api/annotations/:id) so the shared E2E org is left clean.
      if (createdId) {
        await page
          .evaluate(async (id) => {
            const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
            await fetch(`/api/annotations/${id}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${s.token}` },
            }).catch(() => {});
          }, createdId)
          .catch(() => {});
      }
    }
  });

  // M2 (persist) — the forms-designer MCP selection round-trips to the SERVER. The
  // "MCP integrations available to this prompt" pills PUT `enabled_mcps` to
  // /sites/:id/ai-settings, which SILENTLY DROPPED it (not in the allow-list, no column)
  // → a lying-success stub: it toasted "Saved" but the selection never persisted (lived
  // only in localStorage) and the form router ignored it (`loadAvailableTools` returned
  // ALL tools). This proves the fix (migration 0629 + PUT allow-list + GET return +
  // router filter): PUT a selection → GET echoes it back. App-context fetch (real
  // cf_clearance) since a headless PUT is WAF-challenged. Self-restoring (clears the
  // selection in finally so the shared E2E site stays unrestricted).
  test('Forms designer MCP selection round-trips to the SERVER (enabled_mcps persist, not a lying-success) (M2)', async ({
    page,
  }) => {
    await seedAuth(page, KEY);
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200); // acquire cf_clearance for app-context mutations
    const SID = 'e2e-site-1';
    const sel = ['stripe', 'resend'];
    try {
      const out = await page.evaluate(
        async ({ sid, selection }) => {
          const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
          const H = { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' };
          const put = await fetch(`/api/sites/${sid}/ai-settings`, {
            method: 'PUT',
            headers: H,
            body: JSON.stringify({ enabled_mcps: selection }),
          });
          const getRes = await fetch(`/api/sites/${sid}/ai-settings`, { headers: H });
          const body = (await getRes.json().catch(() => ({}))) as {
            data?: { enabled_mcps?: string[] };
          };
          return {
            putStatus: put.status,
            getStatus: getRes.status,
            enabled: body?.data?.enabled_mcps ?? null,
          };
        },
        { sid: SID, selection: sel },
      );
      expect(out.putStatus, 'ai-settings PUT accepts enabled_mcps (200)').toBe(200);
      expect(out.getStatus, 'ai-settings GET (200)').toBe(200);
      expect(Array.isArray(out.enabled), 'GET returns an enabled_mcps array (not dropped)').toBe(
        true,
      );
      expect(out.enabled, 'the selection persisted server-side (round-trip)').toEqual(
        expect.arrayContaining(sel),
      );
    } finally {
      // Restore the empty selection so the shared E2E site is left unrestricted.
      await page
        .evaluate(async (sid) => {
          const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
          await fetch(`/api/sites/${sid}/ai-settings`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled_mcps: [] }),
          }).catch(() => {});
        }, SID)
        .catch(() => {});
    }
  });

  test('MCP connections are site-scoped: ?site_id filters honestly, a bogus site returns none (M3)', async ({
    page,
  }) => {
    // Regression guard for the "ignored scope filter" bug: GET /api/mcp/connections
    // ACCEPTED a site_id/siteId query but ignored it, so the env-var-attachment +
    // voice MCP pickers showed EVERY org connection regardless of the site in
    // context. The endpoint now honors the filter. Data-driven (no hardcoded ids).
    await seedAuth(page, KEY);
    await page.goto('/admin/mcp', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    const r = await page.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
      const auth = { headers: { Authorization: `Bearer ${s.token}` } };
      const get = async (qs: string) => {
        const res = await fetch(`/api/mcp/connections${qs}`, auth);
        const j = (await res.json().catch(() => ({}))) as { data?: Array<{ site_id?: string }> };
        return { status: res.status, data: Array.isArray(j?.data) ? j.data : [] };
      };
      const all = await get('');
      const siteWith = all.data[0]?.site_id ?? null;
      const scoped = siteWith
        ? await get(`?site_id=${encodeURIComponent(siteWith)}`)
        : { status: 200, data: [] as Array<{ site_id?: string }> };
      const bogus = await get('?site_id=__no_such_site__zzz');
      return { all, siteWith, scoped, bogus };
    });

    expect(r.all.status, 'org-wide connections list is 200').toBe(200);
    // The core invariant the fix restores: a filter for a NON-EXISTENT site must
    // return zero connections. Before the fix this leaked EVERY org connection.
    expect(
      r.bogus.data.length,
      'a bogus site_id must return 0 connections (filter honored, not ignored)',
    ).toBe(0);
    // Every connection returned for ?site_id=X actually belongs to X.
    for (const c of r.scoped.data) {
      expect(c.site_id, `?site_id=${r.siteWith} leaked a foreign site's connection`).toBe(
        r.siteWith,
      );
    }
    // If the org has any connection, its owning site round-trips a non-empty list.
    if (r.siteWith) {
      expect(r.scoped.data.length, 'the owning site returns its own connection').toBeGreaterThan(0);
    }
  });

  test('Voice: saving agent-settings does NOT wipe the MCP attachments set on the MCPs tab (M4 data-integrity)', async ({
    page,
  }) => {
    // Cross-tab clobber regression: the voice agent-settings PUT used to write
    // mcp_connection_ids UNCONDITIONALLY (nulling it), but the agent-settings tab
    // never sends it — so every settings save WIPED the voice MCP attachments set
    // via the dedicated /voice/mcp-attachments tab. Mutate on one tab → save on the
    // other → assert the first tab's state PERSISTED.
    await seedAuth(page, KEY);
    await page.goto('/admin/voice', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);

    const SID = 'e2e-site-3';
    const MARK = 'e2e-chaos-mcp-attach';
    const r = await page.evaluate(
      async ([sid, mark]) => {
        const s = JSON.parse(localStorage.getItem('ps_session') || '{}');
        const H = {
          Authorization: `Bearer ${s.token}`,
          'Content-Type': 'application/json',
        } as Record<string, string>;
        const jput = (path: string, body: unknown) =>
          fetch(path, { method: 'PUT', headers: H, body: JSON.stringify(body) }).then(
            (r) => r.status,
          );
        // 1) Attach an MCP connection on the MCPs tab.
        const setStatus = await jput('/api/voice/mcp-attachments', {
          site_id: sid,
          voice: [mark],
          sms: [],
        });
        // 2) Save the agent-settings tab WITHOUT mcp_connection_ids (as the UI does).
        const saveStatus = await jput('/api/voice/agent-settings', {
          siteId: sid,
          voice_system_prompt: 'Chaos persistence probe.',
        });
        // 3) Read the attachments back — must still contain the mark.
        const readRes = await fetch(`/api/voice/mcp-attachments?siteId=${sid}`, {
          headers: { Authorization: `Bearer ${s.token}` },
        });
        const read = (await readRes.json().catch(() => ({}))) as { data?: { voice?: string[] } };
        // 4) Cleanup — clear the test attachment so the shared site is left pristine.
        await jput('/api/voice/mcp-attachments', { site_id: sid, voice: [], sms: [] });
        return { setStatus, saveStatus, voice: read?.data?.voice ?? [] };
      },
      [SID, MARK] as const,
    );

    expect(r.setStatus, 'mcp-attachments PUT succeeded').toBe(200);
    expect(r.saveStatus, 'agent-settings PUT succeeded').toBe(200);
    // The core assertion: the attachment SURVIVED the agent-settings save.
    expect(
      r.voice,
      'agent-settings save wiped the MCP attachment (cross-tab clobber regression)',
    ).toContain(MARK);
  });

  // Verify-against-source-of-truth for the owner Features control plane (Layer 2). The worker
  // SITE_FEATURE_CATALOG was emptied 2026-08-13, so GET /api/site-features returns
  // {features:[]} → the page MUST honestly reflect that (0 toggles), NEVER the stale read-only
  // FALLBACK (the frontend SITE_FEATURE_CATALOG_DISPLAY still lists the REMOVED features as
  // fake, non-functional toggles — enterFallbackMode only fires on a 404/non-JSON, but a
  // regression that surfaces it on an empty 200 would be a LYING control plane). This
  // reconciles the VISIBLE toggle count with the API and asserts the degraded banner is absent
  // on a 200 — so the stale fallback can never masquerade as the real catalog undetected.
  test('Site Features: the owner control plane reconciles with GET /api/site-features (no stale lying-fallback) (M3)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    const respP = page.waitForResponse(
      (r) => /\/api\/site-features(\?|$)/.test(r.url()) && r.request().method() === 'GET',
      { timeout: 20_000 },
    );
    await page.goto('/admin/site-features', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="sf-root"]')).toBeVisible({ timeout: 15_000 });

    const resp = await respP;
    expect(resp.status(), 'GET /api/site-features must serve JSON (200), not a 404/HTML').toBe(200);
    const body = JSON.parse(await resp.text()) as { features?: unknown[] };
    const apiCount = Array.isArray(body.features) ? body.features.length : -1;
    expect(apiCount, 'API returned a real features array').toBeGreaterThanOrEqual(0);

    await page.waitForTimeout(1500); // let the signal→CD render settle before counting

    // RECONCILIATION (the lying-fallback tripwire): one sf-toggle per feature card, so the
    // visible count MUST equal the API's features length. The stale fallback would render
    // SITE_FEATURE_CATALOG_DISPLAY entries (>0) while the API returned 0 → a mismatch fails.
    const uiCount = await page.locator('[data-testid="sf-toggle"]').count();
    expect(
      uiCount,
      `UI feature toggles (${uiCount}) must reconcile with API features (${apiCount}) — never the stale fallback catalog`,
    ).toBe(apiCount);

    // On a healthy 200 the degraded/read-only FALLBACK banner MUST be absent (it only shows the
    // stale removed-feature catalog on a route-not-provisioned 404/non-JSON).
    const fallbackBanner = page.getByText('The catalog below is read-only', { exact: false });
    expect(
      await fallbackBanner.count(),
      'stale read-only fallback banner must NOT show on a 200 response',
    ).toBe(0);

    await assertAlive(page);
    expect(e.consoleErrors, e.consoleErrors.join('\n')).toEqual([]);
    expect(e.pageErrors, e.pageErrors.join('\n')).toEqual([]);
    expect(e.serverErrors, e.serverErrors.join('\n')).toEqual([]);
  });

  // M4 failure-recovery: when GET /api/site-features FAILS (404 / route gone / non-JSON), the
  // page MUST show the honest retryable error card — NEVER the stale removed-feature fallback
  // catalog (SITE_FEATURE_CATALOG_DISPLAY) rendered as fake, non-functional toggles. Injects a
  // 404 via route-interception (a realistic outage the real 200 never exercises).
  test('Site Features: a failed catalog fetch shows the honest error card, NOT stale fallback toggles (M4)', async ({
    page,
  }) => {
    const e = trackErrors(page);
    await seedAuth(page, KEY);
    await page.route('**/api/site-features**', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'not_found' }),
          })
        : route.continue(),
    );
    await page.goto('/admin/site-features', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-testid="sf-root"]')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500);

    // Honest failure: ZERO feature cards (the deleted fallback can no longer invent the removed
    // catalog — its cards render `sf-card-<key>` even without a toggle) and the retryable error
    // card is shown instead.
    expect(
      await page.locator('[data-testid^="sf-card-"]').count(),
      'a failed catalog fetch must NOT render stale fallback feature cards',
    ).toBe(0);
    await expect(page.getByText("Couldn't load features")).toBeVisible({ timeout: 8000 });

    await assertAlive(page);
    expect(e.pageErrors, e.pageErrors.join('\n')).toEqual([]);
  });
});
