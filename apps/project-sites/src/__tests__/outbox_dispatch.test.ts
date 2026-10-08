import {
  eventDispatchTargets,
  dispatchOutboxEvent,
  drainOutbox,
  assessDrainHealth,
} from '../services/outbox_dispatch';
import type { ProjectSitesEvent } from '../services/event_bus';

/**
 * Outbox dispatch router — fans event_bus events to Hatchet (orchestration types
 * only). Tinybird removed: pure-analytics events now fan to NO backend. Pure router
 * + DI'd adapter; D1 stubbed for the drain. No real network/DB.
 */
function ev(type: string, over: Partial<ProjectSitesEvent> = {}): ProjectSitesEvent {
  return {
    id: 'evt_1',
    type,
    tenantId: 't1',
    siteId: 's1',
    traceId: 'tr1',
    producer: 'worker',
    time: '2026-06-19T00:00:00Z',
    specversion: '1.0',
    schemaVersion: '1',
    source: 'worker',
    datacontenttype: 'application/json',
    data: {},
    ...over,
  } as ProjectSitesEvent;
}
const ENV = {} as never;

describe('eventDispatchTargets', () => {
  it('routes orchestration types to Hatchet only', () => {
    expect(eventDispatchTargets(ev('site.published'))).toEqual(['hatchet']);
    expect(eventDispatchTargets(ev('invoice.paid'))).toEqual(['hatchet']);
  });
  it('routes a pure-analytics event to NO backend (Tinybird removed)', () => {
    expect(eventDispatchTargets(ev('site.created'))).toEqual([]);
  });
});

describe('dispatchOutboxEvent', () => {
  it('skips an unconfigured backend (not a failure) → ok with no attempts', async () => {
    const r = await dispatchOutboxEvent(ENV, ev('site.published'));
    expect(r.ok).toBe(true);
    expect(r.attempted).toEqual([]);
  });

  it('a pure-analytics event has no targets → ok, nothing attempted', async () => {
    const push = jest.fn();
    const r = await dispatchOutboxEvent(ENV, ev('site.created'), { pushHatchet: push as never });
    expect(r.ok).toBe(true);
    expect(r.attempted).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it('sends an orchestration event to Hatchet, tenant-tagged', async () => {
    const push = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const env = { HATCHET_API_TOKEN: hatchetTok() } as never;
    const r = await dispatchOutboxEvent(env, ev('site.published'), {
      pushHatchet: push as never,
    });
    expect(r.ok).toBe(true);
    expect(r.attempted).toEqual(['hatchet']);
    expect(push).toHaveBeenCalled();
    const [, key, , opts] = push.mock.calls[0];
    expect(key).toBe('site.published');
    expect(opts.metadata.tenant_id).toBe('t1');
    expect(opts.metadata.site_id).toBe('s1');
  });

  // Regression (incident 2026-09-06): a Hatchet http_error must NOT fail the row.
  // Hatchet is best-effort, so the miss is a SOFT failure only (row stays ok:true),
  // and the drain marks the row dispatched instead of redelivering on retry.
  it('keeps ok:true when a best-effort Hatchet push fails (soft failure)', async () => {
    const push = jest.fn().mockResolvedValue({ ok: false, reason: 'http_error', status: 401 });
    const env = { HATCHET_API_TOKEN: hatchetTok() } as never;
    const r = await dispatchOutboxEvent(env, ev('site.published'), {
      pushHatchet: push as never,
    });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.softFailures).toEqual([{ target: 'hatchet', reason: 'http_error' }]);
  });
});

describe('drainOutbox', () => {
  /** D1 stub: SELECT pending → rows; UPDATEs are recorded. */
  function db(rows: ProjectSitesEvent[]) {
    const updates: string[] = [];
    const stmt = {
      bind: (...a: unknown[]) => {
        stmt._args = a;
        return stmt;
      },
      _args: [] as unknown[],
      all: async () => ({ results: rows.map((r) => ({ payload: JSON.stringify(r) })) }),
      run: async () => {
        updates.push(String(stmt._args[0]));
        return { meta: { changes: 1 } };
      },
      first: async () => null,
    };
    return { db: { prepare: () => stmt } as never, updates };
  }

  it('dispatches pending rows + marks them dispatched', async () => {
    // A pure-analytics event has no backend, so it dispatches cleanly (nothing to send).
    const { db: DB, updates } = db([ev('site.created', { id: 'e1' })]);
    const env = { DB } as never;
    const summary = await drainOutbox(env, { now: () => 'NOW' });
    expect(summary.read).toBe(1);
    expect(summary.dispatched).toBe(1);
    expect(summary.failed).toBe(0);
    expect(updates).toContain('NOW'); // markDispatched bound dispatched_at first
  });

  // Regression (incident 2026-09-06): Hatchet http_error → the row is DISPATCHED
  // (not failed), counted under softFailed. Prevents the retry loop that redelivered
  // orchestration once per drain until the row dead-lettered.
  it('marks the row dispatched (softFailed) when best-effort Hatchet fails', async () => {
    const { db: DB, updates } = db([ev('site.published', { id: 'e1' })]);
    const env = { HATCHET_API_TOKEN: hatchetTok(), DB } as never;
    const summary = await drainOutbox(env, {
      pushHatchet: (async () => ({ ok: false, reason: 'http_error', status: 401 })) as never,
      now: () => 'NOW',
    });
    expect(summary.dispatched).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.softFailed).toBe(1);
    expect(updates).toContain('NOW'); // markDispatched ran, NOT markFailed
  });

  it('returns zeros (never throws) when the read fails', async () => {
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error('db down');
            },
          }),
        }),
      },
    } as never;
    expect(await drainOutbox(env)).toEqual({ read: 0, dispatched: 0, failed: 0 });
  });
});

describe('assessDrainHealth', () => {
  it('is info for a clean drain (no failures, under capacity)', () => {
    const h = assessDrainHealth({ read: 3, dispatched: 3, failed: 0 });
    expect(h).toEqual({
      level: 'info',
      hasFailures: false,
      atCapacity: false,
      message: 'Outbox drained cleanly (3 dispatched)',
    });
  });

  it('is info for an empty drain', () => {
    expect(assessDrainHealth({ read: 0, dispatched: 0, failed: 0 }).level).toBe('info');
  });

  it('warns when events failed dispatch (heading to the dead-letter gate)', () => {
    const h = assessDrainHealth({ read: 5, dispatched: 3, failed: 2 });
    expect(h.level).toBe('warn');
    expect(h.hasFailures).toBe(true);
    expect(h.message).toContain('2 event(s) failed');
  });

  it('warns on soft failures (best-effort backend down) without flagging row failures', () => {
    const h = assessDrainHealth({ read: 4, dispatched: 4, failed: 0, softFailed: 4 });
    expect(h.level).toBe('warn');
    expect(h.hasFailures).toBe(false); // no ROW failures — the row still dispatched
    expect(h.message).toContain('best-effort backend failure');
  });

  it('warns when the page is full (outbox may be backing up)', () => {
    const h = assessDrainHealth({ read: 50, dispatched: 50, failed: 0 }, 50);
    expect(h.level).toBe('warn');
    expect(h.atCapacity).toBe(true);
    expect(h.message).toContain('backing up');
  });

  it('honors a custom limit for the capacity check', () => {
    expect(assessDrainHealth({ read: 10, dispatched: 10, failed: 0 }, 10).atCapacity).toBe(true);
    expect(assessDrainHealth({ read: 9, dispatched: 9, failed: 0 }, 10).atCapacity).toBe(false);
  });

  it('reports both signals when failures AND capacity coincide', () => {
    const h = assessDrainHealth({ read: 50, dispatched: 40, failed: 10 }, 50);
    expect(h.level).toBe('warn');
    expect(h.message).toContain('failed');
    expect(h.message).toContain('backing up');
  });
});

/** A minimal Hatchet JWT (server_url + sub) so resolveHatchet returns config. */
function hatchetTok(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64({})}.${b64({ server_url: 'https://h.run', sub: 'tn' })}.s`;
}
