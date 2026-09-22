/**
 * Tests for the AEO Schema Autopilot pure core (flag `schema_autopilot`).
 * Focus: baseline entity types always emit; every contextual type is accuracy-gated (emitted ONLY
 * with real, visible data) — the anti-"shallow schema" guarantee. Never pads (FAQPage/Product only
 * when real), and records WHY each withheld type was withheld.
 */
import { selectSchemaTypes, isAeoReady, SCHEMA_TYPES } from '../services/schema_autopilot.js';

const rejectedTypes = (d: ReturnType<typeof selectSchemaTypes>) => d.rejected.map((r) => r.type);

describe('schema_autopilot: baseline', () => {
  it('always emits Organization + WebSite + WebPage, even with no facts', () => {
    const d = selectSchemaTypes({});
    expect(d.emit).toEqual(['Organization', 'WebSite', 'WebPage']);
  });
  it('withholds every contextual type without data (never shallow-schema)', () => {
    const rej = rejectedTypes(selectSchemaTypes({}));
    for (const t of [
      'LocalBusiness',
      'FAQPage',
      'Service',
      'Product',
      'AggregateRating',
      'Review',
      'Menu',
      'Speakable',
    ]) {
      expect(rej).toContain(t);
    }
  });
  it('every withheld type carries a reason', () => {
    expect(
      selectSchemaTypes({}).rejected.every(
        (r) => typeof r.reason === 'string' && r.reason.length > 0,
      ),
    ).toBe(true);
  });
});

describe('schema_autopilot: accuracy gates', () => {
  it('LocalBusiness needs BOTH address and phone (NAP)', () => {
    expect(selectSchemaTypes({ hasAddress: true, hasPhone: true }).emit).toContain('LocalBusiness');
    expect(selectSchemaTypes({ hasAddress: true }).emit).not.toContain('LocalBusiness');
  });
  it('FAQPage only with real, visible Q&A — never padded', () => {
    expect(selectSchemaTypes({ faqPairs: 0 }).emit).not.toContain('FAQPage');
    expect(selectSchemaTypes({ faqPairs: 2 }).emit).toContain('FAQPage');
  });
  it('Product only with real products', () => {
    expect(selectSchemaTypes({ products: 0 }).emit).not.toContain('Product');
    expect(selectSchemaTypes({ products: 3 }).emit).toContain('Product');
  });
  it('Review + AggregateRating only with real reviews', () => {
    const none = selectSchemaTypes({ reviewCount: 0 }).emit;
    expect(none).not.toContain('Review');
    expect(none).not.toContain('AggregateRating');
    const some = selectSchemaTypes({ reviewCount: 7 }).emit;
    expect(some).toContain('Review');
    expect(some).toContain('AggregateRating');
  });
  it('Menu needs a food-service vertical AND real menu items', () => {
    expect(selectSchemaTypes({ isFoodService: true, menuItems: 12 }).emit).toContain('Menu');
    expect(selectSchemaTypes({ isFoodService: false, menuItems: 12 }).emit).not.toContain('Menu');
    expect(selectSchemaTypes({ isFoodService: true, menuItems: 0 }).emit).not.toContain('Menu');
  });
  it('BreadcrumbList needs a route ≥ 2 levels deep', () => {
    expect(selectSchemaTypes({ routeDepth: 1 }).emit).not.toContain('BreadcrumbList');
    expect(selectSchemaTypes({ routeDepth: 2 }).emit).toContain('BreadcrumbList');
  });
});

describe('schema_autopilot: isAeoReady', () => {
  it('true when a citation-favored type is emitted, false for baseline-only', () => {
    expect(isAeoReady(selectSchemaTypes({}))).toBe(false);
    expect(isAeoReady(selectSchemaTypes({ faqPairs: 3 }))).toBe(true);
    expect(isAeoReady(selectSchemaTypes({ hasAddress: true, hasPhone: true }))).toBe(true);
  });
  it('only lists real Schema.org types', () => {
    for (const t of selectSchemaTypes({ hasAddress: true, hasPhone: true, faqPairs: 2 }).emit) {
      expect(SCHEMA_TYPES).toContain(t);
    }
  });
});
