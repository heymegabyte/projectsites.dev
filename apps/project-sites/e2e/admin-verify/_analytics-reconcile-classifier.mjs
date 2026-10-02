/**
 * _analytics-reconcile-classifier.mjs — pure display-vs-store classifier for the Analytics
 * surface (fire-80, role 4; hardens the fire-78 half-done reconciler per the BACKLOG line
 * "Analytics reconcile — displayed counts vs D1 `visitor_events`").
 *
 * WHY a separate pure module: `reconcile-surfaces.mjs`'s existing analytics row is
 * `mode:'populated'` — it only asks "is display > 0?". That passes for THREE distinct failure
 * shapes a lying-empty/wrong-source bug can take:
 *   1. LYING-EMPTY  — the store has rows, the display reads 0 (the original AL-216 bug class;
 *      admin `/admin/analytics` showed "never had any traffic" while D1 held 109 real pageviews).
 *   2. WRONG-SOURCE — BOTH store and display are populated, but the display is reading a
 *      DIFFERENT table/window than it claims (e.g. CF-zone httpRequestsAdaptiveGroups instead of
 *      D1 visitor_events) — a divergence `mode:'populated'` is structurally blind to, since
 *      both numbers are non-zero.
 *   3. STALE        — the counts reconcile but the display's self-reported freshness lags the
 *      store's NEWEST event by more than an explicit SLA — correct data, served too late. No
 *      prior reconciler asserted this at all (the fire-78 gap this slice closes).
 *
 * Kept dependency-free + pure (no fetch/wrangler/playwright) so it unit-tests in milliseconds
 * under Jest (see src/__tests__/analytics_reconcile_classifier.test.ts) and is reused unchanged
 * by the live prod probe in reconcile-surfaces.mjs (which supplies the real ground-truth COUNT
 * via `wrangler d1 execute --remote` and the real display via the authed admin Analytics fetch).
 */

/**
 * Freshness SLA: how far behind the display is allowed to lag the newest `visitor_events` row
 * before it's flagged STALE. Chosen generously above any plausible cache/aggregation-rollup
 * window (per-site `/analytics` has no cache layer today; `analytics_daily` rollups run on a
 * schedule) while still catching a genuinely broken/frozen display (e.g. a stuck KV cache, a
 * dead rollup cron). Exported so tests assert against the SAME constant, never a duplicated magic
 * number that could silently drift from the live gate.
 */
export const ANALYTICS_FRESHNESS_SLA_MS = 15 * 60 * 1000; // 15 minutes

/** Relative tolerance for a WINDOWED/live-growing metric (store and display read at slightly
 * different instants) before a divergence counts as WRONG_SOURCE rather than normal drift. */
const COUNT_TOLERANCE_RATIO = 0.1; // 10%
/** Absolute floor so tiny counts (gt=1..5) don't need an impossible sub-1 tolerance window. */
const COUNT_TOLERANCE_FLOOR = 2;

/**
 * Classify a (groundTruth, display) count pair for lying-empty / wrong-source divergence.
 *
 * @param {{ groundTruth: number, display: number }} input - `groundTruth` is the authoritative
 *   D1 `visitor_events` COUNT for the account/window; `display` is the number the admin surface
 *   actually rendered for the same account/window.
 * @returns {{ ok: boolean, code: 'OK'|'LYING_EMPTY'|'WRONG_SOURCE', detail: string }}
 * @example classifyCounts({ groundTruth: 109, display: 0 }) // → { ok:false, code:'LYING_EMPTY', … }
 */
export function classifyCounts({ groundTruth, display }) {
  const gt = Number.isFinite(groundTruth) ? groundTruth : 0;
  const disp = Number.isFinite(display) ? display : Number.NaN;

  // A non-finite/NaN display means the extractor couldn't read a count at all — the surface is
  // effectively showing nothing, so it's classified with the LYING_EMPTY family rather than
  // silently passing or throwing.
  if (!Number.isFinite(disp)) {
    return { ok: false, code: 'LYING_EMPTY', detail: `display is non-numeric (gt=${gt})` };
  }

  // Honest-empty: the store genuinely has no data for this window/account. Any display value
  // of 0 here is correct, never a bug.
  if (gt === 0) {
    if (disp === 0) return { ok: true, code: 'OK', detail: 'honest-empty (gt=0, display=0)' };
    // gt=0 but display shows something — the display is reading data that isn't this
    // account's/window's at all. Still a wrong-source class (inflated from nothing).
    return { ok: false, code: 'WRONG_SOURCE', detail: `gt=0 but display=${disp} (reading unrelated data)` };
  }

  // The classic lying-empty: real data exists, display shows nothing.
  if (disp === 0) {
    return { ok: false, code: 'LYING_EMPTY', detail: `gt=${gt} but display=0` };
  }

  // Both populated — check they reconcile within tolerance (windowed metrics drift a little by
  // design; anything beyond the tolerance band is a different source, not timing noise).
  const tolerance = Math.max(COUNT_TOLERANCE_FLOOR, gt * COUNT_TOLERANCE_RATIO);
  const diff = Math.abs(gt - disp);
  if (diff <= tolerance) {
    return { ok: true, code: 'OK', detail: `gt=${gt}, display=${disp} (within ±${tolerance.toFixed(1)} tolerance)` };
  }
  return {
    ok: false,
    code: 'WRONG_SOURCE',
    detail: `gt=${gt}, display=${disp} diverge by ${diff} (> ±${tolerance.toFixed(1)} tolerance) — likely reading a different source/window`,
  };
}

/**
 * Classify whether a display's self-reported "as-of" timestamp lags the store's newest event
 * beyond the freshness SLA.
 *
 * @param {{ storeNewestMs: number|null, displayComputedAtMs: number|null, nowMs?: number }} input
 *   `storeNewestMs` — epoch ms of the newest `visitor_events` row (null when the store has 0
 *   rows — nothing to be stale against). `displayComputedAtMs` — epoch ms the display surface
 *   reports as when its data was last computed/cached (null when the surface exposes no
 *   freshness signal at all). `nowMs` — injectable for deterministic tests; defaults to `Date.now()`.
 * @returns {{ ok: boolean, code: 'FRESH'|'STALE'|'STALE_UNKNOWN', lagMs: number|null, detail: string }}
 * @example classifyFreshness({ storeNewestMs: Date.now()-60000, displayComputedAtMs: Date.now() })
 */
export function classifyFreshness({ storeNewestMs, displayComputedAtMs, nowMs = Date.now() }) {
  // No events in the store at all → there is nothing for the display to be stale against.
  // Vacuously fresh (an honest-empty surface is never flagged STALE).
  if (storeNewestMs == null) {
    return { ok: true, code: 'FRESH', lagMs: null, detail: 'store has no events — vacuously fresh' };
  }

  // The surface exposes NO freshness signal whatsoever. This is never a silent pass — a surface
  // claiming live data with zero way to verify when it was computed is exactly the shape a
  // frozen/dead rollup can hide behind. Flagged distinctly from STALE so an operator can tell
  // "definitely late" from "instrumentation gap, add a freshness field."
  if (displayComputedAtMs == null) {
    return {
      ok: false,
      code: 'STALE_UNKNOWN',
      lagMs: null,
      detail: 'display exposes no freshness/as-of signal — cannot verify it is current',
    };
  }

  const lagMs = Math.max(0, storeNewestMs - displayComputedAtMs);
  if (lagMs <= ANALYTICS_FRESHNESS_SLA_MS) {
    return { ok: true, code: 'FRESH', lagMs, detail: `lag ${lagMs}ms within ${ANALYTICS_FRESHNESS_SLA_MS}ms SLA` };
  }
  return {
    ok: false,
    code: 'STALE',
    lagMs,
    detail: `display lags newest store event by ${lagMs}ms (> ${ANALYTICS_FRESHNESS_SLA_MS}ms SLA, nowMs=${nowMs})`,
  };
}

/**
 * Combined verdict the live probe reports per surface: reconciles BOTH the count-divergence
 * classifier and the freshness classifier, and NEVER lets one mask the other — a surface can be
 * simultaneously WRONG_SOURCE and STALE, and both must show up in the verdict string.
 *
 * @param {{ groundTruth: number, display: number, storeNewestMs: number|null,
 *   displayComputedAtMs: number|null, nowMs?: number }} input
 * @returns {{ ok: boolean, verdict: string, counts: ReturnType<typeof classifyCounts>,
 *   freshness: ReturnType<typeof classifyFreshness> }}
 * @example
 *   reconcileAnalyticsSurface({ groundTruth:109, display:109, storeNewestMs:Date.now()-60000,
 *     displayComputedAtMs:Date.now()-5000 }) // → { ok:true, verdict:'✅ OK', … }
 */
export function reconcileAnalyticsSurface({
  groundTruth,
  display,
  storeNewestMs,
  displayComputedAtMs,
  nowMs = Date.now(),
}) {
  const counts = classifyCounts({ groundTruth, display });
  const freshness = classifyFreshness({ storeNewestMs, displayComputedAtMs, nowMs });
  const ok = counts.ok && freshness.ok;

  if (ok) return { ok, verdict: '✅ OK', counts, freshness };

  const parts = [];
  if (!counts.ok) {
    const label = counts.code === 'LYING_EMPTY' ? 'LYING-EMPTY' : 'WRONG-SOURCE';
    parts.push(`🔴 ${label} (${counts.detail})`);
  }
  if (!freshness.ok) {
    const label = freshness.code === 'STALE_UNKNOWN' ? 'STALE (unknown freshness)' : 'STALE';
    parts.push(`🟠 ${label} (${freshness.detail})`);
  }
  return { ok, verdict: parts.join(' · '), counts, freshness };
}
