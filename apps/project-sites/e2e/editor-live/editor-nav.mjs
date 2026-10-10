/**
 * editor-nav.mjs — Reusable live-verify helper for the editor Resources panel.
 *
 * ARCHITECTURE (from bolt-embed.service.ts):
 * - The bolt.diy iframe lives at `editor.projectsites.dev` and is PERSISTENT across
 *   admin sub-routes (owned by BoltEmbedService in AdminComponent's template).
 * - The Resources panel (media/files/buckets/automations) gets its data via
 *   PS_RES_* postMessage BRIDGE to the Angular admin PARENT (which holds the bearer
 *   token). It does NOT need WebContainer to boot — it just needs the iframe's React
 *   UI (ResourcesPanel) to mount and the Angular parent to be alive.
 *
 * APPROACH:
 * - Path A: admin at projectsites.dev → auto-select first site → navigate to
 *   /admin/editor → wait for iframe settle → try clicking Resources tab.
 * - Path B (direct): editor directly at bolt-diy-8jf.pages.dev (no CF Access gate,
 *   no admin parent = bridge unavailable, Resources data will error gracefully).
 *
 * m2/m3 (fire-146 — Resources sub-tabs live verify):
 * - verifyResourcesSubTabs() drives each of the 4 sub-tabs (media/files/buckets/
 *   automations) and asserts known testids rendered, collecting per-tab PASS/FAIL
 *   + observed state (data vs empty/disabled vs error) + 0 console errors.
 *
 * Usage:
 *   node apps/project-sites/e2e/editor-live/editor-nav.mjs
 *
 * Env:
 *   E2E_TEST_PASSWORD — test-login password (auto-resolved via get-secret fallback).
 *   PROD_URL          — override the prod base URL (default: https://projectsites.dev).
 *
 * Returns exit code 0 on success, 1 on auth failure, 2 on navigation failure.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchLocalBrowser, getTestPassword, authSeedBrian } from '../admin-verify/_local-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.resolve(__dirname, '../screenshots/editor-live');
const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const DIRECT_EDITOR_URL = 'https://bolt-diy-8jf.pages.dev';

/**
 * Ensure screenshots dir exists.
 */
if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Wait for an element matching `selector` to appear within `timeoutMs`.
 * Returns true if found, false if timed out (never throws).
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @param {number} [timeoutMs=15000]
 */
async function waitForSelector(page, selector, timeoutMs = 15000) {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe for first matching testid inside a frameLocator; return first found.
 * @param {import('@playwright/test').FrameLocator} frame
 * @param {string[]} testids
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<string|null>} first matching testid, or null
 */
async function firstFoundTestId(frame, testids, timeoutMs = 8000) {
  for (const testid of testids) {
    try {
      const loc = frame.locator(`[data-testid="${testid}"]`).first();
      await loc.waitFor({ timeout: timeoutMs, state: 'attached' });
      return testid;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Click an element RELIABLY inside the cross-origin WebContainer iframe.
 * Native `el.click()` (run via evaluate in the frame) fires a real click that
 * React's delegated root listener catches — more reliable than a coordinate
 * force-click (which can land on the WRONG element in a cross-origin iframe —
 * fire-156) or a bare dispatchEvent. Falls through both as backups.
 * @param {import('@playwright/test').FrameLocator} frame
 * @param {string} sel
 */
async function clickReliably(frame, sel) {
  const loc = frame.locator(sel).first();
  try {
    await loc.evaluate((el) => el.click());
    return;
  } catch {
    /* try next */
  }
  try {
    await loc.dispatchEvent('click');
    return;
  } catch {
    /* try next */
  }
  await loc.click({ force: true, timeout: 8000 });
}

/**
 * HONEST active-view check. The workbench top-nav tab reflects `selectedView` via
 * `aria-pressed` (Workbench.client.tsx:451). Every panel stays MOUNTED and inactive
 * layers are `opacity-0 pointer-events-none` (PanelLayer, :653-663) — so Playwright
 * `isVisible()` + `state:'attached'` BOTH return true for a hidden Resources panel
 * (opacity is not part of their visibility model). `aria-pressed === 'true'` is the
 * only signal that the Resources view is actually SHOWING, not just mounted-transparent.
 * @param {import('@playwright/test').FrameLocator} frame
 * @param {string} sel
 * @returns {Promise<boolean>}
 */
async function topTabActive(frame, sel) {
  try {
    const v = await frame.locator(sel).first().getAttribute('aria-pressed');
    return v === 'true';
  } catch {
    return false;
  }
}

/**
 * Save a screenshot with a numeric prefix.
 * @param {import('@playwright/test').Page} page
 * @param {string} label   e.g. '01-admin-shell'
 * @param {string} [dir]   override output dir
 */
async function shot(page, label, dir = SCREENSHOTS_DIR) {
  const dest = path.join(dir, `${label}.png`);
  await page.screenshot({ path: dest, fullPage: false });
  console.log(`[shot] ${dest}`);
  return dest;
}

// ── Tab verification configuration ───────────────────────────────────────────

/**
 * Per-tab probe config. For each Resources sub-tab we:
 *  1. Click the tab button (data-testid="resources-section-<name>")
 *  2. Wait for settlement
 *  3. Assert at least one known testid from the candidates list appears (any = PASS)
 *
 * Candidates are in priority order: most likely to be rendered first.
 * Terminal states (error/disabled/empty) also count as PASS since they prove the
 * panel rendered its honest state — a bridge error is noted as DEGRADED not FAIL.
 */
const TAB_PROBES = [
  {
    name: 'media',
    tabTestId: 'resources-section-media',
    candidates: [
      'resources-media-grid',      // has assets
      'resources-media-empty',     // honest empty launchpad
      'resources-media-skeleton',  // still loading
      'resources-media-count',     // count chip visible (used in any ready state)
      'resources-disabled',        // flag off / bridge disabled
      'resources-error',           // bridge error
    ],
  },
  {
    name: 'files',
    tabTestId: 'resources-section-files',
    candidates: [
      'resources-files-list',     // has files
      'resources-files-empty',    // honest empty
      'resources-files-count',    // count chip visible
      'resources-disabled',       // flag off
      'resources-error',          // bridge error
    ],
  },
  {
    name: 'buckets',
    tabTestId: 'resources-section-buckets',
    candidates: [
      'buckets-list-item',         // has at least one bucket
      'buckets-create',            // create-first CTA = honest empty
      'buckets-skeleton',          // still loading
      'buckets-needs-creds',       // needs R2 credentials
      'resources-disabled',        // flag off
      'resources-error',           // bridge error
    ],
  },
  {
    name: 'automations',
    tabTestId: 'resources-section-automations',
    candidates: [
      'automations-list',          // has automations
      'automations-empty',         // honest empty
      'automations-filter',        // filter bar visible (any loaded state)
      'automations-skeleton',      // still loading
      'automations-disabled',      // flag off / no cron support
      'automations-error',         // bridge error
      'resources-disabled',        // outer disabled
      'resources-error',           // outer error
    ],
  },
  {
    name: 'functions',
    tabTestId: 'resources-section-functions',
    candidates: [
      'functions-list',            // has code-defined functions (deployed worker + crons)
      'functions-empty',           // honest empty launchpad (define them in functions/)
      'functions-skeleton',        // still loading
      'functions-disabled',        // flag off (site_functions dark)
      'functions-error',           // bridge error
      'resources-disabled',        // outer disabled
      'resources-error',           // outer error
    ],
  },
  {
    name: 'connections',
    tabTestId: 'resources-section-connections',
    candidates: [
      'connections-list',          // has connected MCP providers (data)
      'connections-empty',         // honest empty launchpad (connect from Settings → Connections)
      'connections-skeleton',      // still loading
      'connections-disabled',      // flag off (site_connections dark)
      'connections-error',         // bridge error
      'resources-disabled',        // outer disabled
      'resources-error',           // outer error
    ],
  },
];

/**
 * Per-tab state classification from the found testid.
 * @param {string|null} found
 * @returns {'data'|'empty'|'loading'|'disabled'|'error'|'not-rendered'}
 */
function classifyFoundTestId(found) {
  if (!found) return 'not-rendered';
  if (found.includes('error')) return 'error';
  if (found.includes('disabled')) return 'disabled';
  if (found.includes('skeleton') || found.includes('loading')) return 'loading';
  if (found.includes('empty') || found.includes('create') || found.includes('needs-creds')) return 'empty';
  return 'data';
}

// ── m2/m3: Resources sub-tab live verifier ───────────────────────────────────

/**
 * Given a page already authenticated + at /admin/editor with the iframe visible and
 * the Resources tab already clicked (the state fire-145 proved reachable), drive each
 * of the 4 sub-tabs (media/files/buckets/automations) and assert a known testid renders.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').FrameLocator} frame
 * @param {Array<{text:string,url:string}>} consoleErrors - accumulates {text,url} console errors during the run
 * @returns {Promise<Array<{name: string, pass: boolean, state: string, found: string|null, errors: number, screenshot: string}>>}
 */
/**
 * The persistent Preview iframe runs the generated SITE's OWN JS (a WebContainer /
 * StaticBlitz origin) and keeps logging errors in the background even while a Resources
 * sub-tab is shown — so a RAW console-error count mis-attributes that site noise to the
 * editor tab (fire-312: `buckets` falsely read 180). Count only errors from the EDITOR /
 * admin origins; exclude the preview/WebContainer origins. An UNKNOWN origin still counts
 * (never silently hide a real editor error) and the excluded split is logged.
 * @param {{text:string,url:string}} e
 * @returns {boolean} true when the error originates from the background preview iframe
 */
const PREVIEW_NOISE_ORIGIN = /webcontainer|staticblitz|w-corp|local-credentialless|stackblitz/i;
function isPreviewNoise(e) {
  return PREVIEW_NOISE_ORIGIN.test(e && e.url ? e.url : '');
}

async function verifyResourcesSubTabs(page, frame, consoleErrors, resourcesTabSel) {
  const tabResults = [];

  for (const probe of TAB_PROBES) {
    console.log(`\n  ─── Sub-tab: ${probe.name} ───`);

    // The editor auto-switches to Preview once the dev server boots (hasPreview →
    // setSelectedView('preview'), Workbench.client.tsx), which yanks us out of the
    // Resources view mid-run. Re-assert Resources is the ACTIVE view and restore it if
    // not — BEFORE measuring this sub-tab's console errors, so stray Preview-iframe errors
    // aren't mis-attributed to the sub-tab, and the sub-tab is probed while genuinely showing.
    if (resourcesTabSel && !(await topTabActive(frame, resourcesTabSel))) {
      console.log(`  [${probe.name}] Resources view not active (preview auto-switch?) — restoring …`);
      await clickReliably(frame, resourcesTabSel);
      await page.waitForTimeout(1200);
      console.log(`  [${probe.name}] Resources active after restore: ${await topTabActive(frame, resourcesTabSel)}`);
    }

    const errsBefore = consoleErrors.length;

    // Click the sub-tab. A NORMAL click hangs inside the cross-origin WebContainer iframe
    // (the element resolves visible+enabled+stable but the click never settles) — so
    // force-click to bypass the actionability wait, then a DOM dispatchEvent fallback.
    try {
      const tabBtn = frame.locator(`[data-testid="${probe.tabTestId}"]`).first();
      await tabBtn.waitFor({ timeout: 5000, state: 'visible' });
      // Native el.click() (precise, triggers React's delegated onClick) → dispatchEvent →
      // force-click. A coordinate force-click in the cross-origin iframe can land on the
      // wrong element (it hit the Preview top-nav tab in fire-156), so it's the LAST resort.
      await clickReliably(frame, `[data-testid="${probe.tabTestId}"]`);
      await page.waitForTimeout(1500); // let the switched sub-tab's content mount before probing
      console.log(`  [${probe.name}] Tab clicked`);
    } catch (err) {
      console.warn(`  [${probe.name}] Could not click tab: ${err.message}`);
      const sc = await shot(page, `tab-${probe.name}-notfound`);
      tabResults.push({
        name: probe.name,
        pass: false,
        state: 'tab-not-found',
        found: null,
        errors: consoleErrors.slice(errsBefore).filter((e) => !isPreviewNoise(e)).length,
        screenshot: sc,
      });
      continue;
    }

    // Wait for panel to settle
    await page.waitForTimeout(3000);

    // POST-click restore: the one-time preview auto-switch (hasPreview → 'preview') often
    // fires right as the LAST sub-tab (automations) is probed — the dev server finishes
    // booting mid-interaction — yanking the view to Preview AFTER the pre-click check passed.
    // Restore Resources + re-select this sub-tab (up to 2x) so we screenshot the REAL sub-tab,
    // not the Preview iframe (whose site JS also inflates the console-error count).
    for (let fix = 0; fix < 2 && resourcesTabSel && !(await topTabActive(frame, resourcesTabSel)); fix++) {
      console.log(`  [${probe.name}] View yanked off Resources after click — restoring + re-selecting …`);
      await clickReliably(frame, resourcesTabSel);
      await page.waitForTimeout(1000);
      await clickReliably(frame, `[data-testid="${probe.tabTestId}"]`);
      await page.waitForTimeout(1500);
    }

    // Probe for any expected testid
    const found = await firstFoundTestId(frame, probe.candidates, 8000);
    const state = classifyFoundTestId(found);
    const sinceClick = consoleErrors.slice(errsBefore);
    const editorErrors = sinceClick.filter((e) => !isPreviewNoise(e));
    const newErrors = editorErrors.length;
    const excludedPreview = sinceClick.length - newErrors;

    // Capture screenshot
    const sc = await shot(page, `tab-${probe.name}`);

    const pass = found !== null;
    console.log(
      `  [${probe.name}] found=${found ?? 'none'} state=${state} errors=${newErrors}` +
        (excludedPreview > 0 ? ` (+${excludedPreview} preview-iframe noise excluded)` : '') +
        ` pass=${pass}`,
    );
    // Transparency: if the EDITOR-attributed count is non-zero, surface the distinct origins
    // so a real editor error is never masked by the preview-noise filter (fire-312).
    if (newErrors > 0) {
      const origins = [...new Set(editorErrors.map((e) => e.url || '(no-url)'))].slice(0, 4);
      console.log(`  [${probe.name}] counted-error origins: ${origins.join(' | ')}`);
      const sampleTexts = [...new Set(editorErrors.map((e) => (e.text || '').replace(/\s+/g, ' ').slice(0, 180)))].slice(0, 4);
      console.log(`  [${probe.name}] sample error texts: ${sampleTexts.join(' ⋮ ')}`);
    }

    // B1-polish (fire-buckets-b1polish): exercise the Files list⇄grid toggle LIVE so a future fire
    // catches a broken toggle. Best-effort — NEVER fails the buckets probe (try/catch + restore).
    if (probe.name === 'buckets' && pass) {
      try {
        // The one-time preview auto-switch can yank the view off Resources before these extra
        // interaction steps run (it contaminated the grid + menu screenshots pre-fix). Restore
        // Resources + re-select Buckets so the steps act on the REAL panel, not the Preview iframe.
        for (let fix = 0; fix < 2 && resourcesTabSel && !(await topTabActive(frame, resourcesTabSel)); fix++) {
          await clickReliably(frame, resourcesTabSel);
          await page.waitForTimeout(1000);
          await clickReliably(frame, `[data-testid="${probe.tabTestId}"]`);
          await page.waitForTimeout(1500);
        }

        const gridBtn = frame.locator('[data-testid="buckets-view-grid"]').first();

        if (await gridBtn.count()) {
          await clickReliably(frame, '[data-testid="buckets-view-grid"]');
          await page.waitForTimeout(800);

          const gridOn = await firstFoundTestId(
            frame,
            ['buckets-object-grid', 'buckets-objects-needs-creds', 'buckets-objects-empty'],
            4000,
          );
          const gridShot = await shot(page, 'tab-buckets-grid');
          console.log(`  [buckets] view toggle → grid → ${gridOn ?? 'none'} (screenshot ${gridShot})`);

          // Restore list view so other runs keep the default screenshot semantics.
          await clickReliably(frame, '[data-testid="buckets-view-list"]').catch(() => {});
        } else {
          console.log('  [buckets] view toggle not present (older build?) — skipped');
        }
      } catch (e) {
        console.warn(`  [buckets] grid-toggle step skipped: ${e.message}`);
      }
    }

    // B3 (fire-buckets-b3): open a bucket row's actions menu (⋯) LIVE so a future fire catches a
    // broken menu. Real .click() fires the pointer events Radix needs (fallback to clickReliably).
    // Best-effort — NEVER fails the buckets probe (try/catch + Escape to close).
    if (probe.name === 'buckets' && pass) {
      try {
        // Restore Resources+Buckets if the preview auto-switch yanked the view (see the grid step).
        for (let fix = 0; fix < 2 && resourcesTabSel && !(await topTabActive(frame, resourcesTabSel)); fix++) {
          await clickReliably(frame, resourcesTabSel);
          await page.waitForTimeout(1000);
          await clickReliably(frame, `[data-testid="${probe.tabTestId}"]`);
          await page.waitForTimeout(1500);
        }

        const menuBtn = frame.locator('[data-testid="buckets-row-menu-trigger"]').first();

        if (await menuBtn.count()) {
          await menuBtn.click({ timeout: 5000 }).catch(async () => {
            await clickReliably(frame, '[data-testid="buckets-row-menu-trigger"]');
          });
          await page.waitForTimeout(500);

          const menuOpen = await firstFoundTestId(
            frame,
            ['buckets-row-menu-promote', 'buckets-row-menu-address', 'buckets-row-menu-visibility'],
            3000,
          );
          const menuShot = await shot(page, 'tab-buckets-row-menu');
          console.log(`  [buckets] row actions menu → ${menuOpen ?? 'none'} (screenshot ${menuShot})`);

          // Close the menu so it doesn't overlay later probes.
          await page.keyboard.press('Escape').catch(() => {});
        } else {
          console.log('  [buckets] row actions menu trigger not present (older build?) — skipped');
        }
      } catch (e) {
        console.warn(`  [buckets] row-menu step skipped: ${e.message}`);
      }
    }

    tabResults.push({
      name: probe.name,
      pass,
      state,
      found,
      errors: newErrors,
      screenshot: sc,
    });
  }

  return tabResults;
}

// ── PATH A ────────────────────────────────────────────────────────────────────

/**
 * PATH A — admin.projectsites.dev → /admin/editor → Resources tab → sub-tabs.
 *
 * The Angular admin shell MUST be alive for the PS_RES bridge to work.
 * This path fully exercises the real production flow.
 *
 * @param {string} pw
 * @returns {Promise<{ ok: boolean, verdict: string, screenshots: string[], tabResults?: Array }>}
 */
async function pathA_adminEmbed(pw) {
  const screenshots = [];
  const consoleErrors = [];
  const browser = await launchLocalBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    // Collect console errors WITH their origin URL so per-tab counts can exclude the
    // background Preview/WebContainer iframe's site-JS noise (see isPreviewNoise).
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location();
        consoleErrors.push({ text: msg.text(), url: (loc && loc.url) || '' });
      }
    });

    // ── 1. Authenticate ──────────────────────────────────────────────────────
    console.log('[A] Authenticating via test-login seam …');
    const { ok: authOk } = await authSeedBrian(page, pw, PROD_URL);
    if (!authOk) {
      screenshots.push(await shot(page, '01a-auth-failed'));
      return { ok: false, verdict: 'AUTH_FAILED — test-login seam returned no token', screenshots };
    }
    screenshots.push(await shot(page, '01a-homepage-authed'));
    console.log('[A] Auth OK, navigating to /admin …');

    // ── 2. Navigate to /admin ────────────────────────────────────────────────
    await page.goto(`${PROD_URL}/admin`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const shellVisible = await waitForSelector(page, 'app-admin, [data-cockpit="v2"]', 20000);
    if (!shellVisible) {
      screenshots.push(await shot(page, '02a-admin-shell-missing'));
      return {
        ok: false,
        verdict: 'ADMIN_SHELL_NOT_RENDERED — no app-admin/[data-cockpit] found within 20s',
        screenshots,
      };
    }
    screenshots.push(await shot(page, '02a-admin-shell'));
    console.log('[A] Admin shell rendered. Waiting briefly for sites API …');
    await page.waitForTimeout(3000);

    // ── 3. Navigate to /admin/editor ─────────────────────────────────────────
    console.log('[A] Navigating to /admin/editor …');
    await page.goto(`${PROD_URL}/admin/editor`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    screenshots.push(await shot(page, '03a-editor-route-loaded'));

    // ── 4. Wait for the bolt.diy iframe ──────────────────────────────────────
    const iframeFound = await waitForSelector(page, '.bolt-frame', 15000);
    if (!iframeFound) {
      screenshots.push(await shot(page, '04a-iframe-missing'));
      const emptyState = await page.$('.empty-state, [class*="empty"]');
      if (emptyState) {
        return {
          ok: false,
          verdict:
            'NO_SITE_SELECTED — admin shell rendered but no site auto-selected; empty-state visible. Resources panel unreachable without a selected site.',
          screenshots,
        };
      }
      return {
        ok: false,
        verdict:
          'BOLT_FRAME_MISSING — .bolt-frame iframe not found within 15s. Editor route loaded but iframe not mounted.',
        screenshots,
      };
    }
    screenshots.push(await shot(page, '04a-bolt-frame-visible'));
    console.log('[A] .bolt-frame found. Waiting for iframe content to settle …');

    // ── 5. Wait for editor settle (bolt-frame--visible class) ────────────────
    const veilGone = await waitForSelector(page, '.bolt-frame--visible', 20000);
    screenshots.push(await shot(page, '05a-after-veil-wait'));
    if (!veilGone) {
      console.log('[A] bolt-frame--visible not found within 20s — editor may still be booting.');
    }

    // ── 6. Check iframe src ───────────────────────────────────────────────────
    const frameEl = await page.$('.bolt-frame');
    if (!frameEl) {
      return {
        ok: false,
        verdict: 'BOLT_FRAME_ELEMENT_LOST — .bolt-frame disappeared between checks.',
        screenshots,
      };
    }
    const iframeSrc = await frameEl.getAttribute('src') ?? '';
    console.log(`[A] iframe src: ${iframeSrc}`);

    if (!iframeSrc.includes('editor.projectsites.dev') && !iframeSrc.includes('bolt-diy')) {
      screenshots.push(await shot(page, '06a-iframe-wrong-src'));
      return {
        ok: false,
        verdict: `IFRAME_WRONG_SRC — iframe src "${iframeSrc.slice(0, 80)}" is not the editor. BoltEmbedService may not have called bootForSite() yet (no site selected?).`,
        screenshots,
      };
    }

    // ── 7. Try to reach the Resources tab via frameLocator ───────────────────
    console.log('[A] Attempting to reach Resources tab inside iframe …');
    const frame = page.frameLocator('.bolt-frame');
    let resourcesTabVisible = false;
    let resourcesViewActive = false; // HONEST: aria-pressed on the top-nav tab, NOT opacity-0 isVisible
    let resourcesTabSel = null;

    const resourcesSelectors = [
      'button:has-text("Resources")',
      '[data-testid="resources-tab"]',
      '[aria-label*="Resources"]',
      'a:has-text("Resources")',
      '[role="tab"]:has-text("Resources")',
      '.tab:has-text("Resources")',
      'button[title*="Resources"]',
    ];

    for (const sel of resourcesSelectors) {
      try {
        await frame.locator(sel).waitFor({ timeout: 5000, state: 'visible' });
        console.log(`[A] Resources tab found via: ${sel}`);
        resourcesTabVisible = true;
        resourcesTabSel = sel;
        // Click + CONFIRM the view ACTUALLY switched (top-nav tab aria-pressed='true').
        // The old probe checked isVisible() on `resources-section-media`, but every panel
        // stays mounted and the inactive Resources layer is opacity-0 → isVisible()=true
        // even while Code is the showing view (fire-306 caught this lying-green: 4/4 "PASS"
        // while every screenshot showed package.json). Retry the reliable click up to 4x.
        for (let attempt = 1; attempt <= 4 && !resourcesViewActive; attempt++) {
          await clickReliably(frame, sel);
          await page.waitForTimeout(1200);
          resourcesViewActive = await topTabActive(frame, sel);
          console.log(`[A] Resources top-nav tab active (aria-pressed) after click #${attempt}: ${resourcesViewActive}`);
        }
        // Let the just-activated panel settle past its 300ms opacity fade before the shot.
        await page.waitForTimeout(600);
        screenshots.push(await shot(page, '07a-resources-tab-clicked'));
        break;
      } catch {
        // try next selector
      }
    }

    screenshots.push(await shot(page, '08a-editor-final-state'));

    if (!resourcesTabVisible) {
      if (iframeSrc.includes('editor.projectsites.dev') || iframeSrc.includes('bolt-diy')) {
        return {
          ok: false,
          verdict:
            'EDITOR_IFRAME_LOADED_BUT_RESOURCES_TAB_MISSING — bolt.diy iframe reached editor origin but Resources tab selectors not found. Sub-tab verification not possible.',
          screenshots,
        };
      }
      return {
        ok: false,
        verdict: 'EDITOR_UI_NOT_READY — iframe present but editor UI not painting within allotted time.',
        screenshots,
      };
    }

    // HONEST gate: the Resources tab was found + clicked, but did the VIEW actually switch?
    // If aria-pressed never became true, the Resources panel is NOT the showing view (Code
    // stayed active) — report that truthfully instead of green-lighting opacity-0 sub-tabs.
    if (!resourcesViewActive) {
      screenshots.push(await shot(page, '08a-resources-view-not-active'));
      return {
        ok: false,
        verdict:
          'RESOURCES_VIEW_DID_NOT_ACTIVATE — clicked the Resources top-nav tab but aria-pressed never became true; Code remained the showing panel. The always-mounted opacity-0 PanelLayer makes attached/isVisible on sub-tab testids a FALSE-GREEN; this gate catches the real state (fire-306).',
        screenshots,
      };
    }

    // ── 8. m2/m3: Verify all 4 Resources sub-tabs ───────────────────────────
    console.log('\n[A] ═══ m2/m3: Resources sub-tab live verification ═══');

    // First check if Resources sub-tab controls are reachable
    const resourcesPanelTestId = await firstFoundTestId(
      frame,
      ['resources-section-media', 'resources-section-files', 'resources-section-buckets', 'resources-section-automations'],
      8000,
    );

    if (!resourcesPanelTestId) {
      screenshots.push(await shot(page, '08a-resources-panel-no-subtabs'));
      return {
        ok: false,
        verdict:
          'RESOURCES_PANEL_SUBTABS_NOT_FOUND — Resources tab was clicked but sub-tab controls not found within 8s. Panel may need more boot time.',
        screenshots,
      };
    }

    console.log(`[A] Resources sub-tab controls reachable (found: ${resourcesPanelTestId})`);

    const tabResults = await verifyResourcesSubTabs(page, frame, consoleErrors, resourcesTabSel);
    const tabScreenshots = tabResults.map((t) => t.screenshot);

    // Summarise
    const allPass = tabResults.every((t) => t.pass);
    const passCount = tabResults.filter((t) => t.pass).length;
    const verdictParts = tabResults.map((t) => `${t.name}:${t.pass ? 'PASS' : 'FAIL'}(${t.state})`);

    return {
      ok: allPass,
      verdict: `RESOURCES_SUBTAB_LIVE_VERIFY — ${passCount}/4 tabs PASS — ${verdictParts.join(' | ')}`,
      screenshots: [...screenshots, ...tabScreenshots],
      tabResults,
    };
  } finally {
    await browser.close();
  }
}

/**
 * PATH B — direct bolt-diy-8jf.pages.dev (no CF Access, no Angular parent).
 *
 * In this path there is NO admin parent to handle PS_RES_* postMessages, so
 * the Resources panel will mount but data requests will fail silently.
 * Useful for editor-shell smoke only.
 *
 * @returns {Promise<{ ok: boolean, verdict: string, screenshots: string[] }>}
 */
async function pathB_directEditor() {
  const screenshots = [];
  const browser = await launchLocalBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    console.log('[B] Navigating directly to bolt-diy-8jf.pages.dev …');
    try {
      await page.goto(DIRECT_EDITOR_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr) {
      screenshots.push(await shot(page, '01b-direct-nav-error'));
      return {
        ok: false,
        verdict: `DIRECT_NAV_FAILED — ${navErr.message}`,
        screenshots,
      };
    }
    await page.waitForTimeout(3000);
    screenshots.push(await shot(page, '01b-direct-homepage'));

    const title = await page.title();
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (
      title.toLowerCase().includes('access') ||
      bodyText.toLowerCase().includes('verify you are human')
    ) {
      return {
        ok: false,
        verdict: `DIRECT_PATH_CF_GATED — bolt-diy-8jf.pages.dev is behind Cloudflare Access ("${title}"). Direct path not usable headlessly.`,
        screenshots,
      };
    }

    const shellFound = await waitForSelector(
      page,
      '[data-testid="workbench"], .workbench, [class*="workbench"], #app, #root',
      20000,
    );
    screenshots.push(await shot(page, '02b-direct-shell'));

    if (!shellFound) {
      return {
        ok: false,
        verdict:
          'DIRECT_SHELL_NOT_FOUND — direct editor URL loaded but no workbench/root element found. Page may require a slug param.',
        screenshots,
      };
    }

    return {
      ok: true,
      verdict:
        'DIRECT_PATH_REACHABLE — bolt-diy-8jf.pages.dev accessible headlessly. Shell UI found. NOTE: no Angular parent = PS_RES bridge absent = Resources data will error gracefully. Direct path is useful for editor-shell smoke only.',
      screenshots,
    };
  } finally {
    await browser.close();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const startEpoch = Date.now();
  console.log(`[editor-nav] START ${new Date(startEpoch).toLocaleTimeString()}`);

  const pw = getTestPassword();
  if (!pw) {
    console.error('[editor-nav] E2E_TEST_PASSWORD not available — cannot authenticate for Path A.');
    console.log('[editor-nav] Running Path B (unauthenticated direct editor) only …\n');
  }

  const results = {};

  // ── Path A (admin embed, full bridge) ────────────────────────────────────
  if (pw) {
    console.log('\n═══ PATH A: Admin Embed (full bridge) ═══');
    try {
      results.pathA = await pathA_adminEmbed(pw);
    } catch (err) {
      results.pathA = {
        ok: false,
        verdict: `PATH_A_EXCEPTION — ${err.message}`,
        screenshots: [],
      };
      console.error('[A] Unhandled exception:', err.message);
    }
    console.log(`\n[A] Result: ${results.pathA.ok ? '✓ OK' : '✗ FAIL'}`);
    console.log(`[A] Verdict: ${results.pathA.verdict}`);

    if (results.pathA.tabResults) {
      console.log('\n[A] Per-tab verdicts:');
      for (const t of results.pathA.tabResults) {
        const marker = t.pass ? '  ✓' : '  ✗';
        console.log(`${marker} ${t.name.padEnd(12)} state=${t.state.padEnd(12)} found=${(t.found ?? 'NONE').padEnd(35)} errors=${t.errors} screenshot=${path.basename(t.screenshot)}`);
      }
    }
    console.log(`[A] Screenshots: ${results.pathA.screenshots.join(', ')}`);
  }

  // ── Path B (direct editor, no bridge) ────────────────────────────────────
  console.log('\n═══ PATH B: Direct Editor (no bridge) ═══');
  try {
    results.pathB = await pathB_directEditor();
  } catch (err) {
    results.pathB = {
      ok: false,
      verdict: `PATH_B_EXCEPTION — ${err.message}`,
      screenshots: [],
    };
    console.error('[B] Unhandled exception:', err.message);
  }
  console.log(`[B] Result: ${results.pathB.ok ? '✓ OK' : '✗ FAIL'}`);
  console.log(`[B] Verdict: ${results.pathB.verdict}`);
  console.log(`[B] Screenshots: ${results.pathB.screenshots.join(', ')}`);

  // ── Final feasibility verdict ─────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startEpoch) / 1000);
  console.log(`\n═══ FEASIBILITY VERDICT (${elapsed}s elapsed) ═══`);
  const pathAOk = results.pathA?.ok ?? false;
  const pathBOk = results.pathB?.ok ?? false;

  if (pathAOk) {
    console.log('VERDICT: FEASIBLE via Path A (admin embed). All 4 Resources sub-tabs live-verified.');
    process.exit(0);
  } else if (results.pathA?.tabResults) {
    // Partial: reached sub-tabs but some failed
    const passCount = results.pathA.tabResults.filter((t) => t.pass).length;
    if (passCount > 0) {
      console.log(`VERDICT: PARTIALLY VERIFIED via Path A — ${passCount}/4 sub-tabs rendered live.`);
      console.log('Details:', results.pathA.verdict);
      process.exit(0);
    }
    console.log('VERDICT: PATH A reached editor but NO sub-tabs rendered live.');
    console.log('Details:', results.pathA.verdict);
    process.exit(2);
  } else if (pathBOk) {
    console.log('VERDICT: PARTIALLY FEASIBLE via Path B (direct editor, no bridge).');
    console.log('Path A (admin embed) failed:', results.pathA?.verdict);
    process.exit(0);
  } else {
    console.log('VERDICT: NOT FEASIBLE headlessly via either path.');
    console.log('Path A:', results.pathA?.verdict);
    console.log('Path B:', results.pathB?.verdict);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[editor-nav] Fatal error:', err);
  process.exit(1);
});
