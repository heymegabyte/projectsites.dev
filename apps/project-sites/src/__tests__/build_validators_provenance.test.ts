/**
 * validateClaimProvenance — evidence-gated provenance for social-proof claims (role 18, fire-58).
 *
 * Charter (run-the-loop role 18 / BACKLOG § template-evolution): awards / testimonials /
 * certifications / statistics / press / client-logos / case-results render ONLY with verified
 * facts. The DELIVERED build must carry the evidence (`_citations.json`) or the claim is flagged.
 * Acceptance line: "validator red on unverified award section" — award + fabricated review/rating
 * JSON-LD are ERROR severity (block under strict mode); softer classes warn in v1.
 */
import {
  validateClaimProvenance,
  validateBuild,
  CitationsFileSchema,
  type BuildFile,
} from '../services/build_validators';

const file = (path: string, text?: string, size?: number): BuildFile => ({
  path,
  text,
  size: size ?? text?.length ?? 0,
});

const shell = (body: string) =>
  file(
    'index.html',
    `<html><head><title>Acme Plumbing — Columbus plumber</title><meta name="description" content="d"></head><body><h1>Columbus plumbing done right</h1>${body}</body></html>`,
  );

const citations = (entries: unknown) => file('_citations.json', JSON.stringify(entries));

const codes = (v: { code: string }[]) => v.map((x) => x.code);

describe('validateClaimProvenance — award class (the RED acceptance class)', () => {
  it('FLAGS an award claim with NO _citations.json in the build (error severity)', () => {
    const v = validateClaimProvenance([shell('<p>Award-winning service since 2010</p>')]);
    expect(codes(v)).toContain('provenance.award_unverified');
    const award = v.find((x) => x.code === 'provenance.award_unverified')!;
    expect(award.severity).toBe('error');
    expect(award.file).toBe('index.html');
  });

  it('FLAGS "Voted best plumber" and "#1 rated" phrasings', () => {
    const v1 = validateClaimProvenance([shell('<p>Voted best plumber in Columbus</p>')]);
    expect(codes(v1)).toContain('provenance.award_unverified');
    const v2 = validateClaimProvenance([shell('<p>The #1 rated shop in Ohio</p>')]);
    expect(codes(v2)).toContain('provenance.award_unverified');
  });

  it('PASSES an award claim backed by an award citation entry', () => {
    const v = validateClaimProvenance([
      shell('<p>Award-winning service since 2010</p>'),
      citations([
        {
          claim_type: 'award',
          claim: 'Angi Super Service Award 2024',
          source: 'https://www.angi.com/companylist/acme',
        },
      ]),
    ]);
    expect(codes(v)).not.toContain('provenance.award_unverified');
  });

  it('accepts the { citations: [...] } wrapper shape too', () => {
    const v = validateClaimProvenance([
      shell('<p>Award-winning service since 2010</p>'),
      citations({
        citations: [{ claim_type: 'award', claim: 'BBB Torch Award', source: 'bbb.org listing' }],
      }),
    ]);
    expect(codes(v)).not.toContain('provenance.award_unverified');
  });

  it('dedupes to ONE violation per class across many files', () => {
    const v = validateClaimProvenance([
      shell('<p>Award-winning service</p>'),
      file('about/index.html', '<html><body><h1>About</h1><p>Award-winning team</p></body></html>'),
      file('assets/index-abc.js', 'const t="Award-winning crew";'),
    ]);
    expect(v.filter((x) => x.code === 'provenance.award_unverified')).toHaveLength(1);
  });

  it('SKIPS non-content shells (404.html) — never flags an error page', () => {
    const v = validateClaimProvenance([
      shell('<p>Honest copy</p>'),
      file('404.html', '<html><body><p>Award-winning 404</p></body></html>'),
    ]);
    expect(v).toHaveLength(0);
  });
});

describe('validateClaimProvenance — fabricated review/rating structured data (error class)', () => {
  it('FLAGS AggregateRating JSON-LD with no review evidence', () => {
    const v = validateClaimProvenance([
      shell(
        '<script type="application/ld+json">{"@type":"LocalBusiness","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.9","reviewCount":"212"}}</script>',
      ),
    ]);
    expect(codes(v)).toContain('provenance.review_schema_unverified');
    expect(v.find((x) => x.code === 'provenance.review_schema_unverified')!.severity).toBe('error');
  });

  it('FLAGS rating markup emitted from the JS bundle too', () => {
    const v = validateClaimProvenance([
      shell('<p>ok</p>'),
      file('assets/index-abc.js', 'const ld={"@type":"AggregateRating","ratingValue":4.8};'),
    ]);
    expect(codes(v)).toContain('provenance.review_schema_unverified');
  });

  it('PASSES rating markup backed by a review (or testimonial) citation', () => {
    const v = validateClaimProvenance([
      shell(
        '<script type="application/ld+json">{"@type":"AggregateRating","ratingValue":"4.9"}</script>',
      ),
      citations([
        {
          claim_type: 'review',
          claim: '4.9 stars over 212 Google reviews',
          source: 'https://maps.google.com/?cid=123',
        },
      ]),
    ]);
    expect(codes(v)).not.toContain('provenance.review_schema_unverified');
  });
});

describe('validateClaimProvenance — warn classes (press / certification / statistic / client-logo / case-result / testimonial heading)', () => {
  it('WARNS on "As seen in <publication>" press claims without press evidence', () => {
    const v = validateClaimProvenance([shell('<p>As seen in Forbes and the Dispatch</p>')]);
    const hit = v.find((x) => x.code === 'provenance.press_unverified');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warn');
  });

  it('WARNS on "certified by <org>" without certification evidence; passes with it', () => {
    const red = validateClaimProvenance([shell('<p>Certified by the National Board</p>')]);
    expect(codes(red)).toContain('provenance.certification_unverified');
    const green = validateClaimProvenance([
      shell('<p>Certified by the National Board</p>'),
      citations([
        { claim_type: 'certification', claim: 'National Board cert #123', source: 'nb.org/verify' },
      ]),
    ]);
    expect(codes(green)).not.toContain('provenance.certification_unverified');
  });

  it('WARNS on big-round-number statistics ("1,000+ happy customers", "500+ happy clients")', () => {
    const v1 = validateClaimProvenance([shell('<p>1,000+ happy customers</p>')]);
    expect(codes(v1)).toContain('provenance.statistic_unverified');
    const v2 = validateClaimProvenance([
      file('assets/index-abc.js', 'const s="500+ happy clients served";'),
      shell('<p>ok</p>'),
    ]);
    expect(codes(v2)).toContain('provenance.statistic_unverified');
  });

  it('WARNS on "Trusted by leading brands" client-logo framing; "Trusted locally" stays clean', () => {
    const red = validateClaimProvenance([shell('<p>Trusted by leading brands</p>')]);
    expect(codes(red)).toContain('provenance.client_logo_unverified');
    const green = validateClaimProvenance([shell('<p>Trusted locally</p>')]);
    expect(green).toHaveLength(0);
  });

  it('WARNS on "$2.5 million recovered" case-result claims', () => {
    const v = validateClaimProvenance([shell('<p>$2.5 million recovered for our clients</p>')]);
    expect(codes(v)).toContain('provenance.case_result_unverified');
  });

  it('WARNS on a rendered testimonial-section heading without testimonial evidence', () => {
    const v = validateClaimProvenance([
      shell('<p>ok</p>'),
      file('assets/index-abc.js', 'const h="What our customers say";'),
    ]);
    expect(codes(v)).toContain('provenance.testimonial_unverified');
  });
});

describe('validateClaimProvenance — false-positive guards (worker-seeded honest badges)', () => {
  it('NEVER flags the seeded trust-badge triads', () => {
    const v = validateClaimProvenance([
      shell('<p>Licensed &amp; insured · Free consultation · Satisfaction guaranteed</p>'),
      file(
        'assets/index-abc.js',
        'const b=["Trusted locally","Friendly service","Quality guaranteed","Free shipping over $50","Easy 30-day returns"];',
      ),
    ]);
    expect(v).toHaveLength(0);
  });
});

describe('validateClaimProvenance — malformed evidence file', () => {
  it('WARNS provenance.citations_invalid and still treats claims as unverified', () => {
    const v = validateClaimProvenance([
      shell('<p>Award-winning service</p>'),
      file('_citations.json', '{"claim_type": nope not json'),
    ]);
    expect(codes(v)).toContain('provenance.citations_invalid');
    expect(codes(v)).toContain('provenance.award_unverified');
  });

  it('WARNS provenance.citations_invalid on schema-invalid entries (bad claim_type)', () => {
    const v = validateClaimProvenance([
      shell('<p>Award-winning service</p>'),
      citations([{ claim_type: 'vibes', claim: 'x', source: 'y' }]),
    ]);
    expect(codes(v)).toContain('provenance.citations_invalid');
    expect(codes(v)).toContain('provenance.award_unverified');
  });
});

describe('CitationsFileSchema (the typed evidence contract)', () => {
  it('parses a bare array and the wrapper object; rejects entries missing source', () => {
    expect(
      CitationsFileSchema.safeParse([{ claim_type: 'award', claim: 'a', source: 's' }]).success,
    ).toBe(true);
    expect(
      CitationsFileSchema.safeParse({
        citations: [{ claim_type: 'press', claim: 'a', source: 's' }],
      }).success,
    ).toBe(true);
    expect(CitationsFileSchema.safeParse([{ claim_type: 'award', claim: 'a' }]).success).toBe(
      false,
    );
  });
});

describe('validateBuild wiring (interconnectedness — the gate RUNS in the chain)', () => {
  it('surfaces provenance.award_unverified through validateBuild and fails ok', () => {
    const report = validateBuild([shell('<p>Award-winning service since 2010</p>')]);
    expect(report.errors.map((e) => e.code)).toContain('provenance.award_unverified');
    expect(report.ok).toBe(false);
  });
});
