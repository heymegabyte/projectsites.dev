/**
 * @module services/activation_funnel_query
 *
 * @description
 * The I/O layer over the activation funnel (§9). Keeps the pure funnel SSOT
 * ({@link activation_funnel.ts}) free of network/clock — this module does the
 * read and the fail-soft shaping the admin endpoint needs.
 *
 * Tinybird removed — D1 source TODO: the OLAP `activation_funnel` pipe read was
 * deleted, so {@link fetchActivationFunnel} returns the ZERO funnel (every
 * {@link ACTIVATION_STAGES} stage at 0, `degraded:true`) until a D1-backed funnel
 * query replaces it. The activation dashboard already renders the four stages on
 * `degraded:true`, so this is graceful (no 5xx, no dangling network dependency).
 *
 * @see services/activation_funnel.ts (the stage SSOT)
 */

import type { Env } from '../types/env.js';
import { ACTIVATION_STAGES } from './activation_funnel.js';

/** One funnel stage row (currently always the zero fallback). */
export interface ActivationFunnelRow {
  /** The stage's bus event type (`lead.discovered`, …). */
  stage: string;
  /** Human label (`Discovered`, `Engaged`, `Delivered`, `Converted`). */
  label: string;
  /** Funnel position, 0 = top. */
  ordinal: number;
  /** DISTINCT events at this stage in the window. */
  events: number;
  /** DISTINCT sites at this stage in the window. */
  sites: number;
}

/** Result of {@link fetchActivationFunnel}. */
export interface ActivationFunnelResult {
  /** Stages in funnel order (top → bottom), always all {@link ACTIVATION_STAGES}. */
  stages: ActivationFunnelRow[];
  /** True while the funnel has no backing source (Tinybird removed — D1 source TODO). */
  degraded: boolean;
}

/** The zero funnel — every stage at 0 (for the degraded read). */
function zeroFunnel(): ActivationFunnelRow[] {
  return ACTIVATION_STAGES.map((s) => ({
    stage: s.event,
    label: s.label,
    ordinal: s.ordinal,
    events: 0,
    sites: 0,
  }));
}

/**
 * Read the per-tenant activation funnel. Always returns all four stages in order.
 * Never throws.
 *
 * Tinybird removed — D1 source TODO: currently always returns the zero funnel
 * (`degraded:true`) because the OLAP pipe read was deleted. Swap in a D1-backed
 * funnel query here when the funnel moves to the master D1.
 *
 * @param _env - Worker env (unused until a D1 funnel query lands).
 * @param _opts - `{ tenantId?, days? }` — kept for the eventual D1 query.
 * @returns An {@link ActivationFunnelResult} — the zero funnel, `degraded:true`.
 */
export async function fetchActivationFunnel(
  _env: Env,
  _opts: { tenantId?: string; days?: number } = {},
): Promise<ActivationFunnelResult> {
  // Tinybird removed — D1 source TODO. Degrade gracefully to the zero funnel.
  return { stages: zeroFunnel(), degraded: true };
}
