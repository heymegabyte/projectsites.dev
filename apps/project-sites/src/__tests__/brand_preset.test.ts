/**
 * Tests for the AI-brand-kit decision core (flag `ai_brand_kit`). Pins the category→preset mapping the
 * visual loop found missing (all demos are `classic`) + the contract-first validator that keeps an
 * LLM-proposed kit in-range and injection-safe before it reaches `_brand.json`.
 */
import { selectBrandKit, validateBrandKit, type PresetName } from '../services/brand_preset.js';

const INFLECTIONS: Array<[string, string]> = [
  ['plumbing', 'warm-local'],
  ['electrical contractor', 'warm-local'],
  ['landscaping', 'warm-local'],
  ['landscape design', 'warm-local'],
  ['repair', 'warm-local'],
  ['repairs', 'warm-local'],
  ['technology', 'immersive-tech'],
  ['photography', 'minimal-luxury'],
  ['jewelry', 'premium-commerce'],
  ['consulting', 'sophisticated-authority'],
  ['orthodontics', 'clean-clinical'],
  ['volunteer relief', 'mission-organic'],
];

describe('selectBrandKit: category → art-direction preset', () => {
  it('maps common verticals to distinct presets (not all classic)', () => {
    expect(selectBrandKit({ category: 'AI SaaS platform' }).themeStyle).toBe('immersive-tech');
    expect(selectBrandKit({ category: 'sourdough bakery' }).themeStyle).toBe('organic-hospitality');
    expect(selectBrandKit({ category: 'estate planning law firm' }).themeStyle).toBe('sophisticated-authority');
    expect(selectBrandKit({ category: 'family dentistry' }).themeStyle).toBe('clean-clinical');
    expect(selectBrandKit({ category: 'clothing boutique' }).themeStyle).toBe('premium-commerce');
    expect(selectBrandKit({ category: 'plumbing company' }).themeStyle).toBe('warm-local');
    expect(selectBrandKit({ category: 'food bank nonprofit' }).themeStyle).toBe('mission-organic');
    expect(selectBrandKit({ category: 'independent design studio' }).themeStyle).toBe('cinematic-editorial');
  });
  // `\b` needs a NON-word char after the stem, so a truncated stem silently misses its
  // own inflections — `\bplumb\b` never matched "plumbing" and fell through to
  // `classic`. Table-driven so EVERY regression reports in one run; a single `it()`
  // with N assertions stops at the first failure and hides the rest.
  it.each(INFLECTIONS)('matches the inflected form: %s → %s', (category, preset) => {
    expect(selectBrandKit({ category }).themeStyle).toBe(preset);
  });
  it('falls back to classic (low confidence) for an unrecognized category', () => {
    const k = selectBrandKit({ category: 'assorted widgets' });
    expect(k.themeStyle).toBe('classic');
    expect(k.confidence).toBeLessThan(0.6);
  });
  it('produces in-range OKLCH hue/chroma + a real font pairing + a rationale', () => {
    const k = selectBrandKit({ category: 'SaaS' });
    expect(k.brandHue).toBeGreaterThanOrEqual(0);
    expect(k.brandHue).toBeLessThanOrEqual(360);
    expect(k.brandChroma).toBeGreaterThanOrEqual(0.05);
    expect(k.brandChroma).toBeLessThanOrEqual(0.3);
    expect(k.fontPairing.heading.length).toBeGreaterThan(0);
    expect(k.rationale).toMatch(/Confirm/);
  });
});

describe('selectBrandKit: vibe adjustments', () => {
  it('bold raises chroma; minimal lowers it (clamped)', () => {
    const bold = selectBrandKit({ category: 'SaaS', vibeKeywords: ['bold'] }).brandChroma;
    const minimal = selectBrandKit({ category: 'SaaS', vibeKeywords: ['minimal'] }).brandChroma;
    expect(bold).toBeGreaterThan(minimal);
    expect(bold).toBeLessThanOrEqual(0.3);
    expect(minimal).toBeGreaterThanOrEqual(0.05);
  });
  it('playful switches the preset to playful-dimensional', () => {
    expect(selectBrandKit({ category: 'toy shop', vibeKeywords: ['playful'] }).themeStyle).toBe('playful-dimensional');
  });
  it('honors an explicit colorScheme preference', () => {
    expect(selectBrandKit({ category: 'bakery', colorScheme: 'dark' }).colorScheme).toBe('dark');
  });
});

describe('validateBrandKit: contract-first safety', () => {
  const allowed: PresetName[] = ['classic', 'immersive-tech', 'organic-hospitality'];
  it('clamps out-of-range hue/chroma', () => {
    const k = validateBrandKit({ brandHue: 999, brandChroma: 5, themeStyle: 'immersive-tech' }, allowed);
    expect(k.brandHue).toBeLessThanOrEqual(360);
    expect(k.brandChroma).toBeLessThanOrEqual(0.3);
    expect(k.brandChroma).toBeGreaterThanOrEqual(0.05);
  });
  it('forces an unknown/unsupported preset to classic', () => {
    expect(validateBrandKit({ themeStyle: 'evil' as PresetName }, allowed).themeStyle).toBe('classic');
    expect(validateBrandKit({ themeStyle: 'immersive-tech' }, allowed).themeStyle).toBe('immersive-tech');
  });
  it('sanitizes font names (no CSS/HTML injection into font.*)', () => {
    const k = validateBrandKit({ fontPairing: { heading: 'Inter;} body{display:none', body: '<script>' } }, allowed);
    expect(k.fontPairing.heading).toBe('Sora'); // rejected → fallback
    expect(k.fontPairing.body).toBe('Inter');
  });
  it('defaults an invalid colorScheme to auto + tolerates malformed input', () => {
    expect(validateBrandKit({ colorScheme: 'rainbow' as never }, allowed).colorScheme).toBe('auto');
    expect(validateBrandKit(null, allowed).themeStyle).toBe('classic');
    expect(validateBrandKit({}, allowed).brandHue).toBe(210);
  });
});
