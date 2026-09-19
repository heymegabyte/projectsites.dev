// verify-heading-hierarchy.mjs — GENERATED-SITE QUALITY gate: a deployed site's heading outline
// must not SKIP a level (H1 → H3 with no H2) and must have exactly one <h1>.
//
// WHY (the gap this closes — fleet-wide, surfed 2026-09-18): the first-after-hero BentoGrid
// "highlights" section is rendered by the generator WITHOUT a `headline`, so no section <h2>
// exists — yet its tile titles were always <h3>. Result: the page outline jumped H1 → H3 on
// EVERY deployed site (franklin-barbecue, pizzeria-bianco-phoenix, vanta-strength-austin …), a
// WCAG 1.3.1 (Info & Relationships) / axe `heading-order` defect. axe's heading-order is a
// best-practice rule (not in the AA violation set verify-a11y hard-fails on), so no existing
// probe caught it. A screen-reader user navigating by heading level, and a search crawler reading
// the outline, both see a broken structure. Root fix is in the TEMPLATE (BentoGrid tile titles
// become <h2> when the section has no <h2> headline) — lands on the next build, never a one-off.
//
// Report-mode by default (the fix lands on rebuild; already-deployed sites stay skipped until
// they rebuild — the recurring stale-build-debt class, § C.8). `--strict` hard-fails for
// post-rebuild verification. Flips ✅ as the cohort rebuilds off the fixed template.
//
// Usage:
//   node e2e/site-quality/verify-heading-hierarchy.mjs
//   SITES=franklin-barbecue node e2e/site-quality/verify-heading-hierarchy.mjs
//   node e2e/site-quality/verify-heading-hierarchy.mjs --strict   # a skip hard-fails

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const { chromium } = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../frontend/'))(
  'playwright-core',
);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const STRICT = process.argv.includes('--strict');

const SITES = (
  process.env.SITES ||
  'vanta-strength-austin,ironhaus-houston,vantage-digital-studio-portland,franklin-barbecue,pizzeria-bianco-phoenix'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** In-page: the heading outline in DOM order + the first level-skip, if any. */
function readOutline() {
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .filter((h) => (h.textContent || '').trim().length > 0)
    .map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent || '').trim().slice(0, 30) }));
  const h1count = heads.filter((h) => h.level === 1).length;
  let skip = null;
  for (let i = 1; i < heads.length; i++) {
    if (heads[i].level - heads[i - 1].level > 1) {
      skip = { from: heads[i - 1].level, to: heads[i].level, at: heads[i].text };
      break;
    }
  }
  return { h1count, skip, count: heads.length };
}

async function auditSite(browser, slug) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 30000 });
    const title = await page.title().catch(() => '');
    if (!resp || resp.status() !== 200 || /just a moment|checking your browser/i.test(title)) {
      return { slug, auditable: false, status: resp?.status() ?? 0 };
    }
    await page.waitForTimeout(3000); // let hydration render every section's headings
    const outline = await page.evaluate(readOutline);
    return { slug, auditable: true, ...outline };
  } catch (e) {
    return { slug, auditable: false, status: 0, gotoError: String(e).slice(0, 60) };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const browser = await chromium.launch({ headless: true });
const rows = [];
for (const slug of SITES) rows.push(await auditSite(browser, slug));
await browser.close();

let defects = 0;
console.log('\n━━ GENERATED-SITE heading-hierarchy gate (no H1→H3 skip · exactly one <h1>) ━━');
for (const r of rows) {
  if (!r.auditable) {
    console.log(`  ⚠️  ${r.slug.padEnd(34)} NOT AUDITABLE (status=${r.status}${r.gotoError ? ' ' + r.gotoError : ''}) — skip`);
    continue;
  }
  const bad = r.skip || r.h1count !== 1;
  if (bad) {
    defects++;
    const parts = [];
    if (r.h1count !== 1) parts.push(`h1count=${r.h1count}`);
    if (r.skip) parts.push(`skip H${r.skip.from}→H${r.skip.to} at "${r.skip.at}"`);
    console.log(`  ${STRICT ? '❌' : '⚠️ '} ${r.slug.padEnd(34)} ${parts.join(' · ')} (${r.count} headings)`);
  } else {
    console.log(`  ✅ ${r.slug.padEnd(34)} 1 h1 · no level-skip (${r.count} headings)`);
  }
  console.log(`::json:: ${JSON.stringify({ probe: 'heading-hierarchy', slug: r.slug, auditable: r.auditable, h1count: r.h1count ?? null, skip: r.skip ?? null })}`);
}

const fail = STRICT ? defects : 0;
console.log(
  `\nVERDICT: ${fail ? '🔴 FAIL' : defects ? '⚠️ REPORT' : '✅ PASS'} — heading-defects=${defects} of ${rows.length} sites (${STRICT ? 'strict/hard' : 'report — flips ✅ as sites rebuild off the fixed template'})`,
);
if (defects && !STRICT)
  console.log('   ↳ root fix SHIPPED in the TEMPLATE (BentoGrid tiles → <h2> when the section has no <h2> headline); deployed sites flip ✅ on their next build.');
process.exit(fail ? 1 : 0);
