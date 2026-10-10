/**
 * check-buckets-gorgeous3.mjs — prod-verify the gorgeous3 slice on the LIVE editor `/_preview` gallery:
 *   1. PROPAGATION — the two NEW showcases render (`buckets-loading-showcase` + `buckets-status-pills-showcase`).
 *   2. INVISIBLE-TEXT DETECTOR (the gorgeous1 lesson) — the fixed owner-key ACTIVE pill must NOT be
 *      solid-cyan-on-solid-cyan: its computed text color ≠ its background, and the background is a
 *      semi-transparent tint (alpha < 1), proving the `color-mix` fix landed (not the `/15` no-op).
 *   3. SHIMMER — the loading skeletons carry the `psBucketShimmer` sweep overlay (transform-based).
 *   4. A full-page invisible-text sweep across the gallery (color === opaque background → offender).
 * Headless Chromium (no auth — `/_preview` is public). PROD_URL overrides origin (default prod alias).
 */
import { launchLocalBrowser } from '../admin-verify/_local-browser.mjs';
import { mkdirSync } from 'node:fs';

const URL = (process.env.PROD_URL ?? 'https://editor.projectsites.dev') + '/_preview';
const SHOT = 'e2e/screenshots/editor-live/buckets-gorgeous3.png';

const browser = await launchLocalBrowser();
let code = 1;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 2600 } });
  const res = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const status = res?.status();

  // 1 — propagation: wait for BOTH new showcases (if absent → deploy not yet live on this origin).
  let propagated = true;
  for (const id of ['buckets-loading-showcase', 'buckets-status-pills-showcase']) {
    try {
      await page.waitForSelector(`[data-testid="${id}"]`, { timeout: 15000 });
    } catch {
      propagated = false;
    }
  }

  const report = await page.evaluate(() => {
    const out = { activePill: null, shimmer: false, invisible: [] };

    const toRGBA = (c) => {
      const m = c.match(/[\d.]+/g);
      if (!m) return null;
      const [r, g, b, a = '1'] = m;
      return { r: +r, g: +g, b: +b, a: +a };
    };

    // 2 — the ACTIVE status pill: find the span whose trimmed text is "Active" in the pills showcase.
    const pillsHost = document.querySelector('[data-testid="buckets-status-pills-showcase"]');
    if (pillsHost) {
      const active = Array.from(pillsHost.querySelectorAll('span')).find(
        (s) => s.textContent?.trim() === 'Active',
      );
      if (active) {
        const cs = getComputedStyle(active);
        const fg = toRGBA(cs.color);
        const bg = toRGBA(cs.backgroundColor);
        out.activePill = {
          color: cs.color,
          backgroundColor: cs.backgroundColor,
          sameString: cs.color === cs.backgroundColor,
          bgAlpha: bg ? bg.a : null,
          // The fix: solid-opaque text, semi-transparent tint fill, distinct values.
          legible: Boolean(fg && bg && cs.color !== cs.backgroundColor && bg.a < 0.999),
        };
      }
    }

    // 3 — shimmer sweep overlay present under the loading skeletons.
    const loadHost = document.querySelector('[data-testid="buckets-loading-showcase"]');
    if (loadHost) {
      out.shimmer = Array.from(loadHost.querySelectorAll('*')).some((el) =>
        (el.className?.toString?.() ?? '').includes('psBucketShimmer'),
      );
    }

    // 4 — full-gallery invisible-text sweep: a text node whose color === an OPAQUE background is invisible.
    const walk = document.querySelectorAll('[data-testid^="buckets-"] *');
    for (const el of walk) {
      const txt = el.textContent?.trim();
      if (!txt || el.children.length > 0) continue; // leaf text only
      const cs = getComputedStyle(el);
      const fg = toRGBA(cs.color);
      const bg = toRGBA(cs.backgroundColor);
      if (fg && bg && bg.a >= 0.999 && fg.r === bg.r && fg.g === bg.g && fg.b === bg.b) {
        out.invisible.push({ text: txt.slice(0, 32), color: cs.color });
      }
    }
    return out;
  });

  mkdirSync('e2e/screenshots/editor-live', { recursive: true });
  await page.screenshot({ path: SHOT, fullPage: true });

  const ap = report.activePill;
  console.log(`[gorgeous3] GET /_preview → ${status} · propagated: ${propagated}`);
  console.log(
    `[gorgeous3] ACTIVE pill → color=${ap?.color} bg=${ap?.backgroundColor} bgAlpha=${ap?.bgAlpha} legible=${ap?.legible}`,
  );
  console.log(`[gorgeous3] shimmer sweep present: ${report.shimmer}`);
  console.log(`[gorgeous3] invisible-text offenders: ${report.invisible.length}`);
  for (const o of report.invisible) console.log(`   ✗ "${o.text}" color=${o.color}`);
  console.log(`[gorgeous3] screenshot: ${SHOT}`);

  const ok = propagated && ap?.legible && report.shimmer && report.invisible.length === 0;
  if (ok) {
    console.log(
      'VERDICT: ✅ gorgeous3 live — new showcases propagated · ACTIVE pill legible (color-mix tint, not cyan-on-cyan) · shimmer present · 0 invisible-text.',
    );
    code = 0;
  } else if (!propagated) {
    console.log('VERDICT: ⚠ new showcases not yet on this origin (deploy still propagating) — re-run shortly.');
    code = 2;
  } else {
    console.log('VERDICT: ❌ gorgeous3 verification failed — see offenders above.');
    code = 1;
  }
} finally {
  await browser.close();
}
process.exit(code);
