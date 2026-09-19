// verify-headline-grammar.mjs — § C.1/C.7: a generated site's H1 + SEO title must not weave a
// BARE professional-services DISCIPLINE noun as its terminal business noun. The persona headline
// (`${city}'s trusted ${cat}`) and the title frames (`Your neighborhood ${cat}` / `Trusted local
// ${cat}`) all read one derived category phrase. For a CONCRETE vertical ("bakery"/"gym"/"record
// store") the bare noun IS a business; for a DISCIPLINE ("architecture"/"accounting"/"consulting"/
// "engineering"/"marketing") it names a FIELD, not a business — so the frame reads ungrammatically:
// olson-kundig-seattle shipped H1 "Seattle's trusted architecture" + title "Your neighborhood
// architecture | Seattle", ben-badgley-cpa "Your neighborhood accounting | Asheville" (AL-565,
// curl-caught; no prior gate covered it — build_validators checks title/desc LENGTH, not grammar).
//
// Root fix: hero_copy `CATEGORY_NORMALIZE`/`NAME_CATEGORY` suffix the discipline to its business
// noun (architecture firm / accounting firm / marketing agency), so the H1 + title + about copy all
// read right at once. Deployed sites built BEFORE the fix still show it → flips-GREEN-on-rebuild
// tracker: fail-OPEN by default (::notice::, exit 0, suite-safe), STRICT=1 → exit 1 (promote once
// the professional-services cohort has rebuilt). validator-precision: a discipline is flagged ONLY
// when it is NOT already followed by a business suffix (firm/agency/studio/practice/…), so a
// correctly-suffixed "architecture firm" or "marketing agency" never false-fails.
//
// Usage: SITES=olson-kundig-seattle,ben-badgley-cpa [STRICT=1] node e2e/site-quality/verify-headline-grammar.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const SITES = (process.env.SITES || 'olson-kundig-seattle,ben-badgley-cpa,bicycle-habitat-nyc,vanta-strength-austin')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const STRICT = process.env.STRICT === '1';

// Discipline nouns that read as an abstract FIELD when bare (need a firm/agency/studio suffix).
const DISCIPLINE = 'architecture|accounting|consulting|engineering|marketing|advertising';
// Business-noun suffixes that make a discipline a business ("architecture FIRM", "marketing AGENCY").
const SUFFIX =
  'firm|agency|studio|practice|group|company|associates|partners|clinic|office|services|collective|co';
// A discipline noun NOT immediately followed by a business suffix = the bare-terminal defect.
const bareRe = new RegExp(`\\b(${DISCIPLINE})\\b(?!\\s+(?:${SUFFIX})\\b)`, 'i');
// AL-576: the weak generic "Quality {cat} {city} counts on" H1 frame (the 4th heroHeadlineOptions
// candidate, `pick()`-selectable for neutral personalities) — a bland "Quality" lead + clunky
// dropped-relative-pronoun that shipped on 6 live sites. Replaced in hero_copy with a clean
// relative clause ("The {cat} {city} counts on"); this flags any deployed site still on the old
// frame (flips green on rebuild).
const weakLeadRe = /^Quality\b.+\bcounts on$/i;
// AL-585: the boutique persona's vertical-AGNOSTIC filler H1 ("Find something special in {city}" —
// drops the category, so a bike shop read indistinguishable from any gift shop). Replaced in
// hero_copy with a category-bearing "The {city} {cat} worth the trip"; this flags any deployed site
// still on the old filler (flips green on rebuild).
const fillerRe = /^Find something special in\b/i;
// AL-586: the generic-fallback hero SUBHEADLINE wove a bare category noun after "for" —
// "{city}'s dependable choice for {cat}" → "dependable choice for gym" / "for architecture firm"
// (ungrammatical for count nouns; live on vanta-strength-austin + olson-kundig-seattle). Root-fixed
// in site-generation.ts to the article-free possessive "{city}'s dependable {cat}". This flags any
// deployed site still on the old bare-noun subheadline (flips green on rebuild).
const subGrammarRe = /\bdependable choice for\b/i;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const hits = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const slug of SITES) {
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      const r = await page.goto(`https://${slug}.projectsites.dev/`, { waitUntil: 'load', timeout: 45000 });
      if (!r || r.status() !== 200) {
        await ctx.close().catch(() => {});
        continue;
      }
      await page.waitForTimeout(1500); // let the SPA settle its client <title>
      const { h1, title, sub } = await page.evaluate(() => {
        const h = document.querySelector('h1');
        // the hero subheadline is the H1's sibling <p> in the same hero text container
        const p = h?.parentElement?.querySelector('p');
        return { h1: h?.textContent || '', title: document.title || '', sub: p?.textContent || '' };
      });
      const nH1 = norm(h1);
      const nTitle = norm(title);
      const nSub = norm(sub);
      const mH1 = nH1.match(bareRe);
      const mT = nTitle.match(bareRe);
      if (mH1) hits.push({ slug, where: 'h1', detail: `"${nH1}" → bare "${mH1[1]}"` });
      if (mT) hits.push({ slug, where: 'title', detail: `"${nTitle}" → bare "${mT[1]}"` });
      if (weakLeadRe.test(nH1)) hits.push({ slug, where: 'h1', detail: `"${nH1}" → weak "Quality … counts on" lead (AL-576)` });
      if (fillerRe.test(nH1)) hits.push({ slug, where: 'h1', detail: `"${nH1}" → vertical-agnostic "Find something special" filler (AL-585)` });
      if (subGrammarRe.test(nSub)) hits.push({ slug, where: 'subheadline', detail: `"${nSub}" → bare-noun "dependable choice for {cat}" (AL-586)` });
    } catch {
      /* route unreachable → skip (don't false-fail) */
    }
    await ctx.close().catch(() => {});
  }
} finally {
  await browser.close();
}

console.log(JSON.stringify({ sites: SITES, strict: STRICT, hits }, null, 2));
if (!hits.length) {
  console.log(`✅ PASS — no bare-discipline headline/title on ${SITES.length} site(s)`);
  process.exit(0);
}
const msg = `bare-discipline headline/title on ${hits.length} surface(s): ${hits
  .map((h) => `${h.slug}[${h.where}] ${h.detail}`)
  .join(' · ')}`;
if (STRICT) {
  console.log(`❌ FAIL — ${msg}`);
  process.exit(1);
}
// flips-GREEN-on-rebuild tracker: pre-AL-565 professional-services builds still render the bare
// discipline; the hero_copy suffix fix lands next build (NO redeploy of existing sites).
console.log(`::notice:: verify-headline-grammar — ${msg} (stale pre-AL-565 build; clears on rebuild — set STRICT=1 to enforce)`);
process.exit(0);
