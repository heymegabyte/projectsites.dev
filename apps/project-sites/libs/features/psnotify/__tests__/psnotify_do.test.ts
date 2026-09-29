/**
 * Unit tests for {@link PsNotifyDO} — the psnotify inbox Durable Object.
 *
 * TDD-first proof of the core slice: add → list → markRead. The DO's
 * `this.ctx.storage.sql` is backed by a REAL in-memory `node:sqlite`
 * DatabaseSync, so these tests exercise the exact SQL the DO runs (INSERT,
 * the newest-first + unread-only SELECTs, the idempotent UPDATE, the unread
 * COUNT, and `rowsWritten`) — not a call recorder. This is the
 * real-SQLite aggregator harness pattern (see MEMORY: real-sqlite-harness).
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * A minimal `SqlStorage`-shaped shim over node:sqlite. `exec(sql, ...params)`
 * mirrors the CF `ctx.storage.sql.exec` contract: it runs the statement,
 * exposes `rowsWritten`, and returns a cursor with `.toArray()` / `.one()`.
 * A multi-statement string (the schema DDL) routes through `db.exec`.
 */
function makeSqlStorage() {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(statement: string, ...params: unknown[]) {
      const isMulti = statement.trim().includes(';') && /CREATE|INDEX/i.test(statement);
      if (isMulti) {
        db.exec(statement);
        return { toArray: () => [], one: () => ({}), rowsWritten: 0 };
      }
      const stmt = db.prepare(statement);
      const isSelect = /^\s*SELECT/i.test(statement);
      if (isSelect) {
        const rows = stmt.all(...(params as never[]));
        return { toArray: () => rows, one: () => rows[0], rowsWritten: 0 };
      }
      const info = stmt.run(...(params as never[]));
      // The real CF cursor exposes rowsWritten; mirror node:sqlite's `changes`.
      return { toArray: () => [], one: () => ({}), rowsWritten: Number(info.changes ?? 0) };
    },
  };
  return { ctx: { storage: { sql } } };
}

// Mock the CF runtime module: DurableObject base wires the provided ctx/env.
jest.mock(
  'cloudflare:workers',
  () => ({
    __esModule: true,
    DurableObject: class {
      ctx: unknown;
      env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  }),
  { virtual: true },
);

import { PsNotifyDO } from '../do.js';

function makeDO(): PsNotifyDO {
  const { ctx } = makeSqlStorage();
  return new PsNotifyDO(ctx as never, {} as never);
}

describe('PsNotifyDO — add → list → markRead (real SQLite)', () => {
  it('add() stores a row with a UUIDv7 id, unread, and returns it', async () => {
    const inbox = makeDO();
    const n = await inbox.add({ type: 'site.published', title: 'Your site is live 🎉' });

    expect(n.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // `site.published` coerces to the canonical `site_lifecycle` bucket.
    expect(n.type).toBe('site_lifecycle');
    expect(n.title).toBe('Your site is live 🎉');
    expect(n.body).toBe('');
    expect(n.action_url).toBeNull();
    expect(n.read_at).toBeNull();
    expect(typeof n.created_at).toBe('number');
  });

  it('list() returns stored notifications newest-first with the unread count', async () => {
    const inbox = makeDO();
    await inbox.add({ type: 'a', title: 'first' });
    await inbox.add({ type: 'b', title: 'second', body: 'hello', action_url: 'https://x.dev/y' });

    const { notifications, unread } = await inbox.list({} as never);
    expect(notifications).toHaveLength(2);
    // UUIDv7 is time-ordered → the most-recent add sorts first.
    expect(notifications[0].title).toBe('second');
    expect(notifications[0].action_url).toBe('https://x.dev/y');
    expect(notifications[1].title).toBe('first');
    expect(unread).toBe(2);
  });

  it('markRead() stamps read_at, is idempotent, and reports whether a row changed', async () => {
    const inbox = makeDO();
    const n = await inbox.add({ type: 'a', title: 'unread' });

    const firstMark = await inbox.markRead(n.id);
    expect(firstMark).toBe(true);

    // Re-marking the same (already-read) row changes nothing.
    const secondMark = await inbox.markRead(n.id);
    expect(secondMark).toBe(false);

    // Unknown id → no change.
    expect(await inbox.markRead('does-not-exist')).toBe(false);
    // Empty id → guarded false, never a SQL error.
    expect(await inbox.markRead('')).toBe(false);

    const after = await inbox.list({} as never);
    expect(after.notifications[0].read_at).toEqual(expect.any(Number));
    expect(after.unread).toBe(0);
  });

  it('list({unreadOnly:true}) filters out read rows but unread count stays global-accurate', async () => {
    const inbox = makeDO();
    const a = await inbox.add({ type: 'a', title: 'read-me' });
    await inbox.add({ type: 'b', title: 'still-unread' });
    await inbox.markRead(a.id);

    const { notifications, unread } = await inbox.list({ unreadOnly: true } as never);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('still-unread');
    expect(unread).toBe(1);
  });

  it('list({limit}) clamps the returned set', async () => {
    const inbox = makeDO();
    for (let i = 0; i < 5; i++) await inbox.add({ type: 't', title: `n${i}` });
    const { notifications, unread } = await inbox.list({ limit: 2 } as never);
    expect(notifications).toHaveLength(2);
    // Unread count is independent of the page limit.
    expect(unread).toBe(5);
  });

  it('fetch() routes POST /add, GET /list, POST /read for cross-isolate stub calls', async () => {
    const inbox = makeDO();

    const addRes = await inbox.fetch(
      new Request('http://do/add', {
        method: 'POST',
        body: JSON.stringify({ type: 'x', title: 'via fetch' }),
      }),
    );
    expect(addRes.status).toBe(200);
    const added = (await addRes.json()) as { id: string };
    expect(added.id).toBeTruthy();

    const listRes = await inbox.fetch(new Request('http://do/list?unreadOnly=1&limit=10'));
    const listed = (await listRes.json()) as { notifications: unknown[]; unread: number };
    expect(listed.notifications).toHaveLength(1);
    expect(listed.unread).toBe(1);

    const readRes = await inbox.fetch(
      new Request('http://do/read', { method: 'POST', body: JSON.stringify({ id: added.id }) }),
    );
    expect(await readRes.json()).toEqual({ ok: true, updated: true });
  });

  it('fetch() rejects an invalid add payload with 400 (strict schema)', async () => {
    const inbox = makeDO();
    const res = await inbox.fetch(
      new Request('http://do/add', { method: 'POST', body: JSON.stringify({ title: 'no type' }) }),
    );
    expect(res.status).toBe(400);
  });

  it('add() coerces a live free-form workflow type into a canonical enum type', async () => {
    const inbox = makeDO();
    // The live notifyUser transport passes `workflowId` as `type` (e.g. 'site-published',
    // the default 'ps-notify', or a notifyEvent name). None of these are canonical enum
    // members, so a hard enum would REJECT every live write. add() must instead COERCE.
    const published = await inbox.add({ type: 'site-published', title: 'live 🎉' });
    expect(published.type).toBe('site_lifecycle');

    const unknown = await inbox.add({ type: 'ps-notify', title: 'generic' });
    expect(unknown.type).toBe('system');

    const domain = await inbox.add({ type: 'domain_active', title: 'connected 🌐' });
    expect(domain.type).toBe('domain');

    // A caller that already passes a canonical type is preserved verbatim.
    const canonical = await inbox.add({ type: 'billing', title: 'payment received' });
    expect(canonical.type).toBe('billing');
  });

  it('markAllRead() stamps every unread row, is idempotent, and returns the count changed', async () => {
    const inbox = makeDO();
    await inbox.add({ type: 'a', title: 'one' });
    await inbox.add({ type: 'b', title: 'two' });
    await inbox.add({ type: 'c', title: 'three' });

    // First sweep marks all three unread rows read.
    expect(await inbox.markAllRead()).toBe(3);

    const after = await inbox.list({} as never);
    expect(after.unread).toBe(0);
    expect(after.notifications.every((n) => typeof n.read_at === 'number')).toBe(true);

    // Idempotent — a second sweep changes nothing.
    expect(await inbox.markAllRead()).toBe(0);
  });

  it('markAllRead() on an empty inbox is a guarded no-op (never a SQL error)', async () => {
    const inbox = makeDO();
    expect(await inbox.markAllRead()).toBe(0);
  });

  it('fetch() routes POST /read-all for cross-isolate stub calls', async () => {
    const inbox = makeDO();
    await inbox.add({ type: 'a', title: 'one' });
    await inbox.add({ type: 'b', title: 'two' });

    const res = await inbox.fetch(new Request('http://do/read-all', { method: 'POST' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, updated: 2 });

    const after = await inbox.list({} as never);
    expect(after.unread).toBe(0);
  });
});
