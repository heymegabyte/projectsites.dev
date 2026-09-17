/**
 * vertical-rules.test.mjs — regression coverage for the vertical classifier.
 *
 * Run: node --test scripts/vertical-rules.test.mjs   (Node 22, no Jest, no server boot)
 *
 * Locks the AL-701 fix: pack-less verticals (hotel/gallery/tattoo/fish-market) no longer
 * inherit the RETAIL content pack ("free shipping / browse our collection") via retail's
 * greedy `boutique`/`shop`/`goods` tokens. Also guards the existing verticals against
 * regression (real boutique still → retail, coffee shop still → restaurant, etc.).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreVertical, matchDeclaredCategory, VERTICAL_RULES, LIGHT_VERTICAL_PRESETS } from './vertical-rules.mjs';

// Helper: classify from a single identity string (primary), optional research (secondary).
const v = (primary, secondary = '') => scoreVertical(primary.toLowerCase(), secondary.toLowerCase());

test('AL-701: boutique HOTEL routes to hospitality, never retail', () => {
  assert.equal(v('Hotel Emma', 'a boutique hotel in san antonio with a shop and dining'), '_brand.hospitality.json');
  assert.equal(v('The Boutique Hotel', 'luxury accommodations'), '_brand.hospitality.json');
  assert.equal(v('Cedar Lodge Resort', 'mountain resort and inn'), '_brand.hospitality.json');
  assert.equal(v('Harborview Inn', 'bed and breakfast, guest house'), '_brand.hospitality.json');
});

test('AL-701: art gallery routes to gallery, never retail on incidental "shop"/"store"', () => {
  assert.equal(v('Sean Kelly Gallery', 'contemporary art dealer with a gift shop and online store'), '_brand.gallery.json');
  assert.equal(v('The Modern Art Museum', 'exhibition space and fine art collection'), '_brand.gallery.json');
});

test('AL-701: tattoo shop does NOT score retail (falls through to orchestrator brand)', () => {
  // "tattoo shop" must not match retail's shop token; no other vertical claims tattoo,
  // so it returns '' — the orchestrator keeps its own AI-generated brand (no misfit copy).
  assert.equal(v('Three Kings Tattoo', 'brooklyn tattoo shop and studio'), '');
  assert.notEqual(v('Ink & Iron Tattoo', 'tattoo shop'), '_brand.retail.json');
});

test('AL-701: fish market / seafood routes to restaurant (food), never retail e-commerce', () => {
  assert.equal(v('Pike Place Fish Market', 'famous seafood market and fishmonger in seattle'), '_brand.restaurant.json');
  assert.equal(v('The Oyster Bar', 'fresh seafood and raw bar'), '_brand.restaurant.json');
});

test('regression: real retail still routes to retail', () => {
  assert.equal(v('Rose & Thread Boutique', 'independent apparel and clothing store'), '_brand.retail.json');
  assert.equal(v('Summit Outfitters', 'outdoor gear shop and merchandise'), '_brand.retail.json');
  assert.equal(v('Corner Bookshop', 'independent bookstore'), '_brand.retail.json');
  // A gift shop with no competing vertical is still retail.
  assert.equal(v('The Gift Shop', 'curated goods and gifts'), '_brand.retail.json');
});

test('regression: food/wellness "X shop" tie-breaks to the food/wellness vertical (earlier in order)', () => {
  assert.equal(v('Blue Bottle Coffee Shop', 'specialty coffee shop'), '_brand.restaurant.json');
  assert.equal(v("Gino's Barber Shop", 'classic barber shop and grooming'), '_brand.wellness.json');
});

test('regression: existing verticals unchanged', () => {
  assert.equal(v('Bright Smile Dentistry', 'family dentist and orthodontics'), '_brand.dental.json');
  assert.equal(v('Iron Forge Gym', 'strength training and crossfit'), '_brand.fitness.json');
  assert.equal(v('Flowdesk Analytics', 'saas software platform for teams'), '_brand.saas.json');
  assert.equal(v('Ridgeline Realty Group', 'real estate agency and realtor'), '_brand.real-estate.json');
  assert.equal(v('Blackbird Kitchen', 'farm-to-table restaurant'), '_brand.restaurant.json');
  assert.equal(v('Grace Community Soup Kitchen', 'nonprofit soup kitchen and food bank'), '_brand.nonprofit.json');
});

test('authoritative declared-category short-circuit routes new verticals', () => {
  assert.equal(matchDeclaredCategory('boutique hotel'), '_brand.hospitality.json');
  assert.equal(matchDeclaredCategory('art gallery'), '_brand.gallery.json');
  assert.equal(matchDeclaredCategory('seafood market'), '_brand.restaurant.json');
  assert.equal(matchDeclaredCategory('clothing store'), '_brand.retail.json');
  assert.equal(matchDeclaredCategory(''), '');
});

test('hospitality + gallery are DARK (not in LIGHT_VERTICAL_PRESETS)', () => {
  assert.equal(LIGHT_VERTICAL_PRESETS.has('_brand.hospitality.json'), false);
  assert.equal(LIGHT_VERTICAL_PRESETS.has('_brand.gallery.json'), false);
  // Every rule's preset filename is well-formed.
  for (const [file] of VERTICAL_RULES) assert.match(file, /^_brand\.[a-z-]+\.json$/);
});

test('no-match returns empty string (never a false retail default)', () => {
  assert.equal(v('Zzyzx Quantum Widgets', 'an entirely novel category with no keywords'), '');
});
