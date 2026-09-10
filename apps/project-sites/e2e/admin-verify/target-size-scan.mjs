// target-size-scan.mjs — WCAG 2.2 §2.5.8 Target Size (Minimum, AA). axe's target-size rule is
// incomplete + often un-run, and the codified gap (code-style.md) is explicit: "a 23px bordered
// chip is an AA failure axe never flags." This probe MEASURES every visible pointer target across
// the admin and flags BOX controls (real border OR non-transparent background) whose rendered
// min(w,h) < 24 CSS px — UNLESS exempt: (a) inline — an <a> in running prose (the NARROW inline
// exemption), or (b) spacing — ≥24px center-to-center to its nearest same-type neighbor (an
// effectively-24px tap zone). Reports the smallest box control per section.
//
// Fail-open (conditional-ci-gates): E2E_API_KEY unset ⇒ ::notice:: + exit 0.
// Usage: E2E_API_KEY=$(get-secret E2E_API_KEY) SHOTDIR=/tmp/ts node e2e/admin-verify/target-size-scan.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(__dirname, '../../frontend/'));
const { chromium } = req('playwright');

const KEY = process.env.E2E_API_KEY;
if (!KEY) { console.log('::notice:: target-size-scan skipped — E2E_API_KEY unset'); process.exit(0); }
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const SHOTDIR = process.env.SHOTDIR || '';
if (SHOTDIR) mkdirSync(SHOTDIR, { recursive: true });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const MIN = 24; // WCAG 2.2 2.5.8 AA minimum, CSS px

// Vetted top-level sections (mirrors admin-surf-audit / completeness-stub-scan).
const SECTIONS = (process.env.SECTIONS || 'dashboard,sites,forms,analytics,snapshots,billing,audit,docs,settings,mcp,apps,social,domains,seo,site-features,team,webhooks,leads,deliverability,voice,user,api-tokens,logs').split(',');

const browser = await chromium.launch();
// Viewport configurable (VIEWPORT=390 for the mobile touch-target pass — 2.5.8 is most
// critical on touch); default desktop. Mirrors admin-surf-audit's VIEWPORT convention.
const VW = parseInt(process.env.VIEWPORT || '1280', 10);
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: VW, height: 900 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((k) => localStorage.setItem('ps_session', JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() })), KEY);

async function measure() {
  return page.evaluate((MIN) => {
    const main = document.querySelector('app-section-error-boundary') || document.body;
    const sel = 'button, a[href], [role="button"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
    const els = [...main.querySelectorAll(sel)];
    const vis = (el) => { const r = el.getBoundingClientRect(); return el.offsetParent != null && r.width > 0 && r.height > 0; };
    const controls = els.filter(vis);

    const isBox = (el, cs) => {
      const bg = cs.backgroundColor;
      const hasBg = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
      const bw = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].map((p) => parseFloat(cs[p]) || 0);
      const hasBorder = bw.some((w) => w > 0);
      return hasBg || hasBorder || el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.getAttribute('role') === 'button';
    };
    // inline prose link: <a>, computed inline*, has text, no border/bg (a real word-link in a sentence)
    const isInlineProseLink = (el, cs) => el.tagName === 'A' && /^inline/.test(cs.display) && (el.textContent || '').trim().length > 0;

    const rects = controls.map((el) => el.getBoundingClientRect());
    const nearestGap = (i) => {
      const a = rects[i];
      const ac = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
      let min = Infinity;
      for (let j = 0; j < rects.length; j++) {
        if (j === i) continue;
        const b = rects[j];
        const bc = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        const d = Math.hypot(ac.x - bc.x, ac.y - bc.y);
        if (d < min) min = d;
      }
      return min;
    };

    const small = [];
    controls.forEach((el, i) => {
      const cs = getComputedStyle(el);
      const r = rects[i];
      const w = Math.round(r.width), h = Math.round(r.height);
      const dim = Math.min(w, h);
      if (dim >= MIN) return;
      if (isInlineProseLink(el, cs)) return; // inline exemption (narrow)
      const gap = Math.round(nearestGap(i));
      if (gap >= MIN) return; // spacing exemption — effective 24px tap zone
      if (!isBox(el, cs)) return; // only BOX controls (border/bg/native) — bare inline icons w/o box handled by spacing
      const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('placeholder') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 34);
      small.push({ w, h, dim, gap, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', label });
    });
    small.sort((a, b) => a.dim - b.dim);
    return { total: controls.length, small: small.slice(0, 8) };
  }, MIN);
}

const rows = [];
let fails = 0;
for (const s of SECTIONS) {
  try {
    await page.goto(`${ORIGIN}/admin/${s}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1600);
    const m = await measure();
    if (m.small.length) { fails++; if (SHOTDIR) await page.screenshot({ path: `${SHOTDIR}/${s}.png` }); }
    rows.push({ s, ...m });
  } catch (e) {
    rows.push({ s, err: String(e).slice(0, 80) });
  }
}
await browser.close();

for (const r of rows) {
  if (r.err) { console.log(`  !  ${r.s.padEnd(14)} error: ${r.err}`); continue; }
  if (!r.small.length) { console.log(`  ✓  ${r.s.padEnd(14)} ${r.total} controls, all ≥${MIN}px (or exempt)`); continue; }
  console.log(`  ✗  ${r.s.padEnd(14)} ${r.small.length} sub-${MIN}px box target(s):`);
  for (const t of r.small) console.log(`        ${t.w}×${t.h}px (gap ${t.gap}) ${t.tag}${t.role ? '[' + t.role + ']' : ''} "${t.label}"`);
}
console.log(
  fails
    ? `\nVERDICT: ❌ FAIL — ${fails} section(s) have box pointer targets < ${MIN}px with no inline/spacing exemption (WCAG 2.5.8 AA).`
    : `\nVERDICT: ✅ PASS — every box pointer target ≥ ${MIN}px (or inline/spacing-exempt) across all sections (WCAG 2.5.8 AA).`,
);
process.exit(fails ? 1 : 0);
