/**
 * @file promote-workflow.e2e.ts
 * @description Preview → Promote → Production GOLDEN-PATH, driven through the REAL UI on PROD.
 *
 * THE SURFACE (this is what the prior RED spec got wrong):
 * The "Promote to Production" button does NOT live at `/admin/sites/:id/snapshots`. It lives
 * inside the **bolt.diy editor's Source Control panel** — a CROSS-ORIGIN iframe served from
 * `editor.projectsites.dev`, hosted by the Angular admin at `/admin/editor/:siteId`
 * (the persistent iframe is owned by `AdminComponent`/`BoltEmbedService`). To reach the button
 * you must: open the editor for a real site → let the cross-origin frame + WebContainer boot →
 * open the "Source" (Source Control) tab INSIDE the frame → then the `promote-to-production`
 * button renders. The promote HTTP call is made by the admin PARENT over the `PS_PROMOTE_REQUEST`
 * postMessage bridge → `POST /api/sites/:id/promote`; Production truth is `GET /api/sites/:id/releases`.
 *
 * Ground-truth from the code (load-bearing selectors + shapes):
 *  - Frame:          `iframe[title="bolt.diy editor"]`, src `https://editor.projectsites.dev/?embedded=true…`
 *  - Source Control tab trigger: role=tab, accessible name "Source" (title "Source Control — …")
 *    (`app/components/workbench/EditorPanel.tsx`)
 *  - Panel:          `[data-testid="source-control-panel"]` (`app/components/workbench/SourceControlPanel.tsx`)
 *  - Promote button: `[data-testid="promote-to-production"]` — label "Promote"/"Publishing…";
 *    disabled WITH a reason (title/aria) when nothing is promotable (never a dead control).
 *  - Status region:  `[data-testid="promote-status"]` — HONEST outcome. There is NO `data-state`
 *    attribute; SUCCESS is the message text "Published! Production is now serving your Preview."
 *    or (idempotent) "Already live — Production is up to date." + a check-circle icon.
 *  - Releases API:   `GET /api/sites/:id/releases` → `{ releases: Release[], count: number }`
 *    (NOT `{data}`); each Release carries `commit_sha` / `artifact_digest` / `outcome`.
 *    Both promote + releases are gated on the `durable_preview` flag (override-enabled for the E2E org).
 *
 * Auth: real `E2E_API_KEY` session via `setupRealDataPage` (Pathway A). The whole suite skips
 * without a key (no real site to promote → the test would be meaningless).
 *
 * HONESTY: assertions are never weakened to go green. If the real editor frame / Source Control
 * surface genuinely can't mount, the test fails LOUDLY with a diagnostic — a precise gap is a valid
 * result, a false green is not.
 */

import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { gotoAdmin, SYS_ADMIN_TEST_EMAIL } from './helpers/auth.js';
import { realDataAvailable, setupRealDataPage } from './helpers/realdata.js';
import { resolveE2ESite } from './admin-verify/_resolve-e2e-site.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

/**
 * The editor is a cross-origin iframe + WebContainer boot (cold-boot 30–60s once/session), so the
 * editor-facing waits are generous. These are BOUNDED (never sleeps) — a truly-stuck surface still
 * fails, it just isn't flaked by a slow-but-progressing boot.
 */
const EDITOR_BOOT_MS = 90_000;
const PROMOTE_MS = 90_000;

/** Every `/api/*` the editor + admin parent legitimately need must hit REAL prod (authed → real data). */
const EDITOR_PASSTHROUGH =
  /\/api\/(auth\/me|sites\b|sites\/[^/]+\/(preview-state|releases|promote|workflow|readiness|build-context|chat)|sites\/by-slug\/|feature-flags)/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Real session + `/api` routing so the editor + promote + releases calls hit live prod. */
async function authAsSysAdmin(page: Page): Promise<void> {
  await page.goto(PROD_URL, { waitUntil: 'domcontentloaded' });
  await setupRealDataPage(page, { passthrough: EDITOR_PASSTHROUGH, email: SYS_ADMIN_TEST_EMAIL });
}

/** Resolve the real E2E site id/slug; skip the test (never false-fail) when the org has no site. */
async function resolveSiteOrSkip(): Promise<{ id: string; slug: string }> {
  const { id, slug } = await resolveE2ESite(PROD_URL, process.env.E2E_API_KEY!, UA);
  test.skip(!id, 'E2E org has no site to promote — nothing to drive');
  return { id, slug };
}

/**
 * Fetch this site's release history AS THE REAL USER (parent-session pattern the promote UI uses).
 * Returns the honest `{ status, count, latestRevision }`. Reads the real `{releases,count}` shape.
 */
async function fetchReleases(
  page: Page,
  siteId: string,
): Promise<{ status: number; count: number; latestRevision: string | null; latestOutcome: string | null }> {
  return page.evaluate(
    async ({ base, id, token }: { base: string; id: string; token: string }) => {
      const r = await fetch(`${base}/api/sites/${id}/releases`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await r.json().catch(() => ({}))) as {
        releases?: Array<{ commit_sha?: string | null; artifact_digest?: string | null; outcome?: string }>;
      };
      const list = j?.releases ?? [];
      const top = list[0];
      return {
        status: r.status,
        count: list.length,
        // The release's durable "revision" is its commit SHA (fallback: artifact digest).
        latestRevision: top ? (top.commit_sha ?? top.artifact_digest ?? null) : null,
        latestOutcome: top?.outcome ?? null,
      };
    },
    { base: PROD_URL, id: siteId, token: process.env.E2E_API_KEY! },
  );
}

/**
 * Open the editor for `siteId` via the REAL admin route, then return a FrameLocator for the booted
 * cross-origin editor frame. Waits (bounded) for the frame + its workbench to mount. Throws a precise
 * diagnostic if the editor frame never appears — a real gap, surfaced, never masked.
 */
async function openEditorFrame(page: Page, _siteId: string): Promise<FrameLocator> {
  // `/admin/editor` is the route that lifts the persistent bolt iframe into place
  // (AdminComponent.isEditorPath — `/admin` alone is the dashboard, not the editor).
  // NOTE: we deliberately use the bare `/admin/editor` (NOT `/admin/editor/:siteId`): the
  // admin selects the site from the persisted/default selection (`selectedSite ?? sites[0]`,
  // admin-state.service.ts) — NO code maps the `:siteId` route param to `selectSite`, so a
  // deep `:siteId` URL renders the styled admin-404 ("needs a site selected") whenever the SPA
  // route lands before the site list resolves. The bare route is exactly how the real nav link
  // opens the editor (sidebar "Editor" → `/admin/editor`) and boots on the resolved site.
  await gotoAdmin(page, 'editor');

  // Admin shell must render (auth landed) before the iframe mounts.
  await expect(page.locator('app-admin, [data-cockpit="v2"]')).toBeVisible({ timeout: 20_000 });

  // The iframe is materialized lazily by `@if (bolt.iframeUrl())` once the site resolves.
  const iframeEl = page.locator('iframe[title="bolt.diy editor"], iframe[src*="editor.projectsites.dev"]');
  await expect(iframeEl, 'the bolt.diy editor iframe must mount on /admin/editor/:id').toBeVisible({
    timeout: EDITOR_BOOT_MS,
  });

  const frame = page.frameLocator('iframe[title="bolt.diy editor"], iframe[src*="editor.projectsites.dev"]');

  // WebContainer cold-boot: wait for the workbench shell to actually render inside the frame.
  // The Source Control tab lives in the EditorPanel's tab list; its presence proves the workbench
  // (not just the frame document) is up. `getByRole('tab', {name:'Source'})` is the tab trigger.
  await expect(
    frame.getByRole('tab', { name: 'Source', exact: false }),
    'the editor workbench (Source Control tab) must render inside the frame',
  ).toBeVisible({ timeout: EDITOR_BOOT_MS });

  return frame;
}

/** Open the Source Control panel inside the editor frame; assert the panel renders. */
async function openSourceControl(frame: FrameLocator): Promise<void> {
  await frame.getByRole('tab', { name: 'Source', exact: false }).click();
  await expect(
    frame.locator('[data-testid="source-control-panel"]'),
    'Source Control panel must render after clicking the Source tab',
  ).toBeVisible({ timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Preview → Promote → Production golden path (real UI)', () => {
  // Every scenario needs a real E2E_API_KEY (real session → real site → a real promote to assert).
  test.skip(!realDataAvailable(), 'needs E2E_API_KEY for a real session');

  // ---------------------------------------------------------------------------
  // Scenario 1 — Authenticate and open the Editor for a real site (frame + workbench boot)
  // ---------------------------------------------------------------------------
  test('1. authenticate and boot the editor frame for a real site', async ({ page }) => {
    await authAsSysAdmin(page);
    const { id: siteId, slug } = await resolveSiteOrSkip();
    expect(siteId, 'resolveE2ESite must return a real site id').toBeTruthy();
    expect(slug, 'resolveE2ESite must return a real site slug').toBeTruthy();

    // Drives the REAL admin route + the real cross-origin editor frame + workbench boot.
    const frame = await openEditorFrame(page, siteId);

    // Sanity: the frame is the real editor (its file/workbench tab list is present).
    await expect(frame.getByRole('tab', { name: 'Source', exact: false })).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — Open the editor's Source Control panel (Code → Source Control)
  // ---------------------------------------------------------------------------
  test('2. open the Source Control panel inside the editor frame', async ({ page }) => {
    await authAsSysAdmin(page);
    const { id: siteId } = await resolveSiteOrSkip();

    const frame = await openEditorFrame(page, siteId);
    await openSourceControl(frame);

    // The promote control is part of this panel — it must exist here (visible or disabled),
    // never absent from the panel entirely.
    await expect(
      frame.locator('[data-testid="promote-to-production"]'),
      'the Promote button lives in the Source Control panel',
    ).toBeVisible({ timeout: 20_000 });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — The Promote button renders in Source Control (visible + honest state)
  // ---------------------------------------------------------------------------
  test('3. promote-to-production button renders inside the editor Source Control', async ({ page }) => {
    await authAsSysAdmin(page);
    const { id: siteId } = await resolveSiteOrSkip();

    const frame = await openEditorFrame(page, siteId);
    await openSourceControl(frame);

    const promoteBtn = frame.locator('[data-testid="promote-to-production"]');
    await expect(promoteBtn).toBeVisible({ timeout: 20_000 });

    // Honest control: it is either enabled (something to promote) OR disabled WITH a reason
    // (aria-label/title populated) — never a dead/doomed control with no explanation.
    const isDisabled = await promoteBtn.isDisabled();
    if (isDisabled) {
      const reason = (await promoteBtn.getAttribute('aria-label')) ?? '';
      expect(reason.trim().length, 'a disabled Promote button must carry a reason (aria-label)').toBeGreaterThan(0);
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 4 — Click Promote (when enabled) → status surfaces the HONEST success message
  // ---------------------------------------------------------------------------
  test('4. clicking Promote surfaces a success (or the button is honestly gated)', async ({ page }) => {
    await authAsSysAdmin(page);
    const { id: siteId } = await resolveSiteOrSkip();

    const frame = await openEditorFrame(page, siteId);
    await openSourceControl(frame);

    const promoteBtn = frame.locator('[data-testid="promote-to-production"]');
    await expect(promoteBtn).toBeVisible({ timeout: 20_000 });

    if (await promoteBtn.isDisabled()) {
      // Clean state: Production already matches Preview → nothing to promote. That is the correct
      // "no-op" outcome (idempotent money-path already ran). Assert it's honestly disabled + reasoned,
      // and that Production truth is intact.
      const reason = (await promoteBtn.getAttribute('aria-label')) ?? '';
      expect(reason.trim().length, 'disabled Promote must explain why').toBeGreaterThan(0);
      const releases = await fetchReleases(page, siteId);
      expect(releases.status, '/api/sites/:id/releases must be reachable (flag on for E2E org)').toBe(200);
      return;
    }

    // There IS something to promote → click it (real user action) and watch the honest outcome.
    await promoteBtn.click();

    const status = frame.locator('[data-testid="promote-status"]');
    await expect(status, 'a promote-status region must appear after clicking Promote').toBeVisible({
      timeout: 20_000,
    });

    // Bounded wait for a TERMINAL state — success is the honest confirmation copy. There is NO
    // `data-state` attribute; the outcome is the visible message text (SourceControlPanel.tsx).
    // A `commit_ok_deploy_failed` / `failed` message is a REAL failure — we do NOT accept it as green.
    await expect(status, 'promote must reach a success outcome (Production serving the Preview)').toContainText(
      /Published! Production is now serving your Preview\.|Already live — Production is up to date\./,
      { timeout: PROMOTE_MS },
    );

    // A check-circle icon accompanies the success tone (belt-and-suspenders on the honest surface).
    await expect(status.locator('.i-ph\\:check-circle-fill')).toBeVisible();
  });

  // ---------------------------------------------------------------------------
  // Scenario 5 — Production reflects the promotion: /releases returns a real release
  // ---------------------------------------------------------------------------
  test('5. Production reflects the promotion via GET /api/sites/:id/releases', async ({ page }) => {
    await authAsSysAdmin(page);
    const { id: siteId } = await resolveSiteOrSkip();

    // Record the release count BEFORE (as the real user).
    const before = await fetchReleases(page, siteId);
    expect(before.status, '/api/sites/:id/releases must be reachable (durable_preview on for E2E org)').toBe(200);

    // Drive the real promote through the UI.
    const frame = await openEditorFrame(page, siteId);
    await openSourceControl(frame);
    const promoteBtn = frame.locator('[data-testid="promote-to-production"]');
    await expect(promoteBtn).toBeVisible({ timeout: 20_000 });

    if (await promoteBtn.isDisabled()) {
      // Nothing to promote — Production is already up to date. The MONEY-PATH proof is then that a
      // durable release ALREADY exists with a real revision (the fixture promoted revision), not zero.
      expect(
        before.count,
        'a promoted site must have ≥1 durable release even when the button is idempotently gated',
      ).toBeGreaterThan(0);
      expect(before.latestRevision, 'the latest release must carry a durable revision (commit/artifact)').toBeTruthy();
      expect(before.latestOutcome, 'the latest release outcome must be recorded').toBeTruthy();
      return;
    }

    await promoteBtn.click();
    const status = frame.locator('[data-testid="promote-status"]');
    await expect(status).toContainText(
      /Published! Production is now serving your Preview\.|Already live — Production is up to date\./,
      { timeout: PROMOTE_MS },
    );

    // Production truth: a release now exists carrying a real revision. If the promote wrote a NEW
    // release the count grew; an idempotent replay keeps the count but the top release is real.
    const after = await fetchReleases(page, siteId);
    expect(after.status).toBe(200);
    expect(after.count, 'a real release must exist after promote').toBeGreaterThan(0);
    expect(after.count, 'promote must not lose releases').toBeGreaterThanOrEqual(before.count);
    expect(after.latestRevision, 'the latest release must carry a durable revision hash').toBeTruthy();
    expect(after.latestOutcome, 'the latest release must record its outcome').toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // Scenario 6 — Negative: after a successful promote, Preview == Production → button honestly gated
  // ---------------------------------------------------------------------------
  test('6. Promote button is disabled/reasoned when Preview equals Production', async ({ page }) => {
    await authAsSysAdmin(page);
    const { id: siteId } = await resolveSiteOrSkip();

    const frame = await openEditorFrame(page, siteId);
    await openSourceControl(frame);

    const promoteBtn = frame.locator('[data-testid="promote-to-production"]');
    await expect(promoteBtn).toBeVisible({ timeout: 20_000 });

    // If enabled, promote once to bring Preview == Production.
    if (await promoteBtn.isEnabled()) {
      await promoteBtn.click();
      const status = frame.locator('[data-testid="promote-status"]');
      await expect(status).toContainText(
        /Published! Production is now serving your Preview\.|Already live — Production is up to date\./,
        { timeout: PROMOTE_MS },
      );
      // Re-open Source Control so the gate recomputes off the fresh Preview↔Production sync.
      await frame.getByRole('tab', { name: 'Source', exact: false }).click();
      await expect(frame.locator('[data-testid="source-control-panel"]')).toBeVisible({ timeout: 20_000 });
    }

    // Now nothing should be promotable → the button must be disabled WITH a reason (never enabled+doomed,
    // never a dead control). The button is always present in the panel; it is gated, not removed.
    await expect(promoteBtn).toBeDisabled({ timeout: PROMOTE_MS });
    const reason = (await promoteBtn.getAttribute('aria-label')) ?? '';
    expect(reason.trim().length, 'a disabled Promote button must explain why (aria-label)').toBeGreaterThan(0);
  });
});
