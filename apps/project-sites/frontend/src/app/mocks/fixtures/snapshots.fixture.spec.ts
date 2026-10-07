import {
  snapshotMetricFixture,
  snapshotDownloadFixture,
  snapshotDiffFixture,
  type SnapshotMetricResponse,
  type SnapshotDownloadResponse,
  type SnapshotDiffResponse,
} from './snapshots.fixture';
import { toRegistryKey, FIXTURES } from './index';

/**
 * snapshots.fixture — the mock bodies for the Snapshots section's THREE drill-in GET reads the
 * already-wired list + grid fixtures (`per-site.fixture.ts`) do NOT cover. All auth-only (NO
 * feature flag — `snapshotQuality` + `siteVersioning` guard only org + site ownership), traced to:
 *
 *   GET /sites/:id/snapshots/:snapshotId/metrics  → { data: MetricsRow&{screenshot_url} | null; status? }
 *   GET /sites/:id/snapshots/:snapId/download      → { data: { …, files: File[] } }
 *   GET /sites/:id/snapshots/diff                  → { from, to, added, removed, modified, summary } (BARE)
 *
 * These specs test the factories DIRECTLY (envelope shape · every state · worker-contract wire)
 * and assert all three registry keys resolve against the STATIC `FIXTURES` map (per the #35 fix —
 * reading the shipped map, not the mutable `findFixture`/`registerFixtures` seam a sibling spec
 * could leak under Jasmine's random order). They are RED until `index.ts` ADDS the three lines
 * (the orchestrator's merge), then GREEN.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('snapshotMetricFixture (GET /sites/:id/snapshots/:snapshotId/metrics)', () => {
  it('populated → { data: MetricsRow & { screenshot_url } } (the worker envelope on a hit)', () => {
    const res: SnapshotMetricResponse = snapshotMetricFixture('populated', q());
    expect(res.data).not.toBeNull();
    const d = res.data!;
    expect(typeof d.id).toBe('string');
    expect(typeof d.snapshot_id).toBe('string');
    expect(typeof d.site_id).toBe('string');
    // The handler appends screenshot_url (the proxy path, NOT the raw R2 key).
    expect('screenshot_url' in d).toBe(true);
    expect(d.screenshot_url).toBe('/api/sites/site-001/snapshots/snap-002/screenshot.png');
    expect(d.screenshot_url).not.toBe(d.screenshot_r2_key);
  });

  it('carries the full MetricsRow SELECT * shape (Lighthouse + CWV + axe + vision columns)', () => {
    const d = snapshotMetricFixture('populated', q()).data!;
    // A representative field per cluster — all present on the SELECT * wire.
    for (const k of [
      'lh_performance',
      'lh_accessibility',
      'lh_seo',
      'lcp_ms',
      'cls',
      'inp_ms',
      'axe_violations',
      'axe_critical',
      'contrast_failures',
      'jsonld_block_count',
      'vision_overall',
      'vision_scores_json',
      'captured_at',
      'captured_via',
    ]) {
      expect(k in d).toBe(true);
    }
  });

  it('vision_scores_json is valid parseable JSON with the 6 radar axes (the component parses it)', () => {
    const d = snapshotMetricFixture('populated', q()).data!;
    expect(typeof d.vision_scores_json).toBe('string');
    const axes = JSON.parse(d.vision_scores_json!);
    for (const axis of ['layout', 'typography', 'color', 'imagery', 'hierarchy', 'polish']) {
      expect(typeof axes[axis]).toBe('number');
    }
  });

  it('is a mostly-green, believable row (strong Lighthouse, zero axe, high vision)', () => {
    const d = snapshotMetricFixture('populated', q()).data!;
    expect(d.lh_performance!).toBeGreaterThanOrEqual(90);
    expect(d.axe_violations).toBe(0);
    expect(d.error).toBeNull();
    expect(d.vision_overall!).toBeGreaterThanOrEqual(8);
  });

  it('empty → { data: null, status: "pending" } (the worker shape pre-capture → Capture button)', () => {
    const res = snapshotMetricFixture('empty', q());
    expect(res.data).toBeNull();
    expect(res.status).toBe('pending');
  });

  it('loading / default serve the same populated row', () => {
    expect(snapshotMetricFixture('loading', q()).data).not.toBeNull();
    expect(snapshotMetricFixture('populated', q()).data!.snapshot_id).toBe(
      snapshotMetricFixture('loading', q()).data!.snapshot_id,
    );
  });

  it('returns a fresh clone each call (mutating one body never corrupts the next)', () => {
    const a = snapshotMetricFixture('populated', q());
    a.data!.lh_performance = -1;
    const b = snapshotMetricFixture('populated', q());
    expect(b.data!.lh_performance).not.toBe(-1);
  });
});

describe('snapshotDownloadFixture (GET /sites/:id/snapshots/:snapId/download)', () => {
  it('returns the worker envelope { data: { snapshot_id, build_version, generated_at, expires_at, files } }', () => {
    const res: SnapshotDownloadResponse = snapshotDownloadFixture('populated', q());
    const d = res.data;
    expect(typeof d.snapshot_id).toBe('string');
    expect(typeof d.build_version).toBe('string');
    expect(typeof d.generated_at).toBe('string');
    expect(typeof d.expires_at).toBe('string');
    expect(Array.isArray(d.files)).toBe(true);
  });

  it('every file carries the per-object projection { key, size, etag, content_type, url }', () => {
    const files = snapshotDownloadFixture('populated', q()).data.files;
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(typeof f.key).toBe('string');
      expect(typeof f.size).toBe('number');
      expect(typeof f.etag).toBe('string');
      expect('content_type' in f).toBe(true);
      // url is the PUBLIC site URL the browser fetches (bucket is public for site-serving).
      expect(f.url.startsWith('https://')).toBe(true);
      expect(f.url.endsWith(f.key)).toBe(true);
    }
  });

  it('includes the shell + a hashed bundle + the favicon/SEO required files (a believable build)', () => {
    const keys = snapshotDownloadFixture('populated', q()).data.files.map((f) => f.key);
    expect(keys).toContain('index.html');
    expect(keys.some((k) => /^assets\/index-.*\.js$/.test(k))).toBe(true);
    expect(keys).toContain('favicon.ico');
    expect(keys).toContain('site.webmanifest');
    expect(keys).toContain('sitemap.xml');
  });

  it('empty → a manifest with files: [] (the component shows "no files to download")', () => {
    const res = snapshotDownloadFixture('empty', q());
    expect(res.data.files.length).toBe(0);
    // The manifest envelope itself is still well-formed.
    expect(typeof res.data.snapshot_id).toBe('string');
  });

  it('returns a fresh clone each call (mutating one file never corrupts the next)', () => {
    const a = snapshotDownloadFixture('populated', q());
    a.data.files[0]!.key = 'MUTATED';
    const b = snapshotDownloadFixture('populated', q());
    expect(b.data.files[0]!.key).not.toBe('MUTATED');
  });
});

describe('snapshotDiffFixture (GET /sites/:id/snapshots/diff)', () => {
  it('returns a BARE object { from, to, added, removed, modified, summary } (NOT wrapped in { data })', () => {
    const res: SnapshotDiffResponse = snapshotDiffFixture('populated', q('from=snap-001&to=snap-002'));
    expect('data' in (res as unknown as Record<string, unknown>)).toBe(false);
    expect(res.from.id).toBe('snap-001');
    expect(res.to.id).toBe('snap-002');
    expect(Array.isArray(res.added)).toBe(true);
    expect(Array.isArray(res.removed)).toBe(true);
    expect(Array.isArray(res.modified)).toBe(true);
    expect(typeof res.summary).toBe('string');
  });

  it('from/to carry { id, name, build_version } consistent with the snapshots list (initial v1 → v2)', () => {
    const res = snapshotDiffFixture('populated', q());
    expect(res.from.name).toBe('initial');
    expect(res.from.build_version).toBe('v1');
    expect(res.to.name).toBe('warmer-hero-and-booking-cta');
    expect(res.to.build_version).toBe('v2');
  });

  it('added/removed are PlainFile; a removed binary carries binary:true + empty contents', () => {
    const res = snapshotDiffFixture('populated', q());
    expect(res.added.length).toBeGreaterThan(0);
    for (const f of res.added) {
      expect(typeof f.path).toBe('string');
      expect(typeof f.contents).toBe('string');
      expect(typeof f.binary).toBe('boolean');
      expect(typeof f.truncated).toBe('boolean');
    }
    const bin = res.removed.find((f) => f.binary);
    expect(bin).toBeDefined();
    expect(bin!.contents).toBe('');
  });

  it('a modified file carries before/after + line hunks with the add/remove/context flags', () => {
    const res = snapshotDiffFixture('populated', q());
    expect(res.modified.length).toBeGreaterThan(0);
    const m = res.modified[0]!;
    expect(typeof m.before).toBe('string');
    expect(typeof m.after).toBe('string');
    expect(m.hunks.length).toBeGreaterThan(0);
    // The hunk set must include at least one added AND one removed line (a real change).
    expect(m.hunks.some((h) => h.added)).toBe(true);
    expect(m.hunks.some((h) => h.removed)).toBe(true);
    // Each hunk is the diffLines() shape.
    for (const h of m.hunks) {
      expect(typeof h.added).toBe('boolean');
      expect(typeof h.removed).toBe('boolean');
      expect(typeof h.value).toBe('string');
    }
  });

  it('empty → an identical diff (no changes, empty summary → the "snapshots are identical" state)', () => {
    const res = snapshotDiffFixture('empty', q());
    expect(res.added.length).toBe(0);
    expect(res.removed.length).toBe(0);
    expect(res.modified.length).toBe(0);
    expect(res.summary).toBe('');
    // from/to are still populated so the header renders the compare pair.
    expect(res.from.id).toBe('snap-001');
    expect(res.to.id).toBe('snap-002');
  });

  it('populated carries a non-empty AI summary paragraph (the viewer renders the banner)', () => {
    expect(snapshotDiffFixture('populated', q()).summary.length).toBeGreaterThan(20);
  });

  it('returns a fresh clone each call (mutating one hunk never corrupts the next)', () => {
    const a = snapshotDiffFixture('populated', q());
    a.modified[0]!.hunks[0]!.value = 'MUTATED';
    const b = snapshotDiffFixture('populated', q());
    expect(b.modified[0]!.hunks[0]!.value).not.toBe('MUTATED');
  });
});

describe('snapshots fixtures — registry wiring (the shipped FIXTURES map carries all three keys)', () => {
  // Assert against the STATIC registry map + its PATTERN keys directly — the merged lines always
  // carry these factories regardless of Jasmine's spec order, and reading the map (not findFixture)
  // never touches the mutable registerFixtures/EXTRA_FIXTURES seam a sibling spec could leak.
  const reg = FIXTURES as Record<string, unknown>;
  const METRIC_PATTERN = 'GET /sites/:id/snapshots/:snapshotId/metrics';
  const DOWNLOAD_PATTERN = 'GET /sites/:id/snapshots/:snapId/download';
  const DIFF_PATTERN = 'GET /sites/:id/snapshots/diff';

  it('the three snapshot drill-in URLs normalize to the expected keys (query stripped)', () => {
    expect(
      toRegistryKey('GET', 'https://projectsites.dev/api/sites/site-001/snapshots/snap-002/metrics').key,
    ).toBe('GET /sites/site-001/snapshots/snap-002/metrics');
    expect(
      toRegistryKey('GET', 'https://projectsites.dev/api/sites/site-001/snapshots/snap-002/download').key,
    ).toBe('GET /sites/site-001/snapshots/snap-002/download');
    expect(
      toRegistryKey('GET', 'https://projectsites.dev/api/sites/site-001/snapshots/diff?from=a&to=b').key,
    ).toBe('GET /sites/site-001/snapshots/diff');
  });

  it('the METRIC pattern is wired to snapshotMetricFixture in FIXTURES', () => {
    expect(typeof reg[METRIC_PATTERN]).toBe('function');
    expect(reg[METRIC_PATTERN]).toBe(snapshotMetricFixture as unknown);
  });

  it('the DOWNLOAD pattern is wired to snapshotDownloadFixture in FIXTURES', () => {
    expect(typeof reg[DOWNLOAD_PATTERN]).toBe('function');
    expect(reg[DOWNLOAD_PATTERN]).toBe(snapshotDownloadFixture as unknown);
  });

  it('the DIFF pattern is wired to snapshotDiffFixture in FIXTURES', () => {
    expect(typeof reg[DIFF_PATTERN]).toBe('function');
    expect(reg[DIFF_PATTERN]).toBe(snapshotDiffFixture as unknown);
  });

  it('these three keys do NOT collide with the already-wired snapshots list / metrics-grid keys', () => {
    // The list (3 seg) + grid (4 seg, literal `metrics`) are distinct from the drill-in keys.
    expect(METRIC_PATTERN).not.toBe('GET /sites/:id/snapshots');
    expect(METRIC_PATTERN).not.toBe('GET /sites/:id/snapshots/metrics');
    expect(DIFF_PATTERN).not.toBe('GET /sites/:id/snapshots/metrics');
    // The diff key (literal `diff`) and the grid key (literal `metrics`) are both 4-segment but
    // differ in the final literal, so their compiled regexes can never both match one URL.
    expect(toRegistryKey('GET', '/api/sites/x/snapshots/diff').key).not.toBe(
      toRegistryKey('GET', '/api/sites/x/snapshots/metrics').key,
    );
  });
});
