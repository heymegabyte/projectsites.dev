/**
 * fire-65 — reproduces the content-integrity ESCAPE from the lone-mountain-global delivery:
 * a generic pack-default H1 ("Lone Mountain Global — Your community local business"), a doubled
 * adjacent word in the eyebrow ("LOCAL LOCAL BUSINESS YOU CAN TRUST"), and a header-referenced
 * `logo-wordmark.png` absent from the shipped asset list — all VISIBLE to the paying customer,
 * none caught by the existing `validateHeroNotPackDefault` / `validateBannedWords` /
 * `validateAssetExistence` gates. Each `it` is RED until the matching gap is closed in
 * `build_validators.ts`.
 *
 * Per `content-validators-must-exclude-non-content-shells` (memory): the new detectors must NOT
 * false-positive on 404/500/offline shells or unfilled template tokens — only on FINAL rendered
 * content. Covered below.
 */
import {
  validateHeroNotPackDefault,
  validateAdjacentDuplicateWords,
  validateHeaderLogoAssetExistence,
  type BuildFile,
} from '../services/build_validators';

const file = (path: string, text?: string, size?: number): BuildFile => ({
  path,
  text,
  size: size ?? text?.length ?? 0,
});

const shell = (h1: string, eyebrow = '', extraBody = ''): string =>
  `<!DOCTYPE html><html><head><title>x</title></head><body>${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}<h1>${h1}</h1>${extraBody}</body></html>`;

describe('validateHeroNotPackDefault — "Your community local business" boilerplate class (fire-65)', () => {
  it('flags "<Business> — Your community local business" as a generic pack-default hero', () => {
    const f = file('index.html', shell('Lone Mountain Global — Your community local business'));
    const v = validateHeroNotPackDefault([f]);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('copy.generic_pack_hero');
  });

  it('flags the bare boilerplate tail regardless of which business name prefixes it', () => {
    for (const h1 of [
      'Acme Plumbing — Your community local business',
      'Harbor Bakery: Your community local business',
      'Your community local business',
    ]) {
      const v = validateHeroNotPackDefault([file('index.html', shell(h1))]);
      expect(v[0]?.code).toBe('copy.generic_pack_hero');
    }
  });

  it('is case/whitespace-insensitive on the boilerplate tail', () => {
    const f = file('index.html', shell('Lone Mountain Global —   YOUR COMMUNITY   local BUSINESS'));
    expect(validateHeroNotPackDefault([f])[0]?.code).toBe('copy.generic_pack_hero');
  });

  it('does NOT false-positive on a genuine business-specific hero mentioning "local business"', () => {
    // "local business" as an incidental phrase inside a real, specific value proposition must pass.
    const f = file(
      'index.html',
      shell('Lone Mountain Global — the local business consulting firm trusted across Nevada'),
    );
    expect(validateHeroNotPackDefault([f])).toEqual([]);
  });
});

describe('validateAdjacentDuplicateWords — doubled-seed-token class (fire-65, NEW validator)', () => {
  it('flags a case-insensitive adjacent duplicate word in the eyebrow ("LOCAL LOCAL BUSINESS")', () => {
    const f = file(
      'index.html',
      shell('Lone Mountain Global', 'LOCAL LOCAL BUSINESS YOU CAN TRUST'),
    );
    const v = validateAdjacentDuplicateWords([f]);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].code).toBe('copy.doubled_adjacent_word');
    expect(v[0].message).toMatch(/local/i);
  });

  it('flags a doubled word directly in the <h1> ("Your your community local business")', () => {
    const f = file('index.html', shell('Your your community local business'));
    const v = validateAdjacentDuplicateWords([f]);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('copy.doubled_adjacent_word');
  });

  it('flags multiple independent doublings on the same page', () => {
    const f = file(
      'index.html',
      shell('Welcome welcome to our our bakery', 'FRESH FRESH BREAD DAILY'),
    );
    const v = validateAdjacentDuplicateWords([f]);
    expect(v.length).toBeGreaterThanOrEqual(3);
    expect(v.every((x) => x.code === 'copy.doubled_adjacent_word')).toBe(true);
  });

  it('does NOT false-positive on a legitimate repeated word separated by other text', () => {
    const f = file(
      'index.html',
      shell('Lone Mountain Global', '', '<p>Local service, local people, local pride.</p>'),
    );
    expect(validateAdjacentDuplicateWords([f])).toEqual([]);
  });

  it('flags a duplicated numeric token too ("24 24 hours")', () => {
    const f = file('index.html', shell('Open 24 24 hours a day', '', ''));
    const v = validateAdjacentDuplicateWords([f]);
    expect(v.length).toBeGreaterThanOrEqual(1);
  });

  it('EXCLUDES non-content shells (404/500/offline) from the scan — content-validators-must-exclude-non-content-shells', () => {
    const f = file(
      '404.html',
      '<!DOCTYPE html><html><body><h1>Page page not not found found</h1></body></html>',
    );
    expect(validateAdjacentDuplicateWords([f])).toEqual([]);
  });

  it('does NOT scan non-HTML files (JS bundles, JSON)', () => {
    const f = file('assets/index-abc.js', 'const s = "the the quick quick fox";');
    expect(validateAdjacentDuplicateWords([f])).toEqual([]);
  });

  it('passes clean, non-doubled copy (the happy path)', () => {
    const f = file(
      'index.html',
      shell(
        'Lone Mountain Global — strategic consulting for growing Nevada businesses',
        'TRUSTED SINCE 2008',
      ),
    );
    expect(validateAdjacentDuplicateWords([f])).toEqual([]);
  });
});

describe('validateHeaderLogoAssetExistence — header-referenced logo-wordmark 404 class (fire-65, NEW validator)', () => {
  it('flags a header-referenced "/logo-wordmark.png" that is absent from the build output', () => {
    // The Header component renders the wordmark client-side from the JS bundle — the literal
    // `<img>` tag never appears in the server HTML shell, so `validateAssetExistence`'s HTML-only
    // regex scan is structurally blind to it. The reference string DOES land in the shipped JS.
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><head><title>x</title></head><body><div id="root"></div><script src="/assets/index-abc.js"></script></body></html>',
      ),
      file(
        'assets/index-abc.js',
        'function Header(){return e("img",{src:"/logo-wordmark.png",alt:"Lone Mountain Global",className:"h-10 sm:h-12"})}',
      ),
      // NOTE: logo-wordmark.png deliberately NOT in the build output — this is the escape.
    ];
    const v = validateHeaderLogoAssetExistence(files);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('asset.header_logo_missing');
    expect(v[0].severity).toBe('error');
    expect(v[0].message).toMatch(/logo-wordmark\.png/);
  });

  it('passes when the referenced logo-wordmark.png exists in the build output', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/index-abc.js"></script></body></html>',
      ),
      file('assets/index-abc.js', 'e("img",{src:"/logo-wordmark.png",alt:"Acme"})'),
      file('logo-wordmark.png', undefined, 12000),
    ];
    expect(validateHeaderLogoAssetExistence(files)).toEqual([]);
  });

  it('passes when the bundle references no logo-wordmark.png at all (text-wordmark fallback build)', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/index-abc.js"></script></body></html>',
      ),
      file('assets/index-abc.js', 'e("span",{className:"wordmark"},businessName)'),
    ];
    expect(validateHeaderLogoAssetExistence(files)).toEqual([]);
  });

  it('also catches the same missing reference when it appears literally in the HTML shell', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><img src="/logo-wordmark.png" alt="Acme"></body></html>',
      ),
    ];
    const v = validateHeaderLogoAssetExistence(files);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('asset.header_logo_missing');
  });

  it('does NOT false-positive on an unfilled template token placeholder (content-validators-must-exclude-non-content-shells)', () => {
    // A template SHELL carrying a `{{LOGO_WORDMARK_PATH}}`-style token (never rendered to the
    // literal `/logo-wordmark.png` path) is pre-fill content, not final rendered output.
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><img src="{{LOGO_WORDMARK_URL}}" alt="{{BUSINESS_NAME}}"></body></html>',
      ),
    ];
    expect(validateHeaderLogoAssetExistence(files)).toEqual([]);
  });
});
