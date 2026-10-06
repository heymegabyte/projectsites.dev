import {
  socialAccountsFixture,
  socialPostsFixture,
  socialBestTimesFixture,
  socialAutoPilotConfigFixture,
  socialPostAnalyticsFixture,
  type SocialAccountsResponse,
  type SocialPostsResponse,
  type SocialBestTimesResponse,
  type SocialAutoPilotConfigResponse,
  type SocialPostAnalyticsResponse,
} from './social.fixture';
import { toRegistryKey, findFixture } from './index';

/**
 * social.fixture — mock bodies for every PRIMARY GET the admin Social section
 * fires (`pages/admin/sections/social.component.ts` + its presentational
 * sub-components). Each factory is typed to the EXACT worker wire shape traced to
 * `src/routes/social.ts`, so wiring the real endpoint later is a provider SWAP,
 * not a rewrite — and a faithful fixture also catches FE shape-drift.
 *
 * This spec tests every factory DIRECTLY — envelope shape, believable data, and
 * each state variant (`empty` → honest first-run, `populated`/`loading` → rich).
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('socialAccountsFixture (GET /social/accounts → { data })', () => {
  it('returns the worker envelope { data: SocialAccount[] }', () => {
    const res: SocialAccountsResponse = socialAccountsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    const a = res.data[0]!;
    // The worker SELECTs these columns + derives `connected` from status==='active'.
    expect(typeof a.id).toBe('string');
    expect(typeof a.platform).toBe('string');
    expect(typeof a.status).toBe('string');
    expect(typeof a.connected).toBe('boolean');
    expect('handle' in a).toBe(true);
    expect('display_name' in a).toBe(true);
    expect('avatar_url' in a).toBe(true);
    expect('last_error' in a).toBe(true);
    expect('token_expires_at' in a).toBe(true);
    expect('created_at' in a).toBe(true);
    expect('updated_at' in a).toBe(true);
  });

  it('connected is consistent with status (connected ⇔ status === "active")', () => {
    for (const a of socialAccountsFixture('populated', q()).data) {
      expect(a.connected).toBe(a.status === 'active');
    }
  });

  it('populated spans multiple real platforms with ≥1 connected', () => {
    const accts = socialAccountsFixture('populated', q()).data;
    const platforms = new Set(accts.map((a) => a.platform));
    expect(platforms.size).toBeGreaterThanOrEqual(3);
    expect(accts.some((a) => a.connected)).toBe(true);
    // Every platform is a real PlatformId the UI's catalog renders.
    const known = new Set([
      'twitter', 'linkedin', 'facebook', 'instagram', 'threads',
      'bluesky', 'reddit', 'mastodon', 'discord', 'slack', 'telegram',
    ]);
    for (const p of platforms) expect(known.has(p)).toBe(true);
  });

  it('empty → [] (the honest brand-new-site "no accounts" first-run surface)', () => {
    expect(socialAccountsFixture('empty', q()).data).toEqual([]);
  });

  it('returns fresh clones (mutating one result never mutates the next)', () => {
    const first = socialAccountsFixture('populated', q()).data;
    first[0]!.handle = 'MUTATED';
    expect(socialAccountsFixture('populated', q()).data[0]!.handle).not.toBe('MUTATED');
  });
});

describe('socialPostsFixture (GET /social/posts → { data })', () => {
  it('returns the worker envelope { data: SocialPost[] } shaped for the UI contract', () => {
    const res: SocialPostsResponse = socialPostsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    const p = res.data[0]!;
    expect(typeof p.id).toBe('string');
    expect(typeof p.status).toBe('string');
    expect(typeof p.content).toBe('string');
    // The worker resolves account UUIDs → platforms[] + media previews → media[].
    expect(Array.isArray(p.platforms)).toBe(true);
    expect(Array.isArray(p.media)).toBe(true);
    expect(Array.isArray(p.hashtags)).toBe(true);
  });

  it('covers the full status machine across the demo set (draft + scheduled + published)', () => {
    const statuses = new Set(socialPostsFixture('populated', q()).data.map((p) => p.status));
    expect(statuses.has('draft')).toBe(true);
    expect(statuses.has('scheduled')).toBe(true);
    expect(statuses.has('published')).toBe(true);
  });

  it('scheduled posts carry scheduled_at; published posts carry published_at', () => {
    const posts = socialPostsFixture('populated', q()).data;
    for (const p of posts) {
      if (p.status === 'scheduled') {
        expect(typeof p.scheduled_at).toBe('string');
        expect(Number.isNaN(Date.parse(p.scheduled_at!))).toBe(false);
      }
      if (p.status === 'published') {
        expect(typeof p.published_at).toBe('string');
        expect(Number.isNaN(Date.parse(p.published_at!))).toBe(false);
      }
    }
  });

  it('every post platform is a known PlatformId (glyph lookup never misses)', () => {
    const known = new Set([
      'twitter', 'linkedin', 'facebook', 'instagram', 'threads',
      'bluesky', 'reddit', 'mastodon', 'discord', 'slack', 'telegram',
    ]);
    for (const p of socialPostsFixture('populated', q()).data) {
      expect(p.platforms.length).toBeGreaterThan(0);
      for (const plat of p.platforms) expect(known.has(plat)).toBe(true);
    }
  });

  it('empty → [] (the "Nothing here yet" first-run list in every tab)', () => {
    expect(socialPostsFixture('empty', q()).data).toEqual([]);
  });

  it('honors ?status= by returning only that status (mirrors the worker WHERE)', () => {
    const scheduled = socialPostsFixture('populated', q('status=scheduled')).data;
    expect(scheduled.length).toBeGreaterThan(0);
    expect(scheduled.every((p) => p.status === 'scheduled')).toBe(true);
  });

  it('returns fresh clones (mutating one result never mutates the next)', () => {
    const first = socialPostsFixture('populated', q()).data;
    first[0]!.content = 'MUTATED';
    expect(socialPostsFixture('populated', q()).data[0]!.content).not.toBe('MUTATED');
  });
});

describe('socialBestTimesFixture (GET /social/best-times → { times })', () => {
  it('returns the worker envelope { times: string[] }', () => {
    const res: SocialBestTimesResponse = socialBestTimesFixture('populated', q('platforms=twitter,linkedin'));
    expect(Array.isArray(res.times)).toBe(true);
    expect(res.times.length).toBeGreaterThan(0);
    for (const t of res.times) expect(typeof t).toBe('string');
  });

  it('labels parse via the composer applyBestTime regex (^\\w{3}\\s+\\d{1,2}(am|pm))', () => {
    const re = /^(\w{3})\s+(\d{1,2})(am|pm)/i;
    for (const t of socialBestTimesFixture('populated', q('platforms=twitter')).times) {
      expect(re.test(t)).toBe(true);
    }
  });

  it('empty → [] (no selected platforms → no suggested slots)', () => {
    expect(socialBestTimesFixture('empty', q()).times).toEqual([]);
  });
});

describe('socialAutoPilotConfigFixture (GET /social/auto-pilot/config → { data })', () => {
  it('returns the worker envelope { data: AutoPilotConfig & { default_prompt } }', () => {
    const res: SocialAutoPilotConfigResponse = socialAutoPilotConfigFixture('populated', q());
    const d = res.data;
    expect(typeof d.enabled).toBe('boolean');
    expect(typeof d.prompt).toBe('string');
    expect(typeof d.cadence_hours).toBe('number');
    expect(Array.isArray(d.target_networks)).toBe(true);
    expect('last_run_at' in d).toBe(true);
    expect('next_run_at' in d).toBe(true);
    // The worker ALWAYS appends default_prompt so the dialog can "reset to default".
    expect(typeof d.default_prompt).toBe('string');
    expect(d.default_prompt.length).toBeGreaterThan(0);
  });

  it('empty → a valid "off" default (fresh org, never configured)', () => {
    const d = socialAutoPilotConfigFixture('empty', q()).data;
    expect(d.enabled).toBe(false);
    expect(d.target_networks).toEqual([]);
    expect(d.last_run_at).toBeNull();
    expect(d.next_run_at).toBeNull();
    // default_prompt is present even on the off default.
    expect(d.default_prompt.length).toBeGreaterThan(0);
  });

  it('populated target_networks are all known PlatformIds', () => {
    const known = new Set([
      'twitter', 'linkedin', 'facebook', 'instagram', 'threads',
      'bluesky', 'reddit', 'mastodon', 'discord', 'slack', 'telegram',
    ]);
    for (const p of socialAutoPilotConfigFixture('populated', q()).data.target_networks) {
      expect(known.has(p)).toBe(true);
    }
  });
});

describe('socialPostAnalyticsFixture (GET /social/posts/:id/analytics → { data })', () => {
  it('returns the worker envelope { data: { per_platform[], totals } }', () => {
    const res: SocialPostAnalyticsResponse = socialPostAnalyticsFixture('populated', q());
    expect(Array.isArray(res.data.per_platform)).toBe(true);
    const row = res.data.per_platform[0]!;
    // The UI reads impressions/likes/shares/clicks per row (sent-tab stat tiles).
    for (const k of ['impressions', 'likes', 'shares', 'clicks'] as const) {
      expect(typeof row[k]).toBe('number');
    }
    expect(typeof row.platform).toBe('string');
    const t = res.data.totals;
    for (const k of ['impressions', 'reach', 'likes', 'comments', 'shares', 'clicks', 'saves'] as const) {
      expect(typeof t[k]).toBe('number');
    }
  });

  it('totals equal the sum of the per_platform rows (internally consistent)', () => {
    const { per_platform, totals } = socialPostAnalyticsFixture('populated', q()).data;
    const sum = per_platform.reduce((a, r) => a + r.impressions, 0);
    expect(totals.impressions).toBe(sum);
  });

  it('empty → no rows + zeroed totals (a post with no captured analytics yet)', () => {
    const { per_platform, totals } = socialPostAnalyticsFixture('empty', q()).data;
    expect(per_platform).toEqual([]);
    expect(totals).toEqual({
      impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, clicks: 0, saves: 0,
    });
  });
});

describe('social fixtures — registry wiring (findFixture resolves every primary route)', () => {
  it('GET /api/social/accounts → socialAccountsFixture', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/social/accounts?site_id=abc');
    expect(key).toBe('GET /social/accounts');
    expect(findFixture(key)).toBe(socialAccountsFixture as unknown as typeof socialAccountsFixture);
  });

  it('GET /api/social/posts → socialPostsFixture', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/social/posts?site_id=abc');
    expect(key).toBe('GET /social/posts');
    expect(findFixture(key)).toBeDefined();
  });

  it('GET /api/social/best-times → socialBestTimesFixture', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/social/best-times?platforms=twitter');
    expect(key).toBe('GET /social/best-times');
    expect(findFixture(key)).toBeDefined();
  });

  it('GET /api/social/auto-pilot/config → socialAutoPilotConfigFixture', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/social/auto-pilot/config');
    expect(key).toBe('GET /social/auto-pilot/config');
    expect(findFixture(key)).toBeDefined();
  });

  it('GET /api/social/posts/:id/analytics → socialPostAnalyticsFixture (:param pattern)', () => {
    const { key } = toRegistryKey('GET', 'https://projectsites.dev/api/social/posts/post-123/analytics');
    expect(key).toBe('GET /social/posts/post-123/analytics');
    expect(findFixture(key)).toBeDefined();
  });

  it('the :param analytics pattern does NOT shadow the exact /social/posts list route', () => {
    // Exact key must win over the param pattern so the list route stays correct.
    const listKey = toRegistryKey('GET', 'https://projectsites.dev/api/social/posts').key;
    expect(findFixture(listKey)).toBe(
      socialPostsFixture as unknown as ReturnType<typeof findFixture>,
    );
  });
});
