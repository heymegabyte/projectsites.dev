#!/usr/bin/env node
/**
 * verify-hero-distinctiveness.mjs — § C.7 (beat-the-source / distinctiveness): a generated site's
 * hero <h1> — the #1 conversion element — must be the REAL business's value proposition, NOT the
 * industry content-pack DEFAULT shipped un-customized.
 *
 * THE GAP THIS CATCHES (found on franklin-barbecue, 2026-09-19): a world-famous BBQ institution
 * shipped the hero H1 "Austin's cozy corner" — the `{city}'s cozy corner` persona default from
 * hero_copy.ts `personaHeroCopy()`, interpolated with the real city. The build-side
 * `validateHeroNotPackDefault` gate MISSED it because it exact-matched a fixed PACK_DEFAULT_HEROES
 * set, and the city-templated tells never exact-match (fixed same commit: PACK_DEFAULT_HERO_PATTERNS).
 * This is the PROD-side complement — it reads the SERVED homepage of each delivered site and flags a
 * recolored-template hero on the live surface (build gate → server-emit reconciliation).
 *
 * TRACKING-MODE (fail-OPEN, exit 0): every current site predates the pattern gate, so a hard fail
 * would be a fleet-wide false-RED. It emits a ::notice worklist per generic hero so run-all stays
 * green, and HARD-PASSES the moment every audited site serves a distinctive hero (audit-arc ladder).
 * A genuine fetch/parse ERROR is still a hard FAIL.
 *
 * Server-fetch only (no browser needed — the H1 is in the served HTML shell). Auto-joins run-all.
 * Usage: [SITES=slug,slug] node e2e/site-quality/verify-hero-distinctiveness.mjs
 */
import { resolveSites } from './_default-sites.mjs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

// The city/persona-templated "tells" — MUST mirror build_validators.ts PACK_DEFAULT_HERO_PATTERNS so
// the prod probe and the build gate agree on what counts as a recolored-template hero.
const PACK_DEFAULT_HERO_PATTERNS = [
  /\bcozy corner\b/i, // "{City}'s cozy corner"
  /\bpull up a chair\b/i,
  /\beveryone has a seat\b/i,
  /\bmade with heart\b/i,
];

// The FIXED (non-templated) pack defaults — MUST mirror build_validators.ts PACK_DEFAULT_HEROES.
// Without these the probe LIED-GREEN: it marked "Fresh flavors, made from scratch",
// "Get stronger, one session at a time" (colliding across vanta + ironhaus!), "Ideas that move the
// needle", "Trusted counsel when it matters most" etc. as "distinctive" because they don't match the
// city-templated patterns — massively under-reporting the fleet-wide generic-hero problem.
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const PACK_DEFAULT_HEROES = new Set(
  [
    'Trusted primary care for every age',
    'Gentle dental care for your whole family',
    'Move, breathe, and feel restored',
    'Get stronger, one session at a time',
    'Trusted counsel when it matters most',
    'Fresh flavors, made from scratch',
    'Reliable service, done right the first time',
    'Together, we can do more',
    'Built for how you live',
    'Ship faster with less busywork',
    'Find the home that fits your life',
    'Ideas that move the needle',
    'Work I am proud to share',
  ].map(norm),
);

const heroOf = (html) => {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
};

const SITES = resolveSites(process.env.SITES);
let hardFails = 0;
let generic = 0;
let distinctive = 0;
let noHero = 0;
let notAuditable = 0;
const summary = [];

for (const slug of SITES) {
  const base = `https://${slug}.projectsites.dev`;
  try {
    const res = await fetch(base + '/', { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    if (!res.ok) {
      // A 404/non-200 site (never delivered / deleted) isn't a distinctiveness failure — skip it,
      // don't hard-fail the whole probe (matches the sibling site-quality probes' NOT-AUDITABLE handling).
      notAuditable++;
      summary.push(`  ⚠️  ${slug}: served ${res.status} — not auditable (skipped)`);
      continue;
    }
    const h1 = heroOf(await res.text());
    if (!h1) {
      noHero++;
      summary.push(`  ➖ ${slug}: no <h1> in served shell (n/a — client-rendered?)`);
      continue;
    }
    // Generic when the H1 is a FIXED pack default (exact) OR a city/persona-templated tell.
    const isPackDefault = PACK_DEFAULT_HEROES.has(norm(h1)) || PACK_DEFAULT_HERO_PATTERNS.some((re) => re.test(h1));
    if (isPackDefault) {
      generic++;
      summary.push(`  ⚠️  ${slug}: GENERIC pack-default hero "${h1}" — apply the AI hero_headline / lead with the business name [tracked]`);
    } else {
      distinctive++;
      summary.push(`  ✅ ${slug}: distinctive hero "${h1.slice(0, 56)}${h1.length > 56 ? '…' : ''}"`);
    }
  } catch (e) {
    hardFails++;
    summary.push(`  🔴 ${slug}: fetch error — ${String(e).slice(0, 80)}`);
  }
}

console.log(`\n━━ § C.7 hero distinctiveness on the SERVED homepage (${SITES.length} site(s)) ━━`);
for (const l of summary) console.log(l);
console.log(
  `::json:: ${JSON.stringify({ probe: 'hero-distinctiveness', sites: SITES.length, distinctive, generic, noHero, notAuditable, hardFails })}`,
);
if (hardFails) {
  console.log(`\nVERDICT: 🔴 FAIL — ${hardFails} fetch/parse error(s) (a real break, not the tracked gap).`);
  process.exit(1);
}
if (generic) {
  console.log(
    `\nVERDICT: ⏭️  TRACKED (fail-open) — ${generic} site(s) serve a recolored-template hero (${distinctive} distinctive${notAuditable ? `, ${notAuditable} not-auditable` : ''}). The build gate (validateHeroNotPackDefault + PACK_DEFAULT_HEROES + PACK_DEFAULT_HERO_PATTERNS) now flags this class; each flips ✅ as its site rebuilds with a business-specific hero.`,
  );
  process.exit(0);
}
console.log(
  `\nVERDICT: ✅ PASS — every audited site serves a distinctive, business-specific hero${noHero ? ` (${noHero} no-hero n/a)` : ''}.`,
);
process.exit(0);
