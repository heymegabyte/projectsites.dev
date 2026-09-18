/**
 * task_inbox — AI task elicitation inbox service (convergence r34).
 *
 * Locks the workflow↔admin-tray bridge: postAskUser's row insert (UUID +
 * unix-ms expiry, default + custom timeout, options-JSON/null, optional
 * workflow/createdBy), resolveTask's resolve-once guard + stamped payload
 * + best-effort SITE_GENERATION.sendEvent fan-out (present / absent /
 * throwing binding, no-workflow short-circuit), listOpenTasks's
 * org-scoped/unresolved/unexpired filter + view hydration (options +
 * resolution parse, including bad-JSON tolerance), applyExpiredDefaults's
 * sweep (empty set, default-only auto-resolve, resolved count), and
 * deleteTask's hard delete.
 *
 * The `db.js` helpers are jest-mocked (no real D1). `crypto.randomUUID` and
 * `Date.now` are pinned for deterministic id/expiry assertions. ts-jest
 * global `jest`; casts via `as unknown as jest.Mock`.
 */

jest.mock('../services/db.js', () => ({
  dbQuery: jest.fn().mockResolvedValue({ data: [], error: null }),
  dbQueryOne: jest.fn().mockResolvedValue(null),
  dbInsert: jest.fn().mockResolvedValue({ error: null }),
  dbUpdate: jest.fn().mockResolvedValue({ error: null, changes: 1 }),
  dbExecute: jest.fn().mockResolvedValue({ error: null, changes: 0 }),
}));

import {
  postAskUser,
  resolveTask,
  listOpenTasks,
  applyExpiredDefaults,
  deleteTask,
  type TaskInboxRow,
} from '../services/task_inbox.js';
import { dbExecute, dbInsert, dbQuery, dbQueryOne, dbUpdate } from '../services/db.js';
import type { Env } from '../types/env.js';

const mockInsert = dbInsert as unknown as jest.Mock;
const mockQuery = dbQuery as unknown as jest.Mock;
const mockQueryOne = dbQueryOne as unknown as jest.Mock;
const mockUpdate = dbUpdate as unknown as jest.Mock;
const mockExecute = dbExecute as unknown as jest.Mock;

const NOW = 1_700_000_000_000;
const FIXED_UUID = '11111111-2222-4333-8444-555555555555';

/** Minimal Env stub; pass overrides to wire a workflow binding etc. */
function makeEnv(over: Record<string, unknown> = {}): Env {
  return { DB: {} as unknown, ...over } as unknown as Env;
}

/** Build a full ai_task_inbox row, overriding any field. */
function makeRow(over: Partial<TaskInboxRow> = {}): TaskInboxRow {
  return {
    id: 'task-1',
    org_id: 'org-1',
    workflow_instance_id: null,
    task_kind: 'choose_brand_palette',
    prompt: 'Pick a palette',
    options_json: null,
    default_choice: null,
    expires_at: NOW + 1000,
    resolved_at: null,
    resolution_json: null,
    created_at: NOW,
    created_by: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInsert.mockResolvedValue({ error: null });
  mockQuery.mockResolvedValue({ data: [], error: null });
  mockQueryOne.mockResolvedValue(null);
  mockUpdate.mockResolvedValue({ error: null, changes: 1 });
  mockExecute.mockResolvedValue({ error: null, changes: 0 });
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.spyOn(crypto, 'randomUUID').mockReturnValue(FIXED_UUID);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────
// postAskUser — row insert, expiry math, optional fields
// ────────────────────────────────────────────────────────────
describe('postAskUser', () => {
  it('inserts a row and returns id + default-timeout (30m) expiry', async () => {
    const out = await postAskUser(makeEnv(), {
      orgId: 'org-1',
      taskKind: 'choose_brand_palette',
      prompt: 'Pick a palette',
    });

    expect(out).toEqual({ id: FIXED_UUID, expiresAt: NOW + 30 * 60 * 1000 });
    expect(mockInsert).toHaveBeenCalledTimes(1);
    const [, table, record] = mockInsert.mock.calls[0];
    expect(table).toBe('ai_task_inbox');
    expect(record).toMatchObject({
      id: FIXED_UUID,
      org_id: 'org-1',
      task_kind: 'choose_brand_palette',
      prompt: 'Pick a palette',
      created_at: NOW,
      resolved_at: null,
      resolution_json: null,
    });
  });

  it('honors a custom timeoutMs in the expiry', async () => {
    const out = await postAskUser(makeEnv(), {
      orgId: 'org-1',
      taskKind: 'k',
      prompt: 'p',
      timeoutMs: 5 * 60 * 1000,
    });
    expect(out.expiresAt).toBe(NOW + 5 * 60 * 1000);
    expect(mockInsert.mock.calls[0][2].expires_at).toBe(NOW + 5 * 60 * 1000);
  });

  it('serializes a non-empty options array to JSON', async () => {
    await postAskUser(makeEnv(), {
      orgId: 'org-1',
      taskKind: 'k',
      prompt: 'p',
      options: ['cyan', 'maroon'],
    });
    expect(mockInsert.mock.calls[0][2].options_json).toBe(JSON.stringify(['cyan', 'maroon']));
  });

  it('stores options_json as null for an empty options array', async () => {
    await postAskUser(makeEnv(), { orgId: 'org-1', taskKind: 'k', prompt: 'p', options: [] });
    expect(mockInsert.mock.calls[0][2].options_json).toBeNull();
  });

  it('persists optional workflowInstanceId, defaultChoice, and createdBy', async () => {
    await postAskUser(makeEnv(), {
      orgId: 'org-1',
      taskKind: 'k',
      prompt: 'p',
      workflowInstanceId: 'wf-9',
      defaultChoice: 'cyan',
      createdBy: 'user-7',
    });
    const rec = mockInsert.mock.calls[0][2];
    expect(rec.workflow_instance_id).toBe('wf-9');
    expect(rec.default_choice).toBe('cyan');
    expect(rec.created_by).toBe('user-7');
  });

  it('nulls the optional fields when omitted', async () => {
    await postAskUser(makeEnv(), { orgId: 'org-1', taskKind: 'k', prompt: 'p' });
    const rec = mockInsert.mock.calls[0][2];
    expect(rec.workflow_instance_id).toBeNull();
    expect(rec.default_choice).toBeNull();
    expect(rec.created_by).toBeNull();
  });

  it('THROWS on a dropped insert instead of returning a phantom id (no lying-success)', async () => {
    // dbInsert returns { error } and NEVER throws. A silently-dropped INSERT would
    // strand the workflow on a task row that does not exist — `waitForEvent` times
    // out the full window and the step's retry is defeated. postAskUser must fail
    // loud so the workflow step RETRIES the post rather than proceeding blind.
    mockInsert.mockResolvedValueOnce({ error: 'D1_ERROR: database is locked' });
    await expect(
      postAskUser(makeEnv(), { orgId: 'org-1', taskKind: 'k', prompt: 'p' }),
    ).rejects.toThrow(/failed to persist task/);
  });
});

// ────────────────────────────────────────────────────────────
// resolveTask — not-found / already-resolved / update guards
// ────────────────────────────────────────────────────────────
describe('resolveTask (guards)', () => {
  it('returns false when the id is unknown', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const ok = await resolveTask(makeEnv(), 'nope', { choice: 'x' });
    expect(ok).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns false when the task is already resolved', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRow({ resolved_at: NOW - 100 }));
    const ok = await resolveTask(makeEnv(), 'task-1', { choice: 'x' });
    expect(ok).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('returns false when the conditional UPDATE matches zero rows (lost race)', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRow());
    mockUpdate.mockResolvedValueOnce({ error: null, changes: 0 });
    const ok = await resolveTask(makeEnv(), 'task-1', { choice: 'x' });
    expect(ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// resolveTask — success + stamped payload + workflow fan-out
// ────────────────────────────────────────────────────────────
describe('resolveTask (success + fan-out)', () => {
  it('marks resolved with a stamped payload and returns true (no workflow)', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRow({ workflow_instance_id: null }));
    const ok = await resolveTask(makeEnv(), 'task-1', { choice: 'cyan', by: 'user-7' });

    expect(ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [, table, updates, where, params] = mockUpdate.mock.calls[0];
    expect(table).toBe('ai_task_inbox');
    expect(updates.resolved_at).toBe(NOW);
    expect(where).toBe('id = ? AND resolved_at IS NULL');
    expect(params).toEqual(['task-1']);
    const payload = JSON.parse(updates.resolution_json);
    expect(payload).toEqual({ choice: 'cyan', by: 'user-7', at: NOW });
  });

  it('omits autoDefaulted unless explicitly true', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRow());
    await resolveTask(makeEnv(), 'task-1', { choice: 'x', autoDefaulted: false });
    const payload = JSON.parse(mockUpdate.mock.calls[0][2].resolution_json);
    expect(payload.autoDefaulted).toBeUndefined();
  });

  it('keeps autoDefaulted:true when an expired default resolves', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRow());
    await resolveTask(makeEnv(), 'task-1', { choice: 'x', autoDefaulted: true });
    const payload = JSON.parse(mockUpdate.mock.calls[0][2].resolution_json);
    expect(payload.autoDefaulted).toBe(true);
  });

  it('sends a task-resolved event into the workflow via SITE_WORKFLOW.get(id).sendEvent({type,payload})', async () => {
    const sendEvent = jest.fn().mockResolvedValue(undefined);
    const get = jest.fn().mockResolvedValue({ sendEvent });
    mockQueryOne.mockResolvedValueOnce(makeRow({ workflow_instance_id: 'wf-42' }));
    const env = makeEnv({ SITE_WORKFLOW: { get } });

    const ok = await resolveTask(env, 'task-1', { choice: 'navy' });

    expect(ok).toBe(true);
    // Workflows-v2 GA shape (AL-773): get the instance by id, then sendEvent({type, payload}).
    expect(get).toHaveBeenCalledWith('wf-42');
    expect(sendEvent).toHaveBeenCalledTimes(1);
    const [event] = sendEvent.mock.calls[0];
    expect(event.type).toBe('task-resolved-task-1'); // dot-free, matches step.waitForEvent
    expect(event.payload).toMatchObject({ choice: 'navy', at: NOW });
  });

  it('does not send an event when the task has no workflow_instance_id', async () => {
    const sendEvent = jest.fn();
    const get = jest.fn().mockResolvedValue({ sendEvent });
    mockQueryOne.mockResolvedValueOnce(makeRow({ workflow_instance_id: null }));
    await resolveTask(makeEnv({ SITE_WORKFLOW: { get } }), 'task-1', { choice: 'x' });
    expect(get).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('resolves true even when the binding lacks the get/sendEvent API (older runtime)', async () => {
    mockQueryOne.mockResolvedValueOnce(makeRow({ workflow_instance_id: 'wf-1' }));
    const env = makeEnv({ SITE_WORKFLOW: {} }); // no .get → notify path no-ops, row stays resolved
    await expect(resolveTask(env, 'task-1', { choice: 'x' })).resolves.toBe(true);
  });

  it('swallows a sendEvent throw — the row stays resolved (best-effort)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const sendEvent = jest.fn().mockRejectedValue(new Error('instance dead'));
    const get = jest.fn().mockResolvedValue({ sendEvent });
    mockQueryOne.mockResolvedValueOnce(makeRow({ workflow_instance_id: 'wf-77' }));
    const env = makeEnv({ SITE_WORKFLOW: { get } });

    const ok = await resolveTask(env, 'task-1', { choice: 'x' });

    expect(ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged.event).toBe('task_inbox.send_event_failed');
    expect(logged.task_id).toBe('task-1');
  });
});

// ────────────────────────────────────────────────────────────
// listOpenTasks — org-scoped, unresolved, unexpired, hydrated views
// ────────────────────────────────────────────────────────────
describe('listOpenTasks', () => {
  it('queries org + unresolved + unexpired and returns [] when empty', async () => {
    mockQuery.mockResolvedValueOnce({ data: [], error: null });
    const out = await listOpenTasks(makeEnv(), 'org-9');

    expect(out).toEqual([]);
    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('org_id = ?');
    expect(sql).toContain('resolved_at IS NULL');
    expect(sql).toContain('expires_at > ?');
    expect(sql).toContain('ORDER BY created_at DESC');
    expect(params).toEqual(['org-9', NOW]);
  });

  it('hydrates a row into a camelCase view with parsed options', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [
        makeRow({
          id: 't-1',
          org_id: 'org-9',
          workflow_instance_id: 'wf-2',
          options_json: JSON.stringify(['a', 'b']),
          default_choice: 'a',
          created_by: 'u-1',
        }),
      ],
      error: null,
    });

    const [view] = await listOpenTasks(makeEnv(), 'org-9');
    expect(view).toEqual({
      id: 't-1',
      orgId: 'org-9',
      workflowInstanceId: 'wf-2',
      taskKind: 'choose_brand_palette',
      prompt: 'Pick a palette',
      options: ['a', 'b'],
      defaultChoice: 'a',
      expiresAt: NOW + 1000,
      resolvedAt: null,
      resolution: null,
      createdAt: NOW,
      createdBy: 'u-1',
    });
  });

  it('parses a stored resolution payload into the view', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [makeRow({ resolution_json: JSON.stringify({ choice: 'navy', by: 'u', at: NOW }) })],
      error: null,
    });
    const [view] = await listOpenTasks(makeEnv(), 'org-1');
    expect(view.resolution).toEqual({ choice: 'navy', by: 'u', at: NOW });
  });

  it('treats malformed options_json as an empty option set', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [makeRow({ options_json: '{not json' })],
      error: null,
    });
    const [view] = await listOpenTasks(makeEnv(), 'org-1');
    expect(view.options).toEqual([]);
  });

  it('filters non-string entries out of options_json', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [makeRow({ options_json: JSON.stringify(['ok', 5, null, 'fine']) })],
      error: null,
    });
    const [view] = await listOpenTasks(makeEnv(), 'org-1');
    expect(view.options).toEqual(['ok', 'fine']);
  });

  it('treats malformed resolution_json as null resolution', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [makeRow({ resolution_json: 'broken' })],
      error: null,
    });
    const [view] = await listOpenTasks(makeEnv(), 'org-1');
    expect(view.resolution).toBeNull();
  });

  it('treats a resolution without a string choice as null', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [makeRow({ resolution_json: JSON.stringify({ by: 'u', at: NOW }) })],
      error: null,
    });
    const [view] = await listOpenTasks(makeEnv(), 'org-1');
    expect(view.resolution).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// applyExpiredDefaults — sweep of expired tasks with a default_choice
// ────────────────────────────────────────────────────────────
describe('applyExpiredDefaults', () => {
  it('queries expired + unresolved + default-present and returns 0 when none', async () => {
    mockQuery.mockResolvedValueOnce({ data: [], error: null });
    const n = await applyExpiredDefaults(makeEnv());

    expect(n).toBe(0);
    const [, sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('resolved_at IS NULL');
    expect(sql).toContain('expires_at <= ?');
    expect(sql).toContain('default_choice IS NOT NULL');
    expect(params).toEqual([NOW]);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('auto-resolves each expired task with its default_choice and counts successes', async () => {
    const expired = [
      makeRow({ id: 't-a', default_choice: 'cyan' }),
      makeRow({ id: 't-b', default_choice: 'navy' }),
    ];
    // sweep SELECT
    mockQuery.mockResolvedValueOnce({ data: expired, error: null });
    // each resolveTask re-fetches its own row (fresh, unresolved)
    mockQueryOne
      .mockResolvedValueOnce(makeRow({ id: 't-a', default_choice: 'cyan' }))
      .mockResolvedValueOnce(makeRow({ id: 't-b', default_choice: 'navy' }));

    const n = await applyExpiredDefaults(makeEnv());

    expect(n).toBe(2);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    const first = JSON.parse(mockUpdate.mock.calls[0][2].resolution_json);
    expect(first).toEqual({
      choice: 'cyan',
      by: 'system:expired-default',
      at: NOW,
      autoDefaulted: true,
    });
  });

  it('does not count a task that resolveTask reports as already-resolved', async () => {
    mockQuery.mockResolvedValueOnce({
      data: [makeRow({ id: 't-a', default_choice: 'cyan' })],
      error: null,
    });
    // resolveTask re-fetch finds it already resolved → returns false
    mockQueryOne.mockResolvedValueOnce(makeRow({ id: 't-a', resolved_at: NOW - 1 }));

    const n = await applyExpiredDefaults(makeEnv());
    expect(n).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// deleteTask — hard delete by id
// ────────────────────────────────────────────────────────────
describe('deleteTask', () => {
  it('issues a parameterized DELETE for the id', async () => {
    await deleteTask(makeEnv(), 'task-9');
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [, sql, params] = mockExecute.mock.calls[0];
    expect(sql).toBe('DELETE FROM ai_task_inbox WHERE id = ?');
    expect(params).toEqual(['task-9']);
  });
});
