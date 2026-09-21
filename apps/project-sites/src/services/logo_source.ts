/**
 * logo_source.ts — pure EXTRACTION-FIRST decision core for the site-generation logo pipeline.
 * Brian's rule: use the business's REAL logo pulled from internet records when one is available, and
 * only fall back to a gorgeous Ideogram generation when it is not — a real brand mark always beats a
 * generated one. This scores every candidate discovered from internet records (a purpose-built brand
 * endpoint like Clearbit/logo.dev, the site's apple-touch-icon / high-res favicon / og:image, the
 * SOURCE site's logo on an enhancement build, or a social avatar) and decides `extract` vs `generate`.
 * Bigger + square-ish + transparent + SVG/PNG win; tiny favicons and wide banner-photos are rejected.
 * Pure — candidates in, decision out. The pipeline does the actual fetch/generate + Ideogram call.
 * See global rule `logo-contrast` § "Extract the REAL brand logo FIRST".
 */

/** Where a candidate logo came from (drives its base suitability). */
export type LogoCandidateKind =
  | 'clearbit'
  | 'logodev'
  | 'source_site'
  | 'apple_touch_icon'
  | 'social_avatar'
  | 'og_image'
  | 'favicon'
  | 'unknown';

/** Image format of a candidate (drives scalability / alpha assumptions). */
export type LogoFormat = 'svg' | 'png' | 'webp' | 'jpg' | 'ico' | 'unknown';

/** A logo candidate discovered from internet records. */
export interface LogoCandidate {
  /** Absolute URL to fetch the asset. */
  url: string;
  /** Provenance. */
  kind: LogoCandidateKind;
  format?: LogoFormat;
  width?: number;
  height?: number;
  /** True when the asset has a transparent background (sits on any header). */
  hasAlpha?: boolean;
  bytes?: number;
  /** Free-text note about where it was found. */
  source?: string;
}

/** A scored candidate — `usable:false` means it was hard-rejected (too small / wrong kind). */
export interface ScoredLogo {
  candidate: LogoCandidate;
  score: number;
  usable: boolean;
  reason: string;
}

export type LogoDecisionKind = 'extract' | 'generate';

/** The pipeline's decision: extract the best real logo, or generate one with Ideogram. */
export interface LogoDecision {
  decision: LogoDecisionKind;
  /** The chosen candidate when `extract`; null when `generate`. */
  candidate: LogoCandidate | null;
  /** The winning candidate's score (0 when none usable). */
  score: number;
  /** Human explanation for logs/observability. */
  reason: string;
  /** Every candidate scored, best-first — useful for debugging why extraction was/ wasn't chosen. */
  ranked: ScoredLogo[];
}

/** A real brand mark at a decent size clears this; a 32px favicon or a wide og-photo does not. */
export const MIN_LOGO_SCORE = 55;
/** Anything smaller than this on its short edge is unusable as a header logo (raster only). */
const MIN_DIMENSION = 48;

const KIND_BASE: Record<LogoCandidateKind, number> = {
  clearbit: 60,
  logodev: 60,
  source_site: 56,
  apple_touch_icon: 46,
  social_avatar: 36,
  og_image: 30,
  favicon: 20,
  unknown: 10,
};

/**
 * Score one candidate for use as a header logo (0–100), or hard-reject it. Hard rejects: no URL; a
 * raster smaller than {@link MIN_DIMENSION} on its short edge; a favicon under 64px (too low-res for a
 * large header). Otherwise: base by kind, bonuses for SVG/PNG + large size + alpha + square-ish
 * aspect, penalties for JPG/ICO + extreme banner/strip ratios (usually a photo, not a mark). Pure.
 *
 * @param c - the candidate
 * @returns its {@link ScoredLogo}
 * @example scoreLogoCandidate({ url:'x', kind:'clearbit', format:'png', width:512, height:512, hasAlpha:true }).usable // true
 * @example scoreLogoCandidate({ url:'f', kind:'favicon', format:'ico', width:32, height:32 }).usable // false
 */
export function scoreLogoCandidate(c: LogoCandidate): ScoredLogo {
  if (!c || typeof c.url !== 'string' || c.url.trim() === '') {
    return { candidate: c, score: 0, usable: false, reason: 'no url' };
  }

  const w = Number.isFinite(c.width) ? (c.width as number) : undefined;
  const h = Number.isFinite(c.height) ? (c.height as number) : undefined;
  const minDim = w !== undefined && h !== undefined ? Math.min(w, h) : undefined;
  const fmt = c.format ?? 'unknown';

  if (minDim !== undefined && minDim < MIN_DIMENSION && fmt !== 'svg') {
    return { candidate: c, score: 0, usable: false, reason: `too small (${minDim}px < ${MIN_DIMENSION}px)` };
  }
  if (c.kind === 'favicon' && fmt !== 'svg' && (minDim === undefined || minDim < 64)) {
    return { candidate: c, score: 0, usable: false, reason: 'favicon too small/low-res for a large header logo' };
  }

  let score = KIND_BASE[c.kind] ?? KIND_BASE.unknown;

  if (fmt === 'svg') score += 20;
  else if (fmt === 'png') score += 8;
  else if (fmt === 'webp') score += 6;
  else if (fmt === 'jpg') score -= 8;
  else if (fmt === 'ico') score -= 5;

  if (minDim !== undefined) {
    if (minDim >= 512) score += 25;
    else if (minDim >= 256) score += 18;
    else if (minDim >= 128) score += 10;
    else if (minDim >= 64) score += 2;
  }

  if (c.hasAlpha) score += 12;

  if (w !== undefined && h !== undefined && h > 0) {
    const ratio = w / h;
    if (ratio >= 0.6 && ratio <= 1.7) score += 6; // square-ish → likely a mark
    else if (ratio > 3 || ratio < 1 / 3) score -= 8; // banner/strip → often a photo, not a logo
  }

  return { candidate: c, score: Math.max(0, Math.min(100, score)), usable: true, reason: '' };
}

/**
 * Decide whether to EXTRACT the best real logo from internet records or GENERATE one with Ideogram.
 * Scores every candidate, takes the best USABLE one, and extracts it when it clears `minScore`
 * (default {@link MIN_LOGO_SCORE}); otherwise returns `generate`. Deterministic + pure — the pipeline
 * runs the fetch or the Ideogram call based on the returned decision.
 *
 * @param candidates - logo candidates discovered from internet records (may be empty)
 * @param opts - optional score threshold override
 * @returns the {@link LogoDecision}
 * @example pickLogoSource([{ url:'x', kind:'clearbit', format:'png', width:512, height:512, hasAlpha:true }]).decision // 'extract'
 * @example pickLogoSource([]).decision // 'generate'
 * @example pickLogoSource([{ url:'f', kind:'favicon', format:'ico', width:32, height:32 }]).decision // 'generate'
 */
export function pickLogoSource(candidates: readonly LogoCandidate[], opts?: { minScore?: number }): LogoDecision {
  const minScore = opts?.minScore ?? MIN_LOGO_SCORE;
  const ranked = (candidates ?? []).map(scoreLogoCandidate).sort((a, b) => b.score - a.score);
  const best = ranked.find((r) => r.usable) ?? null;

  if (best && best.score >= minScore) {
    return {
      decision: 'extract',
      candidate: best.candidate,
      score: best.score,
      reason: `using the extracted ${best.candidate.kind} logo (score ${best.score} ≥ ${minScore})`,
      ranked,
    };
  }

  return {
    decision: 'generate',
    candidate: null,
    score: best?.score ?? 0,
    reason: best
      ? `best extracted candidate scored ${best.score} < ${minScore} — generating a logo with Ideogram instead`
      : 'no usable logo found in internet records — generating a logo with Ideogram',
    ranked,
  };
}
