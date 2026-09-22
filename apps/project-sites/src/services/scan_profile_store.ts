/**
 * @module services/scan_profile_store
 * @description D1 persistence for lead-scanner scan profiles (SCOPE.md:68).
 *
 * The pure profile contract lives in `services/scan_profiles.ts` (Zod schema +
 * due/run-spec logic). This module is the storage arm: it maps the D1 row shape
 * (snake_case columns, JSON-encoded arrays) to and from the camelCase
 * {@link ScanProfileConfig} the rest of the codebase consumes, and runs the
 * parameterized CRUD statements.
 *
 * @remarks
 * Every row is org-scoped and soft-deleted (`deleted_at`), so a profile is never
 * physically removed and a later "undo" stays possible. The row id is a UUIDv7
 * minted by the caller so a profile id is time-sortable.
 *
 * Trust model (mirrors `lead_store`, which this intentionally copies): the route
 * layer Zod-validates the profile BEFORE it reaches `rowFromConfig`, and the
 * array columns are `JSON.stringify`-encoded on write / `JSON.parse`-decoded on
 * read. Inserts skip `undefined` values via {@link dbInsert} (set-only
 * semantics), updates set null explicitly via {@link dbUpdate}.
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import { dbExecute, dbInsert, dbQuery, dbUpdate } from './db.js';
import { ScanProfileConfigSchema, type ScanProfileConfig } from './scan_profiles.js';

/** The D1 row shape for `scan_profiles` (snake_case, JSON array columns). */
export interface ScanProfileRow {
  id: string;
  org_id: string;
  name: string;
  enabled: number;
  bboxes_json: string;
  categories_json: string;
  providers_json: string;
  filters: string;
  source: string;
  max_leads_per_run: number;
  interval_minutes: number;
  last_run_at: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** A profile plus its lifecycle timestamps (what the admin API returns). */
export interface ScanProfileRecord extends ScanProfileConfig {
  orgId: string;
  createdAt: string;
  updatedAt: string;
}

const SELECT_COLUMNS =
  'id, org_id, name, enabled, bboxes_json, categories_json, providers_json, filters, source, max_leads_per_run, interval_minutes, last_run_at, created_at, updated_at';

/**
 * Decode one D1 row into the typed profile the API returns.
 *
 * @param row - The raw `scan_profiles` row.
 * @returns The decoded profile, or `null` when the stored JSON is corrupt
 *   (a row that cannot be decoded is skipped rather than crashing the list).
 */
export function rowToProfile(row: ScanProfileRow): ScanProfileRecord | null {
  try {
    const parsed = ScanProfileConfigSchema.safeParse({
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      bboxes: JSON.parse(row.bboxes_json),
      categories: JSON.parse(row.categories_json),
      providers: JSON.parse(row.providers_json),
      filters: row.filters,
      source: row.source,
      maxLeadsPerRun: row.max_leads_per_run,
      intervalMinutes: row.interval_minutes,
      lastRunAt: row.last_run_at,
    });
    if (!parsed.success) return null;
    return {
      ...parsed.data,
      orgId: row.org_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

/**
 * Encode a validated profile + its org into the D1 row shape.
 *
 * @param profile - A Zod-validated profile (the route layer owns validation).
 * @param orgId - The owning org (10-char org slug: `slugify(business_name) + 4`).
 * @returns The column map ready for {@link dbInsert}.
 */
export function rowFromProfile(profile: ScanProfileConfig, orgId: string): Record<string, unknown> {
  return {
    id: profile.id,
    org_id: orgId,
    name: profile.name,
    enabled: profile.enabled ? 1 : 0,
    bboxes_json: JSON.stringify(profile.bboxes),
    categories_json: JSON.stringify(profile.categories),
    providers_json: JSON.stringify(profile.providers),
    filters: profile.filters,
    source: profile.source,
    max_leads_per_run: profile.maxLeadsPerRun,
    interval_minutes: profile.intervalMinutes,
    last_run_at: profile.lastRunAt,
  };
}

/**
 * Encode a partial profile patch into the D1 column map.
 *
 * @remarks Only keys present on `patch` are emitted, so a PATCH that changes one
 * field does not clobber the others (set-only semantics).
 *
 * @param patch - The subset of profile fields to change.
 * @returns The column map ready for {@link dbUpdate}.
 */
export function rowPatchFromProfile(
  patch: Partial<Omit<ScanProfileConfig, 'id'>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.enabled !== undefined) out.enabled = patch.enabled ? 1 : 0;
  if (patch.bboxes !== undefined) out.bboxes_json = JSON.stringify(patch.bboxes);
  if (patch.categories !== undefined) out.categories_json = JSON.stringify(patch.categories);
  if (patch.providers !== undefined) out.providers_json = JSON.stringify(patch.providers);
  if (patch.filters !== undefined) out.filters = patch.filters;
  if (patch.source !== undefined) out.source = patch.source;
  if (patch.maxLeadsPerRun !== undefined) out.max_leads_per_run = patch.maxLeadsPerRun;
  if (patch.intervalMinutes !== undefined) out.interval_minutes = patch.intervalMinutes;
  if (patch.lastRunAt !== undefined) out.last_run_at = patch.lastRunAt;
  return out;
}

/**
 * List an org's live (non-deleted) scan profiles, newest first.
 *
 * @param db - The D1 binding (`env.DB`).
 * @param orgId - The owning org.
 * @param limit - Max rows to return (default 100).
 * @returns The decoded profiles, skipping any undecodable row.
 */
export async function listScanProfiles(
  db: D1Database,
  orgId: string,
  limit = 100,
): Promise<ScanProfileRecord[]> {
  const { data } = await dbQuery<ScanProfileRow>(
    db,
    `SELECT ${SELECT_COLUMNS} FROM scan_profiles
      WHERE org_id = ? AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?`,
    [orgId, limit],
  );
  return data.map(rowToProfile).filter((p): p is ScanProfileRecord => p !== null);
}

/**
 * Fetch one live profile by id (org-scoped).
 *
 * @param db - The D1 binding (`env.DB`).
 * @param orgId - The owning org.
 * @param id - The profile id.
 * @returns The profile, or `null` when missing / soft-deleted / another org's.
 */
export async function getScanProfile(
  db: D1Database,
  orgId: string,
  id: string,
): Promise<ScanProfileRecord | null> {
  const { data } = await dbQuery<ScanProfileRow>(
    db,
    `SELECT ${SELECT_COLUMNS} FROM scan_profiles
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    [id, orgId],
  );
  const row = data[0];
  return row ? rowToProfile(row) : null;
}

/**
 * Insert a new scan profile.
 *
 * @param db - The D1 binding (`env.DB`).
 * @param profile - A Zod-validated profile.
 * @param orgId - The owning org.
 * @returns `{ error }` — `null` on success.
 */
export async function insertScanProfile(
  db: D1Database,
  profile: ScanProfileConfig,
  orgId: string,
): Promise<{ error: string | null }> {
  return dbInsert(db, 'scan_profiles', rowFromProfile(profile, orgId));
}

/**
 * Patch a live scan profile. The org predicate is part of the WHERE clause so a
 * cross-org write can never land (defense-in-depth behind the route's assert).
 *
 * @param db - The D1 binding (`env.DB`).
 * @param orgId - The owning org.
 * @param id - The profile id.
 * @param patch - The fields to change.
 * @returns `{ error, changes }` — `changes === 0` means no such live profile.
 */
export async function updateScanProfile(
  db: D1Database,
  orgId: string,
  id: string,
  patch: Partial<Omit<ScanProfileConfig, 'id'>>,
): Promise<{ error: string | null; changes: number }> {
  return dbUpdate(
    db,
    'scan_profiles',
    rowPatchFromProfile(patch),
    'id = ? AND org_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
}

/**
 * Soft-delete a live scan profile (sets `deleted_at`; the row is never removed).
 *
 * @param db - The D1 binding (`env.DB`).
 * @param orgId - The owning org.
 * @param id - The profile id.
 * @returns `{ error, changes }` — `changes === 0` means no such live profile.
 */
export async function deleteScanProfile(
  db: D1Database,
  orgId: string,
  id: string,
): Promise<{ error: string | null; changes: number }> {
  return dbExecute(
    db,
    `UPDATE scan_profiles SET deleted_at = ?, updated_at = ?
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    [new Date().toISOString(), new Date().toISOString(), id, orgId],
  );
}

/**
 * Mark a profile as freshly run (advances `last_run_at`). Called by the cron
 * geo-sweep after a successful run so {@link isProfileDue} schedules the next one.
 *
 * @param env - Worker env (needs `DB`).
 * @param orgId - The owning org.
 * @param id - The profile id.
 * @param nowMs - Completion time (epoch ms; injectable for determinism).
 * @returns `{ error, changes }`.
 */
export async function markProfileRun(
  env: Env,
  orgId: string,
  id: string,
  nowMs: number = Date.now(),
): Promise<{ error: string | null; changes: number }> {
  return dbExecute(
    env.DB,
    `UPDATE scan_profiles SET last_run_at = ?, updated_at = ?
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    [nowMs, new Date().toISOString(), id, orgId],
  );
}
