import { relativeLuminance, contrastRatio, resolveThemePolarity } from '../services/theme_polarity';

describe('relativeLuminance', () => {
  it('black is ~0, white is ~1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
  });
  it('expands 3-digit hex and tolerates a leading #', () => {
    expect(relativeLuminance('#fff')).toBeCloseTo(relativeLuminance('#ffffff'), 5);
    expect(relativeLuminance('000')).toBeCloseTo(0, 5);
  });
  it('returns a value in [0,1] for a mid color', () => {
    const l = relativeLuminance('#808080');
    expect(l).toBeGreaterThan(0);
    expect(l).toBeLessThan(1);
  });
});

describe('contrastRatio', () => {
  it('black-on-white is the 21:1 maximum', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });
  it('is symmetric and 1:1 for identical colors', () => {
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(contrastRatio('#fff', '#000'), 5);
  });
});

describe('resolveThemePolarity', () => {
  it('preserves a POLISHED source theme (score >=7) regardless of logo luminance', () => {
    // light source, dark logo — preservation wins over the dark-logo->light rule (they agree here),
    // and a light source with a LIGHT logo must still stay light because the source is polished.
    const r = resolveThemePolarity({
      logoHex: '#f2f2f2', // light logo would normally -> dark theme
      sourceAestheticScore: 8,
      sourcePolarity: 'light',
    });
    expect(r.theme).toBe('light');
    expect(r.preserveSourceDesign).toBe(true);
    expect(r.reason).toMatch(/polished source/i);
  });

  it('does NOT preserve when the source is mediocre (score < 7)', () => {
    const r = resolveThemePolarity({
      logoHex: '#1a1a1a', // dark logo -> light theme
      sourceAestheticScore: 5,
      sourcePolarity: 'dark',
    });
    expect(r.preserveSourceDesign).toBe(false);
    expect(r.theme).toBe('light'); // driven by the dark logo, not the dark source
  });

  it('dark logo (luminance < 0.4) -> LIGHT theme', () => {
    const r = resolveThemePolarity({ logoHex: '#222222' });
    expect(r.theme).toBe('light');
    expect(r.reason).toMatch(/dark logo/i);
  });

  it('light logo (luminance > 0.6) -> DARK theme', () => {
    const r = resolveThemePolarity({ logoHex: '#fafafa' });
    expect(r.theme).toBe('dark');
    expect(r.reason).toMatch(/light logo/i);
  });

  it('mid-luminance logo defaults to DARK when contrast against backgrounds is fine', () => {
    // #b0b0b0 ≈ luminance 0.45 (mid band); clears 4.5:1 against a near-black bg → stays dark
    const r = resolveThemePolarity({
      logoHex: '#b0b0b0',
      candidateBackgrounds: ['#0a0a0f'],
    });
    expect(r.theme).toBe('dark');
  });

  it('mid-luminance logo FLIPS to light when it fails 4.5:1 against any background', () => {
    // #b0b0b0 passes against near-black but fails against a similar mid-grey bg → flip to light
    const r = resolveThemePolarity({
      logoHex: '#b0b0b0',
      candidateBackgrounds: ['#0a0a0f', '#9a9a9a'],
    });
    expect(r.theme).toBe('light');
    expect(r.reason).toMatch(/contrast/i);
  });

  it('falls back to dark when no logo color is provided', () => {
    const r = resolveThemePolarity({});
    expect(r.theme).toBe('dark');
    expect(r.reason).toMatch(/no logo|default/i);
  });

  it('tolerates an invalid hex by falling back to dark', () => {
    const r = resolveThemePolarity({ logoHex: 'not-a-color' });
    expect(r.theme).toBe('dark');
  });

  it('drives theme from the VALIDATED normalized hex, not the raw logoHex (non-null-! sweep)', () => {
    // Regression for the code-quality sweep: resolveThemePolarity feeds the validated,
    // 3→6-expanded `normalized` hex into relativeLuminance/contrastRatio (not the raw
    // `logoHex!`). A 3-char, #-prefixed logo must resolve IDENTICALLY to its 6-char form.
    const short = resolveThemePolarity({ logoHex: '#f0f' }); // expands to ff00ff
    const long = resolveThemePolarity({ logoHex: '#ff00ff' });
    expect(short.theme).toBe(long.theme);
    expect(short.reason).toBe(long.reason);
    // a dark 3-char logo still drives a LIGHT theme via the normalized-luminance path
    expect(resolveThemePolarity({ logoHex: '#111' }).theme).toBe('light');
    // the mid-luminance contrast path also uses `normalized` — a 3-char logo failing
    // contrast against a candidate bg flips identically to its 6-char form
    const shortContrast = resolveThemePolarity({
      logoHex: '#b0b',
      candidateBackgrounds: ['#bb00bb'],
    });
    const longContrast = resolveThemePolarity({
      logoHex: '#bb00bb',
      candidateBackgrounds: ['#bb00bb'],
    });
    expect(shortContrast.theme).toBe(longContrast.theme);
  });
});
