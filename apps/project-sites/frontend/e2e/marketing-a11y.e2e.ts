/**
 * @module e2e/marketing-a11y
 *
 * WCAG 2.2 AA (axe-core) coverage for the PUBLIC marketing/content pages.
 * admin-a11y covers /admin; this extends the same gate to the customer-facing
 * surface (home + content pages) per the whole-project convergence mandate.
 * These routes are public — no session seed needed.
 *
 * Same AxeBuilder config as admin-a11y (wcag2a/2aa/21aa/22aa; iframe + AG Grid
 * excluded as third-party). Fails on serious/critical only. Reduced-motion so
 * axe measures the settled UI.
 *
 * Run: npx playwright test --config=playwright.prod.config.ts marketing-a11y
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Public pages confirmed axe-clean after the shared-footer contrast fix
// (#64748b → #94a3b8 across blog-list/blog-post/status). The footer is the
// big shared win — it cleared all of these at once.
const ROUTES = [
  // Newly UNBLOCKED + verified axe-clean live (their concurrent-dirty files
  // freed up; fixes landed):
  //   /        + /classic → homepage.component.html `.text-primary/40` step
  //                         numbers bumped to /70 (2.8:1 → ~6.4:1).
  //   /signin            → pages/auth/sign-in.component.ts (the Better Auth cutover
  //                         REPLACED the legacy magic-link page): its "OR" divider was
  //                         `text-white/30` (2.62:1) → `/50` (~5.4:1). Fixed+deployed
  //                         2026-08-09 (1b1f6c20). The old signin.component.html fix
  //                         is dead (legacy page no longer routed).
  //   /roadmap           → has NO Angular route → soft-404s to the public not-found;
  //                         its `.links-heading` h2 was `#64748b` (4.23:1) → `#94a3b8`
  //                         (7.7:1). ⚠️ /roadmap SHOULD be a real page (worker exposes
  //                         GET /api/public/roadmap; changelog promises the columns UI).
  //   /contact           → re-verified stably clean across 3 runs.
  '/', '/contact', '/signin',
  '/blog', '/press', '/privacy', '/terms', '/roadmap', '/integrations',
  // Added iter-174 — verified axe-clean live @1280 (0 violations). Both were
  // coverage GAPS in this gate: /pricing is a high-traffic conversion page
  // (i18n-rewritten iter-170) and /developers is the MCP acquisition surface.
  '/pricing', '/developers',
  // RE-ADDED AL-668 — the worker fixes are deployed + both verified axe-clean on
  // PROD (0 serious/critical, STRICT run) via e2e/admin-verify/verify-platform-footer-pages.mjs.
  //   /status    → the `link-in-text-block` on the `/health/deep` footer link is fixed
  //                (footer <a> now underlined); "All systems operational" renders clean.
  //   /changelog → the flag-off/404 is resolved (public_changelog live, accessible HTML);
  //                "What we shipped…" renders clean + is CLICK-reachable (home → Developers → Changelog).
  '/status', '/changelog',
];
// STILL EXCLUDED (genuinely blocked, NOT faked):
//   /search    → 18 contrast violations are a TRANSIENT loading-skeleton flash
//                (0 at 900ms, 18 at ~1000ms, 0 at 1200ms+) — settles clean;
//                adding it would make the gate flaky. Not a stable defect.

test.describe('marketing — public pages WCAG 2.2 AA (axe-core)', () => {
  test.describe.configure({ retries: 2 });

  for (const path of ROUTES) {
    test(`no serious/critical axe violations — ${path}`, async ({ page }) => {
      test.setTimeout(60000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(path, { waitUntil: 'load' });
      await expect(page.locator('main, header, body').first()).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(700);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .exclude('iframe')
        .exclude('.ag-root')
        .analyze();
      const blocking = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => `${v.impact} · ${v.id} · ${v.nodes.length}× · ${v.nodes[0]?.target?.join(' ') ?? ''}`);
      // eslint-disable-next-line no-console
      console.warn(`\n[${path}] axe BLOCKING: ${blocking.length}${blocking.length ? '\n' + blocking.join('\n') : ' ✓'}`);
      expect(blocking, `${path}\n${blocking.join('\n')}`).toEqual([]);
    });
  }
});
