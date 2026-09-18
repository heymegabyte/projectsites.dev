/**
 * @module services/task_inbox
 * @description AI task elicitation inbox — bridges long-running Workflows
 * that need user input mid-run to the admin UI tray.
 *
 * A workflow step does roughly:
 * ```ts
 * const { id } = await postAskUser(env, {
 *   orgId,
 *   workflowInstanceId: step.context.instanceId,
 *   taskKind: 'choose_brand_palette',
 *   prompt: 'Pick a palette for vitos-mens-salon',
 *   options: ['cyan', 'maroon', 'navy'],
 *   defaultChoice: 'cyan',
 *   timeoutMs: 15 * 60 * 1000,
 * });
 * const resolution = await step.waitForEvent<{choice:string}>(
 *   `task-resolved-${id}`,
 *   { type: `task-resolved-${id}`, timeout: '15 minutes' },
 * );
 * ```
 *
 * The admin task tray polls {@link listOpenTasks}, the user clicks an option,
 * the UI calls `POST /api/inbox/tasks/:id/resolve`, the route calls
 * {@link resolveTask}, which fans the resolution back into the workflow via
 * `env.SITE_WORKFLOW.get(instanceId).sendEvent({ type, payload })` (when the binding is present).
 *
 * Tasks that expire without a resolution can be auto-defaulted via
 * {@link applyExpiredDefaults} (scheduled cron candidate).
 *
 * @packageDocumentation
 */

import type { Env } from '../types/env.js';
import { dbExecute, dbInsert, dbQuery, dbQueryOne, dbUpdate } from './db.js';

// ─── Types ──────────────────────────────────────────────────────────

/** Persistent row shape for `ai_task_inbox`. All timestamps are unix-ms. */
export interface TaskInboxRow {
  id: string;
  org_id: string;
  workflow_instance_id: string | null;
  task_kind: string;
  prompt: string;
  options_json: string | null;
  default_choice: string | null;
  expires_at: number;
  resolved_at: number | null;
  resolution_json: string | null;
  created_at: number;
  created_by: string | null;
}

/**
 * Hydrated task shape returned to the UI — `options` parsed from
 * `options_json`, `resolution` parsed from `resolution_json`.
 */
export interface TaskInboxView {
  id: string;
  orgId: string;
  workflowInstanceId: string | null;
  taskKind: string;
  prompt: string;
  options: string[];
  defaultChoice: string | null;
  expiresAt: number;
  resolvedAt: number | null;
  resolution: TaskResolution | null;
  createdAt: number;
  createdBy: string | null;
}

/** Resolution payload — `choice` is the option key OR free-text response. */
export interface TaskResolution {
  choice: string;
  by?: string;
  /** Unix-ms timestamp of resolution; stamped by {@link resolveTask}. */
  at?: number;
  /** True when {@link applyExpiredDefaults} auto-resolved with `default_choice`. */
  autoDefaulted?: boolean;
}

/** Arguments to {@link postAskUser}. */
export interface PostAskUserArgs {
  orgId: string;
  workflowInstanceId?: string;
  taskKind: string;
  prompt: string;
  options?: string[];
  defaultChoice?: string;
  /** Defaults to 30 min when omitted. */
  timeoutMs?: number;
  createdBy?: string;
}

/** Default elicitation window — 30 min. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Minimal shapes of the Workflows-v2 GA event API (confirmed against the Cloudflare docs):
 * `env.SITE_WORKFLOW.get(instanceId)` → `instance.sendEvent({ type, payload })`. Kept narrow
 * and optional so this compiles regardless of the installed `@cloudflare/workers-types` version
 * and NO-OPS fail-soft on an older runtime that doesn't expose the method.
 */
interface WorkflowInstanceEventSender {
  sendEvent?: (event: { type: string; payload: unknown }) => Promise<unknown>;
}
interface WorkflowBindingWithGet {
  get?: (instanceId: string) => Promise<WorkflowInstanceEventSender>;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function parseOptions(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    /* ignore — bad JSON treated as empty option set */
  }
  return [];
}

function parseResolution(json: string | null): TaskResolution | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as TaskResolution;
    if (parsed && typeof parsed.choice === 'string') return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function toView(row: TaskInboxRow): TaskInboxView {
  return {
    id: row.id,
    orgId: row.org_id,
    workflowInstanceId: row.workflow_instance_id,
    taskKind: row.task_kind,
    prompt: row.prompt,
    options: parseOptions(row.options_json),
    defaultChoice: row.default_choice,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    resolution: parseResolution(row.resolution_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Post a new elicitation request. Returns the row id + expiry so the
 * caller can pair it with a `step.waitForEvent('task-resolved-${id}', …)`.
 *
 * @example
 * ```ts
 * const { id, expiresAt } = await postAskUser(env, {
 *   orgId: 'org_123',
 *   workflowInstanceId: step.context.instanceId,
 *   taskKind: 'confirm_destructive_action',
 *   prompt: 'Replace the existing hero image?',
 *   options: ['yes', 'no'],
 *   defaultChoice: 'no',
 *   timeoutMs: 5 * 60 * 1000,
 * });
 * ```
 */
export async function postAskUser(
  env: Env,
  args: PostAskUserArgs,
): Promise<{ id: string; expiresAt: number }> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const expiresAt = now + timeoutMs;

  const { error } = await dbInsert(env.DB, 'ai_task_inbox', {
    id,
    org_id: args.orgId,
    workflow_instance_id: args.workflowInstanceId ?? null,
    task_kind: args.taskKind,
    prompt: args.prompt,
    options_json: args.options && args.options.length > 0 ? JSON.stringify(args.options) : null,
    default_choice: args.defaultChoice ?? null,
    expires_at: expiresAt,
    resolved_at: null,
    resolution_json: null,
    created_at: now,
    created_by: args.createdBy ?? null,
  });

  // dbInsert returns { error } and NEVER throws (see db.ts). A dropped INSERT is
  // a lying-success: the caller pairs this id with a
  // `step.waitForEvent('task-resolved-${id}')`, but with no row the task never
  // surfaces in the tray AND `applyExpiredDefaults` never finds it — the workflow
  // stalls the FULL timeout window on a task that doesn't exist, and the step's
  // automatic retry is defeated (the step "succeeded" with a phantom id). Fail
  // loud so the workflow step RETRIES the post instead of proceeding blind.
  if (error) {
    throw new Error(`task_inbox.postAskUser: failed to persist task ${id}: ${error}`);
  }

  return { id, expiresAt };
}

/**
 * Mark a task resolved + fan the resolution back into the originating
 * workflow via the `SITE_WORKFLOW` binding (`get(instanceId).sendEvent`,
 * Workflows v2). Silently no-ops the workflow notify path when the
 * binding is absent or doesn't expose the API (older runtime).
 *
 * @returns `true` when the row was updated, `false` when the id is
 *   unknown or already resolved.
 */
export async function resolveTask(
  env: Env,
  id: string,
  resolution: TaskResolution,
): Promise<boolean> {
  const row = await dbQueryOne<TaskInboxRow>(
    env.DB,
    'SELECT * FROM ai_task_inbox WHERE id = ? LIMIT 1',
    [id],
  );
  if (!row) return false;
  if (row.resolved_at !== null) return false;

  const now = Date.now();
  const payload: TaskResolution = {
    choice: resolution.choice,
    by: resolution.by,
    at: now,
    autoDefaulted: resolution.autoDefaulted === true ? true : undefined,
  };

  const { changes } = await dbUpdate(
    env.DB,
    'ai_task_inbox',
    { resolved_at: now, resolution_json: JSON.stringify(payload) },
    'id = ? AND resolved_at IS NULL',
    [id],
  );

  if (changes === 0) return false;

  // Fan the resolution back into the paused workflow via the Workflows-v2 GA API:
  // `env.SITE_WORKFLOW.get(instanceId)` → `instance.sendEvent({ type, payload })`. The prior code
  // read a PHANTOM `env.SITE_GENERATION` binding (the real one is `SITE_WORKFLOW`, per env.ts) AND
  // used a binding-level `sendEvent(instanceId, type, payload)` shape Cloudflare does not expose —
  // so the fan-out was a silent no-op and the paused workflow ALWAYS timed out, ignoring the
  // owner's choice (AL-773). The `type` matches the workflow's `step.waitForEvent(\`task-resolved-
  // ${id}\`)` and stays dot-free (CF requires the event type match ^[a-zA-Z0-9_][a-zA-Z0-9-_]*$; a
  // UUID `id` satisfies it). Wrapped best-effort so a sendEvent failure (instance already timed-out
  // / errored / transport) never rolls back the user-facing resolution — the row stays resolved.
  if (row.workflow_instance_id) {
    const binding = (env as unknown as { SITE_WORKFLOW?: WorkflowBindingWithGet }).SITE_WORKFLOW;
    if (binding && typeof binding.get === 'function') {
      try {
        const instance = await binding.get(row.workflow_instance_id);
        if (instance && typeof instance.sendEvent === 'function') {
          await instance.sendEvent({ type: `task-resolved-${id}`, payload });
        }
      } catch (err) {
        // console.warn (console.log is ESLint-blocked per project convention).
        console.warn(
          JSON.stringify({
            event: 'task_inbox.send_event_failed',
            task_id: id,
            workflow_instance_id: row.workflow_instance_id,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }

  return true;
}

/**
 * List open tasks for an org — unresolved and not yet expired — newest
 * first. The tray polls this; older expired rows are filtered out so the
 * UI never offers a stale option that the workflow can no longer honor.
 */
export async function listOpenTasks(env: Env, orgId: string): Promise<TaskInboxView[]> {
  const now = Date.now();
  const { data } = await dbQuery<TaskInboxRow>(
    env.DB,
    `SELECT * FROM ai_task_inbox
       WHERE org_id = ?
         AND resolved_at IS NULL
         AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 100`,
    [orgId, now],
  );
  return data.map(toView);
}

/**
 * Sweep helper — for every expired+unresolved task with a `default_choice`,
 * auto-resolve via {@link resolveTask}. Returns the number of rows
 * defaulted. Intended for the every-minute scheduled handler.
 */
export async function applyExpiredDefaults(env: Env): Promise<number> {
  const now = Date.now();
  const { data } = await dbQuery<TaskInboxRow>(
    env.DB,
    `SELECT * FROM ai_task_inbox
       WHERE resolved_at IS NULL
         AND expires_at <= ?
         AND default_choice IS NOT NULL
       LIMIT 200`,
    [now],
  );
  if (data.length === 0) return 0;

  let resolved = 0;
  for (const row of data) {
    const ok = await resolveTask(env, row.id, {
      choice: row.default_choice as string,
      by: 'system:expired-default',
      autoDefaulted: true,
    });
    if (ok) resolved++;
  }
  return resolved;
}

/**
 * Soft delete — mostly for test cleanup. Production code should let the
 * sweep handle expiry rather than purging rows directly so the audit
 * trail of resolved tasks remains queryable.
 */
export async function deleteTask(env: Env, id: string): Promise<void> {
  await dbExecute(env.DB, 'DELETE FROM ai_task_inbox WHERE id = ?', [id]);
}
