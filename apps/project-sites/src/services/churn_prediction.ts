/**
 * @module services/churn_prediction
 * @description LOOP-ANALYTICS-016 core — rules-based churn-risk scoring.
 * Pure computation from observable signals (dormancy, activation trend, billing
 * status). No ML, no I/O — transparent, explainable, unit-testable.
 *
 * The nightly cron (outside this module) queries D1 for the input signals, calls
 * `computeChurnRisk`, and persists the score + factors. This module owns only the
 * scoring algorithm.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

// ── Input signals ──────────────────────────────────────────────────────────

/** Observable signals fed into the churn-risk model. */
export const ChurnSignalsSchema = z.object({
  /** Days since the org's last site edit (or last login if no sites). */
  dormancyDays: z.number().finite().nonnegative().default(0),
  /**
   * Activation-score trend: positive = improving, negative = declining.
   * Typically the delta between the last two 30-day windows.
   */
  activationTrend: z.number().finite().default(0),
  /**
   * Stripe subscription status. `null` = free tier (no billing signal).
   */
  billingStatus: z
    .enum(['active', 'past_due', 'canceled', 'trialing', 'incomplete'])
    .nullable()
    .default(null),
  /** Whether the org has published at least one site. */
  hasPublishedSite: z.boolean().default(false),
  /** Whether the org has invited a teammate. */
  hasTeammate: z.boolean().default(false),
  /** Whether the org logged in within the last 7 days. */
  recentLogin: z.boolean().default(false),
});
export type ChurnSignals = z.infer<typeof ChurnSignalsSchema>;

// ── Risk level ─────────────────────────────────────────────────────────────

export const ChurnRiskLevel = z.enum(['low', 'medium', 'high', 'critical']);
export type ChurnRiskLevel = z.infer<typeof ChurnRiskLevel>;

// ── Output ─────────────────────────────────────────────────────────────────

/** The result of one churn-risk computation. */
export const ChurnRiskResultSchema = z.object({
  /** 0–100 risk score (higher = more likely to churn). */
  score: z.number().int().min(0).max(100),
  /** Human-readable risk band. */
  level: ChurnRiskLevel,
  /**
   * Top contributing factors, ordered most-significant-first.
   * Empty when score is 0.
   */
  factors: z.array(z.string()),
});
export type ChurnRiskResult = z.infer<typeof ChurnRiskResultSchema>;

// ── Scoring rules ──────────────────────────────────────────────────────────

/** Per-factor contribution. */
interface Factor {
  /** Points contributed (clamped into 0–100 total). */
  points: number;
  /** Human-readable label explaining the contribution. */
  label: string;
}

/**
 * Computes the churn-risk score (0–100) from observable signals. Rules-based
 * and transparent — every point is attributed to a named factor.
 *
 * Rules (additive, capped at 100):
 * - 90+ days dormant → +40, "Dormant 90+ days"
 * - 30–89 days dormant → +20, "Dormant 30+ days"
 * - 14–29 days dormant → +10, "Dormant 14+ days"
 * - Activation declining >10pts → +25, "Activation score declining"
 * - Activation declining >5pts → +15, "Activation score slipping"
 * - Past-due billing → +30, "Payment past due"
 * - Canceled subscription → +20, "Subscription canceled"
 * - Trial ending (no published site) → +15, "Trial ending without published site"
 * - No published sites → +10, "No published sites"
 * - No recent login (7d) → +10, "No recent login"
 *
 * Mitigating factors (subtractive, floor 0):
 * - Has teammate → −5, "Has teammate (collaborative)"
 * - Recent login → −5, "Recently active"
 * - Published site → −5, "Has published site"
 *
 * @param signals - Observable churn signals for one org.
 * @returns A scored, leveled, and explained risk result.
 *
 * @example
 * ```ts
 * const risk = computeChurnRisk({
 *   dormancyDays: 95,
 *   activationTrend: -12,
 *   billingStatus: 'past_due',
 *   hasPublishedSite: false,
 *   hasTeammate: false,
 *   recentLogin: false,
 * });
 * // { score: 100, level: 'critical', factors: ['Payment past due', ...] }
 * ```
 */
export function computeChurnRisk(signals: ChurnSignals): ChurnRiskResult {
  const parsed = ChurnSignalsSchema.parse(signals);
  const factors: Factor[] = [];

  // ── Dormancy ──────────────────────────────────────────────────────────

  if (parsed.dormancyDays >= 90) {
    factors.push({ points: 40, label: 'Dormant 90+ days' });
  } else if (parsed.dormancyDays >= 30) {
    factors.push({ points: 20, label: 'Dormant 30+ days' });
  } else if (parsed.dormancyDays >= 14) {
    factors.push({ points: 10, label: 'Dormant 14+ days' });
  }

  // ── Activation trend ──────────────────────────────────────────────────

  if (parsed.activationTrend < -10) {
    factors.push({ points: 25, label: 'Activation score declining sharply' });
  } else if (parsed.activationTrend < -5) {
    factors.push({ points: 15, label: 'Activation score slipping' });
  }

  // ── Billing ───────────────────────────────────────────────────────────

  if (parsed.billingStatus === 'past_due') {
    factors.push({ points: 30, label: 'Payment past due' });
  } else if (parsed.billingStatus === 'canceled') {
    factors.push({ points: 20, label: 'Subscription canceled' });
  } else if (parsed.billingStatus === 'trialing' && !parsed.hasPublishedSite) {
    factors.push({ points: 15, label: 'Trial ending without published site' });
  }

  // ── Engagement gaps ───────────────────────────────────────────────────

  if (!parsed.hasPublishedSite) {
    factors.push({ points: 10, label: 'No published sites' });
  }

  if (!parsed.recentLogin) {
    factors.push({ points: 10, label: 'No recent login (7 days)' });
  }

  // ── Mitigating factors (reduce risk) ──────────────────────────────────

  let mitigation = 0;
  const mitigations: string[] = [];

  if (parsed.hasTeammate) {
    mitigation += 5;
    mitigations.push('Has teammate');
  }

  if (parsed.recentLogin) {
    mitigation += 5;
    mitigations.push('Recently active');
  }

  if (parsed.hasPublishedSite) {
    mitigation += 5;
    mitigations.push('Has published site');
  }

  // ── Compute final score ───────────────────────────────────────────────

  const rawScore = factors.reduce((sum, f) => sum + f.points, 0) - mitigation;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));

  // ── Level ─────────────────────────────────────────────────────────────

  const level = classifyRiskLevel(score);

  // ── Build factor list (scored factors, then mitigations) ──────────────

  const factorLabels = [
    ...factors.sort((a, b) => b.points - a.points).map((f) => f.label),
    ...mitigations.map((m) => `${m} (mitigating)`),
  ];

  return ChurnRiskResultSchema.parse({ score, level, factors: factorLabels });
}

/**
 * Classifies a 0–100 risk score into a human-readable risk band.
 *
 * - 0–19 → `low`
 * - 20–49 → `medium`
 * - 50–74 → `high`
 * - 75–100 → `critical`
 *
 * @param score - Risk score (0–100).
 * @returns Risk level band.
 */
export function classifyRiskLevel(score: number): ChurnRiskLevel {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 20) return 'medium';
  return 'low';
}
