import {
  findFixture,
  toRegistryKey,
  registerFixtures,
  type FixtureFactory,
  type MockState,
} from './index';

/**
 * index — the fixture REGISTRY lookup. These specs pin the P1b enhancement: the
 * matcher now resolves a normalized `"<METHOD> <path>"` key against BOTH exact
 * static keys AND `:param` wildcard patterns, with EXACT keys taking precedence.
 *
 * Contract the interceptor depends on:
 *   - an exact key still matches exactly (backward-compatible — never regressed);
 *   - a `:param` pattern (`GET /sites/:id/mcp/connections`) matches ANY value in
 *     that segment (`/sites/abc/mcp/connections`) but NOT a sibling path
 *     (`/sites/abc/other`) and NOT a longer/shorter path (segment count must match);
 *   - when an exact key AND a param pattern could both match, the EXACT one wins;
 *   - an unmatched key returns `undefined` so the interceptor PASSES THROUGH to the
 *     real backend (the mock layer never breaks a real call).
 *
 * `registerFixtures` is the test seam for registering ad-hoc patterns without
 * mutating the shipped `FIXTURES` map; it returns a disposer so each spec is
 * hermetic (registered patterns are removed in `afterEach`). These specs use
 * SYNTHETIC `/_t/…` patterns that never collide with a shipped route, so they
 * exercise the matcher mechanics in isolation — shipped fixtures always win
 * (checked first), so a synthetic key can't be shadowed. (The real per-site
 * patterns are asserted in `per-site.fixture.spec.ts`.)
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

/** A trivial factory that tags its body with the pattern it was registered under. */
function tagged(tag: string): FixtureFactory<{ tag: string }> {
  return (_state: MockState, _query: URLSearchParams) => ({ tag });
}

describe('findFixture — exact + :param matching (P1b)', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('a :param pattern matches any value in that segment', () => {
    dispose = registerFixtures({
      'GET /_t/:id/leaf': tagged('mcp') as FixtureFactory,
    });
    // Different ids all hit the one param pattern.
    const a = findFixture(toRegistryKey('GET', '/api/_t/abc/leaf').key);
    const b = findFixture(toRegistryKey('GET', '/api/_t/site-001/leaf').key);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect((a!('populated', q()) as { tag: string }).tag).toBe('mcp');
    expect((b!('populated', q()) as { tag: string }).tag).toBe('mcp');
  });

  it('a :param pattern does NOT match a sibling sub-path (same prefix, different tail)', () => {
    dispose = registerFixtures({
      'GET /_t/:id/leaf': tagged('mcp') as FixtureFactory,
    });
    // same /_t/:id prefix but a different tail segment → no match → pass-through.
    expect(findFixture(toRegistryKey('GET', '/api/_t/abc/other').key)).toBeUndefined();
    expect(findFixture(toRegistryKey('GET', '/api/_t/abc/leaf/extra').key)).toBeUndefined();
    // too few segments (missing the tail) → no match.
    expect(findFixture(toRegistryKey('GET', '/api/_t/abc').key)).toBeUndefined();
  });

  it('a :param pattern is METHOD-sensitive (GET pattern never matches a DELETE)', () => {
    dispose = registerFixtures({
      'GET /_t/:id/leaf': tagged('mcp') as FixtureFactory,
    });
    expect(findFixture(toRegistryKey('DELETE', '/api/_t/abc/leaf').key)).toBeUndefined();
  });

  it('EXACT keys take precedence over a :param pattern that would also match', () => {
    dispose = registerFixtures({
      'GET /_t/:id/leaf': tagged('param') as FixtureFactory,
      'GET /_t/exact/leaf': tagged('exact') as FixtureFactory,
    });
    const hit = findFixture(toRegistryKey('GET', '/api/_t/exact/leaf').key);
    expect(hit).toBeDefined();
    // The exact key wins even though the param pattern also matches this path.
    expect((hit!('populated', q()) as { tag: string }).tag).toBe('exact');
    // A non-exact id still resolves to the param pattern.
    const other = findFixture(toRegistryKey('GET', '/api/_t/zzz/leaf').key);
    expect((other!('populated', q()) as { tag: string }).tag).toBe('param');
  });

  it('an unmatched key returns undefined (interceptor passes through to the real backend)', () => {
    dispose = registerFixtures({
      'GET /_t/:id/leaf': tagged('mcp') as FixtureFactory,
    });
    expect(findFixture('GET /totally/unknown/route')).toBeUndefined();
    expect(findFixture('POST /_t/abc/leaf')).toBeUndefined();
  });

  it('a multi-:param pattern matches each wildcard segment independently', () => {
    dispose = registerFixtures({
      'GET /_t/:siteId/sub/:table': tagged('cell') as FixtureFactory,
    });
    expect(findFixture(toRegistryKey('GET', '/api/_t/s-1/sub/customers').key)).toBeDefined();
    // both wildcards must be present — a missing tail segment is no match.
    expect(findFixture(toRegistryKey('GET', '/api/_t/s-1/sub').key)).toBeUndefined();
  });

  it('regex-special characters in a real path segment are matched literally, not as a pattern', () => {
    dispose = registerFixtures({
      'GET /_t/:id/leaf': tagged('mcp') as FixtureFactory,
    });
    // A dotted/plus id must still match the single param segment and NOT over-match.
    expect(findFixture(toRegistryKey('GET', '/api/_t/a.b+c/leaf').key)).toBeDefined();
    // A literal that resembles a wildcard in the KEY space must not match across slashes.
    expect(findFixture(toRegistryKey('GET', '/api/_tXabc/leaf').key)).toBeUndefined();
  });

  it('a shipped fixture always wins over a runtime-registered pattern of the same key', () => {
    // Register the EXACT shipped per-site pattern string — the shipped
    // mcpConnectionsFixture (checked first) must win, proving the seam never
    // shadows a shipped route. (Documents the collision the demo depends on.)
    dispose = registerFixtures({
      'GET /sites/:id/mcp/connections': tagged('override-attempt') as FixtureFactory,
    });
    const hit = findFixture(toRegistryKey('GET', '/api/sites/anything/mcp/connections').key);
    expect(hit).toBeDefined();
    const body = hit!('populated', q()) as { tag?: string; data?: { connections?: unknown[] } };
    // Shipped shape (has `data.connections`), NOT the test's `{ tag }`.
    expect(body.tag).toBeUndefined();
    expect(Array.isArray(body.data?.connections)).toBe(true);
  });
});
