/**
 * @module services/analytics_query
 *
 * @description
 * Fail-soft reader for the admin raw-rollup surfaces (events_by_tenant_daily,
 * site_publishes_by_source, claims_by_source). Returns `{ rows, degraded }` —
 * the shaped result the admin endpoints render against.
 *
 * Tinybird removed — D1 source TODO: the former OLAP pipe reads were deleted, so
 * {@link fetchPipeRows} now returns the degraded zero-state (empty rows) for every
 * pipe until a D1-backed rollup query replaces it. The admin dashboard already
 * renders an empty rollup on `degraded:true`, so this is graceful (no 5xx, no
 * dangling network dependency). The row TYPES are preserved so consumers compile
 * unchanged.
 */

import type { Env } from '../types/env.js';

/** A row from `events_by_tenant_daily` (per-tenant/day/type event counts). */
export interface EventsDailyRow {
  tenant_id: string;
  day: string;
  event: string;
  events: number;
}

/** A row from `site_publishes_by_source` (per-tenant/day publish counts by source). */
export interface PublishesBySourceRow {
  tenant_id: string;
  day: string;
  source: string;
  publishes: number;
}

/** A row from `claims_by_source` (per-tenant/day claim-start counts by source + campaign). */
export interface ClaimsBySourceRow {
  tenant_id: string;
  day: string;
  source: string;
  campaign: string;
  claims: number;
}

/** Result of a rollup read — the rows, plus whether the data is the degraded zero-state. */
export interface PipeReadResult<T> {
  rows: T[];
  /** True while the rollup has no backing source (Tinybird removed — D1 source TODO). */
  degraded: boolean;
}

/**
 * Read a raw-rollup surface, fail-soft. Never throws.
 *
 * Tinybird removed — D1 source TODO: currently always returns the degraded
 * zero-state (`rows:[]`, `degraded:true`) because the OLAP pipe reads were
 * deleted. Swap in a D1-backed query here when the rollup moves to the master D1.
 *
 * @param _env - Worker env (unused until a D1 rollup lands).
 * @param _pipe - Rollup name (kept for the eventual D1 query dispatch).
 * @param _params - Rollup query params (`tenant_id`, `days`, `event`, `source`, …).
 * @returns `{ rows: [], degraded: true }` until a D1 source replaces the pipe.
 */
export async function fetchPipeRows<T>(
  _env: Env,
  _pipe: string,
  _params: Record<string, string | number | undefined> = {},
): Promise<PipeReadResult<T>> {
  // Tinybird removed — D1 source TODO. Degrade gracefully to an empty rollup.
  return { rows: [], degraded: true };
}
