/**
 * @file Pure helpers for the per-site Greenfield Reset Danger Zone (FIRE 8).
 *
 * UI-independent so they unit-test without jsdom + so the confirm gate is proven in isolation
 * (the whole feature is destructive — the gate is the safety). The worker RE-CHECKS every gate;
 * these mirror it so the button is disabled BEFORE a doomed request goes out
 * (`action-button-must-gate-on-server-precondition`).
 */
import type { ResetPreviewData } from '~/lib/embed/embedded-mode';

/** The literal a user can always type to confirm, in addition to the exact site slug. */
export const RESET_KEYWORD = 'RESET';

/**
 * True when `typed` authorizes the wipe: it matches the site slug (case-insensitive, trimmed) OR the
 * literal {@link RESET_KEYWORD}. Empty/whitespace never authorizes. Mirrors the worker's check exactly.
 *
 * @param typed - what the user typed into the confirm field
 * @param slug - the site's slug (may be empty/unknown → only `RESET` authorizes)
 */
export function isResetConfirmed(typed: string, slug: string | null | undefined): boolean {
  const t = (typed ?? '').trim();
  if (!t) return false;
  if (t.toLowerCase() === RESET_KEYWORD.toLowerCase()) return true;
  const s = (slug ?? '').trim().toLowerCase();
  return !!s && t.toLowerCase() === s;
}

/** A total of every row/key/object a reset will remove — for the honest "this deletes N things" summary. */
export interface ResetImpactTotals {
  tableCount: number;
  rowCount: number;
  kvKeyCount: number;
  r2ObjectCount: number;
  /** Grand total across all surfaces — the single number the confirm copy leads with. */
  total: number;
  /** True when ANY surface's count could not be read (row/key/object probe failed) — label honestly. */
  hasUnknown: boolean;
}

/**
 * Sum a preview's per-surface counts into totals for the confirm summary. A `null` row count (probe
 * failed) contributes 0 to the sum but flips `hasUnknown` so the UI never implies an exact "0".
 *
 * @param preview - the worker's preview delete-list (or null before it loads)
 */
export function summarizeResetImpact(preview: ResetPreviewData | null | undefined): ResetImpactTotals {
  const tables = preview?.d1?.tables ?? [];
  let rowCount = 0;
  let hasUnknown = false;
  for (const t of tables) {
    if (typeof t.rowCount === 'number') rowCount += t.rowCount;
    else hasUnknown = true;
  }
  if (preview?.d1 && preview.d1.tablesAvailable === false) hasUnknown = true;
  if (preview?.kv && preview.kv.keysAvailable === false) hasUnknown = true;
  if (preview?.r2 && preview.r2.objectsAvailable === false) hasUnknown = true;

  const tableCount = tables.length;
  const kvKeyCount = preview?.kv?.keyCount ?? 0;
  const r2ObjectCount = preview?.r2?.objectCount ?? 0;
  return {
    tableCount,
    rowCount,
    kvKeyCount,
    r2ObjectCount,
    total: rowCount + kvKeyCount + r2ObjectCount,
    hasUnknown,
  };
}

/** True when a loaded preview shows literally nothing to delete (honest empty → offer no wipe). */
export function isResetEmpty(preview: ResetPreviewData | null | undefined): boolean {
  if (!preview || preview.available === false) return true;
  const s = summarizeResetImpact(preview);
  return s.tableCount === 0 && s.kvKeyCount === 0 && s.r2ObjectCount === 0 && !s.hasUnknown;
}
