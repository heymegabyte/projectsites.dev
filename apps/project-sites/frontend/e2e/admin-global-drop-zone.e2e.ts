/**
 * @module e2e/admin-global-drop-zone
 *
 * FULL-JOURNEY TDD — the admin-shell-wide drag-and-drop upload
 * (`GlobalDropZoneComponent`, rendered in `admin.component.html`) was WIRED + LIVE
 * on every `/admin/*` route but had ZERO end-to-end coverage (a FEATURES.md gap).
 * This proves the whole journey against the LIVE deployed bundle, sub-action by
 * sub-action:
 *   1. a NON-file drag (text/plain) is IGNORED — no overlay (the `hasFiles` gate).
 *   2. dragging FILES over the window reveals the fullscreen overlay dialog with
 *      the correct a11y contract (role=dialog, aria-modal, labelled + described).
 *   3. the revealed overlay is axe-clean.
 *   4. dragging OUT (dragleave) hides the overlay again (dragDepth → 0).
 *   5. DROPPING a file fires a real multipart `POST /api/media/upload` and surfaces
 *      an upload toast (the causal drop → upload → feedback chain).
 *   6. ZERO console errors across the whole journey.
 *
 * The component binds `window` drag listeners, so any `/admin/*` route exercises it;
 * we use `/admin/forms` (a non-editor section — no persistent bolt iframe composited
 * over the shell). Drags are dispatched as real `DragEvent`s carrying a `DataTransfer`
 * (a 1×1 PNG for the file case), exactly as a browser delivers an OS file drag.
 *
 * Seeds `ps_session` from `E2E_API_KEY`. Run: `npm run test:e2e:prod`.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const KEY = process.env.E2E_API_KEY ?? '';

/**
 * In-page helper source — dispatches window DragEvents carrying a DataTransfer.
 * `kind: 'files'` adds a real 1×1 PNG File (so `dataTransfer.types` includes
 * 'Files' AND `dataTransfer.files` is populated on drop); `kind: 'text'` carries
 * only text/plain (the ignore path). The DataTransfer is stashed on `window` so
 * dragenter and drop share ONE transfer (the file survives to the drop handler).
 */
const DRAG_HELPERS = `
  window.__e2eMakeDT = (kind) => {
    const dt = new DataTransfer();
    if (kind === 'files') {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], 'e2e-drop.png', { type: 'image/png' }));
    } else {
      dt.setData('text/plain', 'just some text, not a file');
    }
    window.__e2eDT = dt;
    return Array.from(dt.types);
  };
  window.__e2eFire = (type) => {
    window.dispatchEvent(new DragEvent(type, { dataTransfer: window.__e2eDT, bubbles: true, cancelable: true }));
  };
`;

test.describe('admin global drop-zone — drag-anywhere upload journey (live bundle)', () => {
  test.describe.configure({ retries: 1 });

  test.skip(!KEY, 'E2E_API_KEY not set');

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((k: string) => {
      try {
        localStorage.setItem(
          'ps_session',
          JSON.stringify({ token: k, identifier: 'test@megabyte.space', createdAt: Date.now() }),
        );
      } catch {
        /* ignore */
      }
    }, KEY);
    await page.addInitScript(DRAG_HELPERS);
  });

  test('full journey: text-drag ignored → file-drag reveals a11y dialog → leave hides → drop uploads', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // Third-party/analytics noise + the component's OWN best-effort upload-failed
      // warn (a console.warn, not error) are out of scope; capture genuine errors.
      if (/favicon|Failed to load resource|net::ERR|sentry|posthog|gtag|google-analytics/i.test(t)) return;
      consoleErrors.push(t.slice(0, 140));
    });

    // Homepage first, then the seeded admin route (the shell + drop-zone mount).
    await page.goto('/', { waitUntil: 'load' });
    await page.goto('/admin/forms', { waitUntil: 'load' });
    await expect(page.locator('.admin-sidebar, app-admin, [data-cockpit]').first()).toBeVisible({
      timeout: 30000,
    });

    const overlay = page.locator('.gdz-overlay');

    // 1. NON-file drag (text) is IGNORED — no overlay.
    await page.evaluate(() => (window as unknown as { __e2eMakeDT: (k: string) => string[] }).__e2eMakeDT('text'));
    await page.evaluate(() => (window as unknown as { __e2eFire: (t: string) => void }).__e2eFire('dragenter'));
    await expect(overlay).toHaveCount(0);

    // 2. Dragging FILES reveals the overlay dialog.
    const types = await page.evaluate(
      () => (window as unknown as { __e2eMakeDT: (k: string) => string[] }).__e2eMakeDT('files'),
    );
    expect(types).toContain('Files'); // the exact signal `hasFiles()` gates on
    await page.evaluate(() => (window as unknown as { __e2eFire: (t: string) => void }).__e2eFire('dragenter'));
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // 2b. a11y contract of the revealed dialog.
    await expect(overlay).toHaveAttribute('role', 'dialog');
    await expect(overlay).toHaveAttribute('aria-modal', 'true');
    await expect(overlay).toHaveAttribute('aria-labelledby', 'gdz-title');
    await expect(overlay).toHaveAttribute('aria-describedby', 'gdz-help');
    await expect(page.locator('#gdz-title')).toHaveText(/drop files to add to media/i);

    // 3. The overlay is axe-clean.
    const axe = await new AxeBuilder({ page }).include('.gdz-overlay').analyze();
    expect(axe.violations, JSON.stringify(axe.violations.map((v) => v.id))).toEqual([]);

    // 4. Dragging OUT hides the overlay (dragDepth returns to 0).
    await page.evaluate(() => (window as unknown as { __e2eFire: (t: string) => void }).__e2eFire('dragleave'));
    await expect(overlay).toBeHidden({ timeout: 5000 });

    // 5. DROP → real multipart POST /api/media/upload → an upload toast appears.
    await page.evaluate(() => (window as unknown as { __e2eMakeDT: (k: string) => string[] }).__e2eMakeDT('files'));
    await page.evaluate(() => (window as unknown as { __e2eFire: (t: string) => void }).__e2eFire('dragenter'));
    await expect(overlay).toBeVisible();

    const uploadReq = page.waitForRequest(
      (r) => r.url().includes('/api/media/upload') && r.method() === 'POST',
      { timeout: 15000 },
    );
    await page.evaluate(() => (window as unknown as { __e2eFire: (t: string) => void }).__e2eFire('drop'));
    const req = await uploadReq; // real request to prod — proves drop → FormData POST
    expect(req.method()).toBe('POST');
    // Drop dismisses the overlay immediately, then a toast reports upload progress/result.
    await expect(overlay).toBeHidden({ timeout: 5000 });
    await expect(page.locator('app-toast, .toast, [role="status"], [role="alert"]').first()).toBeVisible({
      timeout: 15000,
    });

    // 6. No genuine console errors across the journey.
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
