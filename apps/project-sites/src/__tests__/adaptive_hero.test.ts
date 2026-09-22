/**
 * Tests for the Adaptive Hero pure decision core (flag `adaptive_hero`).
 * Focus: deterministic priority selection, fail-soft null on no variants, fabrication-safety
 * (only ever returns a provided variant), and referrer/emergency classification. No I/O.
 */
import {
  HERO_INTENTS,
  classifyReferrer,
  looksEmergency,
  deriveApplicableIntents,
  pickHeroVariant,
} from '../services/adaptive_hero.js';

describe('adaptive_hero: classifyReferrer', () => {
  it('buckets search, AI-engine, social, and direct', () => {
    expect(classifyReferrer('https://www.google.com/search?q=plumber')).toBe('google');
    expect(classifyReferrer('https://www.bing.com/search?q=x')).toBe('bing');
    expect(classifyReferrer('https://chat.openai.com/')).toBe('ai');
    expect(classifyReferrer('https://www.perplexity.ai/')).toBe('ai');
    expect(classifyReferrer('https://m.facebook.com/')).toBe('social');
    expect(classifyReferrer('')).toBe('direct');
    expect(classifyReferrer(undefined)).toBe('direct');
    expect(classifyReferrer('https://some-blog.example/post')).toBe('other');
  });
});

describe('adaptive_hero: looksEmergency', () => {
  it('flags urgent needs, ignores ordinary queries', () => {
    expect(looksEmergency('emergency plumber near me')).toBe(true);
    expect(looksEmergency('24-hour locksmith')).toBe(true);
    expect(looksEmergency('burst pipe help')).toBe(true);
    expect(looksEmergency('best bakery in town')).toBe(false);
    expect(looksEmergency('')).toBe(false);
  });
});

describe('adaptive_hero: deriveApplicableIntents', () => {
  it('always includes default as the floor', () => {
    expect(deriveApplicableIntents({})).toEqual(['default']);
  });
  it('adds intents per signal', () => {
    expect(deriveApplicableIntents({ returning: true })).toContain('returning');
    expect(deriveApplicableIntents({ openNow: false })).toContain('after_hours');
    expect(deriveApplicableIntents({ utmCampaign: 'spring' })).toContain('promo');
    expect(deriveApplicableIntents({ referrer: 'google' })).toContain('local');
    expect(deriveApplicableIntents({ emergencyIntent: true })).toContain('emergency');
  });
  it('ignores an empty utm campaign', () => {
    expect(deriveApplicableIntents({ utmCampaign: '   ' })).not.toContain('promo');
  });
});

describe('adaptive_hero: pickHeroVariant', () => {
  const V = [
    { intent: 'default' as const, headline: 'Default' },
    { intent: 'returning' as const, headline: 'Welcome back' },
    { intent: 'emergency' as const, headline: 'Call now — 24/7' },
    { intent: 'after_hours' as const, headline: 'Book online' },
  ];

  it('picks the highest-priority applicable intent that has a variant', () => {
    expect(pickHeroVariant({ emergencyIntent: true, returning: true }, V)!.intent).toBe(
      'emergency',
    );
    expect(pickHeroVariant({ openNow: false, returning: true }, V)!.intent).toBe('after_hours');
    expect(pickHeroVariant({ returning: true }, V)!.intent).toBe('returning');
  });
  it('falls back to default when the applicable intent has no variant', () => {
    // emergency applies but no emergency variant present → default
    expect(pickHeroVariant({ emergencyIntent: true }, [V[0], V[1]])!.intent).toBe('default');
  });
  it('returns the default variant for a signal-less visitor', () => {
    expect(pickHeroVariant({}, V)!.intent).toBe('default');
  });
  it('is fail-soft: null when there are no variants (caller renders the static hero)', () => {
    expect(pickHeroVariant({ emergencyIntent: true }, [])).toBeNull();
  });
  it('never returns a variant it was not given (fabrication-safe)', () => {
    const chosen = pickHeroVariant({ emergencyIntent: true, openNow: false }, V);
    expect(V).toContain(chosen);
  });
  it('exposes intents in fixed converting-first priority order', () => {
    expect(HERO_INTENTS[0]).toBe('emergency');
    expect(HERO_INTENTS[HERO_INTENTS.length - 1]).toBe('default');
  });
});
