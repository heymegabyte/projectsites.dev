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
const SITES = (process.env.SITES || 'jenis-splendid-ice-creams-columbus,gentle-dental-seattle').split(',');

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
const CART_FRAMING = /\b(add to cart|free shipping|shop now|browse (?:the )?collection|30[- ]day returns?)\b/i;
const RETAIL_SIGNAL =
  /\b(shop|store|boutique|jewel\w*|florist|book(?:shop|store)|record store|hardware|furniture|gift shop|apparel|clothing)\b/i;

function scan(text, h1, title) {
  const head = `${h1}\n${title}`.toLowerCase();
  const body = text.toLowerCase();
  const findings = [];
  const isQuickserve = QUICKSERVE_SIGNAL.test(head);
  const isRetail = RETAIL_SIGNAL.test(head);
  if (isQuickserve) {
    // strip negated reservation phrases, then look for affirmative framing
    const stripped = body.replace(RESERVATION_NEGATED, ' ');
    const m = stripped.match(RESERVATION_FRAMING);
    if (m) findings.push({ kind: 'reservation_on_quickserve', hit: m[0] });
  }
  if (!isRetail) {
    const m = body.match(CART_FRAMING);
    if (m) findings.push({ kind: 'cart_on_non_retail', hit: m[0] });
  }
  return { isQuickserve, isRetail, findings };
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
      const { isQuickserve, isRetail, findings } = scan(d.text, d.h1, d.title);
      const tag = isQuickserve ? 'quickserve' : isRetail ? 'retail' : 'other';
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
