import { canPreviewPrebuilt, prebuiltPreviewUrl, type PreviewableItem } from './prebuilt-preview';

describe('prebuilt-preview', () => {
  describe('canPreviewPrebuilt', () => {
    it('true for a published prebuilt result with a valid slug', () => {
      expect(canPreviewPrebuilt({ type: 'prebuilt', slug: 'acme-cafe', status: 'published' })).toBe(true);
    });

    it('false for a prebuilt that is not yet live (building/draft/error)', () => {
      for (const status of ['building', 'draft', 'error', 'generating', undefined]) {
        expect(canPreviewPrebuilt({ type: 'prebuilt', slug: 'acme-cafe', status })).toBe(false);
      }
    });

    it('false for a non-prebuilt result (business / custom)', () => {
      expect(canPreviewPrebuilt({ type: 'business', slug: 'acme', status: 'published' })).toBe(false);
      expect(canPreviewPrebuilt({ type: 'custom', status: 'published' })).toBe(false);
    });

    it('false when the slug is missing, blank, or not a valid subdomain label', () => {
      expect(canPreviewPrebuilt({ type: 'prebuilt', slug: undefined, status: 'published' })).toBe(false);
      expect(canPreviewPrebuilt({ type: 'prebuilt', slug: '   ', status: 'published' })).toBe(false);
      expect(canPreviewPrebuilt({ type: 'prebuilt', slug: 'bad slug!', status: 'published' })).toBe(false);
      expect(canPreviewPrebuilt({ type: 'prebuilt', slug: '-lead', status: 'published' })).toBe(false);
    });

    it('false for null/undefined input (never throws)', () => {
      expect(canPreviewPrebuilt(null)).toBe(false);
      expect(canPreviewPrebuilt(undefined)).toBe(false);
    });
  });

  describe('prebuiltPreviewUrl', () => {
    it('builds the public subdomain URL for a valid slug', () => {
      expect(prebuiltPreviewUrl('acme-cafe')).toBe('https://acme-cafe.projectsites.dev');
    });

    it('lowercases + trims before building', () => {
      expect(prebuiltPreviewUrl('  Screen-Door  ')).toBe('https://screen-door.projectsites.dev');
    });

    it('returns empty string for an invalid/blank slug (never emits a broken href)', () => {
      expect(prebuiltPreviewUrl('')).toBe('');
      expect(prebuiltPreviewUrl('   ')).toBe('');
      expect(prebuiltPreviewUrl('has space')).toBe('');
      expect(prebuiltPreviewUrl(undefined)).toBe('');
      expect(prebuiltPreviewUrl(null)).toBe('');
    });

    it('a canPreviewPrebuilt item always yields a non-empty URL (paired contract)', () => {
      const item: PreviewableItem = { type: 'prebuilt', slug: 'stumptown-coffee', status: 'published' };
      expect(canPreviewPrebuilt(item)).toBe(true);
      expect(prebuiltPreviewUrl(item.slug)).toBe('https://stumptown-coffee.projectsites.dev');
    });
  });
});
