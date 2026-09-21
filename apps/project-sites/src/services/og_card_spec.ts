/**
 * og_card_spec.ts — dynamic per-page branded OG/social-card layout core (feature flag
 * `dynamic_og_cards`, enabled=0, rollout=0, stage=experimental).
 *
 * Bleeding-edge source (BLEEDING-EDGE loop, 2026-09-21): Satori (HTML/CSS→SVG→PNG, edge-native,
 * framework-agnostic — runs on CF Workers, not just Vercel) makes per-page branded OG images the
 * standard for 2026 builders; the multi-tenant Kalai pattern ("each app's OG matches its own design")
 * is exactly our case. Sources: https://vercel.com/docs/og-image-generation ,
 * https://github.com/fabian-hiller/og-img . `quality-metrics` already REQUIRES an "og-image 1200×630
 * ≤100KB BRANDED CARD (not raw photo)" — this is the per-page generator that fulfills it. The owner
 * never designs a share card (embarrassingly-easy); every shared link looks premium (conversion).
 *
 * This is the PURE, safe seam: `buildOgCardSpec(page, brand)` → a typed 1200×630 layout spec (title +
 * eyebrow + brand + contrast-safe colors from `_brand.json` hue/scheme + fonts + safe logo) that the
 * Satori render route consumes. Text is sanitized to plain text with length caps (no HTML/layout
 * injection); the logo is accepted only as an https URL (the render path also SSRF-guards the fetch via
 * `safe_fetch`). Pure — inputs in, spec out; never throws.
 */

export interface OgBrandInput {
  businessName?: string;
  /** OKLCH/HSL brand hue 0–360 (from `_brand.json` color.brandHue). */
  brandHue?: number;
  colorScheme?: 'dark' | 'light' | 'auto';
  headingFont?: string;
  bodyFont?: string;
  /** Optional logo URL — included ONLY if a well-formed https URL. */
  logoUrl?: string;
  /** Site host for the footer, e.g. `acme.projectsites.dev`. */
  host?: string;
}

export interface OgPageInput {
  title?: string;
  /** Small eyebrow/category above the title, e.g. `Services`. */
  eyebrow?: string;
  /** Route path for the footer, e.g. `/services`. */
  path?: string;
}

export interface OgCardSpec {
  width: 1200;
  height: 630;
  title: string;
  eyebrow: string;
  brandName: string;
  footer: string;
  bg: string;
  fg: string;
  muted: string;
  accent: string;
  headingFont: string;
  bodyFont: string;
  logoUrl: string | null;
  /** Padding (px) that keeps content clear of platform crop. */
  safeArea: number;
}

const clampHue = (h: unknown): number => {
  const n = Number(h);
  return Number.isFinite(n) ? Math.round(((n % 360) + 360) % 360) : 210;
};

/**
 * Plain-text only: strip angle-brackets, collapse ALL whitespace (`\s` covers space/tab/newline/CR),
 * trim, cap length. Preserves ordinary punctuation (`&`, `-`, `%`, `/`, `'`, `$`, `()` …) so real
 * titles ("Q&A", "Mon-Fri", "Save $20") survive. Adds an ellipsis when the source exceeded `max`.
 */
function cleanText(v: unknown, max: number): string {
  const collapsed = String(v ?? '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const trimmed = cut.replace(/\s+\S*$/, '');
  return `${trimmed || cut}…`;
}

/** Accept ONLY a well-formed https URL with a real host (the render path SSRF-guards the actual fetch). */
function safeLogo(url: unknown): string | null {
  const s = String(url ?? '').trim();
  if (!/^https:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.hostname.includes('.') ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Build the 1200×630 branded OG card layout spec for one page from its brand tokens. Derives a
 * contrast-safe dark/light palette + a hue-driven accent, sanitizes + truncates all text, and only
 * carries a safe https logo. Deterministic + pure — never throws.
 *
 * @param page - the page's title/eyebrow/path
 * @param brand - the site's brand tokens (`_brand.json`-derived)
 * @returns the {@link OgCardSpec} the Satori renderer turns into a PNG
 * @example buildOgCardSpec({ title: 'Fresh Sourdough Daily' }, { businessName: 'Northern Lights Bakery', brandHue: 28, colorScheme: 'light' }).width // 1200
 */
export function buildOgCardSpec(page: OgPageInput, brand: OgBrandInput): OgCardSpec {
  const b = brand ?? {};
  const p = page ?? {};
  const hue = clampHue(b.brandHue);
  const scheme = b.colorScheme === 'light' ? 'light' : 'dark'; // 'auto' → dark (premium default)

  const bg = scheme === 'light' ? '#f7f7fb' : '#0b0b12';
  const fg = scheme === 'light' ? '#0b0b12' : '#f4f4ff';
  const muted = scheme === 'light' ? '#4a4a55' : '#a6a6c0';
  const accent = scheme === 'light' ? `hsl(${hue} 68% 42%)` : `hsl(${hue} 74% 60%)`;

  const host = cleanText(b.host, 48);
  const path = cleanText(p.path, 48);
  const footer = host ? `${host}${path && path !== '/' ? path : ''}` : path;

  return {
    width: 1200,
    height: 630,
    title: cleanText(p.title, 90) || cleanText(b.businessName, 90) || 'Welcome',
    eyebrow: cleanText(p.eyebrow, 40).toUpperCase(),
    brandName: cleanText(b.businessName, 42),
    footer,
    bg,
    fg,
    muted,
    accent,
    headingFont: cleanText(b.headingFont, 42) || 'Sora',
    bodyFont: cleanText(b.bodyFont, 42) || 'Inter',
    logoUrl: safeLogo(b.logoUrl),
    safeArea: 64,
  };
}
