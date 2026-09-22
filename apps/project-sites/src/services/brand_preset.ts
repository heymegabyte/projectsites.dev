/**
 * brand_preset.ts — "AI brand kit, owner confirms" decision core (feature flag `ai_brand_kit`,
 * enabled=0, rollout=0, stage=experimental).
 *
 * Bleeding-edge source (BLEEDING-EDGE loop, 2026-09-21): every AI brand-kit tool (HubSpot, Magnt,
 * ImagineArt, SellerPic, Wireflow) does "business name + industry → palette + typography" — BUT the
 * research found none push the kit NATIVELY into the builder; it's a two-step manual export
 * (https://insidea.com/blog/hubspot/brand-kit-generators, https://www.framer.com/ai/). We own
 * `_brand.json` + `themeStyle`/`applyBrand`, so we beat them with a ONE-STEP kit that lands directly
 * in the site — the owner CONFIRMS one screen, never configures hue sliders (embarrassingly-easy +
 * ai-permanence). This is also the missing brain the visual loop identified: every demo ships
 * `themeStyle:"classic"` because there is NO category→art-direction-preset mapping. This core is that
 * mapping: business facts → a proposed brand kit (themeStyle preset + OKLCH hue/chroma + font pairing)
 * for the confirm screen. Pure — facts in, kit out; the pipeline renders it via `applyBrand`.
 *
 * NOTE: the preset names below are the vocabulary this core PROPOSES; the template's `themeStyle`
 * PresetName + `[data-style]` CSS must include them (the template visual loop's job — see
 * docs/template-visual-audit.md). Until a preset's CSS ships, it falls back to `classic` rendering.
 */

/** The art-direction presets this core proposes (maps 1:1 to template `themeStyle` values to add). */
export type PresetName =
  | 'classic'
  | 'immersive-tech'
  | 'cinematic-editorial'
  | 'minimal-luxury'
  | 'premium-commerce'
  | 'organic-hospitality'
  | 'sophisticated-authority'
  | 'clean-clinical'
  | 'warm-local'
  | 'mission-organic'
  | 'playful-dimensional';

export type ColorScheme = 'dark' | 'light' | 'auto';

export interface BusinessFacts {
  /** Free-text category/industry, e.g. 'SaaS', 'bakery', 'law firm'. */
  category?: string;
  /** Optional vibe adjectives, e.g. ['bold','warm'] or ['minimal','premium']. */
  vibeKeywords?: string[];
  /** Owner's explicit light/dark preference, if any. */
  colorScheme?: ColorScheme;
}

/** The proposed kit shown on the confirm screen + written to `_brand.json`. */
export interface BrandKit {
  themeStyle: PresetName;
  /** OKLCH brand hue 0–360. */
  brandHue: number;
  /** OKLCH brand chroma 0.05 (pastel) – 0.30 (vivid). */
  brandChroma: number;
  fontPairing: { heading: string; body: string };
  colorScheme: ColorScheme;
  /** Plain-language "why this kit" for the confirm screen. */
  rationale: string;
  confidence: number;
}

interface VerticalDefault {
  preset: PresetName;
  hue: number;
  chroma: number;
  heading: string;
  body: string;
  scheme: ColorScheme;
  label: string;
}

/** Canonical vertical → brand defaults. Fonts are real Google Fonts matching the template's `font.*`. */
const VERTICALS: Array<{ match: RegExp; d: VerticalDefault }> = [
  {
    match:
      /\b(saas|software|tech|technology|technologies|technical|ai|app|platform|dev|cloud|data|api|cyber|fintech)\b/i,
    d: {
      preset: 'immersive-tech',
      hue: 200,
      chroma: 0.18,
      heading: 'Space Grotesk',
      body: 'Inter',
      scheme: 'dark',
      label: 'Technology',
    },
  },
  // ORDER IS SEMANTIC — first match wins, so an EARLIER row's generic token
  // silently hijacks an input a LATER row owns. Two live cases: `\bdesign\b`
  // (creative studio) beat `\blandscape\b` for "landscape design", and `\bfood\b`
  // (hospitality) beat `\bnonprofit\b` for "food bank nonprofit" — both resolved
  // to the wrong art direction, with no error. When adding a row, grep the array
  // for a token that also appears in your inputs, and move the SPECIFIC row
  // above the GENERIC one.
  {
    match:
      /\b(plumbing|plumber|hvac|electric|electrical|electrician|trades|contractor|repair|repairs|roofing|landscape|landscaping|landscaper|handyman|construction|cleaning)\b/i,
    d: {
      preset: 'warm-local',
      hue: 24,
      chroma: 0.16,
      heading: 'Sora',
      body: 'Inter',
      scheme: 'light',
      label: 'Local trades',
    },
  },
  {
    match: /\b(studio|agency|creative|design|brand|film|media|production)\b/i,
    d: {
      preset: 'cinematic-editorial',
      hue: 280,
      chroma: 0.14,
      heading: 'Fraunces',
      body: 'Inter',
      scheme: 'dark',
      label: 'Creative studio',
    },
  },
  {
    match:
      /\b(portfolio|photographer|photography|artist|designer|writer|freelance|freelancer|freelancing)\b/i,
    d: {
      preset: 'minimal-luxury',
      hue: 40,
      chroma: 0.06,
      heading: 'Cormorant Garamond',
      body: 'Inter',
      scheme: 'light',
      label: 'Portfolio',
    },
  },
  {
    match:
      /\b(shop|store|retail|apparel|clothing|boutique|ecommerce|commerce|goods|jewelry|jewellery)\b/i,
    d: {
      preset: 'premium-commerce',
      hue: 340,
      chroma: 0.16,
      heading: 'Playfair Display',
      body: 'Inter',
      scheme: 'light',
      label: 'Retail',
    },
  },
  {
    match:
      /\b(nonprofit|non-profit|charity|foundation|community|volunteer|mission|shelter|relief)\b/i,
    d: {
      preset: 'mission-organic',
      hue: 150,
      chroma: 0.14,
      heading: 'Sora',
      body: 'Nunito Sans',
      scheme: 'light',
      label: 'Nonprofit',
    },
  },
  {
    match: /\b(restaurant|cafe|café|bakery|food|coffee|bar|bistro|kitchen|catering|brewery)\b/i,
    d: {
      preset: 'organic-hospitality',
      hue: 28,
      chroma: 0.14,
      heading: 'Fraunces',
      body: 'Nunito Sans',
      scheme: 'light',
      label: 'Hospitality',
    },
  },
  {
    match:
      /\b(law|legal|attorney|lawyer|accounting|finance|advisor|consulting|consultancy|consultant|insurance|estate)\b/i,
    d: {
      preset: 'sophisticated-authority',
      hue: 220,
      chroma: 0.1,
      heading: 'Libre Baskerville',
      body: 'Inter',
      scheme: 'light',
      label: 'Professional services',
    },
  },
  // Inflected forms are listed explicitly alongside their stem: `\bdental\b`
  // and `\bdentist\b` cannot match "dentistry" — the trailing word char kills
  // the `\b` — so "family dentistry" fell through to the `classic` default.
  // The same class bit every truncated stem in this array (`tech`, `freelanc`,
  // `jewel`, `consult`, `orthodont`, `plumb`, `electric`, `landscap`): always
  // list the full form when the stem is shorter than the word people type.
  {
    match:
      /\b(medical|dental|dentist|dentistry|orthodontics|orthodontist|clinic|health|wellness|therapy|doctor|care|spa)\b/i,
    d: {
      preset: 'clean-clinical',
      hue: 185,
      chroma: 0.1,
      heading: 'Poppins',
      body: 'Inter',
      scheme: 'light',
      label: 'Health',
    },
  },
];

const DEFAULT_VERTICAL: VerticalDefault = {
  preset: 'classic',
  hue: 210,
  chroma: 0.12,
  heading: 'Sora',
  body: 'Inter',
  scheme: 'dark',
  label: 'Business',
};

const HUE_NAME = (h: number): string => {
  const n = ((h % 360) + 360) % 360;
  if (n < 20 || n >= 345) return 'red';
  if (n < 45) return 'warm amber';
  if (n < 70) return 'gold';
  if (n < 160) return 'green';
  if (n < 195) return 'teal';
  if (n < 255) return 'blue';
  if (n < 300) return 'violet';
  return 'magenta';
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Propose a complete brand kit from business facts — the deterministic fast-path (no LLM needed) that
 * powers the "confirm your AI brand kit" screen and seeds `_brand.json`. Picks the art-direction preset
 * + OKLCH hue/chroma + font pairing + light/dark from the vertical, then nudges for vibe keywords.
 * Pure, never throws.
 *
 * @param facts - business category + optional vibe keywords + colorScheme preference
 * @returns the proposed {@link BrandKit}
 * @example selectBrandKit({ category: 'AI SaaS' }).themeStyle // 'immersive-tech'
 * @example selectBrandKit({ category: 'bakery' }).themeStyle // 'organic-hospitality'
 * @example selectBrandKit({ category: 'unknown widgets' }).themeStyle // 'classic' (safe default)
 */
export function selectBrandKit(facts: BusinessFacts): BrandKit {
  const cat = String(facts?.category ?? '');
  const vibes = (facts?.vibeKeywords ?? []).map((v) => String(v).toLowerCase());
  const v = VERTICALS.find((x) => x.match.test(cat))?.d ?? DEFAULT_VERTICAL;

  let hue = v.hue;
  let chroma = v.chroma;
  let preset: PresetName = v.preset;
  let confidence = v === DEFAULT_VERTICAL ? 0.4 : 0.85;

  const has = (...ks: string[]) => vibes.some((x) => ks.some((k) => x.includes(k)));
  if (has('bold', 'vibrant', 'energetic', 'loud')) chroma += 0.06;
  if (has('minimal', 'clean', 'understated', 'simple')) chroma -= 0.05;
  if (has('premium', 'luxury', 'elegant', 'refined')) chroma -= 0.03;
  if (has('playful', 'fun', 'friendly', 'quirky')) {
    preset = 'playful-dimensional';
    chroma += 0.04;
  }
  chroma = Math.round(clamp(chroma, 0.05, 0.3) * 100) / 100;
  hue = Math.round(((hue % 360) + 360) % 360);

  const scheme = facts?.colorScheme ?? v.scheme;
  const rationale = `${v.label} brands read best with ${HUE_NAME(hue)} accents and a ${v.heading}/${v.body} pairing — a ${preset.replace(/-/g, ' ')} look, ${scheme} theme. Confirm or tweak.`;

  return {
    themeStyle: preset,
    brandHue: hue,
    brandChroma: chroma,
    fontPairing: { heading: v.heading, body: v.body },
    colorScheme: scheme,
    rationale,
    confidence,
  };
}

/** Sanitize a font family name — real font names only, no CSS/HTML injection into `font.*`. */
function safeFont(name: unknown, fallback: string): string {
  const s = String(name ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9 _-]{0,48}$/.test(s) ? s : fallback;
}

/**
 * Contract-first validation of an LLM-proposed brand kit before it is written to `_brand.json` —
 * clamps hue (0–360) + chroma (0.05–0.30), forces `themeStyle` to an allowed preset (else `classic`),
 * sanitizes font names (no injection), and validates the color scheme. Never trusts the model's raw
 * numbers or strings. Pure, never throws.
 *
 * @param proposal - the LLM's kit (unknown-shaped tolerated)
 * @param allowedPresets - the presets the template's `themeStyle` actually supports
 * @returns a safe, in-range {@link BrandKit}
 * @example validateBrandKit({ themeStyle:'evil', brandHue: 999, brandChroma: 5 }, ['classic']).themeStyle // 'classic'
 */
export function validateBrandKit(
  proposal: Partial<BrandKit> | null | undefined,
  allowedPresets: readonly PresetName[],
): BrandKit {
  const p = proposal ?? {};
  const allowed = new Set(allowedPresets.length ? allowedPresets : (['classic'] as PresetName[]));
  const themeStyle: PresetName = allowed.has(p.themeStyle as PresetName)
    ? (p.themeStyle as PresetName)
    : 'classic';
  const hue = Math.round(clamp(Number.isFinite(p.brandHue) ? (p.brandHue as number) : 210, 0, 360));
  const chroma =
    Math.round(
      clamp(Number.isFinite(p.brandChroma) ? (p.brandChroma as number) : 0.12, 0.05, 0.3) * 100,
    ) / 100;
  const scheme: ColorScheme = ['dark', 'light', 'auto'].includes(String(p.colorScheme))
    ? (p.colorScheme as ColorScheme)
    : 'auto';
  const heading = safeFont(p.fontPairing?.heading, 'Sora');
  const body = safeFont(p.fontPairing?.body, 'Inter');

  return {
    themeStyle,
    brandHue: hue,
    brandChroma: chroma,
    fontPairing: { heading, body },
    colorScheme: scheme,
    rationale: typeof p.rationale === 'string' ? p.rationale.slice(0, 240) : '',
    confidence: clamp(Number.isFinite(p.confidence) ? (p.confidence as number) : 0.5, 0, 1),
  };
}
