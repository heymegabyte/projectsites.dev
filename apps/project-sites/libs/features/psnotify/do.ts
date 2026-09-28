/**
 * @module libs/features/psnotify/do
 * @description SQLite-backed Durable Object — the psnotify notification inbox.
 *
 * One DO instance per user (resolve with `env.PSNOTIFY_DO.getByName(userId)`),
 * so a user's notifications are strongly isolated in their own DO storage — a
 * caller can only ever reach the inbox for the key it resolved. Replaces the
 * old Novu/psnotify-stub in-app channel with zero D1 tables (DO-backed).
 *
 * ## Methods (also reachable via `fetch()` for cross-isolate stub calls)
 * - `add(notification)`   — INSERT one row (id=UUIDv7, read_at=null).
 * - `list({unreadOnly,limit})` — the inbox, newest-first, + the unread count.
 * - `markRead(id)`        — stamp `read_at`; idempotent; returns whether a row changed.
 *
 * Schema is embedded + run idempotently on first touch (`CREATE TABLE IF NOT
 * EXISTS`), so a cold DO is self-healing. The class is registered under the
 * SQLite storage backend via `new_sqlite_classes` in `wrangler.toml`.
 *
 * @packageDocumentation
 */

import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../../../src/types/env.js';
import { uuidv7 } from '../../../src/lib/uuid.js';
import {
  AddNotificationInputSchema,
  ListQuerySchema,
  type AddNotificationInput,
  type ListQuery,
  type ListResponse,
  type Notification,
} from './schemas.js';

/** Embedded DDL — the single source of truth for the inbox table + its recency index. */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  action_url  TEXT,
  read_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(read_at, created_at DESC);
`;

/**
 * Row shape for `ctx.storage.sql.exec<NotificationRow>(...)`. The index
 * signature satisfies the `Record<string, SqlStorageValue>` constraint the
 * typed cursor requires before it will widen into the named interface.
 */
interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  action_url: string | null;
  read_at: number | null;
  created_at: number;
  [key: string]: SqlStorageValue;
}

/** Map a raw SQL row to the public {@link Notification} shape (nulls preserved). */
function rowToNotification(r: NotificationRow): Notification {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    body: r.body ?? '',
    action_url: r.action_url ?? null,
    read_at: r.read_at ?? null,
    created_at: r.created_at,
  };
}

/**
 * The psnotify inbox Durable Object.
 *
 * @example
 * ```ts
 * const inbox = env.PSNOTIFY_DO!.getByName(userId);
 * await inbox.add({ type: 'site.published', title: 'Your site is live 🎉' });
 * const { notifications, unread } = await inbox.list({ unreadOnly: true });
 * ```
 */
export class PsNotifyDO extends DurableObject<Env> {
  /** Flipped true after `ensureSchema` runs once for the DO's lifetime. */
  private schemaReady = false;

  /** SQL storage handle (always present — the class is SQLite-backed by migration). */
  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  /** Idempotently create the table + indexes. `CREATE ... IF NOT EXISTS` → safe every call. */
  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql.exec(SCHEMA_SQL);
    this.schemaReady = true;
  }

  /**
   * Insert one notification. Mints a UUIDv7 `id` + `created_at`; `read_at` starts null.
   *
   * @param input - Validated against {@link AddNotificationInputSchema}.
   * @returns The stored {@link Notification}.
   */
  async add(input: AddNotificationInput): Promise<Notification> {
    this.ensureSchema();
    const parsed = AddNotificationInputSchema.parse(input);
    const row: Notification = {
      id: uuidv7(),
      type: parsed.type,
      title: parsed.title,
      body: parsed.body,
      action_url: parsed.action_url,
      read_at: null,
      created_at: Date.now(),
    };
    this.sql.exec(
      `INSERT INTO notifications (id, type, title, body, action_url, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.type,
      row.title,
      row.body,
      row.action_url,
      row.read_at,
      row.created_at,
    );
    return row;
  }

  /**
   * The inbox, newest-first. When `unreadOnly`, only rows with `read_at IS NULL`.
   * Always returns the total unread count (independent of `limit`/`unreadOnly`).
   *
   * @param query - Validated against {@link ListQuerySchema}.
   */
  async list(query: ListQuery = {} as ListQuery): Promise<ListResponse> {
    this.ensureSchema();
    const { unreadOnly, limit } = ListQuerySchema.parse(query);
    const where = unreadOnly ? 'WHERE read_at IS NULL' : '';
    // `rowid DESC` breaks same-millisecond ties by insertion order (monotonic),
    // so ordering is deterministic even when several notifications share created_at.
    const rows = this.sql
      .exec<NotificationRow>(
        `SELECT id, type, title, body, action_url, read_at, created_at
           FROM notifications ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        limit,
      )
      .toArray();
    const unreadRow = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL`)
      .one();
    return { notifications: rows.map(rowToNotification), unread: Number(unreadRow.n ?? 0) };
  }

  /**
   * Mark one notification read (idempotent — re-marking a read row is a no-op).
   *
   * @param id - The notification id.
   * @returns `true` when an unread row was stamped, `false` when the id is unknown or already read.
   */
  async markRead(id: string): Promise<boolean> {
    this.ensureSchema();
    if (!id) return false;
    // `rowsWritten` lives on the cursor returned by exec(), not on SqlStorage.
    const cursor = this.sql.exec(
      `UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`,
      Date.now(),
      id,
    );
    return cursor.rowsWritten > 0;
  }

  /**
   * HTTP surface for cross-isolate stub calls (`stub.fetch(...)`). The public
   * `/api/notifications` handlers reach the inbox through here.
   *
   * - `POST /add`   `{type,title,body?,action_url?}` → `Notification`
   * - `GET  /list?unreadOnly&limit`                  → `ListResponse`
   * - `POST /read`  `{id}`                            → `{ ok, updated }`
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/add') {
      const body = (await request.json().catch(() => ({}))) as unknown;
      const parsed = AddNotificationInputSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: parsed.error.flatten() }, { status: 400 });
      }
      return Response.json(await this.add(parsed.data));
    }
    if (request.method === 'GET' && url.pathname === '/list') {
      const q = ListQuerySchema.safeParse({
        unreadOnly: url.searchParams.get('unreadOnly') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      if (!q.success) return Response.json({ error: q.error.flatten() }, { status: 400 });
      return Response.json(await this.list(q.data));
    }
    if (request.method === 'POST' && url.pathname === '/read') {
      const { id } = (await request.json().catch(() => ({}))) as { id?: string };
      const updated = await this.markRead(id ?? '');
      return Response.json({ ok: true, updated });
    }
    return new Response('not found', { status: 404 });
  }
}
