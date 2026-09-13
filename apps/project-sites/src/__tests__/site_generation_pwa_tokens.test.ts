/**
 * Regression guard for the C.6 PWA manifest-quality root fix (AL-475).
 *
 * The worker seeds `_brand.json.business.{shortName,description}`, which the
 * container fills into `site.webmanifest`'s `{BUSINESS_SHORT_NAME}` /
 * `{BUSINESS_DESCRIPTION}` tokens (and the visible Footer blurb). The old
 * `safeName.slice(0, 12)` produced a mid-word home-screen label ("Ironhaus Str"
 * from "Ironhaus Strength & Conditioning"), and an empty additionalContext shipped
 * a blank manifest description + blank Footer `<p>`. These lock the fixes.
 */
import { derivePwaShortName, deriveBrandDescription } from '../workflows/site-generation.js';

describe('derivePwaShortName — word-boundary PWA install label (≤12, never mid-word)', () => {
  it('cuts at a word boundary, never mid-word (the ironhaus bug)', () => {
    // OLD slice(0,12) → "Ironhaus Str" (mid-word). NEW → "Ironhaus".
    expect(derivePwaShortName('Ironhaus Strength & Conditioning')).toBe('Ironhaus');
    expect(derivePwaShortName('Vanta Strength Club')).toBe('Vanta');
  });

  it('keeps as many whole words as fit in 12 chars', () => {
    expect(derivePwaShortName('Union Garage NYC')).toBe('Union Garage'); // 12 chars, clean
  });

  it('returns short names whole (≤12 chars)', () => {
    expect(derivePwaShortName('Vito')).toBe('Vito');
    expect(derivePwaShortName('Catbird')).toBe('Catbird');
    expect(derivePwaShortName('Tartine SF')).toBe('Tartine SF'); // 10 chars, whole
  });

  it('drops a trailing word that would overflow 12 chars', () => {
    expect(derivePwaShortName('Gentle Dental')).toBe('Gentle'); // 13 chars → "Gentle Dental" overflows → "Gentle"
  });

  it('never emits a mid-word cut — the label is always a prefix ending at a space in the full name', () => {
    for (const name of [
      'Ironhaus Strength & Conditioning',
      'Vantage Digital Studio Portland',
      'Harborline Coffee Roasters Collective',
      'Union Garage NYC',
    ]) {
      const sn = derivePwaShortName(name);
      expect(sn.length).toBeLessThanOrEqual(12);
      // if it is a strict prefix, the next char in the full name must be a space (word boundary)
      if (name.startsWith(sn) && sn.length < name.length) {
        expect(name[sn.length]).toBe(' ');
      }
    }
  });

  it('hard-truncates only when the first word alone exceeds 12 chars (unavoidable)', () => {
    expect(derivePwaShortName('Conditioningpalooza')).toBe('Conditioningp'.slice(0, 12));
  });

  it('handles empty/undefined safely', () => {
    expect(derivePwaShortName('')).toBe('');
    expect(derivePwaShortName(undefined as unknown as string)).toBe('');
  });
});

describe('deriveBrandDescription — never-empty manifest + Footer blurb', () => {
  it('prefers the owner freeform context, clamped ≤156', () => {
    expect(deriveBrandDescription('Ironhaus', 'fitness', 'A serious strength gym.')).toBe(
      'A serious strength gym.',
    );
    const long = 'x'.repeat(300);
    expect(deriveBrandDescription('N', 'c', long).length).toBe(156);
  });

  it('falls back to "{name} — {category}" when context is empty (never empty)', () => {
    expect(deriveBrandDescription('Ironhaus Strength & Conditioning', 'fitness', '')).toBe(
      'Ironhaus Strength & Conditioning — fitness',
    );
    expect(deriveBrandDescription('Ironhaus', 'fitness', '   ')).toBe('Ironhaus — fitness');
  });

  it('falls back to just the name when category is also empty', () => {
    expect(deriveBrandDescription('Ironhaus', '', '')).toBe('Ironhaus');
  });

  it('is never empty for any real business name', () => {
    expect(deriveBrandDescription('Vito', '', '').length).toBeGreaterThan(0);
    expect(deriveBrandDescription('Catbird', 'jewelry', '').length).toBeGreaterThan(0);
  });
});
