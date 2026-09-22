/**
 * schema_autopilot.ts — pure decision core for the "AEO Schema Autopilot" (flag `schema_autopilot`).
 * In 2026 JSON-LD is a CITATION-eligibility signal for AI answer engines (Perplexity/Gemini/Copilot):
 * "crawlable gets you fetched; parseable gets you cited." The dominant failure is SHALLOW SCHEMA —
 * valid-but-empty or content-mismatched markup is penalized by Google AND ignored by AI engines.
 * So this decides which @types a page should emit ACCURATELY: baseline entity types always; each
 * contextual type ONLY when its citation-critical datum is real + visible on the page. It never pads
 * (FAQPage only with real visible Q&A; Product only with real products) — the exact "JSON-LD accurate
 * only, never pad, FAQPage only when real" rule (quality-metrics), as a tested function the site-gen
 * JSON-LD emitter + build_validators adopt. Pure — facts in, decision out.
 */

/** @types the autopilot can emit, most-broadly-applicable first. */
export const SCHEMA_TYPES = [
  'Organization',
  'WebSite',
  'WebPage',
  'LocalBusiness',
  'BreadcrumbList',
  'FAQPage',
  'Service',
  'Product',
  'AggregateRating',
  'Review',
  'Menu',
  'Speakable',
] as const;
export type SchemaType = (typeof SCHEMA_TYPES)[number];

/** Real, on-page facts (counts of VISIBLE content) the emitter derives from the built page. */
export interface PageFacts {
  routeDepth?: number;
  hasAddress?: boolean;
  hasPhone?: boolean;
  faqPairs?: number;
  services?: number;
  products?: number;
  reviewCount?: number;
  isFoodService?: boolean;
  menuItems?: number;
  quotableAnswer?: boolean;
}

export interface SchemaDecision {
  /** @types to emit — each backed by real, visible data. */
  emit: SchemaType[];
  /** @types deliberately WITHHELD, with why (the anti-shallow-schema record). */
  rejected: Array<{ type: SchemaType; reason: string }>;
}

/**
 * Decide the page's JSON-LD @type set — accurate-only, never padded. Baseline entity types
 * (Organization/WebSite/WebPage) always emit; every contextual type is gated on its
 * citation-critical datum being present + visible, so we never ship a valid-but-empty block
 * (the shallow-schema failure that gets penalized + never cited).
 *
 * @example selectSchemaTypes({}).emit // ['Organization','WebSite','WebPage']
 * @example selectSchemaTypes({ faqPairs: 0 }).rejected // includes FAQPage — "no real, visible Q&A pairs"
 * @example selectSchemaTypes({ hasAddress:true, hasPhone:true }).emit // + 'LocalBusiness'
 */
export function selectSchemaTypes(facts: PageFacts): SchemaDecision {
  const f = facts ?? {};
  const emit: SchemaType[] = ['Organization', 'WebSite', 'WebPage'];
  const rejected: Array<{ type: SchemaType; reason: string }> = [];

  const gate = (type: SchemaType, ok: boolean, reason: string): void => {
    if (ok) emit.push(type);
    else rejected.push({ type, reason });
  };

  gate(
    'LocalBusiness',
    !!(f.hasAddress && f.hasPhone),
    'no verified NAP (needs address + phone matching the profile)',
  );
  gate('BreadcrumbList', (f.routeDepth ?? 0) >= 2, 'route is < 2 levels deep');
  gate(
    'FAQPage',
    (f.faqPairs ?? 0) >= 1,
    'no real, visible Q&A pairs (never fabricate FAQ to add the schema)',
  );
  gate('Service', (f.services ?? 0) >= 1, 'no services listed on the page');
  gate('Product', (f.products ?? 0) >= 1, 'no products listed on the page');
  gate('AggregateRating', (f.reviewCount ?? 0) >= 1, 'no real reviews');
  gate('Review', (f.reviewCount ?? 0) >= 1, 'no real reviews');
  gate(
    'Menu',
    !!(f.isFoodService && (f.menuItems ?? 0) >= 1),
    'not a food-service vertical with a real menu',
  );
  gate('Speakable', !!f.quotableAnswer, 'no quotable-answer block on the page');

  return { emit, rejected };
}

/** True when the page carries at least one AI-answer-engine-favored citation type (FAQPage/Speakable/
 *  LocalBusiness) — a quick "is this page AEO-ready?" signal for the autopilot's admin surface. */
export function isAeoReady(decision: SchemaDecision): boolean {
  return decision.emit.some((t) => t === 'FAQPage' || t === 'Speakable' || t === 'LocalBusiness');
}
