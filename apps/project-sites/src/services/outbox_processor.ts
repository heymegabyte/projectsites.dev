/**
 * @module services/outbox_processor
 * @description Pure, dependency-injected drain for the transactional outbox
 * (`outbox_events`, migration `0574_outbox_events.sql`). Selects a bounded batch
 * of UNDELIVERED rows (oldest first), hands each to an injected `deliver`
 * callback, and records the outcome with parameterized SQL only.
 *
 * ## Why this exists alongside `outbox_dispatch.ts`
 *
 * {@link ../services/outbox_dispatch | `drainOutbox`} is the PRODUCTION drain —
 * it takes the full Worker `env` and fans each event to Hatchet. This
 * module is the framework-agnostic core: it depends only on a D1-shaped `db` and
 * an injected `deliver(event) => Promise<void>`, so a unit test (or a future
 * Queue consumer with a different sink) drives the whole state machine with no
 * real network and no Worker env. Both share the same `outbox_events` schema and
 * the same `MAX_OUTBOX_ATTEMPTS=5` dead-letter gate ({@link nextStatusAfterFailure}).
 *
 * ## State machine (matches the migration's `status` column)
 *
 * - `pending`     — never attempted; eligible for delivery.
 * - `failed` (attempts < max) — transient failure; eligible for retry.
 * - `failed` (attempts ≥ max) — DEAD-LETTER; NOT re-selected (surfaced in the admin DLQ).
 * - `dispatched`  — delivered; `dispatched_at` set; NEVER re-selected.
 *
 * Re-running is idempotent: only `pending`/retryable-`failed` rows are picked, so
 * a row that already reached `dispatched` is never delivered twice.
 *
 * @example
 * ```ts
 * import { processOutbox } from '../services/outbox_processor.js';
 *
 * const summary = await processOutbox(env.DB, async (event) => {
 *   await myQueue.send(event); // throws on failure → row retried / dead-lettered
 * }, { limit: 20 });
 * // summary => { processed: 7, delivered: 6, failed: 1, dead: 0 }
 * ```
 *
 * @packageDocumentation
 */

import { MAX_OUTBOX_ATTEMPTS } from './event_bus.js';

/**
 * Minimal D1 surface this module needs — the real `D1Database` binding satisfies
 * it, and a hand-rolled stub does too (no `env`, no full binding required).
 */
export interface OutboxProcessorDb {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
      run(): Promise<unknown>;
    };
  };
}

/** One undelivered outbox row, as selected for delivery. */
export interface OutboxEventRow {
  /** Primary key (`outbox_events.id`). */
  readonly id: string;
  /** CloudEvents `type` discriminator. */
  readonly type: string;
  /** Owning tenant. */
  readonly tenant_id: string;
  /** Owning site (nullable). */
  readonly site_id: string | null;
  /** Correlation id. */
  readonly trace_id: string;
  /** Emitting producer. */
  readonly producer: string;
  /** Full CloudEvents JSON envelope (string, as stored). */
  readonly payload: string;
  /** Delivery attempts so far (BEFORE this pass). */
  readonly attempts: number;
}

/** Injected delivery side-effect. Resolves on success; THROWS to signal failure. */
export type OutboxDeliver = (event: OutboxEventRow) => Promise<void>;

/** Tuning knobs for one {@link processOutbox} pass. */
export interface ProcessOutboxOptions {
  /** Max rows to drain this pass (oldest first). Default 20. */
  readonly limit?: number;
  /** Attempt cap before a row is dead-lettered. Default {@link MAX_OUTBOX_ATTEMPTS}. */
  readonly maxAttempts?: number;
  /** Clock seam for `dispatched_at` (ISO string). Default `new Date().toISOString()`. */
  readonly now?: () => string;
}

/** Typed outcome of one drain pass. */
export interface ProcessOutboxSummary {
  /** Rows attempted this pass. */
  readonly processed: number;
  /** Rows delivered + marked `dispatched`. */
  readonly delivered: number;
  /** Rows that failed but stay retryable (below the attempt cap). */
  readonly failed: number;
  /** Rows that failed AND reached the attempt cap (now dead-lettered). */
  readonly dead: number;
}

/** Thrown when the injected `db` is missing — a programming error, not a row failure. */
export class OutboxProcessorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxProcessorError';
  }
}

/**
 * Resulting `status` after a delivery failure — the dead-letter gate.
 *
 * @param attemptsAfter - The attempt count AFTER incrementing for this failure.
 * @param maxAttempts - The cap (default {@link MAX_OUTBOX_ATTEMPTS}).
 * @returns `'dead'` once `attemptsAfter >= maxAttempts`, else `'failed'` (retryable).
 * @example
 * nextStatusAfterFailure(1)  // 'failed'  (retry later)
 * nextStatusAfterFailure(5)  // 'dead'    (cap reached — stop retrying)
 */
export function nextStatusAfterFailure(
  attemptsAfter: number,
  maxAttempts = MAX_OUTBOX_ATTEMPTS,
): 'failed' | 'dead' {
  return attemptsAfter >= maxAttempts ? 'dead' : 'failed';
}

/** Empty-pass summary (no rows undelivered). */
const EMPTY_SUMMARY: ProcessOutboxSummary = { processed: 0, delivered: 0, failed: 0, dead: 0 };

/**
 * Drain a bounded batch of undelivered outbox rows, delivering each via the
 * injected `deliver`. Best-effort + idempotent: only `pending` and retryable
 * `failed` rows (`attempts < maxAttempts`) are selected, oldest first, so a
 * re-run never re-delivers an already-`dispatched` row. Per-row delivery failures
 * are caught and recorded (the row retries or dead-letters) — one bad event never
 * aborts the pass. Parameterized SQL only.
 *
 * @param db - A D1-shaped database (the real binding or a test stub).
 * @param deliver - Side-effect that delivers one event; THROWS on failure.
 * @param opts - Optional `{ limit, maxAttempts, now }`.
 * @returns A typed {@link ProcessOutboxSummary}.
 * @throws {OutboxProcessorError} When `db` is not provided.
 *
 * @example
 * ```ts
 * const s = await processOutbox(env.DB, async (e) => publish(e));
 * console.info(JSON.stringify({ service: 'outbox_processor', ...s }));
 * ```
 */
export async function processOutbox(
  db: OutboxProcessorDb,
  deliver: OutboxDeliver,
  opts: ProcessOutboxOptions = {},
): Promise<ProcessOutboxSummary> {
  if (!db || typeof db.prepare !== 'function') {
    throw new OutboxProcessorError('processOutbox requires a D1-shaped `db`');
  }
  const limit = opts.limit ?? 20;
  const maxAttempts = opts.maxAttempts ?? MAX_OUTBOX_ATTEMPTS;
  const now = opts.now ?? (() => new Date().toISOString());

  // Select UNDELIVERED rows: never-tried (`pending`) OR retryable (`failed` under
  // the cap). Dead-lettered rows (`failed` at/over the cap) and `dispatched` rows
  // are excluded, so re-running cannot double-deliver. Oldest first (FIFO).
  const sel = await db
    .prepare(
      `SELECT id, type, tenant_id, site_id, trace_id, producer, payload, attempts
         FROM outbox_events
        WHERE (status = 'pending' OR (status = 'failed' AND attempts < ?))
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .bind(maxAttempts, limit)
    .all<OutboxEventRow>();

  const rows = sel.results ?? [];
  if (rows.length === 0) return EMPTY_SUMMARY;

  let delivered = 0;
  let failed = 0;
  let dead = 0;

  for (const row of rows) {
    try {
      await deliver(row);
      await db
        .prepare(`UPDATE outbox_events SET status = 'dispatched', dispatched_at = ? WHERE id = ?`)
        .bind(now(), row.id)
        .run();
      delivered++;
    } catch (err) {
      const attemptsAfter = row.attempts + 1;
      const lastError = err instanceof Error ? err.message : String(err);
      // Status stays `failed` either way (the row is the dead-letter once
      // attempts ≥ cap — the SELECT above stops re-picking it). Record attempts +
      // last_error so the admin DLQ + retry tooling can reason over it.
      await db
        .prepare(
          `UPDATE outbox_events SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`,
        )
        .bind(attemptsAfter, lastError.slice(0, 1000), row.id)
        .run();
      if (nextStatusAfterFailure(attemptsAfter, maxAttempts) === 'dead') dead++;
      else failed++;
    }
  }

  return { processed: rows.length, delivered, failed, dead };
}
