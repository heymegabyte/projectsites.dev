/**
 * Tests for the extraction-first logo decision core. Every case pins Brian's rule: use the REAL
 * brand logo from internet records when one is good enough, generate with Ideogram only otherwise.
 */
import { scoreLogoCandidate, pickLogoSource, MIN_LOGO_SCORE } from '../services/logo_source.js';

describe('scoreLogoCandidate: hard rejects', () => {
  it('rejects a candidate with no url', () => {
    expect(scoreLogoCandidate({ url: '', kind: 'clearbit' }).usable).toBe(false);
  });
  it('rejects a raster smaller than 48px on its short edge', () => {
    expect(scoreLogoCandidate({ url: 'x', kind: 'apple_touch_icon', format: 'png', width: 32, height: 32 }).usable).toBe(false);
  });
  it('rejects a favicon under 64px (too low-res for a large header)', () => {
    expect(scoreLogoCandidate({ url: 'f', kind: 'favicon', format: 'ico', width: 32, height: 32 }).usable).toBe(false);
  });
});

describe('scoreLogoCandidate: scoring', () => {
  it('a large transparent PNG brand mark scores high', () => {
    const s = scoreLogoCandidate({ url: 'x', kind: 'clearbit', format: 'png', width: 512, height: 512, hasAlpha: true });
    expect(s.usable).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(MIN_LOGO_SCORE);
  });
  it('prefers SVG (scalable) even without dimensions', () => {
    const s = scoreLogoCandidate({ url: 's', kind: 'source_site', format: 'svg' });
    expect(s.usable).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(MIN_LOGO_SCORE);
  });
  it('penalizes a wide banner-shaped JPG (usually a photo, not a mark)', () => {
    const banner = scoreLogoCandidate({ url: 'o', kind: 'og_image', format: 'jpg', width: 1200, height: 630 });
    expect(banner.usable).toBe(true);
    expect(banner.score).toBeLessThan(MIN_LOGO_SCORE);
  });
});

describe('pickLogoSource: extract vs generate', () => {
  it('EXTRACTS when a good real logo exists', () => {
    const d = pickLogoSource([{ url: 'x', kind: 'clearbit', format: 'png', width: 512, height: 512, hasAlpha: true }]);
    expect(d.decision).toBe('extract');
    expect(d.candidate?.kind).toBe('clearbit');
    expect(d.reason).toMatch(/extracted/);
  });
  it('GENERATES (Ideogram) when there are no candidates', () => {
    const d = pickLogoSource([]);
    expect(d.decision).toBe('generate');
    expect(d.candidate).toBeNull();
    expect(d.reason).toMatch(/no usable logo/i);
  });
  it('GENERATES when the only candidate is a tiny favicon (hard-rejected)', () => {
    const d = pickLogoSource([{ url: 'f', kind: 'favicon', format: 'ico', width: 32, height: 32 }]);
    expect(d.decision).toBe('generate');
  });
  it('GENERATES when the best usable candidate is below the score threshold', () => {
    const d = pickLogoSource([{ url: 'o', kind: 'og_image', format: 'jpg', width: 1200, height: 630 }]);
    expect(d.decision).toBe('generate');
    expect(d.reason).toMatch(/< /);
  });
  it('picks the best candidate + returns the full ranking, best-first', () => {
    const d = pickLogoSource([
      { url: 'f', kind: 'favicon', format: 'ico', width: 32, height: 32 },
      { url: 'o', kind: 'og_image', format: 'jpg', width: 1200, height: 630 },
      { url: 'c', kind: 'clearbit', format: 'png', width: 256, height: 256, hasAlpha: true },
    ]);
    expect(d.decision).toBe('extract');
    expect(d.candidate?.kind).toBe('clearbit');
    expect(d.ranked[0].candidate.kind).toBe('clearbit');
    expect(d.ranked[0].score).toBeGreaterThanOrEqual(d.ranked[1].score);
  });
});
