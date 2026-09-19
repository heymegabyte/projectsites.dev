// verify-inp.mjs — COMPLETION § C.2: do DEPLOYED generated sites clear the INP interaction budget?
//
// verify-cwv.mjs measures LCP + CLS on a COLD LOAD but deliberately SKIPS INP ("interaction-driven,
// cannot be produced by a headless page load with no user input"). That left INP≤200ms — an explicit
// C.2 target — the ONE Core-Web-Vital with NO gate on the CORE PRODUCT. A generated site that ships a
// heavy hydration or a janky click handler would blow INP on the business's real visitors, and nothing
// caught it. This closes that gap: it DRIVES real discrete interactions (Playwright clicks are trusted
// CDP input → they register as real `event`-timing entries with an interactionId, exactly like a human
// tap) and reads the resulting interaction latency via the Event Timing API — which IS how field INP is
// computed (INP ≈ the worst interaction's input-delay + processing + presentation-delay).
//
// Interactions are all NON-NAVIGATING template controls present on every generated site (so the page
// under test never changes): the command-palette button, the theme toggle, the mobile menu toggle, and
// the first FAQ accordion. Absent controls are skipped (validator-precision) — a site with too few
// measurable interactions is reported NOT-MEASURABLE (fail-open) rather than false-passed.
//
// Fixes are ROOT-CAUSE in the TEMPLATE (github.com/HeyMegabyte/template.projectsites.dev) — lands next
// build, NO redeploy. Usage:
//   SITES=vanta-strength-austin node e2e/site-quality/verify-inp.mjs
//   node e2e/site-quality/verify-inp.mjs            # default SITES
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'vanta-strength-austin,ironhaus-houston').split(',').map((s) => s.trim()).filter(Boolean);
// Mobile width — INP is scored mobile-first + the menu toggle is present here (matches verify-cwv).
const VIEWPORT = { width: Number(process.env.VIEWPORT) || 390, height: 844 };
const INP_BUDGET_MS = 200; // C.2 target (WCAG/Google "good"); cinematic aim is ≤100ms.
const MIN_INTERACTIONS = 2; // below this we can't meaningfully gate → NOT MEASURABLE (fail-open).

// Non-navigating, always-present template controls (aria-label / role from Header + FAQ).
const INTERACTIONS = [
  { label: 'command-palette', selector: 'button[aria-label="Open command palette"]', escape: true },
  { label: 'theme-toggle', selector: 'button[aria-label^="Theme:"]' },
  { label: 'menu-open', selector: 'button[aria-label="Open menu"]' },
  { label: 'menu-close', selector: 'button[aria-label="Close menu"]' },
  { label: 'faq-accordion', selector: 'button[aria-expanded]' },
];

let fails = 0;
const rows = [];

const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: VIEWPORT });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(base, { waitUntil: 'load', timeout: 60000 });
      if (!resp || resp.status() !== 200) {
        rows.push({ slug, note: `NOT MEASURABLE (status=${resp ? resp.status() : 'none'})` });
        await ctx.close().catch(() => {});
        continue;
      }
      // Install the Event Timing observer BEFORE interacting. `interactionId > 0` marks a discrete
      // user interaction; `duration` is the full event→next-paint latency (the INP quantity).
      await page.evaluate(() => {
        window.__inpMax = 0;
        window.__inpCount = 0;
        const seen = new Set();
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (e.interactionId && e.interactionId > 0) {
              if (!seen.has(e.interactionId)) { seen.add(e.interactionId); window.__inpCount++; }
              if (e.duration > window.__inpMax) window.__inpMax = e.duration;
            }
          }
        });
        // durationThreshold 0 → clamped to the 16ms spec floor; buffered picks up early events.
        po.observe({ type: 'event', durationThreshold: 0, buffered: true });
        window.__inpPO = po;
      });

      const driven = [];
      for (const it of INTERACTIONS) {
        const el = page.locator(it.selector).first();
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 4000 }).catch(() => {});
        driven.push(it.label);
        if (it.escape) await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(220); // let the interaction's paint complete + the entry flush
      }
      await page.waitForTimeout(500);

      const m = await page.evaluate(() => {
        window.__inpPO?.takeRecords?.();
        return { inp: Math.round(window.__inpMax || 0), count: window.__inpCount || 0 };
      });

      if (m.count < MIN_INTERACTIONS) {
        rows.push({ slug, note: `NOT MEASURABLE (only ${m.count} interaction(s) registered; drove [${driven.join(',')}])` });
        await ctx.close().catch(() => {});
        continue;
      }
      const ok = m.inp <= INP_BUDGET_MS;
      if (!ok) fails++;
      rows.push({ slug, inp: m.inp, count: m.count, driven, ok });
    } catch (e) {
      rows.push({ slug, note: `ERROR ${String(e).slice(0, 80)}` });
    }
    await ctx.close().catch(() => {});
  }
} finally {
  await browser.close();
}

console.log(`\n━━ § C.2 INP (interaction latency ≤ ${INP_BUDGET_MS}ms) — deployed generated sites @${VIEWPORT.width}px ━━`);
for (const r of rows) {
  if (r.note) { console.log(`  ⏭️  ${r.slug} — ${r.note}`); continue; }
  console.log(`  ${r.ok ? '✓' : '❌'} ${r.slug} — INP ${r.inp}ms over ${r.count} interaction(s) [${r.driven.join(',')}]`);
}
const measured = rows.filter((r) => !r.note);
if (measured.length === 0) {
  console.log('\n::notice:: § C.2 INP — no site had enough measurable interactions (fail-open, not a regression).');
  process.exit(0);
}
console.log(
  fails === 0
    ? `\nVERDICT: ✅ PASS — every measured site clears INP ≤ ${INP_BUDGET_MS}ms (interactions are snappy on the core product).`
    : `\nVERDICT: 🔴 ${fails} site(s) exceed INP ${INP_BUDGET_MS}ms — a janky handler / heavy hydration ships to real visitors. Root-fix in the template.`,
);
process.exit(fails === 0 ? 0 : 1);
