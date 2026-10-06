/**
 * @module mocks/fixtures/social
 *
 * @description
 * Mock fixtures for the admin **Social** section (`pages/admin/sections/social.component.ts`
 * + its presentational sub-components: `social-accounts`, `social-post-list`,
 * `social-calendar`, `best-time-to-post`, `best-posts`, `channel-breakdown`,
 * `campaign-breakdown`). The section is the Pulse Social composer + scheduler: a
 * 3-pane layout (connected accounts · Compose/Drafts/Queue/Sent/Calendar tabs · live
 * previews). Serving these fixtures lights the whole surface on `?mock=1` with ZERO
 * backend. Each factory is typed to the EXACT worker wire shape, so wiring the real
 * endpoint later is a provider SWAP, not a rewrite — and a faithful fixture also
 * catches FE shape-drift (the campaign's prod-bug-detector property).
 *
 * **Flag-gating:** the SECTION is NOT render-gated by a feature flag. Every PRIMARY
 * GET below is auth-only (`requireAuth`, no `isFlagOn`) in `src/routes/social.ts`, so
 * the Social tab renders fully on `?mock=1` as soon as a site is selected — NO flag
 * flip needed. (Only the money/publish MUTATIONS are gated: `social_publishing_native`
 * on `/posts/publish|schedule|generate`, and the `social_publishing` / `social_autopilot`
 * kill-switches on publish-now / schedule / auto-pilot run-now — none of which fire on
 * initial render.)
 *
 * | Registry key                           | Factory                            | Worker contract (traced to `routes/social.ts`)                 |
 * | -------------------------------------- | ---------------------------------- | -------------------------------------------------------------- |
 * | `GET /social/accounts`                 | {@link socialAccountsFixture}      | `{ data: SocialAccount[] }` (`status`→`connected` derived, L158) |
 * | `GET /social/posts`                    | {@link socialPostsFixture}         | `{ data: SocialPost[] }` (acct-UUID→`platforms[]`, media previews, L398) |
 * | `GET /social/best-times`               | {@link socialBestTimesFixture}     | `{ times: string[] }` (`bestPostingTimes`, L128)               |
 * | `GET /social/auto-pilot/config`        | {@link socialAutoPilotConfigFixture}| `{ data: AutoPilotConfig & { default_prompt } }` (L666)       |
 * | `GET /social/posts/:id/analytics`      | {@link socialPostAnalyticsFixture} | `{ data: { per_platform[], totals } }` (L633)                  |
 *
 * **DEFERRED secondary routes** (NOT needed for the primary surface to render):
 * - `GET /social/analytics/aggregate` + its `best-posts` / `best-time-to-post` children —
 *   the standalone `/admin/social/analytics` route now REDIRECTS to `/admin/analytics?tab=social`
 *   (`app.routes.ts:495`), so `AdminSocialAnalyticsComponent` is no longer a reachable primary
 *   surface. (`channel-breakdown` + `campaign-breakdown` are pure presentational — no fetch.)
 * - `GET /social/mentions` (@-mention autocomplete popup — only on a keystroke in the composer),
 *   `POST /social/og-preview`, `POST /social/import-rss`, `POST /social/:siteId/posts/generate`
 *   (AI assist) — all user-triggered interactions, not initial render.
 *
 * @remarks
 * - Believable data, not lorem: a barber shop's real-looking connected accounts across
 *   several platforms (X · LinkedIn · Facebook · Instagram · Bluesky), a mix of draft /
 *   scheduled / published posts with content, ISO dates, hashtags + links, and realistic
 *   per-platform engagement numbers. Enough texture that every tab (Compose/Drafts/Queue/
 *   Sent/Calendar), the status pills, the Sent-tab stat tiles, and the calendar events render.
 * - `state` variants: `empty` → the honest brand-new-site surface (no accounts, no posts,
 *   auto-pilot off) that drives every tab's first-run empty state; `populated`/`loading`/
 *   default → the rich believable set. `error` is handled by the interceptor (it throws a
 *   500 before these run).
 * - `GET /social/posts/:id/analytics` is the only `:param` PATTERN (one body serves every
 *   demo post id); every other route is a static key. The analytics pattern is anchored so
 *   it can't shadow the exact `/social/posts` list route (exact keys win in `findFixture`).
 */
import type { FixtureFactory, MockState } from './index';
import type { PlatformId } from '../../pages/admin/sections/social-accounts.component';

/** A recent anchor so timestamps read as believable ISO strings. */
const ANCHOR = Date.parse('2026-10-06T13:00:00Z');
/** ISO string `h` hours before the anchor (negative = future). */
const iso = (hoursAgo: number): string => new Date(ANCHOR - hoursAgo * 3_600_000).toISOString();

// ───────────────────────── GET /social/accounts ─────────────────────────

/**
 * One connected account — the `social.ts` accounts projection. The worker SELECTs the
 * raw columns and derives `connected` from `status === 'active'`, so the fixture carries
 * BOTH (a faithful fixture catches the FE drift if the component ever read `status`
 * directly instead of `connected`).
 */
export interface SocialAccountRow {
  id: string;
  platform: PlatformId;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  status: string;
  last_error: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
  /** Derived by the worker: `status === 'active'`. The UI reads THIS, not `status`. */
  connected: boolean;
}

/** The `GET /api/social/accounts` envelope — `{ data }` (`social.ts:159`). */
export interface SocialAccountsResponse {
  data: SocialAccountRow[];
}

/**
 * Build a believable account row. `connected` is kept in lock-step with `status`
 * exactly as the worker derives it (`status === 'active'`).
 */
function account(
  id: string,
  platform: PlatformId,
  handle: string | null,
  displayName: string | null,
  status: string,
  opts: { hoursAgo: number; lastError?: string | null; tokenExpiresHoursAgo?: number | null } = {
    hoursAgo: 240,
  },
): SocialAccountRow {
  return {
    id,
    platform,
    handle,
    display_name: displayName,
    avatar_url: null,
    status,
    last_error: opts.lastError ?? null,
    token_expires_at:
      opts.tokenExpiresHoursAgo === undefined || opts.tokenExpiresHoursAgo === null
        ? null
        : iso(opts.tokenExpiresHoursAgo),
    created_at: iso(opts.hoursAgo),
    updated_at: iso(Math.max(0, opts.hoursAgo - 48)),
    connected: status === 'active',
  };
}

/**
 * Five believable accounts for the demo barber shop across recognizable platforms — four
 * live + one in an error state (an expired token), so the "Live"/"Off" pills, the branded
 * glyphs, and the inline per-account error all render. `account_ids` here (vn-style ids)
 * are what the posts fixture references so the composer's platform→account resolution works.
 */
const ACCOUNTS: readonly SocialAccountRow[] = [
  account('acct-tw-01', 'twitter', '@beverwyckbarber', 'Beverwyck Barber Co.', 'active', { hoursAgo: 720 }),
  account('acct-li-02', 'linkedin', 'beverwyck-barber-co', 'Beverwyck Barber Co.', 'active', { hoursAgo: 600 }),
  account('acct-fb-03', 'facebook', 'BeverwyckBarber', 'Beverwyck Barber Co.', 'active', { hoursAgo: 540 }),
  account('acct-ig-04', 'instagram', '@beverwyckbarber', 'Beverwyck Barber', 'active', { hoursAgo: 480 }),
  account('acct-bs-05', 'bluesky', '@beverwyckbarber.bsky.social', 'Beverwyck Barber', 'error', {
    hoursAgo: 300,
    lastError: 'App password expired — reconnect to resume posting.',
  }),
];

/**
 * Accounts factory. `empty` → `[]` (the honest brand-new-site "no accounts connected"
 * first-run, every platform card reading "Not connected"); `populated`/`loading`/default →
 * the believable connected roster. `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const socialAccountsFixture: FixtureFactory<SocialAccountsResponse> = (
  state: MockState,
): SocialAccountsResponse => ({
  data: state === 'empty' ? [] : ACCOUNTS.map((a) => ({ ...a })),
});

// ───────────────────────── GET /social/posts ─────────────────────────

/** One resolved media preview — the `resolveMediaPreviews` projection (`social.ts:104`). */
export interface SocialPostMedia {
  id: string;
  url: string;
  thumb_url?: string;
  alt: string;
  bytes: number;
  type: 'image' | 'video' | 'gif';
}

/**
 * A post as the UI's `SocialPost` contract — the worker resolves account UUIDs →
 * `platforms[]` and `media_keys` → signed-URL `media[]` BEFORE returning, so the fixture
 * authors the RESOLVED shape (not the raw D1 row).
 */
export interface SocialPostRow {
  id: string;
  status: 'draft' | 'scheduled' | 'published' | 'partial' | 'failed';
  scheduled_at?: string;
  published_at?: string;
  content: string;
  platforms: PlatformId[];
  media: SocialPostMedia[];
  hashtags: string[];
  link?: string;
  site_id?: string;
  per_platform_url?: Partial<Record<PlatformId, string>>;
}

/** The `GET /api/social/posts` envelope — `{ data }` (`social.ts:398`). */
export interface SocialPostsResponse {
  data: SocialPostRow[];
}

/** One believable image preview (points at the assets passthrough — renders in the demo). */
function img(id: string, alt: string): SocialPostMedia {
  return { id, url: `/assets/r2/social/${id}.jpg`, thumb_url: `/assets/r2/social/${id}.jpg`, alt, bytes: 184_320, type: 'image' };
}

/**
 * The believable post set — spans every status the list + calendar + status pills render:
 * drafts, scheduled (future-dated so the Queue + Calendar light up), and published (past-
 * dated with per-platform links so the Sent tab's analytics tiles + "View on …" links show).
 * Content reads as a real barber shop's social voice; dates bracket the anchor so the
 * calendar's current month has events.
 */
const POSTS: readonly SocialPostRow[] = [
  {
    id: 'post-001',
    status: 'draft',
    content: 'New fades, fresh looks. Book your chair this week 💈',
    platforms: ['twitter', 'instagram'],
    media: [img('fade-01', 'A sharp mid-fade haircut')],
    hashtags: ['barber', 'mensgrooming', 'njbarber'],
    site_id: 'site-001',
  },
  {
    id: 'post-002',
    status: 'draft',
    content: 'Father & son cuts are 20% off all September — bring the crew.',
    platforms: ['facebook'],
    media: [],
    hashtags: ['familytime', 'barbershop'],
    site_id: 'site-001',
  },
  {
    id: 'post-003',
    status: 'scheduled',
    scheduled_at: iso(-48), // 2 days out → Queue + Calendar
    content: 'Weekend walk-ins welcome! Doors open 9am Saturday.',
    platforms: ['twitter', 'facebook', 'instagram'],
    media: [img('shop-front', 'The barbershop storefront at golden hour')],
    hashtags: ['walkins', 'weekend'],
    link: 'https://beverwyck-barber.projectsites.dev/book',
    site_id: 'site-001',
  },
  {
    id: 'post-004',
    status: 'scheduled',
    scheduled_at: iso(-120), // 5 days out
    content: 'Meet Marcus — 12 years behind the chair and a master of the classic taper.',
    platforms: ['linkedin', 'instagram'],
    media: [img('barber-marcus', 'Marcus the barber giving a classic taper')],
    hashtags: ['meettheteam', 'craftsmanship'],
    site_id: 'site-001',
  },
  {
    id: 'post-005',
    status: 'published',
    published_at: iso(72), // 3 days ago
    scheduled_at: iso(72),
    content: 'Thank you for 500 five-star cuts this year — the chair is yours. 🙏',
    platforms: ['twitter', 'facebook', 'instagram'],
    media: [img('milestone-500', 'A celebratory 500 cuts milestone graphic')],
    hashtags: ['thankyou', 'milestone'],
    per_platform_url: {
      twitter: 'https://twitter.com/beverwyckbarber/status/1839200000000000001',
      facebook: 'https://facebook.com/BeverwyckBarber/posts/1839200000000000002',
      instagram: 'https://instagram.com/p/C_demo500/',
    },
    site_id: 'site-001',
  },
  {
    id: 'post-006',
    status: 'published',
    published_at: iso(168), // a week ago
    scheduled_at: iso(168),
    content: 'Hot-towel shaves are back by popular demand. Treat yourself.',
    platforms: ['instagram'],
    media: [img('hot-towel', 'A hot-towel straight-razor shave')],
    hashtags: ['hottowelshave', 'selfcare'],
    per_platform_url: { instagram: 'https://instagram.com/p/C_demoShave/' },
    site_id: 'site-001',
  },
];

/**
 * Posts factory. `empty` → `[]` (the "Nothing here yet" first-run in every tab);
 * `populated`/`loading`/default → the believable set. Honors `?status=` exactly as the
 * worker's optional `WHERE status = ?` filter does (the composer always loads WITHOUT a
 * filter so tab count badges are correct, but a filtered call still behaves faithfully).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 * @param query - Parsed query params (honors an optional `status` filter).
 */
export const socialPostsFixture: FixtureFactory<SocialPostsResponse> = (
  state: MockState,
  query: URLSearchParams,
): SocialPostsResponse => {
  if (state === 'empty') return { data: [] };
  const status = query.get('status');
  const rows = POSTS.filter((p) => !status || p.status === status).map((p) => ({
    ...p,
    platforms: [...p.platforms],
    media: p.media.map((m) => ({ ...m })),
    hashtags: [...p.hashtags],
    per_platform_url: p.per_platform_url ? { ...p.per_platform_url } : undefined,
  }));
  return { data: rows };
};

// ───────────────────────── GET /social/best-times ─────────────────────────

/** The `GET /api/social/best-times` envelope — `{ times }` (`social.ts:128`). */
export interface SocialBestTimesResponse {
  times: string[];
}

/**
 * Believable best-time labels, in the EXACT format the worker's `bestPostingTimes` emits
 * and the composer's `applyBestTime` regex parses (`^\w{3}\s+\d{1,2}(am|pm)` — e.g.
 * `"Tue 8am"`). Ordered, de-duped slots a real cross-platform heuristic would surface.
 */
const BEST_TIMES: readonly string[] = ['Tue 8am', 'Tue 12pm', 'Wed 9am', 'Thu 5pm', 'Fri 11am', 'Sat 10am'];

/**
 * Best-times factory. `empty` → `[]` (no selected platforms → no suggested slots, mirroring
 * the worker when `platforms` is empty); `populated`/`loading`/default → the believable slots.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const socialBestTimesFixture: FixtureFactory<SocialBestTimesResponse> = (
  state: MockState,
): SocialBestTimesResponse => ({ times: state === 'empty' ? [] : [...BEST_TIMES] });

// ───────────────────────── GET /social/auto-pilot/config ─────────────────────────

/**
 * The auto-pilot config — the `social_auto_pilot` service's `AutoPilotConfig`, plus the
 * `default_prompt` the worker ALWAYS appends so the dialog can offer "reset to default".
 */
export interface AutoPilotConfigRow {
  enabled: boolean;
  prompt: string;
  cadence_hours: number;
  target_networks: PlatformId[];
  last_run_at: number | null;
  next_run_at: number | null;
  default_prompt: string;
}

/** The `GET /api/social/auto-pilot/config` envelope — `{ data }` (`social.ts:666`). */
export interface SocialAutoPilotConfigResponse {
  data: AutoPilotConfigRow;
}

/** The worker's `DEFAULT_AUTO_PILOT_PROMPT` constant (mirrored verbatim). */
const DEFAULT_AUTO_PILOT_PROMPT =
  'You are an autonomous social media composer for {{business_name}} in the {{business_type}} industry. ' +
  'Write 1 post per platform that drives engagement without sounding AI. Use the brand voice: {{brand_voice}}. ' +
  'Reference recent business updates: {{recent_news}}. Compose for: {{target_networks}}.';

/**
 * Auto-pilot-config factory. `empty` → the worker's valid "off" default for a fresh org
 * that never configured auto-pilot (disabled, no networks, null run cursors) — still with
 * `default_prompt` so the dialog's "reset" works; `populated`/`loading`/default → a
 * believable enabled config (daily cadence across the live networks, a tuned prompt, and a
 * recent last-run + upcoming next-run so the schedule reads as live).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const socialAutoPilotConfigFixture: FixtureFactory<SocialAutoPilotConfigResponse> = (
  state: MockState,
): SocialAutoPilotConfigResponse => {
  if (state === 'empty') {
    return {
      data: {
        enabled: false,
        prompt: '',
        cadence_hours: 24,
        target_networks: [],
        last_run_at: null,
        next_run_at: null,
        default_prompt: DEFAULT_AUTO_PILOT_PROMPT,
      },
    };
  }
  return {
    data: {
      enabled: true,
      prompt:
        'Write warm, confident posts for Beverwyck Barber Co. Highlight walk-in availability, ' +
        'the team’s craftsmanship, and seasonal offers. Keep it human — no hashtags stuffing.',
      cadence_hours: 24,
      target_networks: ['twitter', 'instagram', 'facebook'],
      last_run_at: ANCHOR - 20 * 3_600_000, // ~20h ago
      next_run_at: ANCHOR + 4 * 3_600_000, // ~4h out
      default_prompt: DEFAULT_AUTO_PILOT_PROMPT,
    },
  };
};

// ───────────────────────── GET /social/posts/:id/analytics ─────────────────────────

/** One per-platform analytics row — the `social.ts:633` snapshot projection. */
export interface SocialAnalyticsRow {
  publish_id: string;
  platform: PlatformId;
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  saves: number;
  captured_at: string;
}

/** The summed totals the worker reduces from the per-platform rows. */
export interface SocialAnalyticsTotals {
  impressions: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  clicks: number;
  saves: number;
}

/** The `GET /api/social/posts/:id/analytics` envelope — `{ data: { per_platform, totals } }`. */
export interface SocialPostAnalyticsResponse {
  data: { per_platform: SocialAnalyticsRow[]; totals: SocialAnalyticsTotals };
}

/** Believable per-platform engagement for a well-performing published post. */
const ANALYTICS_ROWS: readonly SocialAnalyticsRow[] = [
  { publish_id: 'pub-001', platform: 'twitter', impressions: 4820, reach: 3610, likes: 182, comments: 24, shares: 41, clicks: 96, saves: 18, captured_at: iso(60) },
  { publish_id: 'pub-002', platform: 'facebook', impressions: 3140, reach: 2480, likes: 118, comments: 31, shares: 22, clicks: 64, saves: 9, captured_at: iso(60) },
  { publish_id: 'pub-003', platform: 'instagram', impressions: 6210, reach: 4890, likes: 402, comments: 58, shares: 73, clicks: 128, saves: 61, captured_at: iso(60) },
];

/** Sum the per-platform rows into totals exactly as the worker's reduce does. */
function sumTotals(rows: readonly SocialAnalyticsRow[]): SocialAnalyticsTotals {
  return rows.reduce(
    (a, r) => ({
      impressions: a.impressions + r.impressions,
      reach: a.reach + r.reach,
      likes: a.likes + r.likes,
      comments: a.comments + r.comments,
      shares: a.shares + r.shares,
      clicks: a.clicks + r.clicks,
      saves: a.saves + r.saves,
    }),
    { impressions: 0, reach: 0, likes: 0, comments: 0, shares: 0, clicks: 0, saves: 0 },
  );
}

/**
 * Post-analytics factory. Served under a `:param` pattern, so ONE body answers every demo
 * post id's Sent-tab prefetch. `empty` → no rows + zeroed totals (a post with no captured
 * analytics yet — the honest "measuring" state); `populated`/`loading`/default → believable
 * per-platform engagement whose totals EQUAL the row sums (internally consistent, mirroring
 * the worker's reduce).
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const socialPostAnalyticsFixture: FixtureFactory<SocialPostAnalyticsResponse> = (
  state: MockState,
): SocialPostAnalyticsResponse => {
  if (state === 'empty') {
    return { data: { per_platform: [], totals: sumTotals([]) } };
  }
  const rows = ANALYTICS_ROWS.map((r) => ({ ...r }));
  return { data: { per_platform: rows, totals: sumTotals(rows) } };
};
