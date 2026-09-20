import {
  categoryFromName,
  categoryPhrase,
  cityFromAddress,
  heroCtasFor,
  heroHeadlineOptions,
  homepageFaq,
  indefiniteArticle,
  leadWithBusinessName,
  personaHeroCopy,
  seoDescriptionFor,
  seoTaglineOptions,
  trustBadgesFor,
} from '../services/hero_copy.js';

describe('hero_copy — heroCtasFor (AL-420: seeded hero CTA labels, never "Reserve a table" on quickserve)', () => {
  it('quickserve gets order/visit CTAs, NEVER a reservation', () => {
    const c = heroCtasFor('quickserve');
    expect(c.primary).toBe('Visit us');
    expect(c.secondary).toBe('See our flavors');
    expect(`${c.primary} ${c.secondary}`.toLowerCase()).not.toMatch(/reserve|reservation|table/);
  });
  it('every mode returns a non-empty, slop-free primary + secondary; unknown → general', () => {
    for (const m of [
      'retail',
      'quickserve',
      'hospitality',
      'service',
      'professional',
      'nonprofit',
      'general',
      'nope',
      '',
      null,
      undefined,
    ]) {
      const c = heroCtasFor(m as string);
      expect(c.primary.length).toBeGreaterThan(2);
      expect(c.secondary.length).toBeGreaterThan(2);
    }
    expect(heroCtasFor('totally-unknown')).toEqual(heroCtasFor('general'));
  });

  it('service mode: APPOINTMENT businesses BOOK, TRADES quote (AL-460 — no "free quote" on a yoga studio)', () => {
    // Appointment / class businesses inside `service` convert on booking — never a quote.
    for (const cat of [
      'Yoga Studio',
      'Hair Salon',
      'Day Spa',
      'Fitness Gym',
      'CrossFit',
      'Dental Clinic',
      'Massage Therapy',
      'Pilates Studio',
      'Veterinary Clinic',
      'Chiropractic',
    ]) {
      expect(heroCtasFor('service', cat).primary).toBe('Book now');
      // the exact live defect — a quote/estimate CTA must NOT appear on an appointment business
      expect(heroCtasFor('service', cat).primary.toLowerCase()).not.toMatch(/quote|estimate/);
    }
    // Trades inside `service` keep the price-first quote CTA (correct for them).
    for (const cat of [
      'Plumbing',
      'Roofing',
      'HVAC',
      'Electrician',
      'Junk Removal',
      'Auto Repair',
    ]) {
      expect(heroCtasFor('service', cat).primary).toBe('Get a free quote');
    }
    // No category → the safe default is unchanged (back-compat).
    expect(heroCtasFor('service').primary).toBe('Get a free quote');
    // Non-service modes ignore the category (quote sub-split is service-only).
    expect(heroCtasFor('retail', 'Yoga Studio').primary).toBe('Visit the shop');
  });

  it('quickserve mode: a GROCERY/MARKET shops (no "flavors"), a made-to-order counter keeps them (AL-819)', () => {
    // A grocery is routed to quickserve (AL-656, no reservations) but has no "flavors" — vision-caught
    // live on rainbow-grocery-san-francisco (secondary CTA "See our flavors" on a grocery).
    for (const cat of [
      'Grocery Store',
      'Supermarket',
      'Greengrocer',
      'Neighborhood Market',
      'Fish Market',
      'Butcher Shop',
    ]) {
      const c = heroCtasFor('quickserve', cat);
      expect(c.secondary).toBe("See what's in store");
      expect(c.secondary.toLowerCase()).not.toMatch(/flavor/);
    }
    // A real made-to-order counter (ice cream / coffee / juice) KEEPS "See our flavors" (no cross-fire).
    for (const cat of ['Ice Cream Shop', 'Coffee Shop', 'Juice Bar']) {
      expect(heroCtasFor('quickserve', cat).secondary).toBe('See our flavors');
    }
    // No category → the safe default is unchanged (back-compat).
    expect(heroCtasFor('quickserve').secondary).toBe('See our flavors');
  });
});

describe('hero_copy — trustBadgesFor (AL-518: commerce-mode trust badges, never "Free shipping" on a tattoo studio)', () => {
  it('SERVICE gets service-appropriate badges, NEVER retail shipping/returns (the live defect)', () => {
    const b = trustBadgesFor('service');
    expect(b).toEqual(['Licensed & insured', 'Free consultation', 'Satisfaction guaranteed']);
    // the exact seven-swords tattoo defect — no e-commerce chips on a non-retail site
    const joined = b.join(' ').toLowerCase();
    expect(joined).not.toMatch(/shipping|returns?|free shipping|30-day/);
  });

  it('RETAIL keeps the shipping/returns/quality triad (correct there — a florist DOES ship + return)', () => {
    expect(trustBadgesFor('retail')).toEqual([
      'Free shipping over $50',
      'Easy 30-day returns',
      'Quality guaranteed',
    ]);
  });

  it('quickserve GROCERY gets fresh-grocery badges, NOT "Made to order"; a real counter keeps it (AL-819)', () => {
    // A grocery makes nothing "to order" — it sells fresh + packaged goods you shop for.
    for (const cat of ['Grocery Store', 'Supermarket', 'Greengrocer', 'Fish Market']) {
      const b = trustBadgesFor('quickserve', cat);
      expect(b).toEqual(['Fresh daily', 'Order ahead', 'Grab & go']);
      expect(b.join(' ').toLowerCase()).not.toMatch(/made to order|flavor/);
    }
    // A real made-to-order counter (ice cream / coffee) KEEPS the made-to-order badge (no cross-fire).
    expect(trustBadgesFor('quickserve', 'Ice Cream Shop')).toEqual([
      'Made to order',
      'Order ahead',
      'Grab & go',
    ]);
    // No category → the safe default is unchanged (back-compat).
    expect(trustBadgesFor('quickserve')).toEqual(['Made to order', 'Order ahead', 'Grab & go']);
  });

  it('every mode returns exactly 3 non-empty, slop-free badges; unknown → general', () => {
    for (const m of [
      'quickserve',
      'hospitality',
      'retail',
      'service',
      'professional',
      'nonprofit',
      'gallery',
      'general',
      'nope',
      '',
      null,
      undefined,
    ]) {
      const b = trustBadgesFor(m as string);
      expect(b).toHaveLength(3);
      for (const badge of b) {
        expect(badge.length).toBeGreaterThan(2);
        // banned-slop guard mirrors build_validators.ts
        expect(badge.toLowerCase()).not.toMatch(
          /world-class|cutting-edge|revolutioniz|limitless|leverage/,
        );
      }
    }
    expect(trustBadgesFor('totally-unknown')).toEqual(trustBadgesFor('general'));
    expect(trustBadgesFor('  SERVICE  ')).toEqual(trustBadgesFor('service')); // case + trim insensitive
  });

  it('ONLY retail may carry shipping/returns copy — every other mode is free of e-commerce chips', () => {
    for (const m of [
      'quickserve',
      'hospitality',
      'service',
      'professional',
      'nonprofit',
      'gallery',
      'general',
    ]) {
      const joined = trustBadgesFor(m).join(' ').toLowerCase();
      expect(joined).not.toMatch(/shipping|returns?/);
    }
  });

  it('gallery mode is CURATORIAL — inquiry/viewing CTAs + non-retail badges, never cart/counter/shipping (wally-workman fix)', () => {
    const cta = heroCtasFor('gallery');
    expect(cta.primary).toBe('View the collection');
    expect(cta.secondary).toBe('Plan your visit');
    const badges = trustBadgesFor('gallery').join(' ').toLowerCase();
    expect(badges).not.toMatch(/shipping|returns?|cart|counter/);
    const faq = homepageFaq('gallery', 'Wally Workman Gallery', 'art gallery', 'Austin');
    const faqText = faq.items
      .map((i) => i.q + ' ' + i.a)
      .join(' ')
      .toLowerCase();
    expect(faqText).toMatch(/exhibition|collection|viewing|acquir|artist/); // curatorial vocabulary
    expect(faqText).not.toMatch(/the counter|free shipping|add to cart|30-day return/); // never retail
    const desc = seoDescriptionFor(
      'gallery',
      'Wally Workman Gallery',
      'art gallery',
      'Austin',
    ).toLowerCase();
    expect(desc).toMatch(/collection|exhibition|artist|visit/);
    expect(desc).not.toMatch(/the counter|free shipping/);
  });

  it('AL-518b: APPOINTMENT services book, TRADES stay "licensed & insured" (rudy-seattle barbershop read trades-y)', () => {
    // Appointment/class businesses inside `service` convert on booking — not a trades credential claim.
    for (const cat of [
      'Barbershop',
      'Hair Salon',
      'Day Spa',
      'Yoga Studio',
      'Dental Clinic',
      'Massage Therapy',
    ]) {
      const b = trustBadgesFor('service', cat);
      expect(b).toEqual([
        'Easy online booking',
        'Experienced professionals',
        'Satisfaction guaranteed',
      ]);
      expect(b.join(' ').toLowerCase()).not.toMatch(/licensed & insured/);
    }
    // Trades inside `service` keep the credential-first triad (correct for plumber/electrician/HVAC).
    for (const cat of ['Plumber', 'Electrician', 'HVAC Contractor', 'Roofing', 'Landscaping']) {
      expect(trustBadgesFor('service', cat)).toEqual([
        'Licensed & insured',
        'Free consultation',
        'Satisfaction guaranteed',
      ]);
    }
    // No category → the generic service triad (unchanged; safe default).
    expect(trustBadgesFor('service')).toEqual([
      'Licensed & insured',
      'Free consultation',
      'Satisfaction guaranteed',
    ]);
    // Category only sub-splits `service` — a retail category is ignored.
    expect(trustBadgesFor('retail', 'Barbershop')).toEqual([
      'Free shipping over $50',
      'Easy 30-day returns',
      'Quality guaranteed',
    ]);
  });
});

/**
 * Regression for AL-361 — the generic/broken hero <h1>. The old inline derivation
 * stripped `store`/`shop`, collapsing "Record Store" → the bare singular "record",
 * and the service-only frames rendered "Quality record Portland counts on" LIVE on
 * Apollon Music and Arts. These lock the fix: retail/venue nouns survive + the frames
 * read naturally for every vertical.
 */
describe('hero_copy — categoryPhrase (AL-361: keep the retail/venue noun phrase)', () => {
  it.each([
    ['Record Store', 'record store'], // the live defect — was the broken "record"
    ['Book Store', 'book store'],
    ['Coffee Shop', 'coffee shop'],
    ['Hardware Store', 'hardware store'],
    ['Steakhouse', 'steakhouse'],
    ['Hair Salon', 'hair salon'], // salon KEPT (descriptive), not stripped
    ['Dental Clinic', 'dental clinic'], // clinic KEPT
    ['Yoga Studio', 'yoga studio'], // studio KEPT
  ])('keeps the natural phrase: %s → %s', (input, expected) => {
    expect(categoryPhrase(input)).toBe(expected);
  });

  it.each([
    ['Plumbing Services', 'plumbing'], // redundant corporate suffix stripped (no re-expansion)
    ['Acme LLC', 'acme'],
    // NB: 'Insurance Agency'/'Consulting Group' strip THEN re-expand to the business noun
    // ('insurance agency'/'consulting firm') — asserted in the AL-565 professional-services test.
  ])('strips redundant corporate suffixes: %s → %s', (input, expected) => {
    expect(categoryPhrase(input)).toBe(expected);
  });

  it('falls back to "local business" (never the old "local service") for blank/odd input', () => {
    expect(categoryPhrase('')).toBe('local business');
    expect(categoryPhrase('   ')).toBe('local business');
    expect(categoryPhrase(undefined)).toBe('local business');
    // @ts-expect-error — defensive: non-string at runtime must not throw
    expect(categoryPhrase(42)).toBe('local business');
    expect(categoryPhrase('Services')).toBe('local business'); // strips to empty → fallback
  });

  it('AL-821: the bare "books" category normalizes to the singular "bookstore" (no "a books" grammar)', () => {
    // Live defect: green-apple-books-sf shipped subhead "…browses with us: a books where every visit…"
    // + desc "San Francisco's books". The OSM/Places category is the bare plural "books".
    expect(categoryPhrase('books')).toBe('bookstore');
    expect(categoryPhrase('book')).toBe('bookstore');
    expect(categoryPhrase('Bookshop')).toBe('bookstore');
    // still bookstore-classified downstream (indefinite article + persona both stay correct)
    expect(indefiniteArticle(categoryPhrase('books'))).toBe('a'); // "a bookstore", never "a books"
    expect(
      personaHeroCopy('scholarly', categoryPhrase('books'), 'San Francisco')!.headlines.join(' '),
    ).toMatch(/next read|browse|shelves/);
  });

  describe('AL-825: bare PRODUCT/MATERIAL nouns get a business-noun suffix (never "City\'s chocolate")', () => {
    // Live defect: dandelion-chocolate-sf shipped H1 "San Francisco's chocolate" — a product, not a
    // business. Same thin-noun class as the disciplines (AL-565) + "books" (AL-821).
    it.each([
      ['chocolate', 'chocolate shop'],
      ['Chocolate', 'chocolate shop'], // case-insensitive normalize
      ['chocolates', 'chocolate shop'],
      ['chocolatier', 'chocolate shop'],
      ['coffee', 'coffee shop'],
      ['espresso', 'coffee shop'],
      ['tea', 'tea shop'],
      ['cheese', 'cheese shop'],
      ['candy', 'candy shop'],
      ['confectionery', 'candy shop'],
      ['ice cream', 'ice cream shop'],
      ['gelato', 'gelato shop'],
      ['pastry', 'bakery'],
      ['bread', 'bakery'],
      ['jewelry', 'jewelry store'],
      ['flowers', 'florist'],
      ['floral', 'florist'],
    ])('%s → %s', (input, expected) => {
      expect(categoryPhrase(input)).toBe(expected);
    });

    it('makes the possessive persona H1 frame grammatical ("San Francisco\'s chocolate shop")', () => {
      // The exact live frame: `${city}'s ${categoryPhrase(cat)}` must read as a business, not a product.
      const cat = categoryPhrase('chocolate');
      expect(`San Francisco's ${cat}`).toBe("San Francisco's chocolate shop");
      // indefinite article stays correct ("a chocolate shop", never "a chocolate")
      expect(indefiniteArticle(cat)).toBe('a');
    });

    it('does NOT over-normalize an already-natural business phrase (idempotent)', () => {
      expect(categoryPhrase('Chocolate Shop')).toBe('chocolate shop');
      expect(categoryPhrase('Coffee Shop')).toBe('coffee shop'); // unchanged from AL-361 behavior
      expect(categoryPhrase('Bakery')).toBe('bakery');
      expect(categoryPhrase('Jewelry Store')).toBe('jewelry store');
    });

    it('AL-857: bare "photo"/"camera" (OSM shop=photo) → "camera shop", not the product word', () => {
      // Live defect on glazers-camera-seattle: business_category "photo" → H1 "Seattle's photo",
      // title "Your neighborhood photo" — a product, not a business (same thin-noun class as
      // AL-821 "books" + AL-825 "chocolate").
      for (const input of ['photo', 'photos', 'photography', 'camera', 'cameras', 'Camera']) {
        expect(categoryPhrase(input)).toBe('camera shop');
      }
      // possessive + neighborhood + indefinite-article frames all stay grammatical
      const cat = categoryPhrase('photo');
      expect(`Seattle's ${cat}`).toBe("Seattle's camera shop");
      expect(indefiniteArticle(cat)).toBe('a'); // "a camera shop", never "a photo"
      // suffixed retail forms were already grammatical — must stay preserved (not over-normalized)
      expect(categoryPhrase('Camera Store')).toBe('camera store');
      expect(categoryPhrase('Photo Store')).toBe('photo store');
    });
  });

  it('AL-820: transit/infrastructure POI types degrade to "local business", never an absurd H1', () => {
    // Live defect: "Berkeley Bowl" the grocery collided with the AC-Transit "Berkeley Bowl" bus_stop →
    // business_category "bus_stop" → H1 "The bus stop Berkeley counts on". A non-business POI type must
    // never render as a vertical.
    for (const t of [
      'bus_stop',
      'bus stop',
      'bus_station',
      'transit_station',
      'train_station',
      'subway_station',
      'light_rail_station',
      'tram_stop',
      'taxi_stand',
      'parking',
      'parking_lot',
      'park_and_ride',
      'street_address',
      'route',
    ]) {
      expect(categoryPhrase(t)).toBe('local business');
    }
    // REGRESSION GUARD: real businesses that merely resemble a transit word are NOT swallowed.
    expect(categoryPhrase('gas station')).toBe('gas station');
    expect(categoryPhrase('fire station')).toBe('fire station');
    // NON_BUSINESS_POI is anchored (^…$) → a real business that merely contains a transit word is NOT
    // swallowed to 'local business' (it keeps its own noun, here suffix-stripped to "bus tour").
    expect(categoryPhrase('bus tour company')).not.toBe('local business');
    expect(categoryPhrase('grocery store')).toBe('grocery store');
  });

  it('normalizes snake_case Google-Places types — no raw type-token in copy (AL-410)', () => {
    // Live defect: Blue Sky Vet shipped H1 "Your Bend veterinary_care" — create-from-search
    // seeds business_category from Places types[0] (snake_case), and categoryPhrase passed the
    // raw underscore token straight into the hero frame. Underscore → space + normalize.
    expect(categoryPhrase('veterinary_care')).toBe('veterinary clinic');
    expect(categoryPhrase('car_repair')).toBe('auto shop');
    expect(categoryPhrase('beauty_salon')).toBe('salon');
    expect(categoryPhrase('point_of_interest')).toBe('local business'); // junk type → clean fallback
    // a snake_case type with no map entry still normalizes to a readable phrase (never a raw token)
    expect(categoryPhrase('bicycle_store')).toBe('bicycle store');
    expect(categoryPhrase('home_goods_store')).not.toContain('_');
    // the H1 frame built from it is clean (the real delivered surface)
    expect(heroHeadlineOptions(categoryPhrase('veterinary_care'), 'Bend')).toContain(
      'Your Bend veterinary clinic',
    );
    expect(heroHeadlineOptions(categoryPhrase('veterinary_care'), 'Bend').join(' ')).not.toContain(
      '_',
    );
  });

  it('normalizes adjectival/thin categories to natural noun phrases (AL-389)', () => {
    // live defect: Gentle Dental shipped "Quality dental Seattle counts on" (bare adjective)
    expect(categoryPhrase('Dental')).toBe('dental practice');
    expect(categoryPhrase('Dentist')).toBe('dental practice');
    expect(categoryPhrase('Dental Practice')).toBe('dental practice'); // strip "practice" → "dental" → re-expand
    expect(categoryPhrase('Medical')).toBe('medical practice');
    expect(categoryPhrase('Law Firm')).toBe('law firm'); // strip "firm" → "law" → re-expand
    expect(categoryPhrase('Legal')).toBe('law firm');
    expect(categoryPhrase('Chiropractic')).toBe('chiropractic clinic');
    // NOT over-normalized — kept nouns + non-thin verticals + categoryFromName output round-trip
    expect(categoryPhrase('Dental Clinic')).toBe('dental clinic');
    expect(categoryPhrase('record store')).toBe('record store');
    expect(categoryPhrase('Plumbing Services')).toBe('plumbing');
  });

  it('suffixes professional-services DISCIPLINE nouns to a business noun (AL-565)', () => {
    // live defects: olson-kundig-seattle H1 "Seattle's trusted architecture" + title "Your
    // neighborhood architecture"; ben-badgley-cpa title "Your neighborhood accounting". A bare
    // discipline noun reads as a FIELD, not a business — suffix firm/agency/studio.
    expect(categoryPhrase('Architecture')).toBe('architecture firm');
    expect(categoryPhrase('architect')).toBe('architecture firm');
    expect(categoryPhrase('Accounting')).toBe('accounting firm');
    expect(categoryPhrase('CPA')).toBe('accounting firm');
    expect(categoryPhrase('Consulting')).toBe('consulting firm');
    expect(categoryPhrase('Engineering')).toBe('engineering firm');
    expect(categoryPhrase('Marketing')).toBe('marketing agency');
    // round-trips: REDUNDANT_SUFFIX strips firm/agency/studio, then CATEGORY_NORMALIZE re-expands
    expect(categoryPhrase('Architecture Firm')).toBe('architecture firm');
    expect(categoryPhrase('Insurance Agency')).toBe('insurance agency'); // AL-565: was bare 'insurance'
    expect(categoryPhrase('Consulting Group')).toBe('consulting firm'); // strip "group" → re-expand
    expect(categoryPhrase('Marketing Agency')).toBe('marketing agency');
    // the woven H1 + title are now grammatical (not "Seattle's trusted architecture")
    expect(heroHeadlineOptions('architecture firm', 'Seattle')).toContain(
      "Seattle's trusted architecture firm",
    );
    // NOT over-reaching: concrete verticals + real estate/design map correctly
    expect(categoryPhrase('Real Estate')).toBe('real estate agency');
    expect(categoryPhrase('Design')).toBe('design studio');
  });

  it('derives an architecture firm from the business NAME (AL-565)', () => {
    expect(categoryFromName('Olson Kundig Architects')).toBe('architecture firm');
    expect(categoryFromName('Gensler Architecture')).toBe('architecture firm');
    // distinctive token — no false match on unrelated names
    expect(categoryFromName('Archie Comics')).toBe('');
  });
});

describe('hero_copy — heroHeadlineOptions (AL-361: grammatical for every vertical)', () => {
  it('no bare-noun "Quality record …" (AL-361) AND no weak "Quality" lead at all (AL-576)', () => {
    const opts = heroHeadlineOptions(categoryPhrase('Record Store'), 'Portland');
    expect(opts).not.toContain('Quality record Portland counts on'); // AL-361: never the bare "record"
    // AL-576: the weak generic "Quality … counts on" 4th frame is replaced by a clean relative clause.
    expect(opts).toContain('The record store Portland counts on');
    expect(opts.join(' ')).not.toMatch(/\bQuality\b/); // no "Quality" opener anywhere in the option set
  });

  it('every option carries the FULL noun phrase + the city, and is non-empty', () => {
    const opts = heroHeadlineOptions('record store', 'Portland');
    expect(opts.length).toBeGreaterThanOrEqual(3);
    for (const o of opts) {
      expect(o).toContain('record store'); // never the bare "record"
      expect(o).toContain('Portland');
      expect(o.trim().length).toBeGreaterThan(0);
    }
    expect(opts).toEqual([
      "Portland's record store",
      "Portland's trusted record store",
      'Your Portland record store',
      'The record store Portland counts on',
    ]);
  });

  it('drops the old service-only "Expert ${x} in ${city}" frame that mangled retail', () => {
    const opts = heroHeadlineOptions('record store', 'Portland');
    expect(opts.some((o) => o.startsWith('Expert '))).toBe(false);
  });

  it('reads naturally for a service vertical too (no regression)', () => {
    const opts = heroHeadlineOptions(categoryPhrase('Plumbing Services'), 'Austin');
    expect(opts).toContain("Austin's plumbing");
    expect(opts).toContain("Austin's trusted plumbing");
  });

  it('contains no banned-slop words', () => {
    const banned = /\b(limitless|revolutionize|cutting-edge|leverage|world-class)\b/i;
    for (const o of heroHeadlineOptions('steak house', 'Chicago')) {
      expect(banned.test(o)).toBe(false);
    }
  });

  it('is graceful on blank inputs (fallback phrasing, never throws)', () => {
    expect(() => heroHeadlineOptions('', '')).not.toThrow();
    const opts = heroHeadlineOptions('', '');
    expect(opts.every((o) => o.includes('local business') && o.includes('your community'))).toBe(
      true,
    );
  });
});

/**
 * Regression for AL-369 — the generic/colliding SEO_TAGLINE. Every restaurant shipped
 * the IDENTICAL "Fresh, Local, Made From Scratch" `<title>` suffix (Ember + Cafe Dim Sum
 * live). These lock the fix: vertical-specific, city-free, distinct from the H1.
 */
describe('hero_copy — seoTaglineOptions (AL-369: vertical-specific <title> suffix)', () => {
  it('NEVER produces the generic colliding "Fresh, Local, Made From Scratch"', () => {
    const opts = seoTaglineOptions(categoryPhrase('Dim Sum Restaurant'));
    expect(opts).not.toContain('Fresh, Local, Made From Scratch');
  });

  it('every option is vertical-specific (carries the category), capital-start, city-free', () => {
    const opts = seoTaglineOptions('record store');
    expect(opts.length).toBeGreaterThanOrEqual(2);
    for (const o of opts) {
      expect(o).toContain('record store'); // vertical keyword, not a generic value-prop
      expect(o[0]).toBe(o[0].toUpperCase()); // title-cased start
      expect(o).not.toMatch(/\b(portland|burlington|austin|\| )/i); // city is appended by Home.tsx
    }
    expect(opts).toEqual([
      'Trusted local record store',
      'Your neighborhood record store',
      'Local record store you can trust',
    ]);
  });

  it('is DISTINCT from the H1 frames (so <title> suffix ≠ <h1>)', () => {
    const cat = 'record store';
    const h1s = new Set(heroHeadlineOptions(cat, 'Portland'));
    for (const tag of seoTaglineOptions(cat)) expect(h1s.has(tag)).toBe(false);
  });

  it('contains no banned-slop words + is graceful on blank', () => {
    const banned = /\b(limitless|revolutionize|cutting-edge|leverage|world-class)\b/i;
    for (const o of seoTaglineOptions('steak house')) expect(banned.test(o)).toBe(false);
    expect(() => seoTaglineOptions('')).not.toThrow();
    expect(seoTaglineOptions('').every((o) => o.includes('local business'))).toBe(true);
  });
});

/**
 * Regression for AL-377 — the category-less create-from-search generic hero. McGuckin
 * Hardware (created with name+address, NO category) shipped a live H1 "Quality local
 * business Boulder counts on" + a "…Local local business you can trust" <title> because
 * the seed read params.businessCategory raw (empty) → categoryPhrase('') → 'local
 * business'. categoryFromName derives the vertical from the NAME so the fast-path seed
 * falls back to a business-specific category instead of the generic filler.
 */
describe('hero_copy — categoryFromName (AL-377: derive vertical from NAME when category-less)', () => {
  it.each([
    ['McGuckin Hardware', 'hardware store'], // the live defect ("Quality local business Boulder counts on")
    ['Sunrise Bakery', 'bakery'],
    ['Elm Street Dental', 'dental practice'],
    ['Boulder Yoga Collective', 'yoga studio'],
    ['Ace Plumbing', 'plumbing'],
    ['Blue Ridge Law Group', 'law firm'],
    ["Tony's Auto Repair", 'auto shop'],
    ['Summit Roofing', 'roofing'],
    ['Petals Florist', 'florist'],
    ['Kabuki Springs & Spa', 'spa'], // AL-383: live miss — spa (+ massage/chiropractic) was dropped from the map
    ['Serenity Massage Therapy', 'massage therapy'],
    ['Waterloo Records', 'record store'], // AL-388: record/music retail fell to "local business" live
    ['Grimeys Vinyl', 'record store'],
    ['Apollon Music and Arts', 'music shop'],
  ])('reads the vertical out of the name: %s → %s', (name, expected) => {
    expect(categoryFromName(name)).toBe(expected);
  });

  it('is word-boundary-precise (no substring false positives)', () => {
    expect(categoryFromName('Lawson & Sons')).toBe(''); // "Lawson" ≠ law
    expect(categoryFromName('Autograph Studios')).toBe(''); // "Autograph" ≠ auto
    expect(categoryFromName('Recorder Repair')).toBe(''); // AL-388: "Recorder" ≠ record
  });

  it('returns "" for a name with no recognizable vertical (caller falls back to local business)', () => {
    expect(categoryFromName('Harvest & Vine')).toBe('');
    expect(categoryFromName('')).toBe('');
    expect(categoryFromName(undefined)).toBe('');
    // @ts-expect-error — defensive: non-string must not throw
    expect(categoryFromName(42)).toBe('');
  });

  it('composes as the fast-path seed uses it: params.businessCategory || categoryFromName(name)', () => {
    // category-less create → name-derived vertical drives the H1 (not the generic fallback)
    expect(categoryPhrase('' || categoryFromName('McGuckin Hardware'))).toBe('hardware store');
    expect(
      heroHeadlineOptions(categoryPhrase(categoryFromName('McGuckin Hardware')), 'Boulder'),
    ).toContain("Boulder's trusted hardware store");
    // a DECLARED category still wins over the name heuristic
    expect(categoryPhrase('Coffee Shop' || categoryFromName('McGuckin Hardware'))).toBe(
      'coffee shop',
    );
  });
});

describe('homepageFaq — homepage content-density lever (AL-409)', () => {
  const BANNED =
    /limitless|revolutioniz|cutting-edge|leverage|world-class|game-chang|unlock|elevate|unparalleled|seamless/i;

  it('returns exactly 5 Q&A pairs + a headline for every mode (AL-466: 4→5 density lever)', () => {
    for (const mode of [
      'hospitality',
      'service',
      'retail',
      'professional',
      'nonprofit',
      'general',
    ]) {
      const faq = homepageFaq(mode, 'Acme Co', 'widget shop', 'Springfield');
      expect(faq.items).toHaveLength(5);
      expect(faq.headline.length).toBeGreaterThan(3);
      for (const it of faq.items) {
        expect(it.q.trim().length).toBeGreaterThan(5);
        expect(it.a.trim().length).toBeGreaterThan(40);
      }
    }
  });

  it('adds ≥225 words of real content (the density lever) with no banned slop', () => {
    const faq = homepageFaq('hospitality', "Schramm's Mead", 'meadery', 'Ferndale');
    const words = faq.items
      .map((i) => `${i.q} ${i.a}`)
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(225);
    for (const it of faq.items) {
      expect(it.q).not.toMatch(BANNED);
      expect(it.a).not.toMatch(BANNED);
    }
  });

  it('is commerce-mode specific — hospitality asks reservations, service asks estimates', () => {
    expect(homepageFaq('hospitality', 'X', 'bar', 'Y').items[0].q.toLowerCase()).toContain(
      'reservation',
    );
    expect(homepageFaq('service', 'X', 'plumbing', 'Y').items[0].q.toLowerCase()).toContain(
      'estimate',
    );
    expect(homepageFaq('retail', 'X', 'shop', 'Y').items.some((i) => /return/i.test(i.q))).toBe(
      true,
    );
    expect(
      homepageFaq('nonprofit', 'X', 'charity', 'Y').items.some((i) =>
        /donation|help|volunteer/i.test(i.q),
      ),
    ).toBe(true);
  });

  it('weaves the real business name + city into answers (never collides, never generic)', () => {
    const faq = homepageFaq('hospitality', "Schramm's Mead", 'meadery', 'Ferndale');
    const all = faq.items.map((i) => i.a).join(' ');
    expect(all).toContain("Schramm's Mead");
    expect(all).toContain('Ferndale');
  });

  it('falls back to the general set for unknown/empty/nullish mode; never throws', () => {
    expect(homepageFaq('nope', 'X', 'shop', 'Y').items).toHaveLength(5);
    expect(homepageFaq('', 'X', 'shop', 'Y').items).toHaveLength(5);
    expect(homepageFaq(undefined, 'X', 'shop', 'Y').items).toHaveLength(5);
    expect(homepageFaq(null, 'X', 'shop', 'Y').items).toHaveLength(5);
    // @ts-expect-error — defensive: non-string mode must not throw
    expect(() => homepageFaq(42, 'X', 'shop', 'Y')).not.toThrow();
  });

  it('handles empty name/category/city without producing undefined text', () => {
    const faq = homepageFaq('general', '', '', '');
    for (const it of faq.items) {
      expect(it.a).not.toContain('undefined');
      expect(it.a.length).toBeGreaterThan(20);
    }
  });
});

/**
 * Regression for AL-483 — personality-flat hero voice ("more elaborate themes"). Live defect:
 * the-secret-society-portland (a NOIR cocktail lounge) shipped the plumber-voice H1 "Quality
 * cocktail bar Portland counts on" + title "Local cocktail bar you can trust" — the dark noir
 * CSS landed but the COPY read like a rugged trade. personaHeroCopy gives each DISTINCTIVE
 * personality a voice-matched headline + subheadline so the delivered hero reads like its theme.
 */
describe('hero_copy — personaHeroCopy (AL-483: personality-aware hero voice)', () => {
  const BANNED =
    /limitless|revolutioniz|cutting-edge|leverage|world-class|game-chang|unlock|elevate|unparalleled|seamless|robust|synergy|holistic|turnkey|utilize/i;
  const DISTINCTIVE = [
    'noir',
    'luxe',
    'warm',
    'bold',
    'artisan',
    'retro',
    'boutique',
    'heritage',
    'botanical',
    'scholarly',
    'precision',
    'brutalist',
  ];

  it('AL-654: the warm persona subhead is vertical-NEUTRAL — no hardcoded "coffee" cafe-ism', () => {
    // franklin-barbecue (BBQ) + pizzeria-bianco both shipped "…where the coffee is hot" — a cafe-ism
    // hardcoded in the warm subhead. Root fix → "where the welcome is warm" (fits every hospitality
    // vertical). A non-cafe hospitality business must never read "coffee" in its hero subhead.
    for (const cat of ['barbecue restaurant', 'pizzeria', 'steakhouse', 'diner']) {
      const p = personaHeroCopy('warm', cat, 'Austin');
      expect(p).not.toBeNull();
      for (const sub of p!.subheadlines) {
        expect(sub.toLowerCase()).not.toContain('coffee');
      }
      // still warm + welcoming (the vertical-neutral replacement lands)
      expect(p!.subheadlines.join(' ').toLowerCase()).toMatch(/welcome is warm|feel at home/);
    }
  });

  it('noir gets an after-dark voice, NOT the plumber-voice live defect', () => {
    const p = personaHeroCopy('noir', 'cocktail bar', 'Portland');
    expect(p).not.toBeNull();
    // the exact live defect strings must NOT appear
    expect(p!.headlines).not.toContain('Quality cocktail bar Portland counts on');
    for (const h of p!.headlines) {
      expect(h).not.toMatch(/quality .* counts on|you can trust|dependable choice/i);
    }
    // reads like an after-dark cocktail den
    expect(p!.headlines.join(' ').toLowerCase()).toMatch(/after dark|night|room after dark/);
    // subheadline still carries the category keyword (SEO) + city (anti-collision)
    expect(p!.subheadlines.every((s) => s.includes('cocktail bar') && s.includes('Portland'))).toBe(
      true,
    );
  });

  it('noir on a TATTOO studio gets INK copy, NOT the nightlife "room after dark"/"careful pours" misfit (AL-696)', () => {
    // A tattoo shop is routed to noir (dark aesthetic fits) but must NOT inherit the bar copy.
    // Live defect: three-kings-tattoo-brooklyn shipped H1 "Brooklyn's room after dark".
    const p = personaHeroCopy('noir', 'tattoo studio', 'Brooklyn');
    expect(p).not.toBeNull();
    const allText = [...p!.headlines, ...p!.subheadlines].join(' ').toLowerCase();
    // the exact nightlife-misfit strings must NOT appear on a tattoo studio
    expect(allText).not.toMatch(/room after dark|careful pours|candlelit|nights begin|after dark/);
    // it reads like an ink/craft studio instead
    expect(allText).toMatch(/ink|custom|wear your story/);
    // still SEO-woven: category keyword + city present
    expect(
      p!.subheadlines.every((s) => s.includes('tattoo studio') && s.includes('Brooklyn')),
    ).toBe(true);
    // REGRESSION GUARD: an actual cocktail bar KEEPS the nightlife copy (the two never cross-fire).
    const bar = personaHeroCopy('noir', 'cocktail bar', 'Portland');
    expect(bar!.headlines.join(' ').toLowerCase()).toMatch(/after dark|nights begin/);
    expect(bar!.headlines.join(' ').toLowerCase()).not.toMatch(/ink|wear your story/);
  });

  it('scholarly on a BOOKSTORE gets BROWSE/READ copy, NOT the education "Bright futures"/"learns" misfit (AL-810)', () => {
    // A bookstore is routed to scholarly (books/reading aesthetic fits) but must NOT inherit the
    // education copy. Live defect: strand-book-store-broadway shipped H1 "Bright futures start in New York".
    const p = personaHeroCopy('scholarly', 'bookstore', 'New York');
    expect(p).not.toBeNull();
    const allText = [...p!.headlines, ...p!.subheadlines].join(' ').toLowerCase();
    // the exact education-misfit strings must NOT appear on a bookstore
    expect(allText).not.toMatch(
      /bright futures|new york learns|patient teaching|every learner|families choose|learning click/,
    );
    // it reads like a bookseller instead
    expect(allText).toMatch(/read|browse|shelves|staff picks/);
    // still SEO-woven: category keyword + city present in every subhead
    expect(p!.subheadlines.every((s) => s.includes('bookstore') && s.includes('New York'))).toBe(
      true,
    );
    // REGRESSION GUARD: an actual tutoring center KEEPS the learning copy (the two never cross-fire).
    const school = personaHeroCopy('scholarly', 'tutoring center', 'Denver');
    expect(school!.headlines.join(' ').toLowerCase()).toMatch(/learns|bright futures/);
    expect(school!.headlines.join(' ').toLowerCase()).not.toMatch(/read|browse|shelves/);
  });

  it('warm on a GROCERY/MARKET gets STOCK-UP/SHOP copy, NOT the sit-down "Pull up a chair"/"seat" dining misfit (AL-819)', () => {
    // A grocery is routed to warm (warm food aesthetic fits) but must NOT inherit the sit-down dining
    // copy. Live defect: rainbow-grocery-san-francisco shipped H1 "Pull up a chair, San Francisco" — you
    // SHOP at a grocery, you don't pull up a chair. Covers the walk-in-food family.
    for (const cat of [
      'grocery store',
      'supermarket',
      'greengrocer',
      'neighborhood market',
      'fish market',
    ]) {
      const p = personaHeroCopy('warm', cat, 'San Francisco');
      expect(p).not.toBeNull();
      const allText = [...p!.headlines, ...p!.subheadlines].join(' ').toLowerCase();
      // the exact sit-down dining-misfit strings must NOT appear on a grocery
      expect(allText).not.toMatch(
        /pull up a chair|everyone has a seat|slow down|cozy corner|feel at home/,
      );
      // it reads like a grocer instead (stock up / market / aisles / shelves / produce / on your list)
      expect(allText).toMatch(/stock up|market|aisles|shelves|produce|on your list|shops with us/);
      // still SEO-woven: category keyword + city present in every subhead
      expect(p!.subheadlines.every((s) => s.includes(cat) && s.includes('San Francisco'))).toBe(
        true,
      );
    }
    // REGRESSION GUARD: an actual restaurant KEEPS the sit-down dining copy (the two never cross-fire).
    const diner = personaHeroCopy('warm', 'barbecue restaurant', 'Austin');
    expect(diner!.headlines.join(' ').toLowerCase()).toMatch(/pull up a chair|cozy corner/);
    expect(diner!.headlines.join(' ').toLowerCase()).not.toMatch(/stock up|on your list/);
  });

  it('bold on a SPORTING-GOODS SHOP gets GEAR-UP copy, NOT the fitness "Train harder"/"coaching, sweat" misfit (AL-852)', () => {
    // A surf/ski/bike/outdoor shop is routed to bold (high-energy aesthetic fits) but must NOT inherit
    // the gym coaching copy. Live defect: mollusk-surf-shop shipped H1 "Train harder in San Francisco"
    // + a "real coaching, real sweat" subhead — Mollusk SELLS surfboards, it does not coach.
    for (const cat of [
      'surf shop',
      'ski shop',
      'bike shop',
      'outdoor outfitter',
      'sporting goods store',
    ]) {
      const p = personaHeroCopy('bold', cat, 'San Francisco');
      expect(p).not.toBeNull();
      const allText = [...p!.headlines, ...p!.subheadlines].join(' ').toLowerCase();
      // the exact fitness-coaching-misfit strings must NOT appear on a gear shop
      expect(allText).not.toMatch(
        /train harder|strongest self|real coaching|real sweat|let's get to work/,
      );
      // it reads like a gear shop instead
      expect(allText).toMatch(/gear up|find your kit|the good stuff|equipment|gears up/);
      // still SEO-woven: category keyword + city present in every subhead
      expect(p!.subheadlines.every((s) => s.includes(cat) && s.includes('San Francisco'))).toBe(
        true,
      );
    }
    // REGRESSION GUARD: an actual gym KEEPS the coaching copy (the two never cross-fire).
    const gym = personaHeroCopy('bold', 'gym', 'Denver');
    expect(gym!.headlines.join(' ').toLowerCase()).toMatch(/train harder|strongest self/);
    expect(gym!.headlines.join(' ').toLowerCase()).not.toMatch(/gear up|find your kit/);
  });

  it('every distinctive personality returns non-empty, city+category-woven, slop-free copy', () => {
    for (const key of DISTINCTIVE) {
      const p = personaHeroCopy(key, 'cocktail bar', 'Portland');
      expect(p).not.toBeNull();
      expect(p!.headlines.length).toBeGreaterThanOrEqual(2);
      expect(p!.subheadlines.length).toBeGreaterThanOrEqual(2);
      for (const h of p!.headlines) {
        expect(h.trim().length).toBeGreaterThan(0);
        expect(h).toContain('Portland'); // city-woven → anti-collision
        expect(h).not.toMatch(BANNED);
      }
      for (const s of p!.subheadlines) {
        expect(s).toContain('cocktail bar'); // category keyword for SEO
        expect(s).toContain('Portland');
        expect(s).not.toMatch(BANNED);
        expect(s.length).toBeGreaterThan(40);
      }
    }
  });

  // AL-501: the 2×-confirmed persona-subhead grammar defect — a category noun bare after a
  // preposition ("for bookstore that…" / "jewelry store done with…"). Now every preposition slot
  // carries a grammatical article; assert it across categories INCLUDING vowel-initial ones.
  it('AL-501: subheadlines grammatical for every category — no bare noun after a preposition, correct a/an', () => {
    const cats = ['bookstore', 'jewelry store', 'art gallery', 'ice cream shop', 'urgent care'];
    for (const cat of cats) {
      const vowel = /^[aeiou]/i.test(cat); // vowel-initial → "a X" would be the WRONG article
      for (const key of DISTINCTIVE) {
        const p = personaHeroCopy(key, cat, 'Seattle');
        expect(p).not.toBeNull();
        for (const s of [...p!.headlines, ...p!.subheadlines]) {
          expect(s.includes(`for ${cat}`)).toBe(false); // "for a/an ${cat}", never bare
          expect(s.includes(`with ${cat}`)).toBe(false);
          expect(s.includes(`— ${cat}`)).toBe(false);
          expect(s.includes(`: ${cat}`)).toBe(false);
          expect(s.includes(`A ${cat}`)).toBe(false); // sentence-initial bare article → reworded to "The ${cat}"
          if (vowel) expect(s.includes(`a ${cat}`)).toBe(false); // never "a art gallery" — must be "an"
        }
      }
    }
  });

  it('AL-542: brutalist headline capitalizes the sentence-initial category (never "New York. design studio.")', () => {
    // Live on pentagram-nyc: "New York. design studio. No compromise" — `cat` is lowercase AND
    // sentence-initial (it follows a period), so it read cap/lower/cap like a capitalization bug.
    // The fragment after ". " must be capitalized; only the first letter (multi-word phrase stays
    // "Design studio", never "Design Studio").
    for (const cat of ['design studio', 'creative studio', 'art gallery']) {
      const p = personaHeroCopy('brutalist', cat, 'New York');
      const h = p!.headlines.find((x) => x.includes('No compromise'))!;
      const capCat = cat.charAt(0).toUpperCase() + cat.slice(1);
      expect(h).toBe(`New York. ${capCat}. No compromise`);
      expect(h).not.toContain(`. ${cat}.`); // never the lowercase sentence-initial form
    }
  });

  // AL-585: the boutique persona shipped a vertical-AGNOSTIC filler headline ("Find something
  // special in New York" on a bike shop — indistinguishable from any gift shop). Every boutique
  // headline candidate must now carry the category so `pick()` can never select a hero that drops
  // the vertical (same class as AL-576's "Quality … counts on" weak-lead fix).
  it('AL-585: boutique headlines all carry the category — no vertical-agnostic "Find something special" filler', () => {
    for (const cat of ['bicycle shop', 'record store', 'plant shop', 'boutique']) {
      const p = personaHeroCopy('boutique', cat, 'New York');
      expect(p).not.toBeNull();
      for (const h of p!.headlines) {
        expect(h).not.toMatch(/find something special/i); // the exact retired filler
        expect(h.toLowerCase()).toContain(cat.toLowerCase()); // every candidate is category-bearing
      }
      expect(p!.headlines).toContain(`The New York ${cat} worth the trip`);
    }
  });

  it('indefiniteArticle — "an" before a vowel, "a" otherwise', () => {
    expect(indefiniteArticle('bookstore')).toBe('a');
    expect(indefiniteArticle('jewelry store')).toBe('a');
    expect(indefiniteArticle('art gallery')).toBe('an');
    expect(indefiniteArticle('ice cream shop')).toBe('an');
    expect(indefiniteArticle('urgent care')).toBe('an');
    expect(indefiniteArticle('')).toBe('a');
  });

  it('AL-508: heritage headline article agrees with the CITY (An Asheville / A Boston, never "A Asheville")', () => {
    // Live defect on ben-badgley-cpa: "A Asheville accounting built on trust" (hardcoded "A").
    const line = (city: string) =>
      personaHeroCopy('heritage', 'accounting', city)!.headlines.find((h) =>
        /built on trust/.test(h),
      )!;
    expect(line('Asheville')).toBe('An Asheville accounting built on trust'); // vowel → An
    expect(line('Austin')).toBe('An Austin accounting built on trust');
    expect(line('Boston')).toBe('A Boston accounting built on trust'); // consonant → A
    expect(line('Houston')).toBe('A Houston accounting built on trust'); // H consonant → A
    // the exact live defect must never recur:
    expect(line('Asheville')).not.toMatch(/^A Asheville/);
  });

  it('returns null for neutral/unknown/empty personalities (caller keeps generic frames)', () => {
    for (const key of [
      'classic',
      'editorial',
      'futuristic',
      'rugged',
      'nope',
      '',
      null,
      undefined,
    ]) {
      expect(personaHeroCopy(key as string, 'plumbing', 'Denver')).toBeNull();
    }
    // @ts-expect-error — defensive: non-string themeStyle must not throw
    expect(personaHeroCopy(42, 'plumbing', 'Denver')).toBeNull();
  });

  it('is graceful on blank category/city (fallback tokens, never throws)', () => {
    expect(() => personaHeroCopy('noir', '', '')).not.toThrow();
    const p = personaHeroCopy('noir', '', '');
    expect(p).not.toBeNull();
    expect(
      p!.subheadlines.every((s) => s.includes('local business') && s.includes('your community')),
    ).toBe(true);
  });

  it('distinctive personalities read DISTINCTLY from each other (not the same template)', () => {
    const noir = personaHeroCopy('noir', 'cafe', 'Austin')!.headlines[0];
    const warm = personaHeroCopy('warm', 'cafe', 'Austin')!.headlines[0];
    const bold = personaHeroCopy('bold', 'gym', 'Austin')!.headlines[0];
    expect(new Set([noir, warm, bold]).size).toBe(3);
  });

  // AL-611: `botanical` is worn by BOTH health/wellness AND plant/garden/florist retail (routed here
  // by theme_style.ts AL-610). The wellness hero copy ("Feel better" / "take a deep breath" /
  // "unhurried care") is a MISFIT on a garden shop — flora-grubb-san-francisco shipped H1 "Feel
  // better in San Francisco". Sub-classify by category: plant/garden/florist → GROW copy, wellness
  // keeps CARE copy. Same lever as heroCtasFor's APPOINTMENT_CATEGORY branch.
  describe('AL-611: botanical splits plant/garden GROW copy from wellness CARE copy', () => {
    const PLANT = [
      'garden shop & plant nursery',
      'plant nursery',
      'garden center',
      'florist',
      'flower shop',
      'greenhouse',
    ];
    const WELLNESS = [
      'family dentistry',
      'day spa',
      'yoga studio',
      'med spa',
      'chiropractic clinic',
    ];

    it('plant/garden/florist → GROW copy, never the wellness "Feel better"/"deep breath"', () => {
      for (const cat of PLANT) {
        const p = personaHeroCopy('botanical', cat, 'San Francisco');
        expect(p).not.toBeNull();
        for (const h of p!.headlines) {
          expect(h).not.toMatch(/feel better|deep breath|capable care/i); // no wellness misfit
        }
        expect(p!.headlines.some((h) => /grow/i.test(h))).toBe(true); // unmistakably garden-retail
        expect(p!.subheadlines.some((s) => /plant|thrive|grow/i.test(s))).toBe(true);
      }
    });

    it('health/wellness KEEPS the CARE copy (no regression — plant branch never steals wellness)', () => {
      for (const cat of WELLNESS) {
        const p = personaHeroCopy('botanical', cat, 'Denver');
        expect(p).not.toBeNull();
        expect(p!.headlines.some((h) => /feel better|deep breath|care/i.test(h))).toBe(true);
        expect(p!.headlines.some((h) => /grow/i.test(h))).toBe(false); // wellness never gets grow copy
      }
    });

    it('the exact live defect never recurs: flora-grubb category no longer yields "Feel better in {city}"', () => {
      const p = personaHeroCopy('botanical', 'garden shop & plant nursery', 'San Francisco');
      expect(p!.headlines).not.toContain('Feel better in San Francisco');
    });
  });
});

/**
 * AL-491 — the CLIENT homepage meta-description ({SEO_DESCRIPTION} → Home.tsx useSEO) collapsed
 * sub-verticals to the wrong broad-vertical pack default: a brewery + a cocktail bar both shipped
 * "Fresh, made-from-scratch food from local ingredients" (restaurant). seoDescriptionFor composes a
 * commerce-mode-angled, name+cat+city-woven description, GUARANTEED in the 120-156 SEO sweet spot.
 */
describe('hero_copy — seoDescriptionFor (AL-491: per-commerce-mode homepage meta description)', () => {
  const BANNED =
    /limitless|revolutioniz|cutting-edge|leverage|world-class|game-chang|unlock|elevate|unparalleled|seamless|robust|synergy|holistic/i;
  const MODES = [
    'hospitality',
    'quickserve',
    'retail',
    'service',
    'professional',
    'nonprofit',
    'general',
  ];

  it('is ALWAYS in the 120-156 SEO sweet spot — every mode, across short + long name/cat/city', () => {
    const samples: Array<[string, string, string]> = [
      ['Half Acre Beer Company', 'brewery', 'Chicago'],
      ['The Secret Society', 'cocktail bar', 'Portland'],
      ['Electric Fetus', 'record store', 'Minneapolis'],
      ['Bo', 'bar', 'LA'], // very short → must PAD to ≥120
      [
        'The Extraordinarily Long-Winded Neighborhood Mercantile & Sundries Emporium',
        'general store',
        'San Francisco',
      ], // very long → must TRUNCATE to ≤156
      ['', '', ''], // fallbacks
    ];
    for (const mode of MODES) {
      for (const [n, c, city] of samples) {
        const d = seoDescriptionFor(mode, n, c, city);
        expect(d.length).toBeGreaterThanOrEqual(120);
        expect(d.length).toBeLessThanOrEqual(156);
        expect(d).not.toMatch(BANNED);
        expect(d).not.toContain('undefined');
        expect(/[.!?]$/.test(d.trim())).toBe(true); // ends on a clean sentence, never mid-word
      }
    }
  });

  it('weaves the real business + vertical + city (keyword-rich, not generic filler)', () => {
    const d = seoDescriptionFor('hospitality', 'Half Acre Beer Company', 'brewery', 'Chicago');
    expect(d).toContain('Half Acre Beer Company');
    expect(d).toContain('brewery');
    expect(d).toContain('Chicago');
    // the exact live wrong-vertical defect must NOT appear
    expect(d).not.toMatch(/made-from-scratch food|fresh flavors/i);
  });

  it('AL-539: a BAKERY names itself + vertical + city, never the restaurant "made-from-scratch food" default', () => {
    // tartine-bakery-sf shipped the RESTAURANT pack default ("made-from-scratch food from local
    // ingredients") because AL-491 gated the SEO_DESCRIPTION seed to the heroImg (curated-image)
    // sub-verticals only — a bakery (heroImg=null, "core" vertical) slipped through to the
    // wrong-vertical SERP snippet. AL-539 decouples the seed from the heroImg gate (seeds every
    // vertical); this locks the exact case for whichever mode a bakery resolves to.
    for (const mode of ['quickserve', 'hospitality']) {
      const d = seoDescriptionFor(mode, 'Tartine Bakery', 'bakery', 'San Francisco');
      expect(d).toContain('Tartine Bakery');
      expect(d).toContain('bakery');
      expect(d).toContain('San Francisco');
      expect(d).not.toMatch(/made-from-scratch food/i);
    }
  });

  it('gives each commerce mode its own conversion angle', () => {
    expect(seoDescriptionFor('hospitality', 'X', 'bar', 'Y')).toMatch(
      /gather|taste|linger|coming back/i,
    );
    expect(seoDescriptionFor('retail', 'X', 'shop', 'Y')).toMatch(/selection|browse|prices/i);
    expect(seoDescriptionFor('service', 'X', 'plumbing', 'Y')).toMatch(/book|dependable|detail/i);
    expect(seoDescriptionFor('nonprofit', 'X', 'charity', 'Y')).toMatch(/mission|impact|involved/i);
    // unknown/empty mode → the general template (still in range)
    const g = seoDescriptionFor('nope', 'X', 'shop', 'Y');
    expect(g.length).toBeGreaterThanOrEqual(120);
    expect(g.length).toBeLessThanOrEqual(156);
  });

  it('AL-507: a truncated desc never ends on a dangling article/preposition ("Reach out for a.")', () => {
    // The `professional` template + a SHORT category was the exact combo that clamped to
    // "…Reach out for a." — a broken meta description. Finance is the first seeded professional
    // vertical (heroImageForVertical now covers wealth/insurance/accounting), so it exposed it.
    const DANGLING = /\b(?:a|an|the|for|to|of|and|or|with|your|our|how|we|is)\.$/i;
    for (const cat of [
      'wealth management',
      'financial advisor',
      'insurance agency',
      'accounting firm',
      'tax preparation',
    ]) {
      const d = seoDescriptionFor('professional', 'Hill Wealth Strategies', cat, 'Richmond');
      expect(d).not.toMatch(DANGLING); // never "…Reach out for a."
      expect(/[.!?]$/.test(d)).toBe(true);
      expect(d.length).toBeGreaterThanOrEqual(120);
      expect(d.length).toBeLessThanOrEqual(156);
      // a finance firm must NOT read as legal (the AL-504 wealth→legal defect)
      expect(d).not.toMatch(/legal counsel|attorney|law office/i);
    }
  });
});

describe('hero_copy — leadWithBusinessName (AL-732: business-name-led H1, no within-city collision)', () => {
  it('prepends the business name so the H1 reads as THIS business, keeping the SEO phrase', () => {
    expect(leadWithBusinessName("Al's Breakfast", "Minneapolis's cozy corner")).toBe(
      "Al's Breakfast — Minneapolis's cozy corner",
    );
    expect(leadWithBusinessName('Perennials', 'The finest florist in Portland')).toBe(
      'Perennials — The finest florist in Portland',
    );
  });

  it('strips a trailing legal suffix from the name (LLC / Inc / Co / Ltd)', () => {
    expect(leadWithBusinessName('Perennials LLC', 'The finest florist in Portland')).toBe(
      'Perennials — The finest florist in Portland',
    );
    expect(leadWithBusinessName('Vanta Strength, Inc.', "Austin, let's get to work")).toBe(
      "Vanta Strength — Austin, let's get to work",
    );
  });

  it('keeps the plain headline for the generic "Business" fallback or an empty/1-char name', () => {
    expect(leadWithBusinessName('Business', "Denver's trusted plumber")).toBe(
      "Denver's trusted plumber",
    );
    expect(leadWithBusinessName('', 'Portlands room after dark')).toBe('Portlands room after dark');
    expect(leadWithBusinessName(null, "Denver's cozy corner")).toBe("Denver's cozy corner");
    expect(leadWithBusinessName('A', "Denver's cozy corner")).toBe("Denver's cozy corner");
  });

  it('never double-names when the name already leads the headline', () => {
    expect(leadWithBusinessName("Al's Breakfast", "Al's Breakfast, always welcoming")).toBe(
      "Al's Breakfast, always welcoming",
    );
  });

  it('keeps the plain headline when leading with the name would blow past a sane H1 length', () => {
    const longName = 'The Very Long Registered Business Name Of Some Place';
    const headline = 'The finest artisanal coffee roaster in the Pacific Northwest';
    expect(leadWithBusinessName(longName, headline)).toBe(headline);
  });

  it('is stable + pure (no throw) on odd inputs', () => {
    expect(() => leadWithBusinessName(undefined, '')).not.toThrow();
    expect(leadWithBusinessName('Ben & Jerry’s', "Vermont's sweet spot")).toBe(
      "Ben & Jerry’s — Vermont's sweet spot",
    );
  });
});

describe('hero_copy — cityFromAddress (AL-733: robust to OSM display_name, not just Places)', () => {
  it('extracts the locality from the verbose OSM/Nominatim display_name (was the ZIP)', () => {
    // Drops country + ZIP + state ("New York") + county → the borough "Manhattan" (a valid locality;
    // was "10002" before AL-733). NYC is the ambiguous case where city==state name.
    expect(
      cityFromAddress(
        'Russ & Daughters, 179, East Houston Street, Manhattan Community Board 3, Manhattan, New York County, New York, 10002, United States',
      ),
    ).toBe('Manhattan');
  });

  it('drops a FULL state name from the OSM display_name (was returning the state, AL-733b)', () => {
    // OSM spells the state out ("…, San Francisco, California, 94110, …") — the ZIP-only drop left
    // "California" / "Texas" as the "city". Dropping the full state (+ county) reveals the real city.
    expect(
      cityFromAddress(
        'Tartine Bakery, 600, Guerrero Street, Mission, San Francisco, California, 94110, United States',
      ),
    ).toBe('San Francisco');
    expect(
      cityFromAddress(
        'Franklin Barbecue, 900, East 11th Street, Austin, Travis County, Texas, 78702, United States',
      ),
    ).toBe('Austin');
  });

  it('KEEPS a state-named city in a compact address via the street-peek (New York / Washington)', () => {
    // "…St, New York, NY 10002" — the field before "New York" is the STREET, so "New York" is the
    // CITY here, not the state (don't over-drop). Same for Washington DC.
    expect(cityFromAddress('179 E Houston St, New York, NY 10002, USA')).toBe('New York');
    expect(cityFromAddress('123 Main St, Washington, DC 20001, USA')).toBe('Washington');
  });

  it('extracts the city from a compact Places formattedAddress (3-part and 4-part+country)', () => {
    expect(cityFromAddress('413 14th Ave SE, Minneapolis, MN 55414')).toBe('Minneapolis');
    expect(cityFromAddress('179 E Houston St, New York, NY 10002, USA')).toBe('New York');
    expect(cityFromAddress('1200 Getty Center Dr, Los Angeles, CA 90049, United States')).toBe(
      'Los Angeles',
    );
  });

  it('never returns a bare ZIP / postcode / country as the city', () => {
    for (const addr of [
      'Foo, 179, Bar Street, Baz County, Springfield, 62704, United States',
      '1 Main St, Austin, TX 78701, USA',
    ]) {
      const c = cityFromAddress(addr);
      expect(c).not.toMatch(/^\d+$/);
      expect(c.toLowerCase()).not.toMatch(/^(usa|united states)$/);
    }
    expect(
      cityFromAddress('Foo, 179, Bar Street, Baz County, Springfield, 62704, United States'),
    ).toBe('Springfield');
  });

  it('falls back gracefully on thin / empty input (no throw)', () => {
    expect(cityFromAddress('')).toBe('your community');
    expect(cityFromAddress(null)).toBe('your community');
    expect(cityFromAddress('Denver')).toBe('your community'); // single field → fallback
    expect(() => cityFromAddress(undefined)).not.toThrow();
  });

  it('handles a bare "City, State" (2-letter code) and "City, State ZIP"', () => {
    expect(cityFromAddress('Portland, OR')).toBe('Portland');
    expect(cityFromAddress('Portland, OR 97201')).toBe('Portland');
  });
});
