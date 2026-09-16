// verify-guest-funnel-a11y.mjs — § B.1 axe-core WCAG 2.2 AA across ALL SIX breakpoints on the
// UNAUTH acquisition funnel a prospect traverses (`/` → `/search` → `/create`).
//
// The gap it closes: every existing § B funnel probe asserts OPERABILITY + 0 console errors
// (verify-guest-funnel / -keyboard / create-wizard / conversion-pivot-speed) and verify-auth-a11y
// covers /signin — but NONE run axe across the 6 mandated breakpoints (375/390/768/1024/1280/1920)
// on the homepage-search-create funnel. The Loop Charter mandates "axe-clean 6bp" for every real
// user journey; this is the durable tripwire for the funnel that converts every prospect. A
// breakpoint-specific regression (contrast at mobile, a target under 24px at 375, a reflow break,
// a missing label on a responsive control) that no other probe sees now goes RED here.
//
// Real Chromium, real UA, serviceWorkers blocked (no stale SW), domcontentloaded (networkidle hangs
// on served SPA). WCAG-tagged violations FAIL; best-practice is reported but non-blocking
// (validator-precision — err toward silence on non-normative rules). Structured JSON per
// surface×breakpoint for trend tracking. Auto-joins admin-verify run-all.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require2 = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'));
const { chromium } = require2('playwright');
const AxeBuilder = require2('@axe-core/playwright').default;

const ORIGIN = process.env.PROD_URL || 'https://projectsites.dev';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BREAKPOINTS = [375, 390, 768, 1024, 1280, 1920];
// The three unauth surfaces a prospect walks; each waits on its primary interactive control.
const SURFACES = [
  { path: '/', ready: '#heroSearch, [data-cta="hero-claim"], input[type="search"]' },
  { path: '/search', ready: 'input[type="search"], input[type="text"]' },
  { path: '/create', ready: 'input, button' },
];

/**
 * Wait for the current DOM to visually SETTLE before running axe: await every running CSS
 * animation/transition to finish (so mid-fade opacity never reads as a contrast fail), raced
 * against a hard cap so an infinite/looping animation can't hang the probe. Pure-ish helper.
 */
async function settle(page) {
  await page
    .evaluate(
      () =>
        new Promise((res) => {
          const running = document.getAnimations().filter((a) => a.playState === 'running');
          if (!running.length) return res();
          Promise.race([
            Promise.allSettled(running.map((a) => a.finished)),
            new Promise((r) => setTimeout(r, 1500)),
          ]).then(res);
        }),
    )
    .catch(() => {});
  await page.waitForTimeout(150);
}

const rows = [];
let fails = 0;
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA, serviceWorkers: 'block' });
const page = await ctx.newPage();

for (const surf of SURFACES) {
  try {
    await page.goto(`${ORIGIN}${surf.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector(surf.ready, { timeout: 20000 }).catch(() => {});
    for (const w of BREAKPOINTS) {
      await page.setViewportSize({ width: w, height: 900 });
      // Analyze only a SETTLED DOM. Route-enter animations (View Transitions / opacity fades)
      // leave elements mid-fade for a few hundred ms; axe reads the reduced-opacity text as a
      // color-contrast fail (proven: 23 phantom nodes @350ms → 0 once settled). Wait for running
      // entrance animations to finish, capped at 1500ms so a LOOPING animation never hangs the
      // probe — then a small buffer. This keeps the gate honest to PERSISTENT a11y issues only.
      await settle(page);
      const res = await new AxeBuilder({ page }).withTags([...TAGS, 'best-practice']).analyze();
      const wcag = res.violations.filter((v) => v.tags.some((t) => TAGS.includes(t)));
      const bp = res.violations.filter((v) => !v.tags.some((t) => TAGS.includes(t)));
      const detail = wcag.length
        ? wcag.map((v) => `${v.id}(${v.nodes.length})`).join(',')
        : bp.length
          ? `wcag:0 · best-practice: ${bp.map((v) => v.id).join(',')}`
          : 'clean';
      if (wcag.length) fails++;
      rows.push({ surface: surf.path, bp: w, wcag: wcag.length, best: bp.length, detail });
    }
  } catch (e) {
    fails++;
    rows.push({ surface: surf.path, bp: 0, wcag: -1, best: 0, detail: `NAV/AXE ERROR: ${String(e).slice(0, 100)}` });
  }
}
await browser.close();

for (const r of rows)
  console.log(`  ${r.wcag === 0 ? '✓' : '✗'} ${r.surface.padEnd(9)} @${String(r.bp).padEnd(4)} wcag=${r.wcag} best=${r.best}  ${r.detail}`);
console.log(JSON.stringify({ probe: 'guest-funnel-a11y', origin: ORIGIN, breakpoints: BREAKPOINTS, rows }));
console.log(
  fails
    ? `\nVERDICT: 🔴 FAIL — ${fails} funnel surface×breakpoint(s) carry WCAG 2.2 AA violations (a prospect on that device hits an a11y break).`
    : `\nVERDICT: ✅ § B.1 PASS — acquisition funnel (/ · /search · /create) is axe-clean WCAG 2.2 AA across all ${BREAKPOINTS.length} breakpoints.`,
);
process.exit(fails ? 1 : 0);
