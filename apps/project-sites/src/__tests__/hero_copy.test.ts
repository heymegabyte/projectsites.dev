import { categoryPhrase, heroHeadlineOptions, seoTaglineOptions } from '../services/hero_copy.js';

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
    ['Plumbing Services', 'plumbing'], // redundant corporate suffix stripped
    ['Insurance Agency', 'insurance'],
    ['Consulting Group', 'consulting'],
    ['Acme LLC', 'acme'],
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
});

describe('hero_copy — heroHeadlineOptions (AL-361: grammatical for every vertical)', () => {
  it('NEVER produces the broken live string "Quality record Portland counts on"', () => {
    const opts = heroHeadlineOptions(categoryPhrase('Record Store'), 'Portland');
    expect(opts).not.toContain('Quality record Portland counts on');
    // the fixed "Quality …" frame reads naturally with the full noun phrase:
    expect(opts).toContain('Quality record store Portland counts on');
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
      'Quality record store Portland counts on',
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
