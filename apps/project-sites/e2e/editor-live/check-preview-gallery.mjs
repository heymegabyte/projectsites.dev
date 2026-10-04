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
  const shot = `${OUT}/preview-gallery.png`;
  await page.screenshot({ path: shot, fullPage: true });
  const realErrors = errors.filter((e) => !/getContext|WebGL|canvas/i.test(e));
  console.log(`[preview] GET /_preview → ${res?.status()} · title: "${title}" · body chars: ${bodyLen} · console errors: ${realErrors.length}`);
  console.log(`[preview] screenshot: ${shot}`);
  console.log(res?.status() === 200 && /Gallery/i.test(title) ? 'VERDICT: ✅ /_preview gallery reachable headlessly + rendered — panel primitives screenshotted.' : `VERDICT: ⚠ status ${res?.status()} / title "${title}".`);
} finally {
  await browser.close();
}
