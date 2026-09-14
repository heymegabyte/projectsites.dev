/**
 * _capture-helpers.mjs — canonical "wait for async UI to SETTLE before screenshot" helper,
 * shared by every admin-verify capture tool (admin-vision-shots, visual-sweep, …).
 *
 * WHY: a full-page / section screenshot taken BEFORE lazy child widgets resolve captures
 * their loading SKELETONS (and pre-roll phantom-0 counters) that no real user ever sees →
 * false "stuck skeleton" / "lying-empty" findings every vision-inspection fire. That class
 * burned AL-550 (billing usage-gauges + credit-wallet shimmered mid-flight in a capture and
 * looked like a lying-loading bug; probing the resolved state proved the product healthy).
 * Each capture tool used to roll its own drifting version of this wait — this is the single
 * source of truth so a new tool can't re-introduce the artifact.
 *
 * waitForCaptureSettle: (1) let the network go idle, then (2) poll until no loading-skeleton
 * element remains — BOTH bounded, so a GENUINELY stuck skeleton is still captured (and
 * surfaced by hasLoadingSkeleton) after the cap rather than hanging the tool.
 */

/**
 * Union of every loading-affordance selector the admin SPA uses across sections/widgets.
 * Superset of each tool's prior hand-rolled set, so adopting it only ever waits for MORE
 * skeleton types (never fewer) — behavior-preserving for callers that had a narrower set.
 */
export const CAPTURE_SKELETON_SEL =
  '[aria-busy="true"], .animate-pulse, .skeleton, .loading-skeleton, [data-loading="true"], [data-testid$="-skeleton"]';

/**
 * Wait for a page's async content to settle before a screenshot.
 * @param {import('playwright').Page} page
 * @param {{ idleMs?: number, skelMs?: number }} [opts] bounded timeouts (network-idle, skeleton-gone).
 * @returns {Promise<void>} resolves when settled OR when the bounds elapse (never rejects).
 * @example await waitForCaptureSettle(page); await page.screenshot({ path, fullPage: true });
 */
export async function waitForCaptureSettle(page, { idleMs = 6000, skelMs = 8000 } = {}) {
  // (1) Network idle — bounded + caught (the admin shell's 30s/60s pollers + bolt-iframe
  //     WebContainer stream mean full idle may never arrive; best-effort quiet is enough).
  await page.waitForLoadState('networkidle', { timeout: idleMs }).catch(() => {});
  // (2) No loading-skeleton element left — bounded so a REAL stuck skeleton survives the cap
  //     and is surfaced by hasLoadingSkeleton() rather than hanging the capture.
  await page
    .waitForFunction((sel) => !document.querySelector(sel), CAPTURE_SKELETON_SEL, {
      timeout: skelMs,
      polling: 200,
    })
    .catch(() => {});
}

/**
 * True when a loading-skeleton element is still present (i.e. survived waitForCaptureSettle) —
 * a genuinely stuck async widget the capture should flag, not a slow-but-resolving one.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 * @example if (await hasLoadingSkeleton(page)) console.log('⚠ stuck skeleton');
 */
export async function hasLoadingSkeleton(page) {
  return page.evaluate((sel) => !!document.querySelector(sel), CAPTURE_SKELETON_SEL);
}
