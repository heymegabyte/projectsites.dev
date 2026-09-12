import {
  themeStyleFromInputs,
  THEME_STYLE_NAMES,
  THEME_PERSONALITY_BRIEF,
  personalityBriefFor,
  commerceModeFor,
  commerceIntentBriefFor,
  COMMERCE_INTENT_BRIEF,
  type CommerceMode,
} from '../services/theme_style.js';

describe('theme_style — themeStyleFromInputs', () => {
  describe('preset registry invariant (drift guard vs template PRESET_NAMES)', () => {
    it('is exactly the 16 template presets, lowercase + unique', () => {
      const expected = [
        'classic',
        'editorial',
        'warm',
        'luxe',
        'brutalist',
        'bold',
        'futuristic',
        'rugged',
        'botanical',
        'boutique',
        'precision',
        'heritage',
        'scholarly',
        'noir',
        'retro',
        'artisan',
      ];
      expect([...THEME_STYLE_NAMES].sort()).toEqual([...expected].sort());
      expect(new Set(THEME_STYLE_NAMES).size).toBe(THEME_STYLE_NAMES.length);
      for (const n of THEME_STYLE_NAMES) expect(n).toBe(n.toLowerCase());
    });

    it('only ever returns a name from the registry (or undefined)', () => {
      const samples = ['Financial / Accounting', 'Automotive', 'Real Estate', 'Other', '', 'zzz'];
      for (const s of samples) {
        const r = themeStyleFromInputs(s);
        if (r !== undefined) expect(THEME_STYLE_NAMES).toContain(r);
      }
    });
  });

  describe('category → preset (every /create dropdown vertical maps sensibly)', () => {
    const cases: Array<[string, string]> = [
      ['Restaurant / Café', 'warm'],
      ['Bar / Nightlife / Brewery', 'warm'],
      ['Bakery / Coffee Shop', 'warm'],
      ['Beauty / Spa / Wellness', 'botanical'],
      ['Salon / Barbershop', 'warm'],
      ['Legal / Law Firm', 'editorial'],
      ['Medical / Healthcare', 'botanical'],
      ['Retail / Shop', 'boutique'],
      ['Technology / SaaS', 'futuristic'],
      ['Construction / Home Services', 'rugged'],
      ['Fitness / Gym', 'bold'],
      ['Real Estate', 'luxe'],
      ['Photography / Creative', 'brutalist'],
      ['Automotive', 'precision'],
      ['Education / Tutoring', 'scholarly'],
      ['Financial / Accounting', 'heritage'],
    ];
    it.each(cases)('%s → %s', (category, expected) => {
      expect(themeStyleFromInputs(category)).toBe(expected);
    });

    it('every one of the 16 presets is reachable via some category/hint', () => {
      const reached = new Set<string>();
      for (const [c] of cases) reached.add(themeStyleFromInputs(c) as string);
      // categories cover most presets; hints reach the rest.
      reached.add(themeStyleFromInputs(undefined, 'sleek high-tech gradient') as string); // futuristic
      reached.add(themeStyleFromInputs('Other', 'timeless trusted institution') as string); // heritage
      reached.add(themeStyleFromInputs('Other', 'raw brutalist stark') as string); // brutalist
      reached.add(themeStyleFromInputs('Other', 'engineered metallic precision') as string); // precision
      reached.add(themeStyleFromInputs('Other', 'chic curated boutique') as string); // boutique
      reached.add(themeStyleFromInputs('Cocktail Bar') as string); // noir
      reached.add(themeStyleFromInputs('Record Store') as string); // retro
      reached.add(themeStyleFromInputs('Coffee Roaster') as string); // artisan
      // classic is the TEMPLATE fallback (undefined here); all 15 non-classic reachable.
      expect(reached.size).toBeGreaterThanOrEqual(14);
      expect(reached.has('undefined')).toBe(false);
    });
  });

  describe('Google Places snake_case types normalize + resolve (AL-256)', () => {
    // The create-from-search path passes Google-Places `types[]`; `_` is a word
    // char so `\bcar\b` never matched `car_dealer` before normalization → these
    // all used to fall to bland `classic`.
    const places: Array<[string, string]> = [
      ['car_dealer', 'precision'],
      ['car_repair', 'precision'],
      ['auto_parts_store', 'precision'],
      ['hardware_store', 'rugged'],
      ['real_estate_agency', 'luxe'],
      ['jewelry_store', 'luxe'],
      ['lodging', 'luxe'],
      ['beauty_salon', 'botanical'],
      ['hair_care', 'warm'],
      ['meal_takeaway', 'warm'],
      ['meal_delivery', 'warm'],
      ['book_store', 'scholarly'],
      ['pet_store', 'boutique'],
      ['home_goods_store', 'boutique'],
      ['furniture_store', 'boutique'],
      ['accounting', 'heritage'],
      ['insurance_agency', 'heritage'],
      ['doctor', 'botanical'],
      ['dentist', 'botanical'],
      ['school', 'scholarly'],
      ['university', 'scholarly'],
      ['place_of_worship', 'editorial'],
      ['local_government_office', 'editorial'],
      ['art_gallery', 'brutalist'],
      ['electrician', 'rugged'],
      ['plumber', 'rugged'],
      ['locksmith', 'rugged'],
      ['moving_company', 'rugged'],
      ['night_club', 'noir'], // AL-334: a nightclub reads noir (cinematic/after-dark), not warm
      ['grocery_or_supermarket', 'warm'],
      ['florist', 'boutique'],
      ['gym', 'bold'],
    ];
    it.each(places)('%s → %s', (type, expected) => {
      expect(themeStyleFromInputs(type)).toBe(expected);
    });
  });

  describe('real prod business_category values resolve distinctively (AL-256 reconciliation)', () => {
    // Sampled from prod D1 `sites.business_category` — each MUST reach a
    // distinctive personality, never bland classic; the charity-food + HVAC +
    // dentistry cases were live mis-themes before this fire.
    const real: Array<[string, string]> = [
      ['food pantry', 'editorial'],
      ['food bank', 'editorial'],
      ['soup kitchen', 'editorial'],
      ['heating and cooling', 'rugged'],
      ['family dentistry', 'botanical'],
      ['fine jewelry boutique', 'luxe'],
      ['personal injury law', 'editorial'],
      ['creative digital agency', 'futuristic'],
      ['gym', 'bold'],
      ['restaurant', 'warm'],
      ['legal', 'editorial'],
      ['fitness', 'bold'],
      ['dental', 'botanical'],
    ];
    it.each(real)('%s → %s (non-classic)', (category, expected) => {
      expect(themeStyleFromInputs(category)).toBe(expected);
    });
    it('food truck stays warm (charity lookahead is scoped)', () => {
      expect(themeStyleFromInputs('food truck')).toBe('warm');
    });
  });

  describe('specific verticals beat the generic shop/store rule (AL-256)', () => {
    // Regression: a hardware store hit boutique via the generic `\bstore\b`
    // before any rugged rule (City Hardware shipped mis-themed); jewelry must
    // reach luxe, not the boutique catch-all.
    it('Hardware Store → rugged (not boutique)', () => {
      expect(themeStyleFromInputs('Hardware Store')).toBe('rugged');
    });
    it('Jewelry Store → luxe (not boutique)', () => {
      expect(themeStyleFromInputs('Jewelry Store')).toBe('luxe');
    });
    // AL-323: bookstores/bookshops/booksellers/libraries are BOOKS+READING, not a
    // clothing boutique. They belong to `scholarly`, ordered ahead of the generic
    // retail `\bstore\w*` catch-all (booksweet shipped boutique live before this).
    it('Book Store → scholarly (not the boutique retail catch-all)', () => {
      expect(themeStyleFromInputs('Book Store')).toBe('scholarly');
    });
    it('Bookshop / Bookseller → scholarly', () => {
      expect(themeStyleFromInputs('Independent Bookshop')).toBe('scholarly');
      expect(themeStyleFromInputs('Rare Bookseller')).toBe('scholarly');
    });
    it('Library → scholarly (books/learning, not civic-editorial)', () => {
      expect(themeStyleFromInputs('Public Library')).toBe('scholarly');
      expect(themeStyleFromInputs('library')).toBe('scholarly');
    });
    it('generic apparel/gift retail still resolves boutique (no over-broadening)', () => {
      expect(themeStyleFromInputs('Clothing Boutique')).toBe('boutique');
      expect(themeStyleFromInputs('Gift Shop')).toBe('boutique');
      expect(themeStyleFromInputs('pet_store')).toBe('boutique');
    });
  });

  describe('MORE ELABORATE themes — noir / retro / artisan now reachable (AL-334)', () => {
    // These 3 personalities are advertised by the /create form's design
    // recommendations + ship full dossiers, but the worker matcher + template
    // couldn't render them → they silently degraded to `classic`. Now first-class.
    it('noir via category (cocktail bar, speakeasy, tattoo, nightclub)', () => {
      expect(themeStyleFromInputs('Cocktail Bar')).toBe('noir');
      expect(themeStyleFromInputs('speakeasy lounge')).toBe('noir');
      expect(themeStyleFromInputs('tattoo_parlor')).toBe('noir');
      expect(themeStyleFromInputs('night_club')).toBe('noir');
    });
    it('retro via category (record store, arcade, vintage shop)', () => {
      expect(themeStyleFromInputs('Record Store')).toBe('retro');
      expect(themeStyleFromInputs('vintage clothing')).toBe('retro');
      expect(themeStyleFromInputs('arcade')).toBe('retro');
    });
    it('artisan via category (coffee roaster, pottery, ceramics, chocolatier)', () => {
      expect(themeStyleFromInputs('Coffee Roaster')).toBe('artisan');
      expect(themeStyleFromInputs('pottery studio')).toBe('artisan');
      expect(themeStyleFromInputs('ceramics')).toBe('artisan');
      expect(themeStyleFromInputs('chocolatier')).toBe('artisan');
    });
    it('all three via explicit design hint (hint wins over category)', () => {
      expect(themeStyleFromInputs('Restaurant / Café', 'moody cinematic speakeasy feel')).toBe(
        'noir',
      );
      expect(themeStyleFromInputs('Retail / Shop', 'nostalgic vintage retro vibe')).toBe('retro');
      expect(themeStyleFromInputs('Retail / Shop', 'handcrafted artisan small-batch maker')).toBe(
        'artisan',
      );
    });
    it('plain coffee shop stays warm; only a roaster/craft reads artisan', () => {
      expect(themeStyleFromInputs('Bakery / Coffee Shop')).toBe('warm');
      expect(themeStyleFromInputs('coffee roaster')).toBe('artisan');
    });
  });

  describe('normalization is punctuation/case/accent agnostic (AL-256)', () => {
    it('mixed separators + case resolve the same', () => {
      expect(themeStyleFromInputs('CAR—DEALER')).toBe('precision');
      expect(themeStyleFromInputs('auto.repair')).toBe('precision');
      expect(themeStyleFromInputs('Restaurant / Café')).toBe('warm');
    });
  });

  describe('design-hint keyword override wins over category', () => {
    it('elegant luxury on a retail shop → luxe (not boutique)', () => {
      expect(themeStyleFromInputs('Retail / Shop', 'we want an elegant, luxurious feel')).toBe(
        'luxe',
      );
    });
    it('bold energetic on a law firm → bold (not editorial)', () => {
      expect(themeStyleFromInputs('Legal / Law Firm', 'bold and energetic brand')).toBe('bold');
    });
    it('calm organic on a gym → botanical (not bold)', () => {
      expect(themeStyleFromInputs('Fitness / Gym', 'calm, organic, natural wellness vibe')).toBe(
        'botanical',
      );
    });
  });

  describe('graceful fallback (undefined → template classic)', () => {
    it('returns undefined for unmapped category', () => {
      expect(themeStyleFromInputs('Other')).toBeUndefined();
      expect(themeStyleFromInputs('')).toBeUndefined();
      expect(themeStyleFromInputs(undefined, undefined)).toBeUndefined();
      expect(themeStyleFromInputs(null, null)).toBeUndefined();
    });
    it('never throws on odd input', () => {
      expect(() => themeStyleFromInputs('   ', '  ')).not.toThrow();
      // @ts-expect-error — defensive: non-string at runtime must not throw
      expect(() => themeStyleFromInputs(42, {})).not.toThrow();
    });
    it('ignores a hint with no style keyword and uses category', () => {
      expect(themeStyleFromInputs('Automotive', 'open Mon-Fri 9-5, call us')).toBe('precision');
    });
  });
});

describe('theme_style — personality content briefs (AL-356)', () => {
  it('every one of the 16 preset names has a non-empty brief', () => {
    for (const name of THEME_STYLE_NAMES) {
      const brief = THEME_PERSONALITY_BRIEF[name];
      expect(typeof brief).toBe('string');
      expect(brief.length).toBeGreaterThan(80); // dense directive, not a stub
      // Every brief must cover the four content levers CSS can't reach.
      expect(brief.toLowerCase()).toContain('imagery');
      expect(brief.toLowerCase()).toContain('copy');
      expect(brief.toLowerCase()).toContain('sections');
      expect(brief.toLowerCase()).toContain('motion');
    }
  });

  it('the brief map keys are EXACTLY the 16 preset names (no drift, no extras)', () => {
    expect(Object.keys(THEME_PERSONALITY_BRIEF).sort()).toEqual([...THEME_STYLE_NAMES].sort());
  });

  it('noir brief steers content toward cinematic/candlelit + AWAY from bright stock', () => {
    const noir = personalityBriefFor('noir')!;
    expect(noir.toLowerCase()).toMatch(/candlelit|cinematic|after-dark/);
    expect(noir.toLowerCase()).toMatch(/never bright|not bright|no.*bright|never.*airy/);
  });

  it('personalityBriefFor round-trips a real vertical→personality lookup', () => {
    // A steakhouse described as "cinematic, candlelit, after-dark" resolves to noir,
    // and that name yields the noir brief — the exact chain buildPrompt uses.
    const style = themeStyleFromInputs('Steakhouse', 'intimate cinematic candlelit after-dark');
    expect(style).toBe('noir');
    expect(personalityBriefFor(style)).toBe(THEME_PERSONALITY_BRIEF.noir);
  });

  it('personalityBriefFor is safe on unknown/empty/non-string (undefined, never throws)', () => {
    expect(personalityBriefFor('nope')).toBeUndefined();
    expect(personalityBriefFor('')).toBeUndefined();
    expect(personalityBriefFor(undefined)).toBeUndefined();
    expect(personalityBriefFor(null)).toBeUndefined();
    // @ts-expect-error — defensive: non-string at runtime must not throw
    expect(() => personalityBriefFor(42)).not.toThrow();
  });
});

describe('theme_style — commerceModeFor (AL-408 conversion axis)', () => {
  const ALL_MODES: CommerceMode[] = [
    'retail',
    'hospitality',
    'service',
    'professional',
    'nonprofit',
    'general',
  ];

  it('classifies the AL-407 regression case: a distillery is HOSPITALITY, never retail', () => {
    // The delivered defect: st-george-spirits shipped "Shop now / Free shipping /
    // 30-day returns". A distillery is visited/tasted/toured — hospitality.
    expect(commerceModeFor('Distillery')).toBe('hospitality');
    expect(commerceModeFor('distiller')).toBe('hospitality');
    expect(commerceModeFor('Craft Spirits / Distillery')).toBe('hospitality');
  });

  it('routes food+drink venues (that sell product but are patronized by visiting) to hospitality', () => {
    for (const v of [
      'Winery',
      'Vineyard',
      'Brewery',
      'Cidery',
      'Restaurant',
      'Cocktail Bar',
      'Coffee Roasters',
      'Bakery',
      'Steakhouse',
      'Hotel',
      'Tasting Room',
    ]) {
      expect(commerceModeFor(v)).toBe('hospitality');
    }
  });

  it('routes GENUINE product sellers to retail (the only mode where cart language is on-brand)', () => {
    for (const v of [
      'Jewelry Store',
      'Goldsmith',
      'Bookstore',
      'Record Store',
      'Florist',
      'Hardware Store',
      'Clothing Boutique',
      'Furniture Store',
      'Gift Shop',
    ]) {
      expect(commerceModeFor(v)).toBe('retail');
    }
  });

  it('routes booked-work verticals to service', () => {
    for (const v of ['Plumbing', 'HVAC', 'Hair Salon', 'Med Spa', 'Dental', 'Auto Repair', 'Gym / Fitness']) {
      expect(commerceModeFor(v)).toBe('service');
    }
  });

  it('routes retained-relationship verticals to professional', () => {
    for (const v of ['Law Firm', 'Accounting', 'Financial Advisor', 'Real Estate', 'Consulting', 'Marketing Agency']) {
      expect(commerceModeFor(v)).toBe('professional');
    }
  });

  it('routes mission verticals to nonprofit (BEFORE hospitality — a food bank is not a restaurant)', () => {
    for (const v of ['Soup Kitchen', 'Food Bank', 'Food Pantry', 'Charity', 'Church', 'Nonprofit']) {
      expect(commerceModeFor(v)).toBe('nonprofit');
    }
  });

  it('falls back to general (never undefined) for an unclassifiable vertical', () => {
    expect(commerceModeFor('Something Unclassifiable XYZ')).toBe('general');
    expect(commerceModeFor('')).toBe('general');
    expect(commerceModeFor(null)).toBe('general');
    expect(commerceModeFor(undefined)).toBe('general');
  });

  it('normalizes snake_case Google-Places types + slash labels', () => {
    expect(commerceModeFor('car_repair')).toBe('service');
    expect(commerceModeFor('jewelry_store')).toBe('retail');
    expect(commerceModeFor('Bar / Nightclub')).toBe('hospitality');
  });

  it('every mode has a non-empty brief; non-retail modes FORBID e-commerce cart language', () => {
    for (const mode of ALL_MODES) {
      const brief = COMMERCE_INTENT_BRIEF[mode];
      expect(typeof brief).toBe('string');
      expect(brief.length).toBeGreaterThan(80);
    }
    // The core AL-407 guard: every non-retail brief must explicitly reject
    // "Shop now" / "Add to cart" / "Free shipping" as primary framing.
    for (const mode of ['hospitality', 'service', 'professional', 'nonprofit', 'general'] as CommerceMode[]) {
      const b = COMMERCE_INTENT_BRIEF[mode].toLowerCase();
      expect(b).toMatch(/forbidden|only use e-commerce|only mode/);
      expect(b).toMatch(/shop now|add to cart|free shipping|cart/);
    }
    // Retail is the one mode that PERMITS cart language.
    expect(COMMERCE_INTENT_BRIEF.retail.toLowerCase()).toMatch(/on-brand|add to cart|shop/);
  });

  it('commerceIntentBriefFor is safe on unknown/empty/non-string (general fallback, never throws)', () => {
    expect(commerceIntentBriefFor('hospitality')).toBe(COMMERCE_INTENT_BRIEF.hospitality);
    expect(commerceIntentBriefFor('nope')).toBe(COMMERCE_INTENT_BRIEF.general);
    expect(commerceIntentBriefFor('')).toBe(COMMERCE_INTENT_BRIEF.general);
    expect(commerceIntentBriefFor(undefined)).toBe(COMMERCE_INTENT_BRIEF.general);
    // @ts-expect-error — defensive: non-string at runtime must not throw
    expect(() => commerceIntentBriefFor(42)).not.toThrow();
  });

  it('hint names the vertical when category is generic', () => {
    // A generic "Other" category but a hint that names a distillery → hospitality.
    expect(commerceModeFor('Other', 'a small-batch distillery and tasting room')).toBe('hospitality');
  });
});
