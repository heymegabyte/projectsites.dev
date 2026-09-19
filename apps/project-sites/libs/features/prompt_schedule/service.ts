import type { Env } from '../../../src/types/env.js';
import { dbQuery, dbInsert, dbExecute } from '../../../src/services/db.js';
import { isFlagOn } from '../../../src/modules/feature_flags/services.js';
import type { CreatePromptSchedule, PromptSchedule } from './schemas.js';

export const FLAG_KEY = 'prompt_schedule';

/**
 * PURE, zero-I/O core: given a set of schedules, a prompt key, and `nowMs`, return the
 * schedule whose [activate_at, deactivate_at) window contains `now` (deactivate_at null =
 * open-ended). On overlap the MOST-RECENTLY-ACTIVATED window wins, so a later campaign
 * override beats an earlier long-running one. Returns null when nothing is active — the
 * caller then falls back to the default variant. Same inputs → same output (unit-tested);
 * this is why the scheduler needs NO cron: activation is evaluated at read time.
 *
 * @param schedules - Candidate schedules (any keys; filtered here).
 * @param key - The prompt registry key to resolve.
 * @param nowMs - Current time in epoch ms (injected — never reads the clock).
 * @returns The winning schedule, or null if none is active for `key` at `nowMs`.
 */
export function resolveActiveSchedule(
  schedules: readonly PromptSchedule[],
  key: string,
  nowMs: number,
): PromptSchedule | null {
  let best: PromptSchedule | null = null;
  let bestStart = -Infinity;
  for (const s of schedules) {
    if (s.prompt_key !== key) continue;
    const start = Date.parse(s.activate_at);
    if (Number.isNaN(start) || start > nowMs) continue;
    if (s.deactivate_at) {
      const end = Date.parse(s.deactivate_at);
      if (Number.isNaN(end) || end <= nowMs) continue;
    }
    if (start >= bestStart) {
      bestStart = start;
      best = s;
    }
  }
  return best;
}

/** Row → validated domain object shape (D1 returns unknown-typed rows). */
function toSchedule(row: Record<string, unknown>): PromptSchedule {
  return {
    id: String(row.id),
    org_id: row.org_id == null ? null : String(row.org_id),
    prompt_key: String(row.prompt_key),
    variant: String(row.variant),
    activate_at: String(row.activate_at),
    deactivate_at: row.deactivate_at == null ? null : String(row.deactivate_at),
    label: row.label == null ? null : String(row.label),
    created_at: String(row.created_at),
  };
}

/** Create a schedule scoped to the caller's org. */
export async function createSchedule(
  env: Env,
  orgId: string,
  input: CreatePromptSchedule,
): Promise<PromptSchedule> {
  const id = crypto.randomUUID();
  const record = {
    id,
    org_id: orgId,
    prompt_key: input.prompt_key,
    variant: input.variant,
    activate_at: input.activate_at,
    deactivate_at: input.deactivate_at ?? null,
    label: input.label ?? null,
    created_at: new Date().toISOString(),
  };
  await dbInsert(env.DB, 'prompt_schedules', record);
  return toSchedule(record);
}

/** List the caller-visible schedules (own org + global), newest window first. */
export async function listSchedules(env: Env, orgId: string): Promise<PromptSchedule[]> {
  const { data } = await dbQuery<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM prompt_schedules
       WHERE (org_id = ? OR org_id IS NULL) AND deleted_at IS NULL
       ORDER BY activate_at DESC LIMIT 200`,
    [orgId],
  );
  return (data ?? []).map(toSchedule);
}

/** Soft-delete a schedule — ORG-SCOPED so a caller can never delete another org's row (IDOR-safe). */
export async function deleteSchedule(env: Env, orgId: string, id: string): Promise<boolean> {
  const { data } = await dbQuery<Record<string, unknown>>(
    env.DB,
    `SELECT id FROM prompt_schedules WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    [id, orgId],
  );
  if (!data || data.length === 0) return false;
  await dbExecute(
    env.DB,
    `UPDATE prompt_schedules SET deleted_at = ? WHERE id = ? AND org_id = ?`,
    [new Date().toISOString(), id, orgId],
  );
  return true;
}

/**
 * The consumption API for the generation pipeline: the variant currently scheduled for
 * `key` for this org (or a global schedule), or null → caller uses the default variant.
 * Consults own-org + global rows and applies {@link resolveActiveSchedule}.
 */
export async function getActiveVariant(
  env: Env,
  orgId: string,
  key: string,
  nowMs: number,
): Promise<PromptSchedule | null> {
  const { data } = await dbQuery<Record<string, unknown>>(
    env.DB,
    `SELECT * FROM prompt_schedules
       WHERE prompt_key = ? AND (org_id = ? OR org_id IS NULL) AND deleted_at IS NULL`,
    [key, orgId],
  );
  return resolveActiveSchedule((data ?? []).map(toSchedule), key, nowMs);
}

/**
 * The ONE call the generation pipeline (`runPrompt`) makes to consume this feature: the variant
 * that is scheduled for `key` right now, or `null` → the caller uses its default rotation. This
 * is what wires prompt_schedule into the build path (previously built-but-unwired).
 *
 * - **Flag-gated**: returns `null` unless the `prompt_schedule` flag is ON, so a scheduled variant
 *   can never affect a build until the feature is promoted (dark-by-default, zero hot-path effect
 *   when off beyond one KV-cached flag read).
 * - **Fail-soft**: NEVER throws — any flag/D1 error resolves to `null` so the build always proceeds
 *   on the default variant (a scheduling outage must never break site generation).
 * - Pass `orgId=''` for GLOBAL (platform-wide) campaign/seasonal schedules (the documented primary
 *   use case); pass a real `orgId` for per-org scheduling.
 *
 * @returns the scheduled variant id, or `null` to use the default.
 */
export async function scheduledVariantForRun(
  env: Env,
  orgId: string,
  key: string,
  nowMs: number,
): Promise<string | null> {
  try {
    if (!(await isFlagOn(env, FLAG_KEY))) return null;
    const active = await getActiveVariant(env, orgId, key, nowMs);
    return active?.variant ?? null;
  } catch {
    return null; // fail-soft: scheduling never breaks a build
  }
}
