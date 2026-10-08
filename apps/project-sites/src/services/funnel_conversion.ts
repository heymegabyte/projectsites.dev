/**
 * @module services/funnel_conversion
 *
 * @description
 * Pure conversion math over the activation funnel (§9, §8 priority #1 — revenue).
 * Turns raw per-stage `sites` counts into the actionable revenue signal: where
 * the funnel leaks. For each stage it computes step retention (this stage ÷ the
 * one above) and reach (this stage ÷ the top), plus the overall discovered→
 * converted rate. No I/O, no clock — fed by {@link fetchActivationFunnel}'s
 * stages so the admin endpoint enriches without a second round-trip.
 *
 * Rates are percentages rounded to 1 dp. A zero denominator yields `null` for
 * the step rate (undefined, not 0 — "no upstream traffic" ≠ "0% converted") and
 * `0` for reach/overall (0 of N reached). Never throws; never NaN/Infinity.
 *
 * @see services/activation_funnel_query.ts (fetchActivationFunnel — the data)
 */

/** Minimal per-stage input (structurally matches `ActivationFunnelRow`). */
export interface FunnelStageCount {
  stage: string;
  label: string;
  ordinal: number;
  sites: number;
}

/** Per-stage conversion row. */
export interface FunnelConversionStep {
  stage: string;
  label: string;
  ordinal: number;
  sites: number;
  /** sites ÷ previous-stage sites, %, 1dp. `null` at the top OR when prev is 0. */
  fromPrevPct: number | null;
  /** sites ÷ top-stage sites, %, 1dp. `0` when the top is 0. */
  fromTopPct: number;
}

/** The funnel's conversion view. */
export interface FunnelConversion {
  steps: FunnelConversionStep[];
  /** Sites at the top (widest) stage. */
  topSites: number;
  /** Sites at the bottom (narrowest) stage. */
  bottomSites: number;
  /** bottomSites ÷ topSites, %, 1dp. `0` when the top is 0. */
  overallPct: number;
}

/** Round to 1 decimal place (finite-safe). */
function pct1(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Compute stage-over-stage + overall conversion from ordered funnel counts.
 *
 * @param stages - Per-stage counts; sorted by `ordinal` internally (input order
 *   irrelevant). An empty array yields an empty, zeroed conversion.
 * @returns A {@link FunnelConversion}.
 * @example
 * computeFunnelConversion([
 *   { stage:'lead.discovered', label:'Discovered', ordinal:0, sites:100 },
 *   { stage:'subscription.active', label:'Converted', ordinal:3, sites:12 },
 * ]).overallPct // → 12
 */
export function computeFunnelConversion(stages: readonly FunnelStageCount[]): FunnelConversion {
  const ordered = [...stages].sort((a, b) => a.ordinal - b.ordinal);
  if (ordered.length === 0) {
    return { steps: [], topSites: 0, bottomSites: 0, overallPct: 0 };
  }
  const topSites = ordered[0].sites;
  const bottomSites = ordered[ordered.length - 1].sites;

  const steps: FunnelConversionStep[] = ordered.map((s, i) => {
    const prev = i === 0 ? null : ordered[i - 1].sites;
    return {
      stage: s.stage,
      label: s.label,
      ordinal: s.ordinal,
      sites: s.sites,
      fromPrevPct: prev === null || prev <= 0 ? null : pct1(s.sites, prev),
      fromTopPct: pct1(s.sites, topSites),
    };
  });

  return { steps, topSites, bottomSites, overallPct: pct1(bottomSites, topSites) };
}
