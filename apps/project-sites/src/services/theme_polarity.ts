/**
 * Source-site theme-polarity preservation guard (ledger #22).
 *
 * @remarks
 * Implements the two BUILD-BREAKING brand rules documented in
 * `apps/project-sites/CLAUDE.md` — "Logo Luminance Drives Theme" and
 * "Source-Site Theme Preservation" — as one pure, testable decision so the
 * brand-research step and `build_validators` can agree on `_brand.json.theme`
 * BEFORE template selection. Logo legibility outranks the dark-first aesthetic;
 * a polished source's polarity outranks the logo rule.
 *
 * Pure: same inputs → same output, no I/O.
 */

/** A site's light/dark polarity. */
export type ThemePolarity = 'light' | 'dark';

/** Inputs to the theme-polarity decision. */
export interface ThemePolarityInput {
  /** Dominant logo color as a hex string (`#rgb` or `#rrggbb`, `#` optional). */
  logoHex?: string;
  /** GPT-4o aesthetic score of the SOURCE homepage screenshot, 0–10. */
  sourceAestheticScore?: number;
  /** The SOURCE site's own polarity, when known. */
  sourcePolarity?: ThemePolarity;
  /** Candidate header/hero/footer backgrounds the logo must remain legible against. */
  candidateBackgrounds?: readonly string[];
}

/** The resolved decision plus the rationale that drove it. */
export interface ThemePolarityDecision {
  /** Theme to build. */
  theme: ThemePolarity;
  /** When true, the orchestrator clones the source layout/colors before adding polish. */
  preserveSourceDesign: boolean;
  /** Human-readable reason — surfaced in build logs + audit. */
  reason: string;
}

/** Source aesthetic score at/above which the source polarity is preserved. */
const POLISHED_SOURCE_THRESHOLD = 7;
/** Logo luminance below this → dark logo → light theme. */
const DARK_LOGO_MAX = 0.4;
/** Logo luminance above this → light logo → dark theme. */
const LIGHT_LOGO_MIN = 0.6;
/** WCAG AA contrast floor for the logo against site backgrounds. */
const MIN_LOGO_CONTRAST = 4.5;

/**
 * WCAG relative luminance of a hex color, in [0, 1].
 *
 * @param hex - `#rgb` or `#rrggbb` (the leading `#` is optional).
 * @returns Relative luminance; `0` for an unparseable color.
 * @example
 * relativeLuminance('#ffffff'); // ~1
 * relativeLuminance('#000');    // 0
 */
export function relativeLuminance(hex: string): number {
  let h = (hex ?? '').trim().replace(/^#/, '').toLowerCase();
  if (h.length === 3) {
    h = h
      .split('')
      .map((x) => x + x)
      .join('');
  }
  if (!/^[0-9a-f]{6}$/.test(h)) return 0;
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

/**
 * WCAG contrast ratio between two hex colors (1–21, higher is more legible).
 *
 * @param a - First hex color.
 * @param b - Second hex color.
 * @returns Contrast ratio; symmetric in its arguments.
 * @example
 * contrastRatio('#000', '#fff'); // ~21
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Resolve the theme polarity for a generated site.
 *
 * @remarks
 * Decision order: (1) a POLISHED source (`sourceAestheticScore >= 7` with a
 * known `sourcePolarity`) is preserved — never flip a polished light site to
 * dark just because dark is the default. (2) Otherwise the logo drives it: a
 * dark logo gets a light theme, a light logo gets a dark theme. (3) A
 * mid-luminance logo defaults to dark but flips to light if it fails 4.5:1
 * against any candidate background. (4) No usable logo → dark.
 *
 * @param input - Logo color, source score/polarity, and candidate backgrounds.
 * @returns The theme, whether to preserve the source design, and the reason.
 * @example
 * resolveThemePolarity({ logoHex: '#222' }); // { theme: 'light', ... }
 */
export function resolveThemePolarity(input: ThemePolarityInput): ThemePolarityDecision {
  const { logoHex, sourceAestheticScore, sourcePolarity, candidateBackgrounds } = input;

  // (1) Preserve a polished source's polarity.
  if (
    typeof sourceAestheticScore === 'number' &&
    sourceAestheticScore >= POLISHED_SOURCE_THRESHOLD &&
    (sourcePolarity === 'light' || sourcePolarity === 'dark')
  ) {
    return {
      theme: sourcePolarity,
      preserveSourceDesign: true,
      reason: `polished source (score ${sourceAestheticScore} ≥ ${POLISHED_SOURCE_THRESHOLD}) — preserving its ${sourcePolarity} polarity`,
    };
  }

  // No usable logo → dark default.
  const h = (logoHex ?? '').trim().replace(/^#/, '').toLowerCase();
  const normalized =
    h.length === 3
      ? h
          .split('')
          .map((x) => x + x)
          .join('')
      : h;
  if (!/^[0-9a-f]{6}$/.test(normalized)) {
    return {
      theme: 'dark',
      preserveSourceDesign: false,
      reason: 'no logo color — default dark theme',
    };
  }

  const lum = relativeLuminance(normalized);

  // (2) Dark logo → light theme.
  if (lum < DARK_LOGO_MAX) {
    return {
      theme: 'light',
      preserveSourceDesign: false,
      reason: `dark logo (luminance ${lum.toFixed(2)} < ${DARK_LOGO_MAX}) — light theme for legibility`,
    };
  }

  // (2) Light logo → dark theme.
  if (lum > LIGHT_LOGO_MIN) {
    return {
      theme: 'dark',
      preserveSourceDesign: false,
      reason: `light logo (luminance ${lum.toFixed(2)} > ${LIGHT_LOGO_MIN}) — dark theme`,
    };
  }

  // (3) Mid-luminance logo: default dark, flip to light on any contrast failure.
  const failing = (candidateBackgrounds ?? []).find(
    (bg) => contrastRatio(normalized, bg) < MIN_LOGO_CONTRAST,
  );
  if (failing) {
    return {
      theme: 'light',
      preserveSourceDesign: false,
      reason: `mid-luminance logo fails ${MIN_LOGO_CONTRAST}:1 contrast against ${failing} — flipping to light theme`,
    };
  }

  return {
    theme: 'dark',
    preserveSourceDesign: false,
    reason: `mid-luminance logo (luminance ${lum.toFixed(2)}) clears contrast — default dark theme`,
  };
}
