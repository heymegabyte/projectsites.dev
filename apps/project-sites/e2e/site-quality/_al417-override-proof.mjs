// _al417-override-proof.mjs — TEMP ground-truth proof for AL-417, run in the GATE Chromium
// (projectsites playwright 1.53.0 — the SAME env verify-a11y.mjs uses to gate C.3).
//
// The deployed blue-sky was built on the OLD template (readable L=0.44). Rebuilding to test a
// CSS token change costs ~$5-15 (credit discipline). Instead: load the REAL deployed page,
// confirm the L=0.44 accent-text fail exists (control), then INJECT the L=0.38 override token
// onto the live DOM and re-run axe. Real page, real .lm-dir element, real gate Chromium, one
// token overridden — the most faithful test short of a rebuild, zero credits.
//
// PASS = a color-contrast violation exists BEFORE the override (proves the bug is live + the
// harness sees it) AND is GONE after (proves L=0.38 clears AA on the real DOM in the gate env).
import { chromium } from 'playwright';
import AxeBuilderNS from '@axe-core/playwright';

const AxeBuilder = AxeBuilderNS?.default ?? AxeBuilderNS;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SLUG = process.env.SLUG || 'blue-sky-vet-clinic-bend';
const base = `https://${SLUG}.projectsites.dev`;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

// The exact fix from the committed template index.css (both light + auto blocks).
const OVERRIDE_CSS = `
  :root[data-theme='light'], :root[data-theme='auto'] {
    --color-accent-readable:  oklch(from var(--color-accent) 0.38 c h) !important;
    --color-success-readable: oklch(from var(--color-success) 0.38 c h) !important;
  }`;

function contrastNodes(results) {
  const v = results.violations.find((x) => x.id === 'color-contrast');
  if (!v) return [];
  return v.nodes.map((n) => ({
    target: n.target.join(' '),
    ratio: n.any?.[0]?.data?.contrastRatio,
    fg: n.any?.[0]?.data?.fgColor,
    bg: n.any?.[0]?.data?.bgColor,
  }));
}

// The .lm-dir accent-text fail is responsive — it renders at 390/768, NOT 1280.
const BREAKPOINTS = (process.env.BPS || '390,768').split(',').map(Number);
const browser = await chromium.launch({ headless: true });
let anyControl = false;
let anyStillFailing = false;
let anyNewlyBroken = false;
try {
  console.log(`\n=== AL-417 override proof — ${base} ===`);
  for (const width of BREAKPOINTS) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(700);
    const status = resp?.status();
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    console.log(`\n──────── @${width}px  status=${status} data-theme=${theme} ────────`);
    if (status !== 200) {
      console.log('  ❌ not auditable (non-200)');
      await ctx.close();
      continue;
    }

    const before = contrastNodes(await new AxeBuilder({ page }).withTags(TAGS).analyze());
    console.log(`  [BEFORE]  color-contrast violations: ${before.length}`);
    for (const n of before) console.log(`    ${n.target}  ratio=${n.ratio} fg=${n.fg} bg=${n.bg}`);

    await page.addStyleTag({ content: OVERRIDE_CSS });
    await page.waitForTimeout(300);

    const after = contrastNodes(await new AxeBuilder({ page }).withTags(TAGS).analyze());
    console.log(`  [AFTER L=0.38]  color-contrast violations: ${after.length}`);
    for (const n of after) console.log(`    ${n.target}  ratio=${n.ratio} fg=${n.fg} bg=${n.bg}`);

    const beforeSet = new Set(before.map((n) => n.target));
    const afterSet = new Set(after.map((n) => n.target));
    const cleared = [...beforeSet].filter((t) => !afterSet.has(t));
    const newlyBroken = [...afterSet].filter((t) => !beforeSet.has(t));
    console.log(`  cleared: ${cleared.join(' | ') || '(none)'}`);
    if (afterSet.size) console.log(`  still failing: ${[...afterSet].join(' | ')}`);
    if (newlyBroken.length) console.log(`  ⚠️ newly broken: ${newlyBroken.join(' | ')}`);

    if (before.length) anyControl = true;
    if (after.length) anyStillFailing = true;
    if (newlyBroken.length) anyNewlyBroken = true;
    await ctx.close();
  }

  console.log('\n--- verdict ---');
  const pass = anyControl && !anyStillFailing && !anyNewlyBroken;
  console.log(
    pass
      ? '✅ PASS — bug was live; L=0.38 clears ALL color-contrast violations on the real page (gate Chromium, failing breakpoints).'
      : !anyControl
        ? '⚠️ INCONCLUSIVE — no color-contrast violation before override at these breakpoints.'
        : anyNewlyBroken
          ? '❌ L=0.38 introduced a NEW contrast fail — reconsider.'
          : '❌ L=0.38 did NOT clear all accent fails — darken to 0.36 and re-run.',
  );
  await browser.close();
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('proof error:', e.message);
  await browser.close();
  process.exit(1);
}
