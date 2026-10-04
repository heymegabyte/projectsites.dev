/**
 * CRAWL-0 unit coverage — the provider-independent crawl DOMAIN.
 *
 * Proves the Zod boundary (CrawlRequest validity + mode default + url requirement),
 * the coverage-status enum, and that the Cloudflare provider SATISFIES the port
 * surface. Pure (no mocks, no env) — the CF engine wiring is exercised in
 * `provider.test.ts` (CRAWL-1). This repo transforms tests with @swc/jest using the
 * GLOBAL `jest`; no import needed.
 */
import {
  CrawlRequestSchema,
  CoverageStatusSchema,
  CrawlModeSchema,
  CrawlStatusSchema,
  LinkKindSchema,
} from '../schemas';
import { CloudflareCrawlProvider } from '../provider';

describe('CrawlRequestSchema', () => {
  it('accepts a bare {url} and defaults mode to "auto"', () => {
    const parsed = CrawlRequestSchema.parse({ url: 'https://example.com' });
    expect(parsed.mode).toBe('auto');
    expect(parsed.url).toBe('https://example.com');
  });

  it('accepts all three render modes', () => {
    for (const mode of ['fast', 'auto', 'rendered'] as const) {
      const parsed = CrawlRequestSchema.parse({ url: 'https://example.com', mode });
      expect(parsed.mode).toBe(mode);
    }
  });

  it('rejects an invalid mode enum value', () => {
    const r = CrawlRequestSchema.safeParse({ url: 'https://example.com', mode: 'turbo' });
    expect(r.success).toBe(false);
  });

  it('requires url — missing url fails', () => {
    const r = CrawlRequestSchema.safeParse({ mode: 'fast' } as unknown as CrawlRequest);
    expect(r.success).toBe(false);
  });

  it('requires url to be a valid absolute URL', () => {
    const r = CrawlRequestSchema.safeParse({ url: 'not-a-url' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown keys (.strict boundary)', () => {
    const r = CrawlRequestSchema.safeParse({ url: 'https://example.com', rogue: true });
    expect(r.success).toBe(false);
  });

  it('carries optional crawl controls when supplied', () => {
    const parsed = CrawlRequestSchema.parse({
      url: 'https://example.com',
      limit: 100,
      depth: 3,
      includeSubdomains: true,
      includeExternalLinks: true,
      includePatterns: ['/blog/*'],
      excludePatterns: ['/admin/*'],
      freshness: 3600,
      force: true,
    });
    expect(parsed.limit).toBe(100);
    expect(parsed.includePatterns).toEqual(['/blog/*']);
    expect(parsed.force).toBe(true);
  });

  it('rejects a non-positive limit and an over-ceiling limit', () => {
    expect(CrawlRequestSchema.safeParse({ url: 'https://e.com', limit: 0 }).success).toBe(false);
    expect(CrawlRequestSchema.safeParse({ url: 'https://e.com', limit: 99999 }).success).toBe(
      false,
    );
  });
});

describe('crawl enums', () => {
  it('CoverageStatusSchema accepts the five reconciliation outcomes', () => {
    for (const s of ['complete', 'partial', 'blocked', 'budget_exhausted', 'failed'] as const) {
      expect(CoverageStatusSchema.parse(s)).toBe(s);
    }
  });

  it('CoverageStatusSchema rejects an unknown status', () => {
    expect(CoverageStatusSchema.safeParse('done').success).toBe(false);
  });

  it('CrawlStatusSchema accepts the full job lifecycle including partial + budget_exhausted', () => {
    for (const s of [
      'queued',
      'running',
      'completed',
      'partial',
      'blocked',
      'budget_exhausted',
      'failed',
      'cancelled',
    ] as const) {
      expect(CrawlStatusSchema.parse(s)).toBe(s);
    }
  });

  it('CrawlModeSchema + LinkKindSchema reject bad values', () => {
    expect(CrawlModeSchema.safeParse('full').success).toBe(false);
    expect(LinkKindSchema.safeParse('sibling').success).toBe(false);
    expect(LinkKindSchema.parse('internal')).toBe('internal');
    expect(LinkKindSchema.parse('external')).toBe('external');
  });
});

describe('CloudflareCrawlProvider (CRAWL-1 port surface)', () => {
  // Construct with a minimal env stub — no network here; CF wiring is covered in provider.test.ts.
  const env = { CF_ACCOUNT_ID: 'acct' } as unknown as ConstructorParameters<
    typeof CloudflareCrawlProvider
  >[0];
  const p = new CloudflareCrawlProvider(env);

  it('implements the four CrawlProvider methods (no longer throws CRAWL-1)', () => {
    expect(typeof p.start).toBe('function');
    expect(typeof p.status).toBe('function');
    expect(typeof p.results).toBe('function');
    expect(typeof p.cancel).toBe('function');
  });
});
