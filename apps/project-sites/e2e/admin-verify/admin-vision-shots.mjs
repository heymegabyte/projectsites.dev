// admin-vision-shots.mjs — capture full-page admin section screenshots for VISION INSPECTION
// (the loop's "VISION-INSPECT the screenshot" mandate). Seeds ps_session from E2E_API_KEY
// (env, never inline). Saves PNGs to /tmp/admin-vision/ for the operator to read + inspect.
//
// ⚠️ PHANTOM-ZERO GUARD (why this tool scrolls before it shoots):
// `<app-rolling-counter>` starts at 0 and only rolls to its real value when an
// IntersectionObserver fires (scrolled into view) OR after a 2500ms below-fold fallback
// (rolling-counter.component.ts). `appReveal` content is likewise hidden until intersected.
// A naive `fullPage` screenshot taken right after load captures every BELOW-THE-FOLD counter
// at its pre-roll 0 and every reveal element hidden — e.g. a footer "0 sites in your account"
// on an account that HAS 109 sites. That phantom-0 has repeatedly caused FALSE "lying-count"
// findings in admin-integrity fires (memory: rolling-counter-fullpage-capture-shows-phantom-zero).
// Fix at the tooling root: SCROLL THROUGH the whole page (fire every observer) + wait past the
// 2500ms fallback BEFORE the fullPage capture, so screenshots show the TRUE resolved state.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const KEY = process.env.E2E_API_KEY;
if (!KEY) {
  console.error('E2E_API_KEY env required (get-secret E2E_API_KEY, never inline)');
  process.exit(2);
}
const ORIGIN = process.env.ORIGIN || 'https://projectsites.dev';
const OUT = process.env.OUT || '/tmp/admin-vision';
mkdirSync(OUT, { recursive: true });
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const VW = parseInt(process.env.VIEWPORT || '1280', 10);
const VH = VW <= 480 ? 844 : 900;
const SECTIONS = (
  process.env.SECTIONS ||
  'dashboard,analytics,billing,team,voice,settings,apps,social,deliverability,snapshots'
).split(',');

// Scroll the full document height in viewport steps so every IntersectionObserver
// (rolling counters + appReveal) intersects and fires, then return to top.
async function scrollThrough(page) {
  await page.evaluate(async () => {
    const vh = window.innerHeight;
    const max = document.body.scrollHeight;
    for (let y = 0; y <= max; y += Math.floor(vh * 0.8)) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  userAgent: UA,
  viewport: { width: VW, height: VH },
  serviceWorkers: 'block',
});
const page = await ctx.newPage();
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((k) => {
  localStorage.setItem(
    'ps_session',
    JSON.stringify({ token: k, identifier: 'e2e@megabyte.space', issuedAt: Date.now() }),
  );
}, KEY);

for (const s of SECTIONS) {
  try {
    await page.goto(`${ORIGIN}/admin/${s}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200); // initial data load
    await scrollThrough(page); // fire every counter/reveal observer
    await page.waitForTimeout(1600); // settle rolls + clear the 2500ms below-fold fallback window
    const file = `${OUT}/${s}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.log(`✓ ${s} → ${file}`);
  } catch (e) {
    console.log(`✗ ${s} — ${e.message}`);
  }
}
await browser.close();
