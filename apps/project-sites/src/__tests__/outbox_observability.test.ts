import {
  outboxStats,
  readFailedOutbox,
  requeueFailedOutbox,
  pruneDispatchedOutbox,
  MAX_OUTBOX_ATTEMPTS,
} from '../services/event_bus';

/**
 * Observability read-layer for the durable outbox: outboxStats (bucket counts,
 * splitting failed → retrying/dead-lettered at MAX_OUTBOX_ATTEMPTS) and
 * readFailedOutbox (newest-first failed rows, triage fields only, limit clamped).
 * D1 stubs — no network.
 */

/** D1 stub whose .first() resolves to the given row (for outboxStats). */
function firstDb(row: unknown) {
  return {
    DB: { prepare: () => ({ bind: () => ({ first: async () => row }) }) },
  } as never;
}

/** Env stub capturing the bound LIMIT and resolving .all() to the given rows. */
function allDb(rows: unknown[]) {
  const captured: { limit?: unknown } = {};
  const env = {
    _captured: captured,
    DB: {
      prepare: () => ({
        bind: (limit: unknown) => {
          captured.limit = limit;
          return { all: async () => ({ results: rows }) };
        },
      }),
    },
  } as unknown as { _captured: { limit?: unknown } };
  return env as never;
}

describe('outboxStats', () => {
  it('maps the aggregate row into the four buckets', async () => {
    const stats = await outboxStats(
      firstDb({ pending: 3, dispatched: 1200, retrying: 1, dead_lettered: 2 }),
    );
    expect(stats).toEqual({ pending: 3, dispatched: 1200, retrying: 1, deadLettered: 2 });
  });

  it('coerces null counts (empty table) to zero', async () => {
    const stats = await outboxStats(
      firstDb({ pending: null, dispatched: null, retrying: null, dead_lettered: null }),
    );
    expect(stats).toEqual({ pending: 0, dispatched: 0, retrying: 0, deadLettered: 0 });
  });
});

describe('readFailedOutbox', () => {
  it('derives deadLettered from attempts >= MAX_OUTBOX_ATTEMPTS', async () => {
    const rows = [
      {
        id: 'a',
        type: 'invoice.paid',
        tenant_id: 't1',
        attempts: MAX_OUTBOX_ATTEMPTS,
        last_error: 'hatchet:500',
        created_at: '2026-06-20T00:00:00Z',
      },
      {
        id: 'b',
        type: 'site.created',
        tenant_id: 't2',
        attempts: 1,
        last_error: 'hatchet:599',
        created_at: '2026-06-20T00:01:00Z',
      },
    ];
    const out = await readFailedOutbox(allDb(rows));
    expect(out[0]).toEqual(
      expect.objectContaining({
        id: 'a',
        tenantId: 't1',
        lastError: 'hatchet:500',
        deadLettered: true,
      }),
    );
    expect(out[1]).toEqual(expect.objectContaining({ id: 'b', deadLettered: false }));
  });

  it('clamps the limit to 1..200 and defaults to 50', async () => {
    const db = allDb([]);
    const cap = (db as unknown as { _captured: { limit?: unknown } })._captured;
    await readFailedOutbox(db);
    expect(cap.limit).toBe(50);
    await readFailedOutbox(db, 9999);
    expect(cap.limit).toBe(200);
    await readFailedOutbox(db, 0);
    expect(cap.limit).toBe(50); // 0 || 50 → 50
    await readFailedOutbox(db, -5);
    expect(cap.limit).toBe(1); // clamped up to the floor
  });

  it('returns [] when there are no failed rows', async () => {
    expect(await readFailedOutbox(allDb([]))).toEqual([]);
  });
});

/** Env stub capturing the bound id + reporting the given UPDATE row-change count. */
function runDb(changes: number) {
  const captured: { id?: unknown } = {};
  const env = {
    _captured: captured,
    DB: {
      prepare: () => ({
        bind: (id: unknown) => {
          captured.id = id;
          return { run: async () => ({ meta: { changes } }) };
        },
      }),
    },
  } as unknown as { _captured: { id?: unknown } };
  return env as never;
}

describe('requeueFailedOutbox', () => {
  it('returns requeued:true and binds the id when a failed row is reset', async () => {
    const db = runDb(1);
    const out = await requeueFailedOutbox(db, 'evt_123');
    expect(out).toEqual({ requeued: true });
    expect((db as unknown as { _captured: { id?: unknown } })._captured.id).toBe('evt_123');
  });

  it('returns requeued:false when no failed row matches (0 changes)', async () => {
    expect(await requeueFailedOutbox(runDb(0), 'missing')).toEqual({ requeued: false });
  });
});

describe('pruneDispatchedOutbox', () => {
  it('deletes dispatched rows and returns the count, binding the day modifier', async () => {
    const db = runDb(4120);
    const out = await pruneDispatchedOutbox(db, 30);
    expect(out).toEqual({ deleted: 4120 });
    expect((db as unknown as { _captured: { id?: unknown } })._captured.id).toBe('-30 days');
  });

  it('clamps a non-positive window up to a 1-day floor', async () => {
    const db = runDb(0);
    await pruneDispatchedOutbox(db, 0);
    expect((db as unknown as { _captured: { id?: unknown } })._captured.id).toBe('-30 days'); // 0 || 30 → 30
    await pruneDispatchedOutbox(db, -5);
    expect((db as unknown as { _captured: { id?: unknown } })._captured.id).toBe('-1 days'); // clamped to floor
  });

  it('defaults to a 30-day window', async () => {
    const db = runDb(0);
    await pruneDispatchedOutbox(db);
    expect((db as unknown as { _captured: { id?: unknown } })._captured.id).toBe('-30 days');
  });
});
