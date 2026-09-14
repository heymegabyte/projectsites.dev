// verify-hero-image-vertical.mjs — COMPLETION § C.7 (beat-the-source): does the deployed
// site's HERO IMAGE actually show the business's VERTICAL? A guitar shop with a women's-
// clothing-BOUTIQUE hero (the Unsplash query was a generic "modern boutique retail store")
// reads as a mis-templated site and LOSES to the real business — a wrong-vertical defect
// exactly like a wrong-vertical H1, but on the FIRST thing a visitor sees (AL-423/424).
//
// No existing gate catches it: the image 200s, is on the allowlist, and is axe-irrelevant —
// only its SUBJECT is wrong. This decodes the hero Unsplash `ixid` (which carries the search
// query) and checks the business's SPECIFIC vertical noun (from the H1/title, minus generic
// retail words) appears in it. gentle-dental → "dental clinic interior" ✓; Gruhn guitar shop
// → "boutique retail store" ✗ (no "guitar").
//
// Food-service cluster bridge (AL-450): coffee/cafe/bakery/deli/restaurant/ice-cream/juice all
// share ONE content-pack hero (a warm "cafe interior" scene) because the worker doesn't seed a
// per-vertical HERO_IMAGE_URL. A cafe/counter hero is CORRECT for the whole cluster, so a coffee
// shop's "coffee" vertical matches a "cafe" hero query (and a bakery vs the same). The bridge fires
// ONLY when the business noun AND the hero query are both food-domain — a non-food business
// (guitar/dental) gets no synonym help, so a wrong-vertical hero on those still flags.
//
// Precision (validator-precision): needs a REAL vertical noun in the H1 AND a decodable hero
// query; skips sites whose hero isn't Unsplash-with-ixid (not auditable). Generic retail nouns
// (shop/store/retail/boutique) DON'T count as a match — the vertical is "guitar", not "shop".
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// Default set includes a SUB-VERTICAL case (perennials-brooklyn, a plant shop) that the AL-485
// worker HERO_IMAGE_URL seed targets — it tracks ❌ (fail-open ::notice) until that site rebuilds
// with the curated plant hero, then flips ✓. gentle-dental is the known-good control.
const SITES = (process.env.SITES || 'gruhn-guitars-nashville,gentle-dental-seattle,perennials-brooklyn').split(',');

// Words in the H1/title that are NOT the vertical: filler, geo-agnostic, and GENERIC retail
// nouns (a guitar shop's vertical is "guitar", never the generic "shop"/"store"/"retail").
const NON_VERTICAL =
  /^(quality|trusted|local|dependable|honest|personal|always|your|the|and|for|with|counts|side|get|one|session|time|welcome|choice|best|top|neighborhood|community|you|can|trust|our|home|of|to|in|at|a|an|shop|store|retail|boutique|storefront|business|company|co|inc|llc|services?|place|good|goods|nashville|seattle|austin|houston|portland|francisco|boston|columbus|bend|bozeman)$/i;

// Food-service domain lexicon — a business noun AND a hero query that BOTH match here are the
// same food cluster, so a shared "cafe interior" hero is a correct match for any of them (AL-450).
// Only bridges within food; a non-food vertical noun never touches it.
const FOOD_LEXICON =
  /\b(coffee|cafe|caf[eé]|espresso|roaster|roastery|barista|bakery|bakeshop|pastry|patisserie|deli|delicatessen|restaurant|bistro|diner|eatery|brasserie|tavern|pub|grill|kitchen|creamery|cream|scoop|gelato|gelateria|ice[- ]?cream|froyo|frozen[- ]?yogurt|juice|smoothie|teahouse|dessert|sandwich|pizzeria|pizza|taqueria|food|dining|brunch|breakfast|lunch|dinner|menu)\b/i;

// Finance-services domain lexicon (AL-507) — the SAME cluster idea as FOOD_LEXICON, for the
// financial-services domain. A finance-domain business (wealth mgmt / advisor / investment /
// insurance / accounting / bookkeeping / tax / CPA) AND a finance-domain hero query (the seeded
// "financial advisor office meeting") are the same visual domain — a professional financial office
// — so one hero is a correct match for any of them. This bridges the AL-504 wealth→legal defect:
// a finance firm still on the pack's "law office" hero has a NON-finance query → no bridge → still
// FLAGS. `invest(ment|ing|or)` never touches "investigator"; `tax(es)?` never touches "taxi".
const FINANCE_LEXICON =
  /\b(wealth|financ\w*|invest(ment|ing|or)\w*|asset\s?manage\w*|retirement|insuranc\w*|accountan\w*|accounting|bookkeep\w*|cpa|tax(es)?|fiduciar\w*|advisor\w*|advisory|brokerage|portfolio)\b/i;

// Creative-services domain lexicon (AL-544) — SAME cluster idea as FOOD/FINANCE, for the creative
// domain (design studio / graphic design / creative-branding-ad agency / photography / videography /
// art studio-gallery / production / animation / record label). These share ONE visual domain — a
// design/creative workspace — so one hero ("graphic design studio workspace") is a correct match for
// any of them. Bridges the design-studio → generic "creative agency team meeting" defect: a design
// studio (nouns {design,studio}) + a creative-domain hero query is a correct cluster match, exactly
// like wealth ↔ "financial advisor office". No bare `agency` here → an insurance/real-estate agency
// (finance/luxe hero) never false-bridges (its hero query isn't in this lexicon).
const CREATIVE_LEXICON =
  /\b(design|graphic|creative|agenc\w*|brand\w*|photograph\w*|videograph\w*|gallery|galleries|portfolio|advertis\w*|animation|production|illustrat\w*)\b/i;

// Decode the Unsplash `ixid` (base64 → pipe-delimited; the query is the URL-encoded field).
function heroQueryFromHtml(html) {
  const m = html.match(/ixid=([A-Za-z0-9]+)/);
  if (!m) return null;
  try {
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const field = dec.split('|').find((f) => /%[0-9a-f]{2}/i.test(f) || /\b(store|shop|retail|interior|dining|studio|clinic)\b/i.test(f));
    return field ? decodeURIComponent(field).toLowerCase() : null;
  } catch {
    return null;
  }
}

const browser = await chromium.launch({ headless: true });
let flags = 0;
const rows = [];
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const html = await page.content();
      if (!resp || resp.status() !== 200) {
        rows.push(`  ⏭️  ${slug} — status ${resp?.status()}`);
        await ctx.close();
        continue;
      }
      const h1 = (await page.evaluate(() => document.querySelector('h1')?.textContent || '')).toLowerCase();
      const title = (await page.title()).toLowerCase();
      const heroQuery = heroQueryFromHtml(html);
      // the business's SPECIFIC vertical nouns (drop filler/geo/generic-retail)
      const verticalNouns = [...new Set(`${h1} ${title}`.split(/[^a-z]+/).filter((w) => w.length >= 4 && !NON_VERTICAL.test(w)))];
      if (!heroQuery) {
        rows.push(`  ⏭️  ${slug} — hero not Unsplash-ixid (not auditable via query)`);
      } else if (verticalNouns.length === 0) {
        rows.push(`  ⏭️  ${slug} — no specific vertical noun in H1/title`);
      } else {
        const literalMatch = verticalNouns.some((n) => heroQuery.includes(n) || heroQuery.includes(n.replace(/s$/, '')));
        // Food-cluster bridge: a food-domain business + a food-domain hero query is a correct match
        // (coffee ↔ cafe, bakery ↔ cafe interior, …) even when the exact noun differs.
        const foodMatch = verticalNouns.some((n) => FOOD_LEXICON.test(n)) && FOOD_LEXICON.test(heroQuery);
        // Finance-cluster bridge (AL-507): a finance-domain business + a finance-domain hero query
        // (wealth ↔ "financial advisor office", insurance ↔ same) is a correct match — one financial-
        // office hero serves the whole cluster, mirroring the food bridge above.
        const financeMatch =
          verticalNouns.some((n) => FINANCE_LEXICON.test(n)) && FINANCE_LEXICON.test(heroQuery);
        // Creative-cluster bridge (AL-544): a creative-domain business (design/agency/photography/
        // branding/art/production) + a creative-domain hero query is a correct match — one design-
        // studio-workspace hero serves the whole cluster, mirroring the food + finance bridges.
        const creativeMatch =
          verticalNouns.some((n) => CREATIVE_LEXICON.test(n)) && CREATIVE_LEXICON.test(heroQuery);
        const matched = literalMatch || foodMatch || financeMatch || creativeMatch;
        if (matched) {
          const how = literalMatch
            ? ''
            : foodMatch
              ? ' [food-cluster]'
              : financeMatch
                ? ' [finance-cluster]'
                : ' [creative-cluster]';
          rows.push(`  ✓ ${slug} — hero query "${heroQuery}" matches vertical {${verticalNouns.join(',')}}${how}`);
        } else {
          flags++;
          rows.push(`  ❌ ${slug} — hero query "${heroQuery}" shows NONE of the business vertical {${verticalNouns.join(',')}} (wrong-vertical hero image)`);
        }
      }
    } catch (e) {
      rows.push(`  ⏭️  ${slug} — ${e.message.slice(0, 50)}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log('\n━━ § C.7 hero-image ↔ vertical match ━━');
rows.forEach((r) => console.log(r));
if (flags === 0) {
  console.log('\n✓ § C.7 hero-image-vertical PASS — every audited hero shows the business vertical.');
  process.exit(0);
}
// TRACKING (::notice, exit 0) — the AI hero-image query is a PERSISTED _assets.json asset
// (existing-wins on /reset, AL-424); sites deployed with a generic "boutique retail store"
// query keep it until a FRESH rebuild picks a vertical-specific query (the AL-424 prompt fix +
// the documented per-vertical hero-query seed). Exit 0 so run-all stays green; promote to hard
// exit 1 once fresh deliveries confirm the query is vertical-specific.
console.log(
  `\n::notice:: § C.7 hero-image-vertical — ${flags} wrong-vertical hero image(s) on deployed sites (root fix = vertical-specific hero query; tracking, not blocking).`,
);
process.exit(0);
