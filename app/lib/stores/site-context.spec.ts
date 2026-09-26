import { beforeEach, describe, expect, it } from 'vitest';
import { primarySiteUrl, setSiteSlug, siteSlugAtom } from './site-context';

describe('site-context', () => {
  beforeEach(() => setSiteSlug(undefined));

  it('builds the primary URL from a slug', () => {
    expect(primarySiteUrl('russ-and-daughters')).toBe('https://russ-and-daughters.projectsites.dev');
  });

  it('returns undefined for a missing slug', () => {
    expect(primarySiteUrl(undefined)).toBeUndefined();
  });

  it('trims and clears blank slugs on the atom', () => {
    setSiteSlug('  acme  ');
    expect(siteSlugAtom.get()).toBe('acme');

    setSiteSlug('   ');
    expect(siteSlugAtom.get()).toBeUndefined();

    setSiteSlug(null);
    expect(siteSlugAtom.get()).toBeUndefined();
  });
});
