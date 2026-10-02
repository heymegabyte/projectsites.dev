/**
 * TDD-first (fire-80, role 4): the Analytics display-vs-store reconciler classifier.
 *
 * `reconcile-surfaces.mjs`'s existing analytics row only checks `display > 0` (mode:'populated')
 * — it CANNOT distinguish an honest-populated display from one reading a WRONG source with a
 * different (but still >0) count, and it has NO freshness assertion at all (fire-78 left this
 * half-done — see `.claude/run-the-loop/BACKLOG.md` "Analytics reconcile — displayed counts vs
 * D1 `visitor_events`"). Per the global `verify-against-source-of-truth` rule: a 200 + non-zero
 * display is NOT proof the display reconciles with the authoritative store — only a direct
 * ground-truth-vs-display diff is.
 *
 * This suite locks the PURE classifier (`_analytics-reconcile-classifier.mjs`) that the live
 * `reconcile-surfaces.mjs` prod probe calls. Three fixture classes, each a real bug this closes:
 *   1. LYING-EMPTY  — store has rows, display shows 0.
 *   2. WRONG-SOURCE — store and display both >0 but the counts diverge beyond noise tolerance
 *      (display reading a different table/window than the store it claims to summarize).
 *   3. STALE        — display's self-reported "freshness" timestamp lags the store's newest
 *      event by more than the SLA (data is correct but late — the fire-78 gap).
 * A healthy case (reconciled + fresh) must NOT false-positive on any of the three.
 */
import {
  classifyCounts,
  classifyFreshness,
  ANALYTICS_FRESHNESS_SLA_MS,
  reconcileAnalyticsSurface,
} from '../../e2e/admin-verify/_analytics-reconcile-classifier.mjs';

describe('classifyCounts — display vs D1 ground-truth divergence', () => {
  it('flags LYING_EMPTY when the store has rows but the display shows 0', () => {
    const v = classifyCounts({ groundTruth: 109, display: 0 });
    expect(v.code).toBe('LYING_EMPTY');
    expect(v.ok).toBe(false);
  });

  it('flags WRONG_SOURCE when both are populated but diverge beyond tolerance', () => {
    // Reference incident shape: UI read CF-zone adaptive-groups (wrong source) while D1
    // visitor_events held the true count — both non-zero, wildly different.
    const v = classifyCounts({ groundTruth: 2256, display: 12 });
    expect(v.code).toBe('WRONG_SOURCE');
    expect(v.ok).toBe(false);
  });

  it('passes OK when display exactly matches ground truth', () => {
    const v = classifyCounts({ groundTruth: 109, display: 109 });
    expect(v.code).toBe('OK');
    expect(v.ok).toBe(true);
  });

  it('passes OK within the windowed-metric noise tolerance (display is a live-growing window)', () => {
    // `/api/sites/:id/analytics` pageviews is a WINDOWED metric vs an all-time D1 count — a
    // few events landing between the two reads is expected, not a bug. Default tolerance 10%.
    const v = classifyCounts({ groundTruth: 1000, display: 950 });
    expect(v.code).toBe('OK');
    expect(v.ok).toBe(true);
  });

  it('honest-empty (both zero) is OK, never a false LYING_EMPTY', () => {
    const v = classifyCounts({ groundTruth: 0, display: 0 });
    expect(v.code).toBe('OK');
    expect(v.ok).toBe(true);
  });

  it('flags WRONG_SOURCE when display EXCEEDS ground truth beyond tolerance (double-count / wrong scope)', () => {
    const v = classifyCounts({ groundTruth: 50, display: 500 });
    expect(v.code).toBe('WRONG_SOURCE');
    expect(v.ok).toBe(false);
  });

  it('treats a non-finite / NaN display as LYING_EMPTY-class (extract failure reads as no data)', () => {
    const v = classifyCounts({ groundTruth: 10, display: Number.NaN });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('LYING_EMPTY');
  });
});

describe('classifyFreshness — display must not lag the store beyond the SLA', () => {
  const NOW = Date.parse('2026-10-02T12:00:00Z');

  it('passes OK when the display was computed after the newest store event', () => {
    const storeNewestMs = NOW - 5 * 60_000; // 5 min old event
    const displayComputedAtMs = NOW - 1 * 60_000; // display computed 1 min ago
    const v = classifyFreshness({ storeNewestMs, displayComputedAtMs, nowMs: NOW });
    expect(v.ok).toBe(true);
    expect(v.code).toBe('FRESH');
  });

  it('flags STALE when the display lags the newest store event by more than the SLA', () => {
    const storeNewestMs = NOW - 1 * 60_000; // event landed 1 min ago
    const displayComputedAtMs = NOW - (ANALYTICS_FRESHNESS_SLA_MS + 10 * 60_000); // display is old
    const v = classifyFreshness({ storeNewestMs, displayComputedAtMs, nowMs: NOW });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('STALE');
    expect(v.lagMs).toBeGreaterThan(ANALYTICS_FRESHNESS_SLA_MS);
  });

  it('passes OK exactly at the SLA boundary minus a hair (no off-by-one false-positive)', () => {
    const storeNewestMs = NOW - 1000;
    const displayComputedAtMs = storeNewestMs - 1000 + (ANALYTICS_FRESHNESS_SLA_MS - 1);
    const v = classifyFreshness({ storeNewestMs, displayComputedAtMs, nowMs: NOW });
    expect(v.ok).toBe(true);
  });

  it('treats a store with zero events (no newest timestamp) as vacuously FRESH — nothing to be stale against', () => {
    const v = classifyFreshness({ storeNewestMs: null, displayComputedAtMs: NOW, nowMs: NOW });
    expect(v.ok).toBe(true);
    expect(v.code).toBe('FRESH');
  });

  it('treats a missing displayComputedAtMs (surface exposes no freshness signal) as STALE-UNKNOWN, never a silent pass', () => {
    const v = classifyFreshness({
      storeNewestMs: NOW - 60_000,
      displayComputedAtMs: null,
      nowMs: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('STALE_UNKNOWN');
  });
});

describe('reconcileAnalyticsSurface — the combined verdict the live probe reports', () => {
  const NOW = Date.parse('2026-10-02T12:00:00Z');

  it('OK when counts reconcile AND freshness clears the SLA', () => {
    const v = reconcileAnalyticsSurface({
      groundTruth: 109,
      display: 109,
      storeNewestMs: NOW - 60_000,
      displayComputedAtMs: NOW - 5_000,
      nowMs: NOW,
    });
    expect(v.ok).toBe(true);
    expect(v.verdict).toBe('✅ OK');
  });

  it('fails on LYING_EMPTY even when freshness would have passed', () => {
    const v = reconcileAnalyticsSurface({
      groundTruth: 109,
      display: 0,
      storeNewestMs: NOW - 60_000,
      displayComputedAtMs: NOW - 5_000,
      nowMs: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.verdict).toMatch(/LYING-EMPTY/);
  });

  it('fails on STALE even when counts reconcile perfectly (the fire-78 gap this slice closes)', () => {
    const v = reconcileAnalyticsSurface({
      groundTruth: 109,
      display: 109,
      storeNewestMs: NOW - 60_000,
      displayComputedAtMs: NOW - (ANALYTICS_FRESHNESS_SLA_MS + 10 * 60_000),
      nowMs: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.verdict).toMatch(/STALE/);
  });

  it('reports BOTH failures when counts diverge AND freshness is stale (never masks one with the other)', () => {
    // storeNewestMs is RECENT (an event just landed); displayComputedAtMs is from WAY
    // before that — a lag of (ANALYTICS_FRESHNESS_SLA_MS + 1), genuinely beyond the SLA.
    const storeNewestMs = NOW - 60_000;
    const v = reconcileAnalyticsSurface({
      groundTruth: 2256,
      display: 12,
      storeNewestMs,
      displayComputedAtMs: storeNewestMs - (ANALYTICS_FRESHNESS_SLA_MS + 1),
      nowMs: NOW,
    });
    expect(v.ok).toBe(false);
    expect(v.verdict).toMatch(/WRONG-SOURCE/);
    expect(v.verdict).toMatch(/STALE/);
  });
});
