#!/usr/bin/env node
/**
 * webgl-template-gate.mjs — gate for the industry-themed WebGL hero presets.
 *
 * Per preset (restaurant / nonprofit / retail / professional-services):
 *   1. loads templates/webgl/harness.html?preset=<key> in real Chromium,
 *   2. asserts the canvas MOUNTS (handle.ok) and goes .is-live,
 *   3. renders a deterministic frame + gl.readPixels samples — pixels must be
 *      NON-BLACK and NON-UNIFORM (the black-broken-shader class: a linked program
 *      that outputs vec4(0) renders "fine" to every DOM probe),
 *   4. screenshots the full hero to .claude/run-the-loop/visual/webgl-presets/.
 * Plus one reduced-motion run asserting NO GL init + the static gradient fallback.
 *
 * Usage: node e2e/webgl-template-gate.mjs   (exit 1 on any gate failure)
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBGL_DIR = resolve(__dirname, '../templates/webgl');
const REPO_ROOT = resolve(__dirname, '../../..');
const SHOT_DIR = join(REPO_ROOT, '.claude/run-the-loop/visual/webgl-presets');
const PRESETS = [
  'restaurant', 'nonprofit', 'retail', 'professional-services',
  'medical', 'wellness', 'saas', 'agency', 'portfolio', 'local-service',
];
/** Deterministic shader-time (s) per screenshot — glint presets catch the sweep mid-pass
 *  (shader_t = s × speed; phase = fract(shader_t / (4.5/speed)) ≈ 0.5). */
const SHOT_TIMES = {
  restaurant: 6.0, nonprofit: 5.0, retail: 3.9, 'professional-services': 4.0,
  medical: 5.0, wellness: 6.0, saas: 4.0, agency: 5.6, portfolio: 6.25, 'local-service': 4.0,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function startServer() {
  return new Promise((resolveStart) => {
    const server = createServer(async (req, res) => {
      try {
        const path = new URL(req.url, 'http://x').pathname;
        const file = path === '/' ? '/harness.html' : path;
        const body = await readFile(join(WEBGL_DIR, file.replace(/^\/+/, '')));
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolveStart({ server, port: server.address().port }));
  });
}

function stats(samples) {
  const lums = samples.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const mean = lums.reduce((a, v) => a + v, 0) / lums.length;
  const sd = Math.sqrt(lums.reduce((a, v) => a + (v - mean) ** 2, 0) / lums.length);
  const unique = new Set(samples.map(([r, g, b]) => `${r},${g},${b}`)).size;
  const alphaOk = samples.every(([, , , a]) => a === 255);
  return { mean: +mean.toFixed(1), sd: +sd.toFixed(1), unique, alphaOk };
}

async function gatePreset(page, base, key) {
  const consoleErrors = [];
  const onErr = (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); };
  page.on('console', onErr);
  await page.goto(`${base}/harness.html?preset=${key}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });

  const ok = await page.evaluate(() => window.__hero?.ok === true);
  const live = ok
    ? await page
        .waitForFunction(() => document.querySelector('.webgl-hero-canvas')?.classList.contains('is-live'), null, { timeout: 5000 })
        .then(() => true)
        .catch(() => false)
    : false;

  // Deterministic frames at two shader times — both sampled, second one screenshotted.
  const sampleA = ok ? await page.evaluate(() => { window.__hero.renderAt(2.0); return window.__hero.sample(128); }) : [];
  const sampleB = ok ? await page.evaluate(() => { window.__hero.renderAt(9.5); return window.__hero.sample(128); }) : [];
  const sA = ok ? stats(sampleA) : null;
  const sB = ok ? stats(sampleB) : null;
  // Motion check: the two times must not render identical fields.
  const movesInTime = ok ? JSON.stringify(sampleA) !== JSON.stringify(sampleB) : false;

  // Deterministic screenshot: freeze the loop at the preset's signature moment.
  if (ok) {
    await page.evaluate((t) => { window.__hero.pause(); window.__hero.renderAt(t); }, SHOT_TIMES[key] ?? 5.0);
  }
  await mkdir(SHOT_DIR, { recursive: true });
  const shot = join(SHOT_DIR, `${key}.png`);
  await page.screenshot({ path: shot, fullPage: false });

  const nonBlack = ok && sA.mean > 6 && sB.mean > 6;
  const nonUniform = ok && sA.unique > 8 && sB.unique > 8 && (sA.sd > 1.5 || sB.sd > 1.5);
  const pass = ok && live && nonBlack && nonUniform && movesInTime && sA.alphaOk && consoleErrors.length === 0;
  page.off('console', onErr);
  return { key, ok, live, statsA: sA, statsB: sB, movesInTime, consoleErrors, shot, pass };
}

async function gateReducedMotion(page, base) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${base}/harness.html?preset=restaurant`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
  const glSkipped = await page.evaluate(() => window.__hero?.ok === false && window.__hero?.reason === 'reduced-motion');
  const fallbackPainted = await page.evaluate(() => {
    const el = document.querySelector('.webgl-hero-layer');
    const cs = getComputedStyle(el);
    return cs.backgroundImage.includes('radial-gradient') && cs.backgroundColor !== 'rgba(0, 0, 0, 0)';
  });
  await mkdir(SHOT_DIR, { recursive: true });
  const shot = join(SHOT_DIR, 'reduced-motion-fallback.png');
  await page.screenshot({ path: shot, fullPage: false });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  return { key: 'reduced-motion', glSkipped, fallbackPainted, shot, pass: glSkipped && fallbackPainted };
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const results = [];
for (const key of PRESETS) results.push(await gatePreset(page, base, key));
results.push(await gateReducedMotion(page, base));

await browser.close();
server.close();

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(JSON.stringify(r));
}
console.log(`\nwebgl-template-gate: ${results.length - failed}/${results.length} passed · screenshots → ${SHOT_DIR}`);
process.exit(failed === 0 ? 0 : 1);
