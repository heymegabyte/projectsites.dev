/**
 * @module services/hero_copy
 * @description Pure derivations for the fast-path site-generation seed's hero copy —
 * the business-category noun phrase and the `<h1>` headline options that get written
 * into `_content.json` (HERO_HEADLINE) when a build carries no AI-authored hero.
 *
 * WHY (AL-361, 2026-09-11 — root cause of a defect confirmed on 2 live deliveries):
 * the inline derivation stripped `store`/`shop` from the category, so "Record Store"
 * collapsed to the bare singular "record" and the service-oriented `<h1>` frames
 * rendered broken copy — Apollon Music and Arts shipped **"Quality record Portland
 * counts on"** (and the frames read awkwardly for product/retail/food verticals in
 * general). `validateHeroNotPackDefault` only denylists the OLD static pack defaults,
 * so these dynamic-but-broken headlines passed. Fixing the derivation to keep the
 * natural retail/venue noun phrase ("record store", "book shop", "steak house") + using
 * frames that read cleanly for BOTH service and product verticals fixes every downstream
 * seeded string (about paragraphs, services intro, hero sub, and the H1), not just the H1.
 *
 * Pure. Never throw. Extracted so the derivation is unit-testable (the inline version
 * lived deep inside the workflow `run()` and had zero coverage).
 */

/**
 * Redundant corporate/legal suffixes that do NOT belong in running prose — stripped so
 * "Plumbing Services" → "plumbing", "Smith & Co LLC" → "smith &". Descriptive
 * retail/venue nouns (store, shop, house, studio, salon, center, parlor, clinic) are
 * DELIBERATELY kept — they ARE the vertical and reading "record store" / "steak house" is
 * correct where "record" / "steak" is broken.
 */
const REDUNDANT_SUFFIX =
  /\b(services?|company|co|llc|inc|corp|corporation|group|enterprises?|practice|agency|firm)\b/g;

/**
 * Derive a natural, prose-ready noun phrase from a declared business category.
 *
 * @param category - The declared vertical (e.g. `"Record Store"`, `"Plumbing Services"`,
 *   `"Steakhouse"`); any type (non-strings yield the fallback).
 * @returns A lowercased noun phrase safe to drop into copy, or `'local business'` when
 *   the category is blank/unusable. Retail/venue nouns are preserved.
 *
 * @example
 * categoryPhrase('Record Store')        // → 'record store'  (was the broken 'record')
 * categoryPhrase('Plumbing Services')   // → 'plumbing'
 * categoryPhrase('Steakhouse')          // → 'steakhouse'
 * categoryPhrase('Coffee Shop')         // → 'coffee shop'
 * categoryPhrase('')                    // → 'local business'
 */
export function categoryPhrase(category?: unknown): string {
  const raw = typeof category === 'string' ? category : '';
  const phrase = raw
    .toLowerCase()
    .replace(REDUNDANT_SUFFIX, '')
    .replace(/[&/]+\s*$/, '') // a trailing "&"/"/" left by a stripped suffix ("smith &")
    .replace(/\s{2,}/g, ' ')
    .trim();
  return phrase || 'local business';
}

/**
 * Hero `<h1>` headline options for a category phrase + city, worded to read naturally
 * for BOTH service and product/retail/food verticals (the old frames were
 * service-only). Identity-woven with the city so headlines never collide across
 * businesses/cities and never trip `validateHeroNotPackDefault`. The caller picks one.
 *
 * @param catPhrase - A phrase from {@link categoryPhrase} (e.g. `'record store'`).
 * @param cityPhrase - The city/community (e.g. `'Portland'`, or `'your community'`).
 * @returns Non-empty list of grammatical, slop-free headline candidates.
 *
 * @example
 * heroHeadlineOptions('record store', 'Portland')
 * // → ["Portland's record store", "Portland's trusted record store",
 * //    "Your Portland record store", "Quality record store Portland counts on"]
 */
export function heroHeadlineOptions(catPhrase: string, cityPhrase: string): readonly string[] {
  const cat = (catPhrase || 'local business').trim();
  const city = (cityPhrase || 'your community').trim();
  return [
    `${city}'s ${cat}`,
    `${city}'s trusted ${cat}`,
    `Your ${city} ${cat}`,
    `Quality ${cat} ${city} counts on`,
  ];
}
