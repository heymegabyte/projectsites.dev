/**
 * adaptive_hero.ts — pure decision core for the "Adaptive Hero" feature (flag `adaptive_hero`).
 * The generated site's hero adapts to each visitor from CHEAP, PII-FREE edge signals (Referer,
 * UTM, a returning-visitor cookie, local hour / open-now, CF geo) — no external firmographic
 * enrichment (unlike Mutiny/Clearbit), no per-visitor tracking. The AI generates a small set of
 * hero VARIANTS at build time (each tagged with the intent it serves); this module, run in the
 * edge Worker on each request, deterministically SELECTS the best variant — it never invents copy
 * (fabrication-safe: it can only return a variant it was given, or null to fall back to the
 * static hero). Bleeding-edge source: AI website personalization / adaptive hero (the "end of
 * static websites" trend), reframed embarrassingly-easy — the owner configures nothing.
 *
 * This is the classification/selection seam only; the build-time variant generation, the Worker
 * request→signals mapping, and the template render wire into it WITHOUT changing this contract.
 */

/** Intents a hero variant can target, in fixed selection priority (highest-converting first). */
export const HERO_INTENTS = [
  'emergency',
  'after_hours',
  'returning',
  'promo',
  'local',
  'default',
] as const;
export type HeroIntent = (typeof HERO_INTENTS)[number];

/** Referrer buckets — includes an `ai` bucket for answer-engine referrals (ChatGPT/Perplexity/…). */
export type ReferrerCategory = 'google' | 'bing' | 'ai' | 'social' | 'direct' | 'other';

/** Cheap, PII-free signals a Worker derives from the request. All optional — absence is fine. */
export interface VisitorSignals {
  referrer?: ReferrerCategory;
  utmCampaign?: string;
  returning?: boolean;
  /** Business-local hour 0–23 (from the site's timezone), used only with openNow. */
  hourLocal?: number;
  /** Whether the business is open right now (from business_hours). false → after-hours intent. */
  openNow?: boolean;
  /** Caller-derived: the search/UTM text looked like an urgent need. */
  emergencyIntent?: boolean;
}

/** One AI-generated hero option. `intent` ties it to a {@link HeroIntent}; copy is build-time text. */
export interface HeroVariant {
  intent: HeroIntent;
  headline: string;
  subheadline?: string;
  ctaText?: string;
}

const SOCIAL =
  /facebook|fb\.com|instagram|twitter|x\.com|t\.co|tiktok|linkedin|pinterest|reddit|youtube/i;
const AI_ENGINE =
  /chatgpt|openai|perplexity|\bclaude\b|anthropic|gemini|bard|copilot|you\.com|phind/i;

/**
 * Bucket a `Referer` header value. Empty/absent → `direct`. Never throws.
 *
 * @param referer - the raw Referer header (may be empty/undefined)
 * @returns the referrer category
 * @example classifyReferrer('https://www.google.com/search?q=plumber') // 'google'
 * @example classifyReferrer('https://chat.openai.com/') // 'ai'
 * @example classifyReferrer('') // 'direct'
 */
export function classifyReferrer(referer: string | null | undefined): ReferrerCategory {
  const r = String(referer ?? '')
    .trim()
    .toLowerCase();
  if (!r) return 'direct';
  if (AI_ENGINE.test(r)) return 'ai';
  if (/google\./.test(r)) return 'google';
  if (/bing\.com|duckduckgo|search\.yahoo/.test(r)) return 'bing';
  if (SOCIAL.test(r)) return 'social';
  return 'other';
}

const EMERGENCY_RE =
  /\b(emergency|urgent|asap|24[\s-]?h(?:ou)?r|same[\s-]?day|broke[nd]?|burst|leak|flood|no heat|no power|lock(?:ed)?\s?out)\b/i;

/**
 * Whether a free-text signal (a search term, a UTM value) reads as an urgent need — drives the
 * highest-converting `emergency` intent. Pure keyword match; never throws.
 *
 * @example looksEmergency('emergency plumber near me') // true
 * @example looksEmergency('best bakery') // false
 */
export function looksEmergency(text: string | null | undefined): boolean {
  return EMERGENCY_RE.test(String(text ?? ''));
}

/**
 * The set of intents that APPLY to a visitor, derived from signals (unordered; selection order is
 * fixed by {@link HERO_INTENTS}). `default` always applies as the floor. Pure.
 *
 * @example deriveApplicableIntents({ returning: true }) // includes 'returning' + 'default'
 */
export function deriveApplicableIntents(signals: VisitorSignals): HeroIntent[] {
  const s = signals ?? {};
  const out = new Set<HeroIntent>(['default']);
  if (s.emergencyIntent) out.add('emergency');
  if (s.openNow === false) out.add('after_hours');
  if (s.returning) out.add('returning');
  if (s.utmCampaign && String(s.utmCampaign).trim()) out.add('promo');
  if (s.referrer === 'google' || s.referrer === 'bing' || s.referrer === 'ai') out.add('local');
  return [...out];
}

/**
 * Select the best hero variant for a visitor: the first intent in the fixed {@link HERO_INTENTS}
 * priority that BOTH applies to the visitor AND has a matching variant. Falls back to the
 * `default` variant, then the first variant. Returns `null` only when `variants` is empty — the
 * caller then renders the static hero (fail-soft; the edge never blocks a render on this).
 * Deterministic: same signals + variants → same choice. Never invents copy.
 *
 * @param signals - the visitor signals
 * @param variants - AI-generated variants (each tagged with its {@link HeroIntent})
 * @returns the chosen variant, or null when there are none
 * @example pickHeroVariant({ emergencyIntent: true }, [{intent:'default',headline:'A'},{intent:'emergency',headline:'Call now'}]) // the emergency one
 */
export function pickHeroVariant(
  signals: VisitorSignals,
  variants: readonly HeroVariant[],
): HeroVariant | null {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const applicable = new Set(deriveApplicableIntents(signals));
  for (const intent of HERO_INTENTS) {
    if (!applicable.has(intent)) continue;
    const match = variants.find((v) => v.intent === intent);
    if (match) return match;
  }
  return variants.find((v) => v.intent === 'default') ?? variants[0];
}
