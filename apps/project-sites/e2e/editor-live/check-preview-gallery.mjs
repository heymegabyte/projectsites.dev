/**
 * check-preview-gallery.mjs — headless visual-QA of the editor's /_preview panel gallery
 * (fire-159: the embed-only gate now exempts /_preview). No auth, no WebContainer boot — a plain
 * top-level nav renders every shared workbench panel primitive for a clean screenshot.
 *   node apps/project-sites/e2e/editor-live/check-preview-gallery.mjs
 */
import { mkdirSync } from 'node:fs';
import { launchLocalBrowser } from '../admin-verify/_local-browser.mjs';

const URL = (process.env.PROD_URL ?? 'https://editor.projectsites.dev') + '/_preview';
const OUT = 'e2e/screenshots/editor-live';
mkdirSync(OUT, { recursive: true });

const browser = await launchLocalBrowser();
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 2200 });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  const res = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
  const title = await page.title();
  const bodyLen = await page.evaluate(() => document.body.innerText.length);
  // Assert the BucketsTwoPane frame (fire-162) actually rendered — the gate must prove the data-bound
  // two-pane layout + its min-w-0 object pane paint headlessly, not merely that the page title loaded.
  const twoPane = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="buckets-two-pane"]');
    const obj = document.querySelector('[data-testid="buckets-object-pane"]');
    return { present: !!pane && !!obj, objMinW0: obj ? obj.className.includes('min-w-0') : false };
  });
  const shot = `${OUT}/preview-gallery.png`;
  await page.screenshot({ path: shot, fullPage: true });
  const realErrors = errors.filter((e) => !/getContext|WebGL|canvas/i.test(e));
  console.log(`[preview] GET /_preview → ${res?.status()} · title: "${title}" · body chars: ${bodyLen} · console errors: ${realErrors.length}`);
  console.log(`[preview] BucketsTwoPane present: ${twoPane.present} · object pane min-w-0: ${twoPane.objMinW0}`);
  console.log(`[preview] screenshot: ${shot}`);
  const ok = res?.status() === 200 && /Gallery/i.test(title) && twoPane.present && twoPane.objMinW0 && realErrors.length === 0;
  console.log(
    ok
      ? 'VERDICT: ✅ /_preview gallery reachable headlessly — panel primitives + BucketsTwoPane (min-w-0 object pane) rendered + screenshotted.'
      : `VERDICT: ⚠ status ${res?.status()} / title "${title}" / twoPane ${twoPane.present} / minW0 ${twoPane.objMinW0} / errors ${realErrors.length}.`,
  );
  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
