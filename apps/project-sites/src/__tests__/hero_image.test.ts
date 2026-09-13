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
