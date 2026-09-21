#!/usr/bin/env node
/**
 * template-render-audit.mjs — the durable render+inspect harness for the template visual-quality loop.
 *
 * Renders every gallery demo across the loop's breakpoint matrix + reduced-motion, and GATHERS THE
 * EVIDENCE the visual scoring reads: full-page + initial-viewport screenshots, axe violations, console
 * errors, and basic CWV (LCP/CLS). It deliberately does NOT assign the 15-category rubric scores — those
 * require human/vision INSPECTION of the screenshots (the loop bars inferring scores from code/metrics).
 * This makes the first render window turnkey: `node template-render-audit.mjs` → screenshots + a JSON
 * evidence report → then score visually into docs/template-visual-audit.md.
 *
 * Run (any Playwright-capable window; no Docker needed per cf-browser-rendering-playwright-no-docker):
 *   npm i -D playwright @axe-core/playwright   # if absent
 *   node apps/project-sites/e2e/site-quality/template-render-audit.mjs
 * Wire into e2e/admin-verify/run-all.mjs once green.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '__screenshots__');
const REPORT = join(HERE, 'template-render-audit.report.json');

/** Real gallery inventory (template.projectsites.dev), name → category → live demo URL. */
const DEMOS = [
  { name: 'latch', category: 'saas', url: 'https://projectsites-demo-latch.pages.dev' },
  { name: 'field-studio', category: 'design-studio', url: 'https://projectsites-demo-field-studio.pages.dev' },
  { name: 'maria-chen', category: 'portfolio', url: 'https://projectsites-demo-maria-chen.pages.dev' },
  { name: 'field-threads', category: 'retail', url: 'https://projectsites-demo-field-threads.pages.dev' },
  { name: 'northern-lights-bakery', category: 'restaurant', url: 'https://projectsites-demo-northern-lights-bakery.pages.dev' },
  { name: 'doe-law', category: 'legal', url: 'https://projectsites-demo-doe-law.pages.dev' },
  { name: 'chen-family-dentistry', category: 'medical', url: 'https://projectsites-demo-chen-family-dentistry.pages.dev' },
  { name: 'anchor-plumbing', category: 'trades', url: 'https://projectsites-demo-anchor-plumbing.pages.dev' },
  { name: 'anchorage-weekend-bags', category: 'nonprofit', url: 'https://projectsites-demo-anchorage-weekend-bags.pages.dev' },
];

/** The loop's breakpoint matrix (label → viewport). */
const BREAKPOINTS = [
  { label: 'mobile-portrait', width: 390, height: 844 },
  { label: 'mobile-landscape', width: 844, height: 390 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'desktop', width: 1280, height: 800 },
  { label: 'large-desktop', width: 1920, height: 1080 },
];

/** Inject a tiny LCP/CLS collector before navigation; read via window.__cwv after load. */
const CWV_INIT = `
  window.__cwv = { lcp: 0, cls: 0 };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__cwv.lcp = Math.round(e.startTime); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cwv.cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  } catch {}
`;

async function loadDeps() {
  try {
    const pw = await import('playwright');
    let AxeBuilder = null;
    try {
      AxeBuilder = (await import('@axe-core/playwright')).default;
    } catch {
      /* axe optional — report notes its absence */
    }
    return { chromium: pw.chromium, AxeBuilder };
  } catch {
    return null;
  }
}

async function auditOne(browser, AxeBuilder, demo, bp, reducedMotion) {
  const context = await browser.newContext({
    viewport: { width: bp.width, height: bp.height },
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 300)));
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));
  await page.addInitScript(CWV_INIT);

  const rec = { demo: demo.name, category: demo.category, breakpoint: bp.label, reducedMotion, ok: false };
  try {
    const resp = await page.goto(demo.url, { waitUntil: 'networkidle', timeout: 45_000 });
    rec.status = resp?.status() ?? 0;
    await page.waitForTimeout(1200); // let entrance choreography + LCP settle
    const suffix = reducedMotion ? `${bp.label}-reduced` : bp.label;
    const shot = join(OUT_DIR, demo.name, `${suffix}.png`);
    await mkdir(dirname(shot), { recursive: true });
    await page.screenshot({ path: shot, fullPage: bp.label === 'desktop' && !reducedMotion });
    rec.screenshot = shot;
    rec.h1Count = await page.locator('h1').count();
    rec.rootHasContent = await page.evaluate(() => (document.body?.innerText ?? '').trim().length > 40);
    rec.placeholderLeak = await page.evaluate(() => /\{[A-Z_]{3,}\}/.test(document.body?.innerText ?? ''));
    rec.cwv = await page.evaluate(() => window.__cwv);
    if (AxeBuilder) {
      const res = await new AxeBuilder({ page }).analyze();
      rec.axeViolations = res.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
    } else {
      rec.axeViolations = null; // axe not installed
    }
    rec.consoleErrors = consoleErrors;
    rec.ok = rec.status === 200 && consoleErrors.length === 0 && rec.rootHasContent && !rec.placeholderLeak;
  } catch (e) {
    rec.error = String(e).slice(0, 300);
  } finally {
    await context.close();
  }
  return rec;
}

async function main() {
  const deps = await loadDeps();
  if (!deps) {
    process.stderr.write('template-render-audit: Playwright not installed. Run `npm i -D playwright @axe-core/playwright` then retry.\n');
    await writeFile(REPORT, JSON.stringify({ meta: { error: 'playwright_missing' }, records: [] }, null, 2));
    process.exit(2);
  }
  const { chromium, AxeBuilder } = deps;
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const records = [];
  for (const demo of DEMOS) {
    for (const bp of BREAKPOINTS) records.push(await auditOne(browser, AxeBuilder, demo, bp, false));
    records.push(await auditOne(browser, AxeBuilder, demo, { label: 'desktop', width: 1280, height: 800 }, true)); // reduced-motion pass
  }
  await browser.close();

  const summary = {
    demos: DEMOS.length,
    passes: records.filter((r) => r.ok).length,
    withConsoleErrors: records.filter((r) => (r.consoleErrors?.length ?? 0) > 0).length,
    withPlaceholderLeak: records.filter((r) => r.placeholderLeak).length,
    withAxeViolations: records.filter((r) => (r.axeViolations?.length ?? 0) > 0).length,
    axeInstalled: !!AxeBuilder,
  };
  await writeFile(REPORT, JSON.stringify({ meta: { generatedFrom: 'template-render-audit', note: 'EVIDENCE ONLY — score the screenshots visually; do not infer the 15-cat rubric from this JSON.' }, summary, records }, null, 2));
  process.stderr.write(`template-render-audit: ${summary.passes}/${records.length} render-clean · placeholderLeak=${summary.withPlaceholderLeak} · consoleErrs=${summary.withConsoleErrors} · report=${REPORT}\n`);
}

main().catch((e) => {
  process.stderr.write(`template-render-audit fatal: ${String(e)}\n`);
  process.exit(1);
});
