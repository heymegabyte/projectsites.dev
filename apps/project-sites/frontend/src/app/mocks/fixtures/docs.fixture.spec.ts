import {
  docsOpenApiFixture,
  docsStatsFixture,
  docsAppOverviewFixture,
  type DocsOpenApiSpec,
  type DocsStatsResponse,
  type DocsAppOverviewResponse,
} from './docs.fixture';
import { toRegistryKey, findFixture, registerFixtures } from './index';

/**
 * docs.fixture — the mock bodies for the admin **Docs** explorer (`/admin/docs`). Three
 * authenticated GET reads (NO feature flag — `requireUser` only), traced to `routes/docs.ts`:
 *
 *   GET /admin/docs/openapi.json → the BARE OpenAPI 3.1 spec object (NOT a `{data}` envelope)
 *   GET /admin/docs/stats        → `{ data: DocsStats }`
 *   GET /admin/docs/app-overview → `{ data: { markdown, generated_at } }`
 *
 * These specs test the factories DIRECTLY (shape + every state + the spec↔stats internal
 * consistency the overview hero depends on) and assert the three registry keys resolve through the
 * interceptor's normalizer — including the `.json`-extension route, which `toRegistryKey` preserves.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('docsOpenApiFixture (bare OpenAPI spec, worker-contract-shaped)', () => {
  it('returns the BARE spec object (openapi/info/paths) — NOT wrapped in { data }', () => {
    const spec = docsOpenApiFixture('populated', q());
    expect((spec as unknown as { data?: unknown }).data).toBeUndefined();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Project Sites API');
    expect(typeof spec.info.version).toBe('string');
    expect(typeof spec.paths).toBe('object');
  });

  it('ships a believable multi-category surface (8+ paths across 6+ tags)', () => {
    const spec = docsOpenApiFixture('populated', q());
    const pathKeys = Object.keys(spec.paths);
    expect(pathKeys.length).toBeGreaterThanOrEqual(8);
    const tags = new Set<string>();
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) tags.add(op.tags[0]!);
    }
    expect(tags.size).toBeGreaterThanOrEqual(6);
  });

  it('exercises every rail feature: public + authed, a {param} path, a rate-limit, a request body, x-* extensions', () => {
    const spec = docsOpenApiFixture('populated', q());
    const ops = Object.values(spec.paths).flatMap((m) => Object.values(m));
    expect(ops.some((o) => o.security && o.security.length > 0)).toBe(true); // authed
    expect(ops.some((o) => !o.security)).toBe(true); // public
    expect(Object.keys(spec.paths).some((p) => /\{[^}]+\}/.test(p))).toBe(true); // {param} path
    expect(ops.some((o) => o['x-rate-limit'])).toBe(true); // rate-limited
    expect(ops.some((o) => o.requestBody)).toBe(true); // request body
    expect(ops.some((o) => o['x-category'])).toBe(true); // category
    expect(ops.some((o) => o['x-added-at'])).toBe(true); // recent-additions driver
  });

  it('a {param} path op carries a matching required path parameter', () => {
    const spec = docsOpenApiFixture('populated', q());
    for (const [path, methods] of Object.entries(spec.paths)) {
      const names = Array.from(path.matchAll(/\{([^}]+)\}/g)).map((m) => m[1]);
      if (names.length === 0) continue;
      for (const op of Object.values(methods)) {
        const paramNames = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
        for (const n of names) expect(paramNames).toContain(n!);
      }
    }
  });

  it('empty → a VALID minimal spec (one path, never path-less) so the explorer cannot crash', () => {
    const spec = docsOpenApiFixture('empty', q());
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths).length).toBe(1);
  });

  it('returns a fresh clone each call (mutating one body never corrupts the next)', () => {
    const a = docsOpenApiFixture('populated', q());
    delete (a.paths as Record<string, unknown>)[Object.keys(a.paths)[0]!];
    const b = docsOpenApiFixture('populated', q());
    expect(Object.keys(b.paths).length).toBeGreaterThan(Object.keys(a.paths).length);
  });
});

describe('docsStatsFixture (envelope { data: DocsStats }, consistent with the spec)', () => {
  it('returns the worker envelope shape { data: { total, public, authed, rate_limited, recent, category_counts } }', () => {
    const res: DocsStatsResponse = docsStatsFixture('populated', q());
    const s = res.data;
    expect(typeof s.total).toBe('number');
    expect(typeof s.public).toBe('number');
    expect(typeof s.authed).toBe('number');
    expect(typeof s.rate_limited).toBe('number');
    expect(Array.isArray(s.recent)).toBe(true);
    expect(typeof s.category_counts).toBe('object');
    expect(typeof s.generated_at).toBe('string');
  });

  it('total === the spec operation count, and public + authed === total (derived from the same source)', () => {
    const spec = docsOpenApiFixture('populated', q());
    const opCount = Object.values(spec.paths).reduce((n, m) => n + Object.keys(m).length, 0);
    const s = docsStatsFixture('populated', q()).data;
    expect(s.total).toBe(opCount);
    expect(s.public + s.authed).toBe(s.total);
  });

  it('category_counts sums to total (every op is categorized exactly once)', () => {
    const s = docsStatsFixture('populated', q()).data;
    const sum = Object.values(s.category_counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(s.total);
  });

  it('recent is ordered newest-first and every entry has an addedAt (the overview "Recent additions" block)', () => {
    const { recent } = docsStatsFixture('populated', q()).data;
    expect(recent.length).toBeGreaterThan(0);
    for (const r of recent) expect(typeof r.addedAt).toBe('string');
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i - 1]!.addedAt.localeCompare(recent[i]!.addedAt)).toBeGreaterThanOrEqual(0);
    }
  });

  it('empty → truthful minimal counters (total 1, no recent additions)', () => {
    const s = docsStatsFixture('empty', q()).data;
    expect(s.total).toBe(1);
    expect(s.public + s.authed).toBe(1);
    expect(s.recent.length).toBe(0);
  });
});

describe('docsAppOverviewFixture (envelope { data: { markdown, generated_at } })', () => {
  it('returns markdown + generated_at under { data }', () => {
    const res: DocsAppOverviewResponse = docsAppOverviewFixture('populated', q());
    expect(typeof res.data.markdown).toBe('string');
    expect(typeof res.data.generated_at).toBe('string');
    expect(res.data.markdown.length).toBeGreaterThan(50);
  });

  it('exercises the markdown renderer: an h1, an h2, a fenced code block, a bullet list, an inline link', () => {
    const md = docsAppOverviewFixture('populated', q()).data.markdown;
    expect(md).toContain('# Project Sites');
    expect(md).toContain('## ');
    expect(md).toContain('```');
    expect(md).toMatch(/^- /m);
    expect(md).toMatch(/\[[^\]]+\]\([^)]+\)/);
  });

  it('empty → a terse but valid (non-blank) stub so the overview pane never renders empty', () => {
    const md = docsAppOverviewFixture('empty', q()).data.markdown;
    expect(md.length).toBeGreaterThan(20);
    expect(md).toContain('# Project Sites');
  });
});

describe('docs fixtures — registry wiring (keys resolve through the interceptor normalizer)', () => {
  // Mirror the real registry lines so the spec is RED until index.ts merges them, then GREEN.
  let dispose: () => void;
  beforeEach(() => {
    dispose = registerFixtures({
      'GET /admin/docs/openapi.json': docsOpenApiFixture as never,
      'GET /admin/docs/stats': docsStatsFixture as never,
      'GET /admin/docs/app-overview': docsAppOverviewFixture as never,
    });
  });
  afterEach(() => dispose());

  it('GET /api/admin/docs/openapi.json resolves (the .json extension is preserved, not stripped)', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/admin/docs/openapi.json');
    expect(key).toBe('GET /admin/docs/openapi.json');
    expect(findFixture(key)).toBe(docsOpenApiFixture as never);
  });

  it('GET /api/admin/docs/stats resolves (query stripped)', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/admin/docs/stats?t=1');
    expect(key).toBe('GET /admin/docs/stats');
    expect(findFixture(key)).toBe(docsStatsFixture as never);
  });

  it('GET /api/admin/docs/app-overview resolves', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/admin/docs/app-overview');
    expect(key).toBe('GET /admin/docs/app-overview');
    expect(findFixture(key)).toBe(docsAppOverviewFixture as never);
  });
});
