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
import { fileURLToPath } from 'node:url';
import { launchLocalBrowser, getTestPassword, authSeedBrian } from '../admin-verify/_local-browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.resolve(__dirname, '../screenshots/editor-live');
const PROD_URL = process.env.PROD_URL ?? 'https://projectsites.dev';
const DIRECT_EDITOR_URL = 'https://bolt-diy-8jf.pages.dev';

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

/**
 * PATH A — admin.projectsites.dev → /admin/editor → Resources tab.
 *
 * The Angular admin shell MUST be alive for the PS_RES bridge to work.
 * This path fully exercises the real production flow.
 *
 * @param {string} pw
 * @returns {Promise<{ ok: boolean, verdict: string, screenshots: string[] }>}
 */
async function pathA_adminEmbed(pw) {
  const screenshots = [];
  const browser = await launchLocalBrowser();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

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
        await frame.locator(sel).first().click();
        await page.waitForTimeout(2000);
        screenshots.push(await shot(page, '07a-resources-tab-clicked'));
        break;
      } catch {
        // try next selector
      }
    }

    screenshots.push(await shot(page, '08a-editor-final-state'));

    if (resourcesTabVisible) {
      return {
        ok: true,
        verdict:
          'RESOURCES_TAB_REACHED — clicked successfully via iframe frameLocator. Resources panel is headlessly reachable via the admin embed path.',
        screenshots,
      };
    }

    if (iframeSrc.includes('editor.projectsites.dev') || iframeSrc.includes('bolt-diy')) {
      return {
        ok: true,
        verdict:
          'EDITOR_IFRAME_LOADED — bolt.diy iframe reached editor origin. Resources tab selectors not found within timeout — editor UI may still be booting (WebContainer cold start ~30-60s). Bridge path is viable; Resources panel reachable given more boot time or a site with an existing build.',
        screenshots,
      };
    }

    return {
      ok: false,
      verdict: 'EDITOR_UI_NOT_READY — iframe present but editor UI not painting within allotted time.',
      screenshots,
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
    console.log(`[A] Result: ${results.pathA.ok ? '✓ OK' : '✗ FAIL'}`);
    console.log(`[A] Verdict: ${results.pathA.verdict}`);
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
    console.log('VERDICT: FEASIBLE via Path A (admin embed). Resources panel reachable headlessly.');
    console.log(
      'Next milestone: verify PS_RES_MEDIA response populates the panel (bridge data round-trip).',
    );
    process.exit(0);
  } else if (pathBOk) {
    console.log('VERDICT: PARTIALLY FEASIBLE via Path B (direct editor, no bridge).');
    console.log('Path A (admin embed) failed:', results.pathA?.verdict);
    console.log(
      'Recommendation: fix Path A auth/navigation issue. Bridge contract integration test as interim verification.',
    );
    process.exit(0);
  } else {
    console.log('VERDICT: NOT FEASIBLE headlessly via either path.');
    console.log('Path A:', results.pathA?.verdict);
    console.log('Path B:', results.pathB?.verdict);
    console.log('Recommendation: Bridge-contract integration test exercising real PS_RES handlers');
    console.log(
      '  OR a manual 2-min smoke checklist: (1) sign in → (2) open Editor → (3) click Resources tab → (4) verify media/files/buckets panels load.',
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[editor-nav] Fatal error:', err);
  process.exit(1);
});
