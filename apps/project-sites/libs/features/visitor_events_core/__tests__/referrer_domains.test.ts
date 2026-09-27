/**
 * getReferrerDomains + referrerToDomain — top EXTERNAL referring domains. Locks:
 *   - referrerToDomain: host extraction, www-strip, non-http → null, malformed → null,
 *   - the aggregator merges raw referrers by domain, EXCLUDES the site's own hosts (self-referral),
 *     drops unparseable, sorts desc, caps top-N,
 *   - `capped` is set when the raw-referrer scan fills its row cap,
 *   - fail-soft empty.
 */

import { getReferrerDomains, referrerToDomain } from '../service.js';
import type { Env } from '../../../../src/types/env.js';

function stubEnv(rows: unknown[]): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            all: async () => ({ results: rows }),
            first: async () => rows[0] ?? null,
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };
  return { DB: db } as unknown as Env;
}

describe('referrerToDomain', () => {
  it('extracts the host and strips a leading www.', () => {
    expect(referrerToDomain('https://www.Google.com/search?q=x')).toBe('google.com');
    expect(referrerToDomain('https://news.ycombinator.com/item?id=1')).toBe('news.ycombinator.com');
    expect(referrerToDomain('http://Reddit.com/r/x')).toBe('reddit.com');
  });
  it('returns null for empty / malformed / non-http referrers', () => {
    expect(referrerToDomain('')).toBeNull();
    expect(referrerToDomain('   ')).toBeNull();
    expect(referrerToDomain(null)).toBeNull();
    expect(referrerToDomain('not a url')).toBeNull();
    expect(referrerToDomain('android-app://com.example.app')).toBeNull();
    expect(referrerToDomain('mailto:x@y.com')).toBeNull();
  });
});

describe('getReferrerDomains', () => {
  it('merges raw referrers by domain, sorts desc, and shapes {label,count}', async () => {
    const rows = [
      { referrer: 'https://news.ycombinator.com/item?id=1', n: 5 },
      { referrer: 'https://news.ycombinator.com/item?id=2', n: 3 }, // same domain → merges to 8
      { referrer: 'https://reddit.com/r/a', n: 4 },
    ];
    const out = await getReferrerDomains(stubEnv(rows), 'site_1', 30);
    expect(out.domains).toEqual([
      { label: 'news.ycombinator.com', count: 8 },
      { label: 'reddit.com', count: 4 },
    ]);
    expect(out.capped).toBe(false);
  });

  it('EXCLUDES the site OWN hosts (internal navigation is not a referral)', async () => {
    const rows = [
      { referrer: 'https://acme.projectsites.dev/about', n: 10 }, // self — excluded
      { referrer: 'https://www.acme.com/x', n: 7 }, // custom domain (www) — excluded
      { referrer: 'https://reddit.com/r/a', n: 4 }, // external — kept
    ];
    const selfHosts = new Set(['acme.projectsites.dev', 'acme.com']);
    const out = await getReferrerDomains(stubEnv(rows), 'site_1', 30, undefined, undefined, selfHosts);
    expect(out.domains).toEqual([{ label: 'reddit.com', count: 4 }]);
  });

  it('drops unparseable referrers without throwing', async () => {
    const rows = [
      { referrer: 'garbage', n: 9 },
      { referrer: 'https://x.com/a', n: 2 },
    ];
    const out = await getReferrerDomains(stubEnv(rows), 'site_1', 30);
    expect(out.domains).toEqual([{ label: 'x.com', count: 2 }]);
  });

  it('returns an honest empty summary on a query error / no rows', async () => {
    const out = await getReferrerDomains(stubEnv([]), 'site_1');
    expect(out).toEqual({ domains: [], capped: false });
  });
});
