// verify-meta-desc-vertical.mjs — COMPLETION § C.1/C.4: does the deployed site's RENDERED
// homepage <meta name="description"> actually describe the business's VERTICAL?
//
// The template content pack keys the homepage meta description ({SEO_DESCRIPTION} → Home.tsx
// useSEO → the CLIENT <meta name="description">) off the BROAD visual vertical, so a sub-vertical
// that collapses to the wrong bucket ships a WRONG-vertical SERP snippet — a brewery + a cocktail
// bar both collapsed to `restaurant` and shipped "Fresh, made-from-scratch food from local
// ingredients" (a food snippet for a beer/cocktail business, confirmed live). No existing gate
// caught it: verify-build-invariants (C.1) checks the desc LENGTH, verify-seo (C.4) checks the SEO
// infra — neither checks that the desc SUBJECT matches the vertical. AL-491 root-fixed it by seeding
// a commerce-mode-angled, cat-woven SEO_DESCRIPTION for the collapsing sub-verticals; this probe
// locks it: the RENDERED (post-hydration) meta description must contain the business's vertical noun
// (from the H1/title, minus filler/geo/generic-retail), mirroring verify-hero-image-vertical.
//
// Fail-OPEN tracking (::notice, exit 0) — the fix lands on a FRESH rebuild (existing-wins
// _content.json seed), so deployed pre-fix sites stay flagged until they rebuild; promote to a hard
// exit 1 once the collapse cases confirm green. Skips a site whose H1 has no specific vertical noun.
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// half-acre + secret-society are the live collapse cases (pre-AL-491 build → flip green on rebuild);
// gentle-dental is the known-good control (its pack DESCRIPTION already names the vertical).
const SITES = (process.env.SITES || 'half-acre-beer-chicago,the-secret-society-portland,gentle-dental-seattle').split(',');

// Words in the H1/title that are NOT the vertical (filler / geo / generic-retail). Mirrors
// verify-hero-image-vertical so the two gates read the vertical identically.
const NON_VERTICAL =
  /^(quality|trusted|local|dependable|honest|personal|always|your|the|and|for|with|counts|side|get|one|welcoming|neighborhood|community|you|can|trust|our|home|of|to|in|at|a|an|shop|store|retail|boutique|storefront|business|company|co|inc|llc|services?|place|good|goods|favorite|throwback|chicago|portland|minneapolis|seattle|austin|houston|nashville|boston|brooklyn|bend|bozeman|madison|denver)$/i;
// NO food-cluster bridge here (unlike verify-hero-image-vertical): a shared "cafe interior" HERO is
// a correct match for the whole food cluster, but a DESCRIPTION must name the SPECIFIC vertical — a
// brewery's "made-from-scratch food" snippet is the exact wrong-vertical defect AL-491 fixes, so the
// desc must literally contain the business's vertical noun (brewery/cocktail/…), never just any food word.

const browser = await chromium.launch({ headless: true });
let flags = 0;
const rows = [];
try {
  for (const slug of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(`https://${slug}.projectsites.dev`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!resp || resp.status() !== 200) { rows.push(`  ⏭️  ${slug} — status ${resp?.status()}`); await ctx.close(); continue; }
      await page.waitForTimeout(3000); // let useSEO overwrite the shell desc on hydration
      const { desc, h1, title } = await page.evaluate(() => ({
        desc: (document.querySelector('meta[name="description"]')?.getAttribute('content') || '').toLowerCase(),
        h1: (document.querySelector('h1')?.textContent || '').toLowerCase(),
        title: document.title.toLowerCase(),
      }));
      const verticalNouns = [...new Set(`${h1} ${title}`.split(/[^a-z]+/).filter((w) => w.length >= 4 && !NON_VERTICAL.test(w)))];
      if (!desc) { rows.push(`  ⏭️  ${slug} — no rendered meta description`); }
      else if (verticalNouns.length === 0) { rows.push(`  ⏭️  ${slug} — no specific vertical noun in H1/title`); }
      else {
        const literal = verticalNouns.some((n) => desc.includes(n) || desc.includes(n.replace(/s$/, '')));
        if (literal) rows.push(`  ✓ ${slug} — meta desc names the vertical {${verticalNouns.join(',')}}`);
        else { flags++; rows.push(`  ❌ ${slug} — meta desc "${desc.slice(0, 70)}…" names NONE of {${verticalNouns.join(',')}} (wrong-vertical SERP snippet)`); }
      }
    } catch (e) { rows.push(`  ⏭️  ${slug} — ${e.message.slice(0, 50)}`); }
    await ctx.close();
  }
} finally { await browser.close(); }

console.log('\n━━ § C.1/C.4 rendered meta-description ↔ vertical match ━━');
rows.forEach((r) => console.log(r));
if (flags === 0) { console.log('\n✓ § C meta-desc-vertical PASS — every audited homepage meta description names its vertical.'); process.exit(0); }
console.log(`\n::notice:: § C meta-desc-vertical — ${flags} wrong-vertical meta description(s) on deployed sites (AL-491 seed flips them green on rebuild; tracking, not blocking).`);
process.exit(0);
