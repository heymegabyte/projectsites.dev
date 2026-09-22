/**
 * Tests for the dynamic OG-card layout core (flag `dynamic_og_cards`). Pins the 1200×630 contract,
 * contrast-safe dark/light palettes, hue-driven accent, text sanitize/truncate (no HTML/layout
 * injection), and the https-only logo guard.
 */
import { buildOgCardSpec } from '../services/og_card_spec.js';

describe('buildOgCardSpec: layout + palette', () => {
  it('is always 1200×630 with a safe area', () => {
    const s = buildOgCardSpec({ title: 'Hi' }, { businessName: 'Acme' });
    expect(s.width).toBe(1200);
    expect(s.height).toBe(630);
    expect(s.safeArea).toBeGreaterThan(0);
  });
  it('dark scheme (or auto) → dark bg + light fg; light scheme → inverse', () => {
    const dark = buildOgCardSpec({ title: 'X' }, { colorScheme: 'dark' });
    const light = buildOgCardSpec({ title: 'X' }, { colorScheme: 'light' });
    const auto = buildOgCardSpec({ title: 'X' }, { colorScheme: 'auto' });
    expect(dark.bg).toBe('#0b0b12');
    expect(dark.fg).toBe('#f4f4ff');
    expect(light.bg).toBe('#f7f7fb');
    expect(light.fg).toBe('#0b0b12');
    expect(auto.bg).toBe(dark.bg); // auto defaults to the premium dark
  });
  it('derives the accent from the brand hue (in-range, hue present)', () => {
    expect(buildOgCardSpec({ title: 'X' }, { brandHue: 28 }).accent).toContain('28');
    expect(buildOgCardSpec({ title: 'X' }, { brandHue: 999 }).accent).toMatch(/hsl\(\d+/); // clamped, still valid
  });
});

describe('buildOgCardSpec: text safety', () => {
  it('strips angle brackets + control chars and collapses whitespace', () => {
    const s = buildOgCardSpec({ title: '  Hello <script>  world\n\t ' }, {});
    expect(s.title).not.toMatch(/[<>]/);
    expect(s.title).toBe('Hello script world');
  });
  it('truncates a very long title with an ellipsis', () => {
    const long = 'word '.repeat(60);
    const s = buildOgCardSpec({ title: long }, {});
    expect(s.title.length).toBeLessThanOrEqual(91);
    expect(s.title.endsWith('…')).toBe(true);
  });
  it('uppercases the eyebrow + falls back title→business→Welcome', () => {
    expect(buildOgCardSpec({ eyebrow: 'services' }, {}).eyebrow).toBe('SERVICES');
    expect(buildOgCardSpec({}, { businessName: 'Acme Co' }).title).toBe('Acme Co');
    expect(buildOgCardSpec({}, {}).title).toBe('Welcome');
  });
  it('builds a host+path footer, dropping a bare "/"', () => {
    expect(buildOgCardSpec({ path: '/services' }, { host: 'acme.projectsites.dev' }).footer).toBe(
      'acme.projectsites.dev/services',
    );
    expect(buildOgCardSpec({ path: '/' }, { host: 'acme.projectsites.dev' }).footer).toBe(
      'acme.projectsites.dev',
    );
  });
});

describe('buildOgCardSpec: logo guard', () => {
  it('accepts an https logo with a real host', () => {
    expect(
      buildOgCardSpec({ title: 'X' }, { logoUrl: 'https://cdn.example.com/logo.png' }).logoUrl,
    ).toBe('https://cdn.example.com/logo.png');
  });
  it('rejects http / data / hostless URLs', () => {
    expect(
      buildOgCardSpec({ title: 'X' }, { logoUrl: 'http://example.com/l.png' }).logoUrl,
    ).toBeNull();
    expect(
      buildOgCardSpec({ title: 'X' }, { logoUrl: 'data:image/png;base64,AAAA' }).logoUrl,
    ).toBeNull();
    expect(buildOgCardSpec({ title: 'X' }, { logoUrl: 'https://localhost' }).logoUrl).toBeNull();
    expect(buildOgCardSpec({ title: 'X' }, {}).logoUrl).toBeNull();
  });
});
