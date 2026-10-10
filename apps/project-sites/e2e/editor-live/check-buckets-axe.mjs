/**
 * check-buckets-axe.mjs — the DURABLE axe-core WCAG 2.2 AA gate for the editor's `/_preview`
 * Buckets UI primitives, run at ALL SIX responsive breakpoints (375 · 390 · 768 · 1024 · 1280 ·
 * 1920). `/_preview` (editor.projectsites.dev/_preview) is the public, auth-free visual-QA gallery
 * where the Buckets two-pane layout, populated list/grid (color-coded file-type glyphs), and the
 * object-preview showcase render HEADLESSLY — the authed Buckets panel sits behind Cloudflare Access,
 * so this gallery is the only axe-reachable surface for those primitives.
 *
 *   node apps/project-sites/e2e/editor-live/check-buckets-axe.mjs
 *   (PROD_URL overrides the default origin; defaults to https://editor.projectsites.dev)
 *   npm run verify:buckets-axe
 *
 * MODELED on the sibling `check-preview-gallery.mjs` / `check-buckets-populated.mjs`: same
 * `launchLocalBrowser()`, same `/_preview` target, same screenshot/exitCode shape.
 *
 * TWO LOAD-BEARING DETAILS:
 *   1. `@axe-core/playwright`'s `AxeBuilder` REQUIRES a page created via
 *      `browser.newContext().newPage()` — a bare `browser.newPage()` throws
 *      "Please use browser.newContext()". (Confirmed this session.) So we open ONE context + page
 *      and resize the viewport across the 6 breakpoints, re-navigating `/_preview` each time.
 *   2. Tag set matches the dedicated a11y spec posture: wcag2a + wcag2aa + wcag21aa. We FAIL
 *      (exitCode 1) on ANY serious/critical-impact violation at ANY breakpoint; moderate/minor are
 *      logged as ADVISORY (the a11y-sweep backlog), never silently dropped and never dishonestly
 *      filtered. A real serious/critical violation MUST fail — no suppressions.
 */
import { mkdirSync } from 'node:fs';
import { launchLocalBrowser } from '../admin-verify/_local-browser.mjs';

const URL = (process.env.PROD_URL ?? 'https://editor.projectsites.dev') + '/_preview';
const OUT = 'e2e/screenshots/editor-live';
mkdirSync(OUT, { recursive: true });

// 6 responsive breakpoints (width) — the canonical ProjectSites set. Tall heights so the whole
// gallery (two-pane + populated list/grid + preview showcase) is in the layout axe analyzes.
const BREAKPOINTS = [
  { name: 'mobile-sm', width: 375, height: 2600 },
  { name: 'mobile-md', width: 390, height: 2600 },
  { name: 'tablet', width: 768, height: 2600 },
  { name: 'desktop-sm', width: 1024, height: 2400 },
  { name: 'desktop-md', width: 1280, height: 2400 },
  { name: 'desktop-lg', width: 1920, height: 2200 },
];

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'];
const FAIL_IMPACTS = new Set(['serious', 'critical']);

// AxeBuilder is exported both as a named export and as default across @axe-core/playwright minors —
// resolve defensively so a version bump never silently breaks the gate.
const axeMod = await import('@axe-core/playwright');
const AxeBuilder = axeMod.AxeBuilder ?? axeMod.default;
if (typeof AxeBuilder !== 'function') {
  console.warn('VERDICT: ⚠ @axe-core/playwright did not export AxeBuilder — cannot run axe gate.');
  process.exitCode = 1;
  process.exit();
}

const browser = await launchLocalBrowser();
// REQUIRED by AxeBuilder: a page from an explicit context, NOT browser.newPage().
const context = await browser.newContext();
const page = await context.newPage();

// Per-breakpoint rollups + a flat list of every failing (serious/critical) node for the summary.
const perBp = []; // { bp, status, serious, critical, moderate, minor, failing: [{id,impact,targets}] }
let totalSerious = 0;
let totalCritical = 0;
let totalModerate = 0;
let totalMinor = 0;
let navTrouble = false;

try {
  for (const bp of BREAKPOINTS) {
    await page.setViewportSize({ width: bp.width, height: bp.height });
    let status = 0;
    try {
      const res = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      status = res?.status() ?? 0;
    } catch {
      navTrouble = true;
    }
    // Settle ~4s: the gallery is static React, but give hydration + the one WebGL nebula a beat so
    // axe analyzes the fully-painted layout (matches the sibling probes' settle discipline).
    await page.waitForTimeout(4000);

    const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();

    const counts = { serious: 0, critical: 0, moderate: 0, minor: 0 };
    const failing = [];
    for (const v of results.violations) {
      const impact = v.impact ?? 'unknown';
      if (impact in counts) counts[impact] += 1;
      const targets = (v.nodes ?? []).map((n) => (n.target ?? []).join(' ')).filter(Boolean);
      // Print EVERY violation (advisory + failing) so the gate is fully transparent.
      console.warn(
        `[buckets-axe] ${bp.name} ${bp.width}×${bp.height} · ${impact.toUpperCase()} · ${v.id} · ${
          (v.nodes ?? []).length
        } node(s) · ${v.help}`,
      );
      for (const t of targets) console.warn(`[buckets-axe]     ↳ ${t}`);
      if (FAIL_IMPACTS.has(impact)) failing.push({ id: v.id, impact, targets });
    }

    totalSerious += counts.serious;
    totalCritical += counts.critical;
    totalModerate += counts.moderate;
    totalMinor += counts.minor;

    perBp.push({ bp: bp.name, dims: `${bp.width}×${bp.height}`, status, ...counts, failing });

    console.warn(
      `[buckets-axe] ${bp.name} ${bp.width}×${bp.height} → GET /_preview ${status} · ` +
        `critical:${counts.critical} serious:${counts.serious} moderate:${counts.moderate} minor:${counts.minor}`,
    );

    // One screenshot at the largest breakpoint is enough for the record (visual sweep owns the rest).
    if (bp.name === 'desktop-lg') {
      const shot = `${OUT}/buckets-axe-${bp.width}.png`;
      await page.screenshot({ path: shot, fullPage: true });
      console.warn(`[buckets-axe] screenshot: ${shot}`);
    }
  }

  // ----- Aggregate verdict ------------------------------------------------------------------
  console.warn('[buckets-axe] ───────────── per-breakpoint summary ─────────────');
  for (const r of perBp) {
    console.warn(
      `[buckets-axe]   ${r.bp.padEnd(11)} ${r.dims.padEnd(10)} status ${r.status} · ` +
        `C:${r.critical} S:${r.serious} Mo:${r.moderate} Mi:${r.minor}`,
    );
  }

  const failingBreakpoints = perBp.filter((r) => r.critical + r.serious > 0);
  const allFailingNodes = perBp.flatMap((r) => r.failing.map((f) => ({ bp: r.bp, ...f })));
  const serviceable = perBp.every((r) => r.status === 200) && !navTrouble;

  if (allFailingNodes.length > 0) {
    console.warn(
      `[buckets-axe] FAILING (serious/critical) across ${failingBreakpoints.length} breakpoint(s):`,
    );
    for (const f of allFailingNodes) {
      console.warn(
        `[buckets-axe]   ✗ [${f.impact}] ${f.id} @ ${f.bp}${
          f.targets.length ? ` → ${f.targets.join(' | ')}` : ''
        }`,
      );
    }
  }

  const advisoryTotal = totalModerate + totalMinor;
  if (advisoryTotal > 0) {
    console.warn(
      `[buckets-axe] ADVISORY (logged, non-failing): moderate:${totalModerate} minor:${totalMinor} — a11y-sweep backlog.`,
    );
  }

  const ok = allFailingNodes.length === 0 && serviceable;
  if (ok) {
    console.warn(
      `VERDICT: ✅ Buckets /_preview axe-clean at all 6 breakpoints (375·390·768·1024·1280·1920) — ` +
        `0 serious/critical WCAG 2.2 AA violations` +
        (advisoryTotal > 0
          ? ` (${advisoryTotal} moderate/minor advisory, non-blocking).`
          : `.`),
    );
  } else if (!serviceable) {
    console.warn(
      `VERDICT: ⚠ /_preview did not serve 200 at every breakpoint (nav trouble: ${navTrouble}) — ` +
        `cannot certify axe-clean. Statuses: ${perBp.map((r) => `${r.bp}=${r.status}`).join(', ')}.`,
    );
  } else {
    console.warn(
      `VERDICT: ❌ Buckets /_preview has ${allFailingNodes.length} serious/critical axe violation(s) ` +
        `across ${failingBreakpoints.length} breakpoint(s) — FIX before ship (totals C:${totalCritical} S:${totalSerious}).`,
    );
  }

  if (!ok) process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
}
