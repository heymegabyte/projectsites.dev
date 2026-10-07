/**
 * @module mocks/fixtures/snapshots
 *
 * @description
 * Mock fixtures for the Snapshots admin section's THREE richer per-site GET reads that the
 * list + metrics-grid fixtures (`per-site.fixture.ts` — `snapshotsListFixture` + `snapshotMetricsFixture`,
 * already wired) do NOT cover. Each is fired by a drill-in action on a snapshot ROW (or the diff
 * viewer), traced to its worker handler for the EXACT envelope:
 *
 * | Route                                            | Factory                     | Fired by (admin surface)                              | Worker handler                                          |
 * | ------------------------------------------------ | --------------------------- | ----------------------------------------------------- | ------------------------------------------------------- |
 * | `GET /sites/:id/snapshots/:snapshotId/metrics`   | {@link snapshotMetricFixture} | Snapshots row — "toggle metrics" + capture-poll       | `snapshotQuality` `src/routes/snapshot_quality.ts`      |
 * | `GET /sites/:id/snapshots/:snapId/download`      | {@link snapshotDownloadFixture} | Snapshots row — "Download .zip" (→ manifest → jszip)  | `siteVersioning` `libs/features/site_versioning/…`      |
 * | `GET /sites/:id/snapshots/diff`                  | {@link snapshotDiffFixture} | Snapshot-diff viewer (`/admin/snapshots/diff`)         | `siteVersioning` `libs/features/site_versioning/…`      |
 *
 * @remarks
 * - **NO feature flag.** Both worker surfaces (`snapshotQuality` + `siteVersioning`) mount
 *   directly in `index.ts` with NO `requireFlag` guard — they are auth-only (orgId required →
 *   cross-org collapses to 404). Unlike the sibling sparkline/readiness cards (flag-gated), these
 *   three are always live for an authed owner, so the demo serves populated data unconditionally.
 * - **`:param` PATTERN keys** (see {@link import('./index').FIXTURES}) so ONE fixture serves EVERY
 *   site+snapshot id. Both drill-in keys are 5-segment (`…/snapshots/:snapshotId/metrics`,
 *   `…/snapshots/:snapId/download`); the diff key is a 4-segment LITERAL (`…/snapshots/diff`). None
 *   can shadow — nor be shadowed by — the already-wired `GET /sites/:id/snapshots` (3 seg) or
 *   `GET /sites/:id/snapshots/metrics` (4 seg, literal `metrics`): the matcher anchors each regex
 *   (`^…$`, one `[^/]+` per `:param`) and an EXACT/literal final segment never matches a different
 *   literal, so `diff` ≠ `metrics` and the `:snapshotId/metrics` 5-seg pattern can't match the
 *   4-seg grid key. (Verified against source — the worker param names `:snapshotId` vs `:snapId`
 *   are cosmetic; the registry matcher only cares about segment COUNT + literals.)
 * - Each returns the EXACT worker wire shape so wiring the real endpoint later is a provider SWAP.
 *   The interceptor owns realistic latency + the `error` short-circuit.
 * - The data is deliberately CONSISTENT with `snapshotsListFixture`'s two rows (`snap-001` =
 *   "initial" v1, `snap-002` = "warmer-hero-and-booking-cta" v2): the metrics fixture scores v2,
 *   the download fixture manifests v2's files, and the diff fixture compares v1 → v2 — so a demo
 *   that opens a row and then its diff reads as one coherent story, never three unrelated mocks.
 */
import type { FixtureFactory, MockState } from './index';

/** A recent anchor so the fixtures' ISO timestamps read as believable (mirrors per-site.fixture). */
const SNAP_ANCHOR = Date.parse('2026-10-06T13:00:00Z');
const snapIso = (hoursAgo: number): string =>
  new Date(SNAP_ANCHOR - hoursAgo * 3_600_000).toISOString();

// ═══════════ GET /sites/:id/snapshots/:snapshotId/metrics ═══════════
// Single-snapshot quality metrics — the Lighthouse + axe + vision row behind a snapshot's
// expandable "metrics" matrix (and the capture-poll's success read). The worker returns
// `{ data: MetricsRow & { screenshot_url } }` when a row exists, or `{ data: null, status:
// 'pending' }` when the quality scan hasn't run yet (snapshot_quality.ts).

/**
 * One snapshot's metrics row — mirrors the worker's `MetricsRow` (a `SELECT *` from
 * `snapshot_metrics`) PLUS the `screenshot_url` the handler appends. Every Lighthouse /
 * CWV / axe / vision field is nullable (a snapshot may predate the metrics feature, or a
 * single Lighthouse dimension may have errored). The frontend `SnapshotMetrics` interface
 * reads a subset — the extra `id`/`snapshot_id`/`site_id`/`captured_via`/`duration_ms` keys
 * are harmless (they're on the `SELECT *` wire).
 */
export interface SnapshotMetricRow {
  id: string;
  snapshot_id: string;
  site_id: string;
  lh_performance: number | null;
  lh_accessibility: number | null;
  lh_best_practices: number | null;
  lh_seo: number | null;
  lh_pwa: number | null;
  lcp_ms: number | null;
  fcp_ms: number | null;
  tbt_ms: number | null;
  cls: number | null;
  inp_ms: number | null;
  si_ms: number | null;
  page_size_bytes: number | null;
  asset_count: number | null;
  request_count: number | null;
  dom_node_count: number | null;
  jsonld_block_count: number | null;
  title_chars: number | null;
  meta_desc_chars: number | null;
  h1_count: number | null;
  internal_links: number | null;
  outbound_links: number | null;
  axe_violations: number | null;
  axe_critical: number | null;
  axe_serious: number | null;
  contrast_failures: number | null;
  target_size_failures: number | null;
  screenshot_r2_key: string | null;
  vision_overall: number | null;
  vision_scores_json: string | null;
  vision_notes: string | null;
  vision_model: string | null;
  captured_at: string;
  captured_via: string;
  duration_ms: number | null;
  error: string | null;
  /** Appended by the handler from `screenshot_r2_key` — the worker-served proxy URL (never raw R2). */
  screenshot_url: string | null;
}

/**
 * The `GET /api/sites/:siteId/snapshots/:snapshotId/metrics` envelope. The worker returns
 * `{ data: MetricsRow & { screenshot_url } }` on a hit, or `{ data: null, status: 'pending' }`
 * when no metrics row exists yet (the capture pipeline hasn't finished). The `status` key is
 * ONLY present on the pending branch — modelled as optional here to match the discriminated wire.
 */
export interface SnapshotMetricResponse {
  data: SnapshotMetricRow | null;
  status?: 'pending';
}

/**
 * A believable, mostly-green metrics row for the v2 snapshot — a well-built small-business site:
 * strong Lighthouse (perf 96 / a11y 100 / SEO 100), healthy CWV (LCP 1.8s, CLS 0.02, INP 90ms),
 * zero axe violations, and a high Llama-4 Scout vision score with a written critique. The
 * `vision_scores_json` is the 6-axis blob the radar component parses.
 */
const METRIC_ROW: SnapshotMetricRow = {
  id: 'metric-002',
  snapshot_id: 'snap-002',
  site_id: 'site-001',
  lh_performance: 96,
  lh_accessibility: 100,
  lh_best_practices: 100,
  lh_seo: 100,
  lh_pwa: 90,
  lcp_ms: 1820,
  fcp_ms: 940,
  tbt_ms: 60,
  cls: 0.02,
  inp_ms: 90,
  si_ms: 1550,
  page_size_bytes: 1_245_000,
  asset_count: 28,
  request_count: 34,
  dom_node_count: 612,
  jsonld_block_count: 4,
  title_chars: 56,
  meta_desc_chars: 148,
  h1_count: 1,
  internal_links: 14,
  outbound_links: 3,
  axe_violations: 0,
  axe_critical: 0,
  axe_serious: 0,
  contrast_failures: 0,
  target_size_failures: 0,
  screenshot_r2_key: 'snapshots/site-001/snap-002/screenshot.png',
  vision_overall: 9,
  vision_scores_json: JSON.stringify({
    layout: 9,
    typography: 9,
    color: 8,
    imagery: 9,
    hierarchy: 9,
    polish: 9,
  }),
  vision_notes:
    'Confident, warm hero with a clear booking CTA above the fold; type hierarchy is crisp and the palette reads premium. Minor: the testimonial section could use one more line of breathing room.',
  vision_model: '@cf/meta/llama-4-scout-17b-16e-instruct',
  captured_at: snapIso(47),
  captured_via: 'on_demand',
  duration_ms: 18_400,
  // No dimension errored on this capture (a clean run).
  error: null,
  // The worker's `screenshot_url` is the proxy path, NOT the raw R2 key.
  screenshot_url: '/api/sites/site-001/snapshots/snap-002/screenshot.png',
};

/**
 * Single-snapshot metrics factory. `empty` → `{ data: null, status: 'pending' }` (the honest
 * "no quality scan yet → Capture button" state the worker returns pre-capture); `populated` /
 * `loading` / default → the believable mostly-green metrics row (fresh clone each call). `error`
 * is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const snapshotMetricFixture: FixtureFactory<SnapshotMetricResponse> = (
  state: MockState,
): SnapshotMetricResponse =>
  state === 'empty' ? { data: null, status: 'pending' } : { data: { ...METRIC_ROW } };

// ═══════════ GET /sites/:id/snapshots/:snapId/download ═══════════
// Download manifest — the JSON list of a snapshot's R2 files (public URLs) the row's
// "Download .zip" action fetches before lazy-loading jszip to assemble the bundle client-side.
// The worker returns `{ data: { snapshot_id, build_version, generated_at, expires_at, files } }`
// (site_versioning handlers.ts) — a manifest, NOT a server-side zip.

/** One file in the download manifest — mirrors the worker's per-object projection. */
export interface SnapshotDownloadFile {
  key: string;
  size: number;
  etag: string;
  content_type: string | null;
  url: string;
}

/** The `{ data }` body of the download manifest. */
export interface SnapshotDownloadBody {
  snapshot_id: string;
  build_version: string;
  generated_at: string;
  expires_at: string;
  files: SnapshotDownloadFile[];
}

/** The `GET /api/sites/:id/snapshots/:snapId/download` envelope — the worker wraps it in `{ data }`. */
export interface SnapshotDownloadResponse {
  data: SnapshotDownloadBody;
}

/** The public site base the worker builds each file `url` from (`https://{slug}{SITES_SUFFIX}`). */
const SITE_BASE = 'https://beverwyck-barber.projectsites.dev';

/**
 * A believable file set for the v2 build — the shell + a hashed JS/CSS bundle, the favicon set,
 * SEO/PWA required files, and a hero image. `url` is the public R2 site URL the browser fetches
 * (the bucket is public for site-serving); `etag`/`size`/`content_type` mirror real R2 objects.
 */
const DOWNLOAD_FILES: readonly SnapshotDownloadFile[] = [
  { key: 'index.html', size: 24_118, etag: '"a1b2c3d4e5f60718"', content_type: 'text/html', url: `${SITE_BASE}/index.html` },
  { key: 'assets/index-8f2a1c.js', size: 184_552, etag: '"b2c3d4e5f6071829"', content_type: 'text/javascript', url: `${SITE_BASE}/assets/index-8f2a1c.js` },
  { key: 'assets/index-3d9e4b.css', size: 42_990, etag: '"c3d4e5f607182930"', content_type: 'text/css', url: `${SITE_BASE}/assets/index-3d9e4b.css` },
  { key: 'assets/hero-chair.webp', size: 96_220, etag: '"d4e5f60718293041"', content_type: 'image/webp', url: `${SITE_BASE}/assets/hero-chair.webp` },
  { key: 'favicon.ico', size: 15_086, etag: '"e5f6071829304152"', content_type: 'image/x-icon', url: `${SITE_BASE}/favicon.ico` },
  { key: 'apple-touch-icon.png', size: 18_440, etag: '"f607182930415263"', content_type: 'image/png', url: `${SITE_BASE}/apple-touch-icon.png` },
  { key: 'site.webmanifest', size: 612, etag: '"0718293041526374"', content_type: 'application/manifest+json', url: `${SITE_BASE}/site.webmanifest` },
  { key: 'robots.txt', size: 142, etag: '"1829304152637485"', content_type: 'text/plain', url: `${SITE_BASE}/robots.txt` },
  { key: 'sitemap.xml', size: 988, etag: '"2930415263748596"', content_type: 'application/xml', url: `${SITE_BASE}/sitemap.xml` },
];

/**
 * Download-manifest factory. `empty` → a manifest with an EMPTY `files` list (the worker's shape
 * when a snapshot's R2 prefix is empty → the component's "This snapshot has no files to download"
 * toast); `populated` / `loading` / default → the v2 build's believable file set (fresh clones).
 * `generated_at` is now-ish, `expires_at` is +1h (mirrors the handler). `error` is handled by the
 * interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const snapshotDownloadFixture: FixtureFactory<SnapshotDownloadResponse> = (
  state: MockState,
): SnapshotDownloadResponse => ({
  data: {
    snapshot_id: 'snap-002',
    build_version: 'v2',
    generated_at: snapIso(0),
    expires_at: new Date(SNAP_ANCHOR + 3_600_000).toISOString(),
    files: state === 'empty' ? [] : DOWNLOAD_FILES.map((f) => ({ ...f })),
  },
});

// ═══════════ GET /sites/:id/snapshots/diff?from=A&to=B ═══════════
// Side-by-side file diff between two snapshots + a best-effort AI summary. The diff viewer
// (`/admin/snapshots/diff`) reads `{ from, to, added, removed, modified, summary }` — a BARE
// object, NOT `{ data }` (site_versioning handlers.ts). Added/removed carry PlainFile; modified
// carries line hunks the viewer paints red/green.

/** One line hunk in a modified file's diff (mirrors `diff.diffLines()` output). */
export interface DiffHunk {
  added: boolean;
  removed: boolean;
  value: string;
}

/** An added/removed file — contents inlined for text, `binary:true` (empty contents) otherwise. */
export interface DiffPlainFile {
  path: string;
  contents: string;
  binary: boolean;
  truncated: boolean;
}

/** A modified file — before/after + the computed line hunks. */
export interface DiffModifiedFile {
  path: string;
  before: string;
  after: string;
  hunks: DiffHunk[];
  truncated: boolean;
}

/** One side of the compare (the snapshot's id + name + build version). */
export interface DiffEndpoint {
  id: string;
  name: string;
  build_version: string;
}

/** The `GET /api/sites/:siteId/snapshots/diff` envelope — a BARE object (NOT `{ data }`). */
export interface SnapshotDiffResponse {
  from: DiffEndpoint;
  to: DiffEndpoint;
  added: DiffPlainFile[];
  removed: DiffPlainFile[];
  modified: DiffModifiedFile[];
  summary: string;
}

/** A believable v1 → v2 diff: one added section component, one removed legacy asset, one modified shell. */
const DIFF_ADDED: readonly DiffPlainFile[] = [
  {
    path: 'src/components/BookingCta.tsx',
    contents:
      "export function BookingCta() {\n  return (\n    <a href=\"#book\" className=\"booking-cta\">\n      Book your chair\n    </a>\n  );\n}\n",
    binary: false,
    truncated: false,
  },
];

const DIFF_REMOVED: readonly DiffPlainFile[] = [
  { path: 'public/hero-old.jpg', contents: '', binary: true, truncated: false },
];

const DIFF_MODIFIED: readonly DiffModifiedFile[] = [
  {
    path: 'index.html',
    before: '<h1 class="hero">Beverwyck Barber</h1>\n<p>Walk-ins welcome.</p>\n',
    after: '<h1 class="hero hero--warm">Beverwyck Barber</h1>\n<p>Walk-ins welcome.</p>\n<a href="#book">Book now</a>\n',
    hunks: [
      { added: false, removed: true, value: '<h1 class="hero">Beverwyck Barber</h1>\n' },
      { added: true, removed: false, value: '<h1 class="hero hero--warm">Beverwyck Barber</h1>\n' },
      { added: false, removed: false, value: '<p>Walk-ins welcome.</p>\n' },
      { added: true, removed: false, value: '<a href="#book">Book now</a>\n' },
    ],
    truncated: false,
  },
];

/**
 * Snapshot-diff factory. `empty` → an IDENTICAL diff (no added/removed/modified, empty summary →
 * the viewer's "Snapshots are identical — no file changes detected" state); `populated` /
 * `loading` / default → a believable v1 → v2 change set (added CTA, removed legacy hero, modified
 * shell) with an AI summary paragraph. `from`/`to` carry the two snapshot names consistent with
 * `snapshotsListFixture` (initial v1 → warmer-hero-and-booking-cta v2). The `from`/`to` query
 * params the viewer sends (`?from=A&to=B`) don't change the body here — the demo has one canonical
 * pair. `error` is handled by the interceptor.
 *
 * @param state - The mock state knob from `?mock=1&state=…`.
 */
export const snapshotDiffFixture: FixtureFactory<SnapshotDiffResponse> = (
  state: MockState,
): SnapshotDiffResponse => {
  const from: DiffEndpoint = { id: 'snap-001', name: 'initial', build_version: 'v1' };
  const to: DiffEndpoint = { id: 'snap-002', name: 'warmer-hero-and-booking-cta', build_version: 'v2' };
  if (state === 'empty') {
    return { from, to, added: [], removed: [], modified: [], summary: '' };
  }
  return {
    from,
    to,
    added: DIFF_ADDED.map((f) => ({ ...f })),
    removed: DIFF_REMOVED.map((f) => ({ ...f })),
    modified: DIFF_MODIFIED.map((f) => ({ ...f, hunks: f.hunks.map((h) => ({ ...h })) })),
    summary:
      'Warmed the hero styling and promoted a booking call-to-action above the fold — a new BookingCta component was added and the legacy hero image was dropped in favor of a lighter WebP.',
  };
};
