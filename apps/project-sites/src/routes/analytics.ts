/**
 * @module routes/analytics
 *
 * Unified Analytics ingestion plane — Plane H.
 * Fast-ack `POST /api/events` dispatches validated events to the
 * `EventDispatcher` Durable Object via `ctx.waitUntil` so the HTTP
 * response is always immediate. The debug endpoint `GET /api/analytics-debug`
 * proxies to the DO for operator inspection.
 *
 * Both routes degrade gracefully when the `EVENT_DISPATCHER` binding is
 * absent (test / local dev environments without the DO configured).
 *
 * @example
 * // Mount in src/index.ts:
 * import { analyticsRoutes } from './routes/analytics.js';
 * app.route('/', analyticsRoutes);
 */

import { Hono } from 'hono';
import { IncomingEventSchema, type IncomingEvent } from '../services/analytics_events.js';
import { ensureAnalyticsSchema } from '../services/analytics_schema.js';
import type { Env } from '../types/env.js';
import { dbQueryOne } from '../services/db.js';
import { recordVisitorEvent } from '../../libs/features/visitor_events_core/service.js';

/**
 * Beacon event kinds mirrored into `visitor_events` (the store the admin analytics
 * actually reads). Narrowing type-guard: `IncomingEvent.eventType` is a wider union
 * (adds `error`/`scroll`), so the guard both filters AND narrows to a valid
 * `VisitorEventType` before we call `recordVisitorEvent`.
 */
const VISITOR_MIRROR_TYPES = ['conversion', 'form_start', 'form_submit'] as const;
type VisitorMirrorType = (typeof VISITOR_MIRROR_TYPES)[number];
const isVisitorMirrorType = (t: string): t is VisitorMirrorType =>
  (VISITOR_MIRROR_TYPES as readonly string[]).includes(t);

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

/**
 * Persist a validated event to the `analytics_events` table (the durable local
 * copy the Analytics tab reads). Best-effort + never throws: `INSERT OR IGNORE`
 * dedups on the `eventId UNIQUE` index, and a missing table self-heals once via
 * {@link ensureAnalyticsSchema} then retries. Independent of the dispatcher DO,
 * so analytics are readable even before the DO binding goes live.
 *
 * @param db - The platform D1 database.
 * @param event - A schema-validated incoming event.
 */
export async function persistAnalyticsEvent(db: D1Database, event: IncomingEvent): Promise<void> {
  const insert = () =>
    db
      .prepare(
        `INSERT OR IGNORE INTO analytics_events
           (id, siteId, eventId, eventType, userId, sessionId, timestamp, payload, ip, dedupId, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ingested')`,
      )
      .bind(
        crypto.randomUUID(),
        event.siteId,
        event.eventId,
        event.eventType,
        event.userId ?? null,
        event.sessionId ?? null,
        event.timestamp,
        JSON.stringify(event.payload ?? {}),
        event.ip ?? null,
        event.eventId,
      )
      .run();
  try {
    await insert();
  } catch {
    try {
      await ensureAnalyticsSchema(db);
      await insert();
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          msg: 'analytics.persist_failed',
          siteId: event.siteId,
          error: String(err),
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// POST /api/events — ingest a single analytics event
// ---------------------------------------------------------------------------

/**
 * Ingest an analytics event.
 *
 * Validates the body with `IncomingEventSchema`, then dispatches to the
 * `EventDispatcher` Durable Object inside `ctx.waitUntil` so the caller
 * always receives a fast 202 ack — never awaiting the DO round-trip.
 *
 * When `EVENT_DISPATCHER` is absent (test / local), the dispatch is skipped
 * and a 202 is still returned.
 *
 * @returns 202 `{status:'queued'}` on success, 400 `{error:'invalid_event', details}` on validation failure.
 *
 * @example
 * POST /api/events
 * {
 *   "eventId": "123e4567-e89b-42d3-a456-426614174000",
 *   "siteId": "s1",
 *   "eventType": "pageview",
 *   "timestamp": 1700000000000
 * }
 * → 202 { status: 'queued' }
 */
analyticsRoutes.post('/api/events', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_event', details: 'Request body must be valid JSON.' }, 400);
  }

  const parsed = IncomingEventSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_event', details: parsed.error.flatten() }, 400);
  }

  const event: IncomingEvent = parsed.data;
  const env = c.env;

  // Durable local copy (the Analytics tab feed) — runs regardless of the DO.
  if (env.DB) {
    const dbWrite = persistAnalyticsEvent(env.DB, event);
    try {
      c.executionCtx.waitUntil(dbWrite);
    } catch {
      void dbWrite;
    }
  }

  // Mirror the beacon-only funnel events into `visitor_events` — the table the
  // admin analytics ACTUALLY reads (conversion count + AN27 section attribution +
  // AN19 visitor funnel + AN17 form completion). `conversion`, `form_start`, and
  // `form_submit` are emitted ONLY by the client beacon; without this mirror they'd
  // be lost — the beacon's `analytics_events` store is a separate pipeline the admin
  // doesn't read (and isn't even provisioned in prod). Pageviews are NOT mirrored:
  // the server-side `recordPageviewFromRequest` records them per serve, so mirroring
  // would double-count.
  if (env.DB && isVisitorMirrorType(event.eventType)) {
    // Capture the narrowed type in a const — property narrowing is not preserved
    // into the async closure below.
    const mirrorType: VisitorMirrorType = event.eventType;
    const mirrorWrite = (async () => {
      try {
        const site = await dbQueryOne<{ id: string; org_id: string }>(
          env.DB,
          'SELECT id, org_id FROM sites WHERE (id = ? OR slug = ?) AND deleted_at IS NULL',
          [event.siteId, event.siteId],
        );
        if (!site?.org_id) return;
        const p = event.payload as
          | { kind?: unknown; section?: unknown; href?: unknown; channel?: unknown; form?: unknown }
          | undefined;
        // Conversions carry kind/section/channel (AN27 attribution); form events
        // carry the form key (AN17 completion) — build the metadata per event type.
        const metadata: Record<string, unknown> =
          mirrorType === 'conversion'
            ? {
                kind: typeof p?.kind === 'string' ? p.kind : undefined,
                section: typeof p?.section === 'string' ? p.section : undefined,
                channel: typeof p?.channel === 'string' ? p.channel : undefined,
              }
            : { form: typeof p?.form === 'string' ? p.form : undefined };
        await recordVisitorEvent(
          env,
          { orgId: site.org_id, siteId: site.id },
          {
            sessionId: event.sessionId ?? event.userId ?? event.eventId,
            eventType: mirrorType,
            path: typeof p?.href === 'string' ? p.href.slice(0, 2048) : undefined,
            referrer: event.referer ?? undefined,
            metadata,
          },
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'analytics.visitor_mirror_failed',
            siteId: event.siteId,
            eventType: event.eventType,
            error: String(err),
          }),
        );
      }
    })();
    try {
      c.executionCtx.waitUntil(mirrorWrite);
    } catch {
      void mirrorWrite;
    }
  }

  if (env.EVENT_DISPATCHER) {
    // Narrowed const so the async closure needs no non-null assertion — TS drops the outer
    // `if (env.EVENT_DISPATCHER)` narrowing across the closure boundary, so capturing it here
    // keeps the code assertion-free (TS-strictness) AND robust to future refactors.
    const dispatcher = env.EVENT_DISPATCHER;
    const p = (async () => {
      try {
        const stub = dispatcher.get(dispatcher.idFromName(event.siteId));
        await stub.fetch(
          new Request('https://do/enqueue', {
            method: 'POST',
            body: JSON.stringify(event),
          }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'analytics.enqueue_failed',
            siteId: event.siteId,
            eventId: event.eventId,
            error: String(err),
          }),
        );
      }
    })();

    // Guard: executionCtx getter throws in Hono's test harness
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      void p;
    }
  }

  return c.json({ status: 'queued' }, 202);
});

// ---------------------------------------------------------------------------
// GET /api/analytics-debug — operator debug proxy to EventDispatcher DO
// ---------------------------------------------------------------------------

/**
 * Proxy operator debug request to the `EventDispatcher` Durable Object.
 *
 * Requires `siteId` query param. When `EVENT_DISPATCHER` binding is absent
 * returns a graceful fallback body rather than throwing.
 *
 * @param siteId - Required query param identifying which site's DO to query.
 * @returns 200 JSON from the DO's `/debug` endpoint, or fallback payload.
 *
 * @example
 * GET /api/analytics-debug?siteId=s1
 * → 200 { events: [], note: 'dispatcher_unavailable' }  // when binding absent
 */
analyticsRoutes.get('/api/analytics-debug', async (c) => {
  const siteId = c.req.query('siteId');
  if (!siteId) {
    return c.json({ error: 'missing_param', details: 'siteId query param is required.' }, 400);
  }

  const env = c.env;

  if (!env.EVENT_DISPATCHER) {
    return c.json({ events: [], note: 'dispatcher_unavailable' }, 200);
  }

  try {
    const stub = env.EVENT_DISPATCHER.get(env.EVENT_DISPATCHER.idFromName(siteId));
    const res = await stub.fetch(new Request('https://do/debug'));
    const data = await res.json();
    return c.json(data, 200);
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        msg: 'analytics.debug_failed',
        siteId,
        error: String(err),
      }),
    );
    return c.json({ events: [], note: 'dispatcher_unavailable' }, 200);
  }
});

// ---------------------------------------------------------------------------
// GET /api/analytics-data — the Analytics tab feed (durable D1 store)
// ---------------------------------------------------------------------------

/**
 * Return the most recent stored events for a site — what the admin Live Events
 * tab renders. Reads the canonical `visitor_events` D1 store (the old beacon
 * `analytics_events` table is not provisioned in prod — reading it returned a
 * lying-empty feed). Accepts a slug OR record id. Never throws: any DB error
 * yields an empty feed.
 *
 * @param siteId - Required query param (site slug or record id).
 * @param limit - Optional, default 100, capped at 500.
 * @returns 200 `{ events: [...], count, has_more }` or `{ events: [], note }`.
 * @example GET /api/analytics-data?siteId=megabytespace&limit=50
 */
analyticsRoutes.get('/api/analytics-data', async (c) => {
  const siteId = c.req.query('siteId');
  if (!siteId) {
    return c.json({ error: 'missing_param', details: 'siteId query param is required.' }, 400);
  }
  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 100));
  const db = c.env.DB;
  if (!db) return c.json({ events: [], count: 0, has_more: false, note: 'db_unavailable' }, 200);

  try {
    // Read the durable visitor_events feed (the canonical store). The old beacon
    // table `analytics_events` does not exist in prod — reading it returned a
    // lying-empty feed. Resolve slug-or-id (the tab passes the slug; visitor_events
    // .site_id is always the record id) and map rows to the LiveEvent shape.
    const { results } = await db
      .prepare(
        `SELECT id, id AS eventId, event_type AS eventType, NULL AS userId,
                session_id AS sessionId,
                CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS timestamp,
                metadata AS payload, 'ingested' AS status
           FROM visitor_events
          WHERE site_id = ?
             OR site_id = (SELECT id FROM sites WHERE slug = ? AND deleted_at IS NULL LIMIT 1)
          ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(siteId, siteId, limit + 1)
      .all();
    const rows = (results ?? []) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const events = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
      ...r,
      payload: typeof r['payload'] === 'string' ? safeParse(r['payload'] as string) : r['payload'],
    }));
    return c.json({ events, count: events.length, has_more: hasMore }, 200);
  } catch (err) {
    console.warn(
      JSON.stringify({ level: 'warn', msg: 'analytics.data_failed', siteId, error: String(err) }),
    );
    return c.json({ events: [], count: 0, has_more: false, note: 'no_data' }, 200);
  }
});

/** Parse a JSON string, returning `{}` on failure (never throws). */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// POST /api/test-event — synthetic event injector (ops "Test Connection")
// ---------------------------------------------------------------------------

const TEST_PROVIDERS = ['all', 'sentry', 'posthog', 'ga4', 'gtm'] as const;

/**
 * Inject a synthetic event for a site to confirm the ingestion pipeline works
 * end-to-end without waiting for real traffic — the admin "Test Connection"
 * affordance. Builds a valid event, persists it to D1 (so it appears in the
 * Analytics feed), and enqueues to the dispatcher DO when bound. Never throws.
 *
 * @param siteId - Required query param.
 * @param provider - Optional `all|sentry|posthog|ga4|gtm` (default `all`); recorded in the payload.
 * @returns 200 `{ ok, eventId, siteId, provider, dispatched }` or 400 on bad input.
 * @example POST /api/test-event?siteId=s1&provider=sentry
 */
analyticsRoutes.post('/api/test-event', async (c) => {
  const siteId = c.req.query('siteId');
  if (!siteId) {
    return c.json(
      { ok: false, error: 'missing_param', details: 'siteId query param is required.' },
      400,
    );
  }
  const provider = (c.req.query('provider') ?? 'all') as (typeof TEST_PROVIDERS)[number];
  if (!TEST_PROVIDERS.includes(provider)) {
    return c.json(
      {
        ok: false,
        error: 'bad_provider',
        details: `provider must be one of ${TEST_PROVIDERS.join(', ')}.`,
      },
      400,
    );
  }

  const event: IncomingEvent = {
    eventId: crypto.randomUUID(),
    siteId,
    eventType: 'custom',
    timestamp: Date.now(),
    payload: { test: true, provider, source: 'test-event' },
  };

  const env = c.env;
  if (env.DB) {
    const w = persistAnalyticsEvent(env.DB, event);
    try {
      c.executionCtx.waitUntil(w);
    } catch {
      void w;
    }
  }

  let dispatched = false;
  if (env.EVENT_DISPATCHER) {
    dispatched = true;
    // Narrowed const (see the enqueue path above) → assertion-free async closure.
    const dispatcher = env.EVENT_DISPATCHER;
    const p = (async () => {
      try {
        const stub = dispatcher.get(dispatcher.idFromName(siteId));
        await stub.fetch(
          new Request('https://do/enqueue', { method: 'POST', body: JSON.stringify(event) }),
        );
      } catch (err) {
        console.warn(
          JSON.stringify({
            level: 'warn',
            msg: 'analytics.test_enqueue_failed',
            siteId,
            error: String(err),
          }),
        );
      }
    })();
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      void p;
    }
  }

  return c.json({ ok: true, eventId: event.eventId, siteId, provider, dispatched }, 200);
});
