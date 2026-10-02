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
  validateWordmarkContrast,
  validateEyebrowContrast,
  validateNoBuildPromptLeak,
  validateNoEmptyNap,
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

/**
 * fire-80 — reproduces gp-09 cycle-2 vision defect (a): the HTML TEXT wordmark (the common render
 * path — most generated sites lack a `/logo-wordmark.png`, so the Header falls back to a styled
 * `<span>` of the business name) ships with a DARK text color/token, rendering DARK-ON-DARK and
 * illegible in the nav. Per `logo-contrast`: a light-text wordmark must sit on a dark backing OR
 * carry a halo; a dark text token on the transparent/dark nav is the defect. The gate scans the
 * shipped JS bundle (where the React Header renders) for a wordmark span styled with a near-black /
 * dark-token color AND lacking any halo (`text-shadow`/`drop-shadow`) or explicit dark-backing.
 */
describe('validateWordmarkContrast — dark-on-dark text wordmark class (fire-80, gp-09 c2)', () => {
  it('flags a text wordmark span rendered with a near-black hex color (dark-on-dark, no halo)', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/h.js"></script></body></html>',
      ),
      // React Header renders the business NAME as a styled span with an inline near-black color and
      // no halo — illegible over the dark/transparent nav.
      file(
        'assets/h.js',
        'function Header(){return e("span",{className:"wordmark",style:{color:"#0a0a1a"}},businessName)}',
      ),
    ];
    const v = validateWordmarkContrast(files);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].code).toBe('contrast.wordmark_dark_on_dark');
    expect(v[0].severity).toBe('error');
  });

  it('flags a text wordmark styled with a dark THEME token class (text-[#0...]/text-ink-900) sans halo', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/h.js"></script></body></html>',
      ),
      file(
        'assets/h.js',
        'e("span",{className:"wordmark font-bold text-[#111827] whitespace-nowrap"},business)',
      ),
    ];
    const v = validateWordmarkContrast(files);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].code).toBe('contrast.wordmark_dark_on_dark');
  });

  it('PASSES a text wordmark with a light token + a text-shadow halo (the logo-contrast fix)', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/h.js"></script></body></html>',
      ),
      // Light token (text-text / text-white) + halo via [text-shadow:...] — legible on any nav.
      file(
        'assets/h.js',
        'e("span",{className:"wordmark text-text whitespace-nowrap [text-shadow:0_1px_3px_rgba(0,0,0,0.55)]"},business)',
      ),
    ];
    expect(validateWordmarkContrast(files)).toEqual([]);
  });

  it('PASSES a dark-colored wordmark that sits on an explicit dark backing (bg-* on the same span)', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/h.js"></script></body></html>',
      ),
      // A dark text token is fine when the element carries its OWN light/dark backing — contrast is local.
      file(
        'assets/h.js',
        'e("span",{className:"wordmark text-[#111827] bg-surface rounded-lg px-2"},business)',
      ),
    ];
    expect(validateWordmarkContrast(files)).toEqual([]);
  });

  it('PASSES an IMAGE wordmark (no text span) — the img path is covered by header-logo-asset gate', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/h.js"></script></body></html>',
      ),
      file('assets/h.js', 'e("img",{src:"/logo-wordmark.png",alt:business,className:"h-12"})'),
      file('logo-wordmark.png', undefined, 12000),
    ];
    expect(validateWordmarkContrast(files)).toEqual([]);
  });

  it('does NOT scan non-JS/HTML files', () => {
    const files = [file('data.json', '{"wordmark":"color:#0a0a1a"}')];
    expect(validateWordmarkContrast(files)).toEqual([]);
  });
});

/**
 * fire-80 — reproduces gp-09 cycle-2 vision defect (b): the hero EYEBROW (the small uppercase label
 * above the H1) uses OPACITY-ON-A-MUTED-TOKEN (`text-text-subtle`, `text-white/40`, `opacity-50` on
 * a muted color), which `text-contrast` flags as a silent WCAG-AA failure — a muted token further
 * faded by opacity rarely clears 4.5:1. The fix is a SOLID brand/OKLCH token (`text-accent`,
 * `--ink-accent`), never opacity on muted. The gate scans the shipped bundle/HTML for an eyebrow
 * element styled with the faded-muted anti-pattern.
 */
describe('validateEyebrowContrast — opacity-on-muted eyebrow AA-fail class (fire-80, gp-09 c2)', () => {
  it('flags an eyebrow using a low-opacity white utility (text-white/40 → fails AA on dark)', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/hero.js"></script></body></html>',
      ),
      file(
        'assets/hero.js',
        'e("p",{className:"eyebrow uppercase tracking-widest text-white/40"},"EST. 2008")',
      ),
    ];
    const v = validateEyebrowContrast(files);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].code).toBe('contrast.eyebrow_low_contrast');
    expect(v[0].severity).toBe('error');
  });

  it('flags an eyebrow on a muted token further dimmed by an opacity-* class', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/hero.js"></script></body></html>',
      ),
      file(
        'assets/hero.js',
        'e("span",{className:"eyebrow text-text-subtle opacity-60 uppercase"},"WELCOME")',
      ),
    ];
    const v = validateEyebrowContrast(files);
    expect(v.length).toBeGreaterThanOrEqual(1);
    expect(v[0].code).toBe('contrast.eyebrow_low_contrast');
  });

  it('PASSES an eyebrow on a solid brand accent token (the text-contrast fix)', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/hero.js"></script></body></html>',
      ),
      // Solid accent token at full opacity — the --ink-accent / text-accent pattern clears AA.
      file(
        'assets/hero.js',
        'e("p",{className:"eyebrow uppercase tracking-widest text-accent"},"EST. 2008")',
      ),
    ];
    expect(validateEyebrowContrast(files)).toEqual([]);
  });

  it('PASSES an eyebrow with a solid muted token at FULL opacity (text-text-muted, no opacity fade)', () => {
    // text-text-muted alone is a legitimate AA-safe mid token; only opacity-fading it fails.
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/hero.js"></script></body></html>',
      ),
      file('assets/hero.js', 'e("p",{className:"eyebrow uppercase text-text-muted"},"WELCOME")'),
    ];
    expect(validateEyebrowContrast(files)).toEqual([]);
  });

  it('does NOT false-positive on a low-opacity utility that is NOT on an eyebrow element', () => {
    const files = [
      file(
        'index.html',
        '<!DOCTYPE html><html><body><script src="/assets/hero.js"></script></body></html>',
      ),
      // A decorative divider using text-white/40 — not an eyebrow, must not trip the gate.
      file('assets/hero.js', 'e("span",{className:"divider text-white/40"},"•")'),
    ];
    expect(validateEyebrowContrast(files)).toEqual([]);
  });
});

/**
 * fire-83 — build-prompt-leak class: the generation PROMPT, an AI refusal/preamble, or a markdown
 * code fence survived into the shipped page (a real, highly-embarrassing generation defect). Each
 * is a visible `error`-severity hole the existing copy gates don't catch.
 */
describe('validateNoBuildPromptLeak — leaked generation prompt / AI preamble / code fence (fire-83)', () => {
  it('flags a leaked "Build a professional website" instruction in the body', () => {
    const f = file(
      'index.html',
      shell('Acme Bakery', '', '<p>Build a professional website for Acme Bakery in Newark.</p>'),
    );
    const v = validateNoBuildPromptLeak([f]);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('copy.build_prompt_leaked');
    expect(v[0].severity).toBe('error');
  });

  it('flags an "As an AI language model" refusal preamble', () => {
    const f = file('about.html', shell('About', '', '<p>As an AI language model, I cannot…</p>'));
    expect(validateNoBuildPromptLeak([f])[0]?.code).toBe('copy.build_prompt_leaked');
  });

  it('flags an "I\'ll create the website" meta-preamble and a leaked ``` code fence', () => {
    for (const body of ["<p>I'll create the website now.</p>", '<p>```html</p>']) {
      const v = validateNoBuildPromptLeak([file('index.html', shell('X', '', body))]);
      expect(v[0]?.code).toBe('copy.build_prompt_leaked');
    }
  });

  it('does NOT false-positive on real bakery copy ("I\'ll create a custom cake")', () => {
    // The bare verb is fine — only the build-time "create a website/page" shape is a leak.
    const f = file(
      'index.html',
      shell('Acme Bakery', '', "<p>I'll create a custom cake for your celebration.</p>"),
    );
    expect(validateNoBuildPromptLeak([f])).toEqual([]);
  });

  it('does NOT scan a 404 shell (non-content shell exclusion)', () => {
    const f = file('404.html', shell('Not found', '', '<p>As an AI, here is the error page.</p>'));
    expect(validateNoBuildPromptLeak([f])).toEqual([]);
  });

  it('passes clean marketing copy (the happy path)', () => {
    const f = file(
      'index.html',
      shell('Acme Bakery', '', '<p>Fresh sourdough baked daily in the heart of Newark.</p>'),
    );
    expect(validateNoBuildPromptLeak([f])).toEqual([]);
  });
});

/**
 * fire-83 — empty-NAP class: a local-business page renders an address/phone BLOCK with no real value
 * (blank, "N/A", an unfilled `{{token}}`, "undefined") — the one thing a visitor needs is a hole.
 * Only a PRESENT-but-EMPTY block is an `error`; a page that omits the block isn't flagged here.
 */
describe('validateNoEmptyNap — present-but-empty address/phone block (fire-83)', () => {
  it('flags a blank <address> element', () => {
    const f = file('contact.html', shell('Contact', '', '<address>  </address>'));
    const v = validateNoEmptyNap([f]);
    expect(v).toHaveLength(1);
    expect(v[0].code).toBe('content.empty_nap');
    expect(v[0].severity).toBe('error');
  });

  it('flags an itemprop="telephone" with an "N/A" placeholder value', () => {
    const f = file('index.html', shell('X', '', '<span itemprop="telephone">N/A</span>'));
    expect(validateNoEmptyNap([f])[0]?.code).toBe('content.empty_nap');
  });

  it('flags an unfilled {{phone}} token and an "undefined" street address', () => {
    for (const body of [
      '<span itemprop="telephone">{{phone}}</span>',
      '<span itemprop="streetAddress">undefined</span>',
    ]) {
      const v = validateNoEmptyNap([file('index.html', shell('X', '', body))]);
      expect(v[0]?.code).toBe('content.empty_nap');
    }
  });

  it('does NOT flag a filled <address> with a real NAP', () => {
    const f = file(
      'contact.html',
      shell('Contact', '', '<address>74 N Beverwyck Rd, Lake Hiawatha, NJ 07034</address>'),
    );
    expect(validateNoEmptyNap([f])).toEqual([]);
  });

  it('does NOT flag a filled itemprop telephone', () => {
    const f = file(
      'index.html',
      shell('X', '', '<span itemprop="telephone">(973) 555-0142</span>'),
    );
    expect(validateNoEmptyNap([f])).toEqual([]);
  });

  it('does NOT scan a 404 shell for empty NAP (non-content shell exclusion)', () => {
    const f = file('500.html', shell('Error', '', '<address>N/A</address>'));
    expect(validateNoEmptyNap([f])).toEqual([]);
  });
});
