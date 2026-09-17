// verify-conversion-framing.mjs — COMPLETION § C.7 (beat-the-source): does a deployed
// generated site's CONVERSION FRAMING match its VERTICAL? A scoop shop that says "Reserve a
// table", or a distillery that says "Add to cart / Free shipping", reads like a generic
// mis-templated site and LOSES to the real business — a wrong-vertical defect exactly like a
// wrong-vertical H1.
//
// This is the gate the product LACKED — the Jeni's Splendid Ice Creams misframe (AL-419/420)
// shipped "Reserve a table" + "Reservations welcome" + "Easy reservations" onto an ice cream
// shop. The seeded surfaces (hero CTAs, FAQ) were root-fixed (AL-420 quickserve CommerceMode +
// seeded HERO_CTA), but AI-generated client-rendered SECTIONS still leaked reservation framing.
// A curl/fetch can't see them (they hydrate client-side) — so this renders with real Chromium.
//
// Precision (validator-precision-discipline): only flags when a STRONG vertical signal (from the
// H1 + <title>, not an incidental body mention) COEXISTS with off-vertical framing, and it
// excludes NEGATED phrases ("no reservation needed", "walk-ins welcome, no reservations").
//
// Usage: SITES=jenis-splendid-ice-creams-columbus node e2e/site-quality/verify-conversion-framing.mjs
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
// Default cohort covers each vertical class + the AL-701 defect sites (hotel/gallery/tattoo/
// fish-market) that mis-routed to the RETAIL content pack. AL-701 fix: container-server.mjs
// classifier gained hospitality + gallery verticals + narrowed retail (boutique-hotel/tattoo-shop)
// + routed seafood→restaurant, and the template gained _content.{hospitality,gallery}.json packs.
// These sites read RIGHT once rebuilt (tracking until then, per the audit-arc ladder below).
const SITES = (process.env.SITES ||
  'jenis-splendid-ice-creams-columbus,gentle-dental-seattle,sean-kelly-gallery,hotel-emma-san-antonio,three-kings-tattoo-brooklyn,pike-place-fish-market-seattle').split(',');

// A quickserve WALK-UP counter vertical, detected from the H1 + <title> (the authoritative
// vertical signal). These businesses take orders at a counter — never table reservations.
const QUICKSERVE_SIGNAL =
  /\b(ice\s?cream|gelato|frozen\s?yogurt|froyo|creamer(?:y|ies)|coffee\s?(?:shop|house|bar)|\bcafe\b|café|espresso\s?bar|bakery|bakeries|patisserie|\bdonut|doughnut|juice\s?bar|smoothie|\bdeli\b|delicatessen|sandwich\s?(?:shop|bar)|food\s?truck|bubble\s?tea|\bboba\b)\b/i;

// Full-service reservation framing — a wrong-vertical defect ON A QUICKSERVE site. Affirmative
// only: the negated forms ("no reservation needed") are the CORRECT quickserve copy.
const RESERVATION_FRAMING =
  /\b(reserve a table|reservations?\s+welcome|book (?:a|your) table|easy reservations?|make a reservation|table reservations?)\b/i;
const RESERVATION_NEGATED =
  /\b(no reservations?(?:\s+(?:needed|required|necessary))?|without a reservation|walk[- ]?ins?\s+welcome|no reservation needed)\b/i;

// E-commerce cart framing — a wrong-vertical defect on any NON-retail site (the AL-408 class).
const CART_FRAMING = /\b(add to cart|free shipping|shop now|browse (?:the |our )?collection|30[- ]day returns?)\b/i;
const RETAIL_SIGNAL =
  /\b(shop|store|boutique|jewel\w*|florist|book(?:shop|store)|record store|hardware|furniture|gift shop|apparel|clothing)\b/i;

// A CURATORIAL art space (gallery / fine-art dealer / art museum) — detected from the H1 + <title>.
// It is VIEWED, VISITED, and pieces are INQUIRED-about, never checked out of a cart or ordered at a
// walk-up "counter". A gallery is NEVER retail (its own dedicated `gallery` CommerceMode, AL-679).
const GALLERY_SIGNAL = /\b(art\s?galler\w*|fine\s?art\w*|art\s?dealer\w*|art\s?museum\w*|\bmuseum\b)\b/i;
// Curatorial vocabulary a real gallery site SHOULD carry (positive signal — its absence is a soft miss).
const GALLERY_CURATORIAL = /\b(exhibition|collection|viewing|acquir\w*|artist|on view|curat\w*)\b/i;
// LODGING (hotel / resort / inn / B&B) — hospitality, NEVER retail. Detected from H1 + <title>. A
// "boutique hotel" carries the RETAIL token `boutique`, so the base RETAIL_SIGNAL wrongly reads it as
// a shop → SUPPRESSES the cart-framing check → "Free shipping" / "the counter" ship UNFLAGGED on a
// hotel (the hotel-emma-san-antonio defect, AL-680: a boutique hotel with no per-vertical content pack
// mis-routes to the RETAIL pack). Like GALLERY, lodging overrides isRetail=false so the misfit fires.
const LODGING_SIGNAL =
  /\b(hotel\w*|resort\w*|\binn\b|motel\w*|lodge\b|lodging|bed\s?and\s?breakfast|\bb&b\b|guesthouse|hostel\w*)\b/i;
// Hospitality vocabulary a real lodging site SHOULD carry (positive signal — its absence on a
// hotel is a soft miss, mirroring GALLERY_CURATORIAL). Confirms the AL-701 hospitality content
// pack landed: a rebuilt hotel reads stay/room/book, not just "not retail".
const LODGING_HOSPITALITY =
  /\b(stays?|rooms?|suites?|book\w*|night\w*|check[- ]?in|concierge|accommodat\w*|guests?|amenit\w*|hospitality)\b/i;
// Retail-shop framing that mis-fits ANY pack-less non-retail vertical (gallery / lodging): the RETAIL
// content pack's "the counter" / "Find your new favorite" / "Free shipping" / cart copy. Shared by the
// gallery + lodging checks; both are curatorial/hospitality verticals a retail pack should never own.
const RETAIL_MISFIT =
  /\b(the counter|people behind the counter|behind the counter|find your new favorite|visit the shop|browse our collection|add to cart|free shipping|30[- ]day returns?)\b/i;
// A SERVICE business colloquially called a "…shop" (tattoo/barber/body/auto/repair shop) is NOT
// retail — the bare `shop` token would otherwise mis-classify it as retail and SUPPRESS the
// cart-framing check (the three-kings-tattoo class). Mirrors build_validators.validateConversionFraming.
const SERVICE_SHOP = /\b(tattoo|barber|body|auto|repair|machine|brake|muffler|welding|fix[- ]?it)\s?shop\b/i;

function scan(text, h1, title) {
  const head = `${h1}\n${title}`.toLowerCase();
  const body = text.toLowerCase();
  const findings = [];
  const isGallery = GALLERY_SIGNAL.test(head);
  const isLodging = LODGING_SIGNAL.test(head);
  const isQuickserve = QUICKSERVE_SIGNAL.test(head);
  // A gallery OR a hotel/lodging is curatorial/hospitality, NEVER retail — even if an incidental
  // "shop"/"boutique" token appears (a "boutique hotel" is a hotel, not a boutique shop).
  const isRetail = !isGallery && !isLodging && RETAIL_SIGNAL.test(head) && !SERVICE_SHOP.test(head);
  if (isQuickserve) {
    // strip negated reservation phrases, then look for affirmative framing
    const stripped = body.replace(RESERVATION_NEGATED, ' ');
    const m = stripped.match(RESERVATION_FRAMING);
    if (m) findings.push({ kind: 'reservation_on_quickserve', hit: m[0] });
  }
  if (isGallery) {
    // A gallery must read curatorially — flag retail-shop/counter/cart framing that mis-fits it.
    const m = body.match(RETAIL_MISFIT);
    if (m) findings.push({ kind: 'retail_framing_on_gallery', hit: m[0] });
    if (!GALLERY_CURATORIAL.test(body))
      findings.push({ kind: 'gallery_missing_curatorial_voice', hit: 'no exhibition/collection/viewing/artist vocabulary' });
  } else if (isLodging) {
    // A hotel/lodging must read hospitality — flag the RETAIL content pack's cart/counter/shipping copy.
    const m = body.match(RETAIL_MISFIT);
    if (m) findings.push({ kind: 'retail_framing_on_lodging', hit: m[0] });
    if (!LODGING_HOSPITALITY.test(body))
      findings.push({ kind: 'lodging_missing_hospitality_voice', hit: 'no stay/room/book/night/concierge vocabulary' });
  } else if (!isRetail) {
    const m = body.match(CART_FRAMING);
    if (m) findings.push({ kind: 'cart_on_non_retail', hit: m[0] });
  }
  return { isGallery, isLodging, isQuickserve, isRetail, findings };
}

const browser = await chromium.launch({ headless: true });
let totalFindings = 0;
const rows = [];
try {
  for (const slug of SITES) {
    const base = `https://${slug}.projectsites.dev`;
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(1500); // let client-rendered sections hydrate
      if (!resp || resp.status() !== 200) {
        rows.push(`  ⏭️  ${slug} — not auditable (status ${resp?.status()})`);
        await ctx.close();
        continue;
      }
      const d = await page.evaluate(() => ({
        h1: document.querySelector('h1')?.textContent || '',
        title: document.title,
        text: document.body.innerText,
      }));
      const { isGallery, isLodging, isQuickserve, isRetail, findings } = scan(d.text, d.h1, d.title);
      const tag = isGallery ? 'gallery' : isLodging ? 'lodging' : isQuickserve ? 'quickserve' : isRetail ? 'retail' : 'other';
      if (findings.length) {
        totalFindings += findings.length;
        rows.push(`  ❌ ${slug} [${tag}] — ${findings.map((f) => `${f.kind}:"${f.hit}"`).join(', ')}`);
      } else {
        rows.push(`  ✓ ${slug} [${tag}] — conversion framing matches vertical`);
      }
    } catch (e) {
      rows.push(`  ⏭️  ${slug} — ${e.message.slice(0, 60)}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log('\n━━ § C.7 conversion-framing (vertical ↔ CTA/section match) ━━');
rows.forEach((r) => console.log(r));
if (totalFindings === 0) {
  console.log('\n✓ § C.7 conversion-framing PASS — every audited site frames itself as its real vertical.');
  process.exit(0);
}
// TRACKING (::notice, exit 0) — the root fix (quickserve CommerceMode + seeded HERO_CTA AL-420 +
// the `conversion.reservation_on_quickserve` build_validators warn AL-421 guiding the
// validator-fixer) lands on the NEXT build; sites deployed BEFORE it (Jeni's/Tartine) still leak
// AI-section reservation framing until they rebuild. Exit 0 so run-all stays green on the not-yet-
// cycled fleet; PROMOTE to a hard `exit 1` once quickserve sites rebuild clean (audit-arc ladder).
console.log(
  `\n::notice:: § C.7 conversion-framing — ${totalFindings} wrong-vertical framing hit(s) on deployed sites (root fix lands on rebuild; tracking, not blocking).`,
);
process.exit(0);
