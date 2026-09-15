import { heroImageForVertical } from '../services/hero_image.js';

/**
 * AL-485 — C.7 hero-image-vertical. The template pack collapses sub-verticals (plant/record/
 * cocktail/…) to a generic bucket, shipping a wrong-vertical HERO (the #1 visual element).
 * `heroImageForVertical` seeds a curated on-vertical hero at delivery time (existing-wins
 * `_content.json`). These lock (a) the sub-vertical → hero mapping + synonyms, (b) null for
 * broad/unknown verticals (pack default stands, no regression), and (c) the probe-compatibility
 * invariant: every curated URL's `ixid` base64-decodes to a query containing the vertical noun —
 * exactly what `verify-hero-image-vertical.mjs` reads, so the prod gate flips green on rebuild.
 */

/** Decode the hero URL's Unsplash ixid to its query string (mirrors verify-hero-image-vertical). */
function heroQuery(url: string): string {
  const m = url.match(/ixid=([A-Za-z0-9]+)/);
  if (!m) return '';
  const dec = Buffer.from(m[1], 'base64').toString('utf8');
  const field = dec.split('|').find((f) => /%[0-9a-f]{2}/i.test(f));
  return field ? decodeURIComponent(field).toLowerCase() : '';
}

describe('hero_image — heroImageForVertical (AL-485: per-sub-vertical hero seed)', () => {
  it('maps the collapsing sub-verticals (the live-flagged cases + siblings)', () => {
    // the two live-flagged deliveries:
    expect(heroImageForVertical('plant shop')?.alt).toMatch(/plant/i); // perennials-brooklyn
    expect(heroImageForVertical('cocktail bar')?.alt).toMatch(/bar|cocktail/i); // the-secret-society
    // the rest of the curated set:
    expect(heroImageForVertical('record store')?.alt).toMatch(/vinyl|record/i);
    expect(heroImageForVertical('florist')?.alt).toMatch(/flower|bouquet/i);
    expect(heroImageForVertical('bookstore')?.alt).toMatch(/book/i);
    expect(heroImageForVertical('brewery')?.alt).toMatch(/beer|brew/i);
    expect(heroImageForVertical('jewelry store')?.alt).toMatch(/necklace|jewel/i);
    expect(heroImageForVertical('tattoo studio')?.alt).toMatch(/tattoo/i);
    // AL-507 — finance cluster (was the wealth→legal defect: scales-of-justice + "law office" hero):
    expect(heroImageForVertical('wealth management')?.alt).toMatch(/financial|advisor|figures/i);
  });

  it('matches sub-vertical SYNONYMS to the right hero', () => {
    expect(heroImageForVertical('garden center')).toBe(heroImageForVertical('plant shop'));
    expect(heroImageForVertical('plant nursery')).toBe(heroImageForVertical('plant shop'));
    expect(heroImageForVertical('speakeasy')).toBe(heroImageForVertical('cocktail bar'));
    expect(heroImageForVertical('jazz lounge')).toBe(heroImageForVertical('cocktail bar'));
    expect(heroImageForVertical('vinyl shop')).toBe(heroImageForVertical('record store'));
    expect(heroImageForVertical('taproom')).toBe(heroImageForVertical('brewery'));
    expect(heroImageForVertical('flower shop')).toBe(heroImageForVertical('florist'));
  });

  it('AL-507: the whole finance CLUSTER shares ONE financial-office hero', () => {
    const finance = heroImageForVertical('wealth management')!;
    expect(finance).not.toBeNull();
    for (const v of [
      'financial advisor',
      'financial planning',
      'investment firm',
      'asset management',
      'retirement planning',
      'insurance agency',
      'accounting firm',
      'accountant',
      'bookkeeping service',
      'CPA firm',
      'tax preparation',
    ]) {
      expect(heroImageForVertical(v)).toBe(finance); // one hero for the whole cluster
    }
  });

  it('AL-507: finance patterns do NOT false-match adjacent verticals', () => {
    // legal is NOT finance — a law firm keeps the pack's (correct) law-office default:
    expect(heroImageForVertical('law firm')).toBeNull();
    expect(heroImageForVertical('legal services')).toBeNull();
    // precision guards baked into the regex:
    expect(heroImageForVertical('private investigator')).toBeNull(); // invest(ment|ing|or), not "investig"
    expect(heroImageForVertical('taxi service')).toBeNull(); // tax(es)?, not "taxi"
    expect(heroImageForVertical('food bank')).toBeNull(); // no bare "bank"
  });

  it('AL-597: specialty-food + active-gear map to on-vertical heroes (was the generic retail default)', () => {
    // the-meat-hook-brooklyn / murrays-cheese-nyc / bicycle-habitat-nyc all shipped the generic
    // "cozy independent shop interior shelves" retail hero — now each gets a real on-vertical image.
    expect(heroImageForVertical('butcher shop')?.alt).toMatch(/butcher|cuts|meat/i);
    expect(heroImageForVertical('cheese shop')?.alt).toMatch(/cheese/i);
    expect(heroImageForVertical('bicycle shop')?.alt).toMatch(/bicycle|bike/i);
    // the ixid decodes to the vertical noun (exactly what verify-hero-image-vertical scores → green):
    expect(heroQuery(heroImageForVertical('butcher shop')!.url)).toMatch(/butcher/);
    expect(heroQuery(heroImageForVertical('cheese shop')!.url)).toMatch(/cheese/);
    expect(heroQuery(heroImageForVertical('bicycle shop')!.url)).toMatch(/bicycle/);
  });

  it('AL-614: outdoor/ski/mountaineering CLUSTER shares ONE gear hero (was generic retail)', () => {
    // alpenglow-sports-tahoe-city (outdoor & ski outfitter) shipped a generic gift-shop/home-goods
    // interior hero — now the whole outdoor cluster gets a real climbing/mountaineering-gear image.
    const outdoor = heroImageForVertical('outdoor gear & ski shop')!;
    expect(outdoor).not.toBeNull();
    expect(outdoor.alt).toMatch(/outdoor|climb|mountaineer|gear/i);
    for (const v of [
      'ski shop',
      'outdoor outfitter',
      'mountaineering',
      'climbing gym',
      'snowboard shop',
      'backcountry',
      'camping gear',
    ]) {
      expect(heroImageForVertical(v)).toBe(outdoor); // one gear hero for the whole cluster
    }
    // the ixid decodes to an outdoor-domain query (what verify-hero-image-vertical's OUTDOOR_LEXICON reads → green):
    expect(heroQuery(outdoor.url)).toMatch(/mountaineer|equipment|outdoor|ski/);
  });

  it('AL-614: outdoor patterns do NOT false-match adjacent verticals', () => {
    expect(heroImageForVertical('outdoor dining')).toBeNull(); // bare "outdoor" needs a gear/shop suffix
    expect(heroImageForVertical('skincare clinic')).toBeNull(); // \bskis\b / "ski shop", never "skin"
    // a bicycle shop stays on the BIKE hero (its rule is ordered before OUTDOOR), not the gear hero:
    expect(heroImageForVertical('bicycle shop')?.alt).toMatch(/bicycle|bike/i);
  });

  it('AL-597: synonyms route correctly + no false-match', () => {
    expect(heroImageForVertical('cheesemonger')).toBe(heroImageForVertical('cheese shop'));
    expect(heroImageForVertical('delicatessen')).toBe(heroImageForVertical('cheese shop'));
    expect(heroImageForVertical('meat market')).toBe(heroImageForVertical('butcher shop'));
    expect(heroImageForVertical('cyclery')).toBe(heroImageForVertical('bicycle shop'));
    expect(heroImageForVertical('bike shop')).toBe(heroImageForVertical('bicycle shop'));
    // precision: a motorcycle is NOT a bicycle; "meat" needs shop/market/counter (never a restaurant)
    expect(heroImageForVertical('motorcycle dealer')).toBeNull();
    expect(heroImageForVertical('meatball restaurant')).toBeNull();
  });

  it('AL-544: the whole CREATIVE cluster shares ONE design-studio-workspace hero', () => {
    const creative = heroImageForVertical('design studio')!; // pentagram-nyc's vertical
    expect(creative).not.toBeNull();
    expect(creative.alt).toMatch(/design|studio|creative/i);
    for (const v of [
      'graphic design',
      'creative agency',
      'creative studio',
      'design agency',
      'design firm',
      'branding',
      'brand studio',
      'art gallery',
      'art studio',
      'photography studio',
      'photo studio',
      'videography',
      'production studio',
      'production house',
      'record label',
      'advertising agency',
    ]) {
      expect(heroImageForVertical(v)).toBe(creative); // one hero for the whole cluster
    }
    // probe-compat: the ixid base64-decodes to a query naming the vertical (design/studio)
    expect(heroQuery(creative.url)).toMatch(/design|studio/i);
  });

  it('AL-544: creative patterns do NOT false-match insurance/real-estate agencies or fitness studios (no bare "agency"/"studio")', () => {
    expect(heroImageForVertical('insurance agency')).toBe(
      heroImageForVertical('wealth management'),
    ); // → FINANCE, not CREATIVE
    expect(heroImageForVertical('real estate agency')).toBeNull(); // luxe pack default, not creative
    expect(heroImageForVertical('yoga studio')).toBeNull(); // no bare \bstudio\b → fitness stays pack default
    expect(heroImageForVertical('dance studio')).toBeNull();
  });

  it('returns null for broad/unknown verticals (pack default stands — no regression)', () => {
    for (const v of [
      'plumbing',
      'dental practice',
      'restaurant',
      'law firm',
      'gym',
      'coffee shop',
      'local business',
      '',
      '   ',
      'other',
    ]) {
      expect(heroImageForVertical(v)).toBeNull();
    }
    expect(heroImageForVertical(null)).toBeNull();
    expect(heroImageForVertical(undefined)).toBeNull();
    // @ts-expect-error — defensive: non-string must not throw
    expect(heroImageForVertical(42)).toBeNull();
  });

  it('does NOT false-match "barber" as a cocktail bar (narrow patterns, no bare \\bbar\\b)', () => {
    expect(heroImageForVertical('barbershop')).toBeNull();
    expect(heroImageForVertical('barber')).toBeNull();
  });

  it('every curated hero URL is an allowlisted images.unsplash.com CDN link', () => {
    for (const v of [
      'plant shop',
      'florist',
      'cocktail bar',
      'record store',
      'bookstore',
      'brewery',
      'jewelry store',
      'tattoo studio',
      'wealth management',
    ]) {
      const img = heroImageForVertical(v)!;
      expect(img.url.startsWith('https://images.unsplash.com/photo-')).toBe(true);
      expect(img.alt.length).toBeGreaterThan(10);
    }
  });

  it('PROBE-COMPAT: each hero ixid decodes to a query containing its vertical noun (gate flips green)', () => {
    const cases: Array<[string, RegExp]> = [
      ['plant shop', /plant/],
      ['florist', /flower|florist/],
      ['cocktail bar', /cocktail|bar/],
      ['record store', /record|vinyl/],
      ['bookstore', /book/],
      ['brewery', /brew|beer/],
      ['jewelry store', /jewelry|jewel/],
      ['tattoo studio', /tattoo/],
      // finance-cluster: query carries "financial" → the probe's FINANCE_LEXICON bridge accepts it
      // for any finance-domain H1 noun (wealth/insurance/accounting/…), no per-noun image needed.
      ['wealth management', /financ|advisor/],
    ];
    for (const [v, re] of cases) {
      const q = heroQuery(heroImageForVertical(v)!.url);
      expect(q).toMatch(re);
    }
  });
});
