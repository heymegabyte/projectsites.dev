/**
 * check-buckets-populated.mjs — the DURABLE visual-regression gate for the editor's `/_preview`
 * POPULATED Buckets gallery. Proves the filled bucket renders DISTINCT file-type icons (one glyph
 * PER extension family, never one generic file icon for everything) — the permanent proof behind
 * Brian's "file-type icons on a populated bucket" mandate.
 *
 *   node apps/project-sites/e2e/editor-live/check-buckets-populated.mjs
 *   (PROD_URL overrides the default origin; defaults to https://editor.projectsites.dev)
 *
 * Modeled on the sibling `check-preview-gallery.mjs`: same `launchLocalBrowser()`, same `/_preview`
 * target, same screenshot-and-exitCode shape, same WebGL/canvas console-noise filter. No auth, no
 * WebContainer boot — a plain top-level nav renders the static gallery.
 *
 * WHAT IT ASSERTS (the distinct-icon proof):
 *   1. The populated sample `[data-testid="buckets-populated-sample"]` is present, AND both the
 *      `buckets-object-list` + `buckets-object-grid` views render inside it (list + grid both prove
 *      the icon vocabulary in each layout).
 *   2. Within the populated sample ONLY, every element whose class contains `i-ph:` is collected and
 *      reduced to the DISTINCT set of `i-ph:*` icon classes. The gate requires >= 10 distinct
 *      file-type icon classes — the real `iconForObject()` (BucketsPanel.tsx) maps 11 extension
 *      families to 11 glyphs, so a gallery exercising diverse keys clears 10 easily; a regression to
 *      a single generic `i-ph:file-duotone` for every row collapses the count and fails here.
 *   3. At least one `folder` icon and one `image` icon are present (core proof the sample shows both
 *      a directory affordance and a recognised image type, not just abstract file rows).
 *
 * NOTE (fire-buckets-b5-slice3): a parallel agent is still building the populated sample. Until that
 * ships to prod this probe is EXPECTED to fail the distinct-icon assertion — that is honest RED, not
 * a script bug. The script PARSES + RUNS regardless; the VERDICT line says exactly why.
 */
import { mkdirSync } from 'node:fs';
import { launchLocalBrowser } from '../admin-verify/_local-browser.mjs';

const URL = (process.env.PROD_URL ?? 'https://editor.projectsites.dev') + '/_preview';
const OUT = 'e2e/screenshots/editor-live';
const MIN_DISTINCT_ICONS = 10;
mkdirSync(OUT, { recursive: true });

const browser = await launchLocalBrowser();
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 2600 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

try {
  const res = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500); // let the static gallery settle (matches the sibling)

  const title = await page.title();

  // Collect icon evidence FROM THE POPULATED SAMPLE ONLY — scoping to the sample is what makes this
  // a proof of the FILLED gallery and not of incidental chrome icons elsewhere on the page.
  const probe = await page.evaluate(() => {
    const sample = document.querySelector('[data-testid="buckets-populated-sample"]');
    const list = sample?.querySelector('[data-testid="buckets-object-list"]') ?? null;
    const grid = sample?.querySelector('[data-testid="buckets-object-grid"]') ?? null;

    // Every `i-ph:<name>` token inside the sample → the DISTINCT set of icon class names.
    const distinct = new Set();
    if (sample) {
      for (const el of sample.querySelectorAll('[class*="i-ph:"]')) {
        for (const cls of String(el.className).split(/\s+/)) {
          if (cls.startsWith('i-ph:')) distinct.add(cls);
        }
      }
    }
    const icons = [...distinct].sort();
    return {
      samplePresent: !!sample,
      listPresent: !!list,
      gridPresent: !!grid,
      icons,
      distinctCount: icons.length,
      hasFolder: icons.some((c) => /folder/.test(c)),
      hasImage: icons.some((c) => /image/.test(c)),
    };
  });

  const shot = `${OUT}/buckets-populated.png`;
  await page.screenshot({ path: shot, fullPage: true });

  // Same WebGL/canvas console-noise filter as the sibling gallery probe.
  const realErrors = errors.filter((e) => !/getContext|WebGL|canvas/i.test(e));

  const enoughDistinct = probe.distinctCount >= MIN_DISTINCT_ICONS;
  const ok =
    res?.status() === 200 &&
    probe.samplePresent &&
    probe.listPresent &&
    probe.gridPresent &&
    enoughDistinct &&
    probe.hasFolder &&
    probe.hasImage &&
    realErrors.length === 0;

  console.log(
    `[buckets-populated] GET /_preview → ${res?.status()} · title: "${title}" · console errors: ${realErrors.length}`,
  );
  console.log(
    `[buckets-populated] sample: ${probe.samplePresent} · object-list: ${probe.listPresent} · object-grid: ${probe.gridPresent}`,
  );
  console.log(
    `[buckets-populated] distinct i-ph icons in sample: ${probe.distinctCount} (need >= ${MIN_DISTINCT_ICONS}) · folder: ${probe.hasFolder} · image: ${probe.hasImage}`,
  );
  console.log(`[buckets-populated] icons: ${probe.icons.join(', ') || '(none)'}`);
  console.log(`[buckets-populated] screenshot: ${shot}`);

  if (ok) {
    console.log(
      `VERDICT: ✅ populated Buckets gallery renders ${probe.distinctCount} DISTINCT file-type icons (folder + image present) across list + grid — distinct-icon gate GREEN.`,
    );
  } else if (!probe.samplePresent) {
    console.log(
      'VERDICT: ⚠ buckets-populated-sample NOT present on /_preview — the populated gallery is not deployed yet (expected until the parallel sample ships). Distinct-icon gate PENDING-DEPLOY.',
    );
  } else {
    console.log(
      `VERDICT: ⚠ populated gate NOT green — status ${res?.status()} / list ${probe.listPresent} / grid ${probe.gridPresent} / distinct ${probe.distinctCount} (need >= ${MIN_DISTINCT_ICONS}) / folder ${probe.hasFolder} / image ${probe.hasImage} / errors ${realErrors.length}.`,
    );
  }

  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
