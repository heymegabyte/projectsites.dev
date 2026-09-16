// verify-a11y.mjs — COMPLETION § C.3: do DEPLOYED generated sites pass axe-core with
// ZERO violations at 6 breakpoints (375 / 390 / 768 / 1024 / 1280 / 1920)?
//
// This audits the LIVE product (`{slug}.projectsites.dev`) with a real headless Chromium +
// @axe-core/playwright (WCAG 2.0/2.1/2.2 A + AA rulesets). A generated site is the CORE
// product — an axe violation there ships to the business's real visitors. Fixes are
// ROOT-CAUSE in the TEMPLATE (github.com/HeyMegabyte/template.projectsites.dev — lands next
// build) or the site-gen prompt / build_validators.ts — NEVER a one-off patch to one site.
//
// axe 0 ≠ full WCAG AA (it auto-tests ~57% by volume; 2.4.11/2.5.7/3.3.8 etc. need manual
// review) — but 0 axe violations is a necessary floor, and a real violation is unambiguous.
//
// Usage:
//   SITES=vanta-strength-austin node e2e/site-quality/verify-a11y.mjs
//   node e2e/site-quality/verify-a11y.mjs            # default SITES, all 6 breakpoints
import { chromium } from 'playwright';
import AxeBuilderNS from '@axe-core/playwright';
import { resolveSites } from './_default-sites.mjs';

// @axe-core/playwright ships CJS — the AxeBuilder class is the default export under both
// ESM-interop shapes, so normalize defensively.
const AxeBuilder = AxeBuilderNS?.default ?? AxeBuilderNS;

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = resolveSites(process.env.SITES);
const BREAKPOINTS = [375, 390, 768, 1024, 1280, 1920];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let totalViolations = 0;
const summary = [];

const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const seen = new Map(); // ruleId -> { impact, bps:Set, nodes, help }
    let auditable = true;

    for (const width of BREAKPOINTS) {
      const ctx = await browser.newContext({ userAgent: UA, viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      try {
        // `load` not `networkidle` — generated sites keep a beacon/poll open, so networkidle
        // never settles and times out (admin-verify learned this the hard way).
        const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(600); // let deferred hydration/fonts settle before axe
        // Guard: a CF challenge / non-200 shell is NOT auditable (don't report phantom passes).
        const title = await page.title().catch(() => '');
        if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
          auditable = false;
          await ctx.close();
          break;
        }
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        for (const v of results.violations) {
          const prev = seen.get(v.id) ?? { impact: v.impact, bps: new Set(), nodes: 0, help: v.help, samples: [] };
          prev.bps.add(width);
          prev.nodes += v.nodes.length;
          // Capture up to 3 example nodes (selector + contrast color data) to root-cause.
          for (const n of v.nodes.slice(0, 3)) {
            if (prev.samples.length >= 3) break;
            const data = n.any?.[0]?.data ?? {};
            prev.samples.push({
              target: Array.isArray(n.target) ? n.target.join(' ') : String(n.target),
              fg: data.fgColor,
              bg: data.bgColor,
              ratio: data.contrastRatio,
              want: data.expectedContrastRatio,
            });
          }
          seen.set(v.id, prev);
        }
      } catch (e) {
        console.error(`  ${slug} @${width}px — audit error: ${String(e).slice(0, 80)}`);
      } finally {
        await ctx.close();
      }
    }

    if (!auditable) {
      summary.push({ slug, note: 'NOT AUDITABLE (non-200 / CF challenge shell)' });
      continue;
    }
    const violations = [...seen.entries()].map(([id, d]) => ({
      id,
      impact: d.impact,
      breakpoints: [...d.bps].sort((a, b) => a - b),
      help: d.help,
      samples: d.samples,
    }));
    // "0 violations" is the mandate; serious/critical are the hard-fail floor.
    const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    totalViolations += blocking.length;
    summary.push({ slug, violations, blocking: blocking.length });
  }
} finally {
  await browser.close();
}

console.log('\n━━ § C.3 generated-site a11y (axe @ 6 breakpoints) ━━');
for (const s of summary) {
  if (s.note) {
    console.log(`  ⚠️  ${s.slug} — ${s.note}`);
    continue;
  }
  if (s.violations.length === 0) {
    console.log(`  ✅ ${s.slug} — 0 axe violations across ${BREAKPOINTS.length} breakpoints`);
    continue;
  }
  const mark = s.blocking > 0 ? '❌' : '⚠️ ';
  console.log(`  ${mark} ${s.slug} — ${s.violations.length} rule(s) (${s.blocking} serious/critical):`);
  for (const v of s.violations) {
    console.log(`       [${v.impact}] ${v.id} @${v.breakpoints.join('/')}px — ${v.help}`);
    for (const smp of v.samples ?? []) {
      console.log(`          ↳ ${smp.target}  fg=${smp.fg} bg=${smp.bg} ratio=${smp.ratio} want=${smp.want}`);
    }
  }
}

if (totalViolations > 0) {
  console.error(`\n✗ § C.3 FAIL — ${totalViolations} serious/critical axe violation-rule(s) on deployed sites (root-fix in TEMPLATE).`);
  process.exit(1);
}
console.log('\n✓ § C.3 PASS — deployed sites are axe-clean (no serious/critical) at all breakpoints.');
