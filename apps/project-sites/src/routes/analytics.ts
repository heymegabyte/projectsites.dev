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

import { Hono, type Context } from 'hono';
import { IncomingEventSchema, type IncomingEvent } from '../services/analytics_events.js';
import { ensureAnalyticsSchema } from '../services/analytics_schema.js';
import type { Env, Variables } from '../types/env.js';
import { dbQueryOne } from '../services/db.js';
import { recordVisitorEvent } from '../../libs/features/visitor_events_core/service.js';

/**
 * Beacon event kinds mirrored into `visitor_events` (the store the admin analytics
 * actually reads). Narrowing type-guard: `IncomingEvent.eventType` is a wider union
 * (adds `error`/`scroll`), so the guard both filters AND narrows to a valid
 * `VisitorEventType` before we call `recordVisitorEvent`.
 */
const VISITOR_MIRROR_TYPES = [
  'conversion',
  'form_start',
  'form_submit',
  'web_vital',
  'js_error',
  'page_engagement',
  'scroll_depth',
  'network_quality',
  'nav_timing',
  // Generic UI interaction (button / role=button / summary / opt-in [data-ps-track]) — the
  // first-party "most-clicked elements" signal; distinct from outbound clicks (conversions) and
  // page navigations (pageviews), which the beacon emits on separate paths.
  'click',
  // AI concierge usage (app.js universal-runtime FAB): `concierge_open` on panel open,
  // `concierge_message` per visitor question. Previously LOST (only the un-provisioned
  // analytics_events store held them) — mirror them so concierge engagement is measurable.
  'concierge_open',
  'concierge_message',
] as const;
type VisitorMirrorType = (typeof VISITOR_MIRROR_TYPES)[number];
const isVisitorMirrorType = (t: string): t is VisitorMirrorType =>
  (VISITOR_MIRROR_TYPES as readonly string[]).includes(t);

/**
 * Server-side re-guard for one `nav_timing` phase: a finite, non-negative, bounded (≤600s)
 * millisecond duration, rounded. A 0 is HONEST (cached DNS / reused connection) and kept —
 * only non-finite / negative / absurd values are dropped (→ undefined, omitted from metadata),
 * so the median never sees a fabricated or hostile phase.
 */
function navPhase(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 600_000
    ? Math.round(v)
    : undefined;
}

/**
 * Server-side normalize the DESTINATION of a click conversion into a clean, groupable link for
 * the "top links clicked" report. These are the OWNER's own outbound targets (their phone /
 * email / social / booking links) — NOT visitor PII. Kept: `tel:` / `mailto:` / `sms:` whole
 * (short, the owner's contact) and `http(s)` normalized to `origin + pathname` (query + fragment
 * STRIPPED so tracking params are never stored and same-page links group cleanly). Anything else
 * (relative `#`, `javascript:`, a CTA button with no href) → undefined, so only real external /
 * contact links are recorded. Length-capped defensively.
 */
export function normalizeClickHref(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const href = raw.slice(0, 500);
  if (/^(tel:|mailto:|sms:)/i.test(href)) return href.slice(0, 200);
  if (/^https?:\/\//i.test(href)) {
    try {
      const u = new URL(href);
      return `${u.origin}${u.pathname}`.slice(0, 200);
    } catch {
      return (href.split(/[?#]/)[0] ?? href).slice(0, 200);
    }
  }
  return undefined;
}

export const analyticsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

type AnalyticsCtx = Context<{ Bindings: Env; Variables: Variables }>;

/**
 * Resolve a site slug-or-id to its canonical record id ONLY when it belongs to
 * the caller's org. Returns null for unauthenticated callers (no `orgId`), unknown
 * sites, and foreign-org sites alike — so callers 404 uniformly and a prober can
 * never distinguish "not yours" from "doesn't exist" (the existence-leak protocol).
 *
 * These analytics endpoints accept a slug OR a record id, so this is the slug-aware
 * companion to the id-only `assertSiteOwned`/`requireOwnedSite` guards in
 * services/site_ownership.ts (which match on `id` only).
 *
 * @param env - Worker env (uses `env.DB`).
 * @param orgId - Caller's org from `c.get('orgId')`; falsy → null (unauthorized).
 * @param siteOrSlug - The client-supplied `siteId` query param (slug or record id).
 * @returns The owned site's canonical record id, or null when not owned/unauthorized.
 * @example const id = await resolveOwnedSiteId(c.env, c.get('orgId'), siteId);
 */
async function resolveOwnedSiteId(
  env: Env,
  orgId: string | undefined,
  siteOrSlug: string,
): Promise<string | null> {
  if (!orgId) return null;
  const row = await dbQueryOne<{ id: string }>(
    env.DB,
    'SELECT id FROM sites WHERE (id = ? OR slug = ?) AND org_id = ? AND deleted_at IS NULL LIMIT 1',
    [siteOrSlug, siteOrSlug, orgId],
  );
  return row?.id ?? null;
}

/**
 * Deny a site-scoped analytics request that failed the org-ownership check: emit a
 * structured warn (probing visibility, correlated by requestId) then return a 404
 * that never distinguishes unauthorized from non-existent (never 403 — no leak).
 */
function denyNotOwned(c: AnalyticsCtx, route: string, siteId: string): Response {
  console.warn(
    JSON.stringify({
      level: 'warn',
      msg: 'analytics.ownership_denied',
      route,
      siteId,
      hasOrg: !!c.get('orgId'),
      requestId: c.get('requestId') ?? null,
    }),
  );
  return c.json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
}

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
          | {
              kind?: unknown;
              section?: unknown;
              href?: unknown;
              channel?: unknown;
              form?: unknown;
              metric?: unknown;
              value?: unknown;
              message?: unknown;
              source?: unknown;
              line?: unknown;
              duration_ms?: unknown;
              percent?: unknown;
              effective_type?: unknown;
              downlink?: unknown;
              rtt?: unknown;
              save_data?: unknown;
              dns?: unknown;
              connect?: unknown;
              ttfb?: unknown;
              transfer?: unknown;
              dom?: unknown;
              total?: unknown;
              nv?: unknown;
              ep?: unknown;
              sid?: unknown;
              label?: unknown;
            }
          | undefined;
        // web_vital carries {metric, value}: validate against the known CWV set + a
        // finite non-negative number, and SKIP the mirror on anything else so the p75
        // aggregation never sees a fabricated or hostile sample.
        let cwvMetric = '';
        let cwvValue = Number.NaN;
        if (mirrorType === 'web_vital') {
          cwvMetric = typeof p?.metric === 'string' ? p.metric.toUpperCase() : '';
          cwvValue = typeof p?.value === 'number' ? p.value : Number.NaN;
          if (
            !['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].includes(cwvMetric) ||
            !Number.isFinite(cwvValue) ||
            cwvValue < 0
          ) {
            return;
          }
        }
        // Conversions carry kind/section/channel (AN27 attribution); form events
        // carry the form key (AN17 completion); web_vital carries {metric, value};
        // js_error carries {message, source, line} (site-health signal).
        const metadata: Record<string, unknown> =
          mirrorType === 'conversion'
            ? {
                kind: typeof p?.kind === 'string' ? p.kind : undefined,
                section: typeof p?.section === 'string' ? p.section : undefined,
                channel: typeof p?.channel === 'string' ? p.channel : undefined,
                // AN-OUTBOUND — the click DESTINATION (owner's own outbound/contact link),
                // server-normalized (query stripped, never a tracking param) for the top-links report.
                href: normalizeClickHref(p?.href),
              }
            : mirrorType === 'web_vital'
              ? { metric: cwvMetric, value: cwvValue }
              : mirrorType === 'js_error'
                ? {
                    // Server-side defense: only the typed fields, re-truncated (the client
                    // already caps). Never persist arbitrary payload; a hostile message is a
                    // bound string, never executed.
                    message: typeof p?.message === 'string' ? p.message.slice(0, 300) : undefined,
                    source: typeof p?.source === 'string' ? p.source.slice(0, 300) : undefined,
                    line:
                      typeof p?.line === 'number' && Number.isFinite(p.line) ? p.line : undefined,
                  }
                : mirrorType === 'page_engagement'
                  ? {
                      // Server-side re-guard: dwell must be a finite, sane duration (the client
                      // already bounds 1s–30min); anything else is dropped so a median never skews.
                      duration_ms:
                        typeof p?.duration_ms === 'number' &&
                        Number.isFinite(p.duration_ms) &&
                        p.duration_ms >= 0 &&
                        p.duration_ms <= 1_800_000
                          ? Math.round(p.duration_ms)
                          : undefined,
                      // New-vs-returning: browser-scoped flag (1 = new / 0 = returning); anything
                      // else omitted → the aggregator counts it as "unknown", never new/returning.
                      nv: p?.nv === 0 || p?.nv === 1 ? p.nv : undefined,
                      // Entry page: 1 = the session's first (landing) page; else omitted so only
                      // entry pages carry the flag (the aggregator filters ep = 1).
                      ep: p?.ep === 1 ? 1 : undefined,
                      // Session id (per-tab, from sessionStorage) — groups a visit's page_engagements so
                      // the exit-pages aggregator can pick each session's LAST page. Bound + length-capped;
                      // a non-string is omitted (that visit just isn't grouped, never fabricated).
                      sid: typeof p?.sid === 'string' && p.sid ? p.sid.slice(0, 64) : undefined,
                    }
                  : mirrorType === 'scroll_depth'
                    ? {
                        // Server-side re-guard: max scroll depth is a finite 0–100 percent (the
                        // client already clamps); anything else is dropped so the funnel + median
                        // never see a fabricated or out-of-range sample.
                        percent:
                          typeof p?.percent === 'number' &&
                          Number.isFinite(p.percent) &&
                          p.percent >= 0 &&
                          p.percent <= 100
                            ? Math.round(p.percent)
                            : undefined,
                      }
                    : mirrorType === 'network_quality'
                      ? {
                          // Server-side re-guard on the navigator.connection estimate:
                          // effective_type must be a known class; downlink/rtt finite + non-negative;
                          // save_data a real boolean. Anything else is dropped so the distribution +
                          // medians never see a fabricated or hostile value.
                          effective_type:
                            typeof p?.effective_type === 'string' &&
                            ['slow-2g', '2g', '3g', '4g'].includes(p.effective_type)
                              ? p.effective_type
                              : undefined,
                          downlink:
                            typeof p?.downlink === 'number' &&
                            Number.isFinite(p.downlink) &&
                            p.downlink >= 0
                              ? p.downlink
                              : undefined,
                          rtt:
                            typeof p?.rtt === 'number' && Number.isFinite(p.rtt) && p.rtt >= 0
                              ? Math.round(p.rtt)
                              : undefined,
                          save_data: typeof p?.save_data === 'boolean' ? p.save_data : undefined,
                        }
                      : mirrorType === 'nav_timing'
                        ? {
                            // Each PerformanceNavigationTiming phase, re-guarded by navPhase
                            // (finite, 0–600s, rounded; an honest 0 is kept).
                            dns: navPhase(p?.dns),
                            connect: navPhase(p?.connect),
                            ttfb: navPhase(p?.ttfb),
                            transfer: navPhase(p?.transfer),
                            dom: navPhase(p?.dom),
                            total: navPhase(p?.total),
                          }
                        : mirrorType === 'concierge_open' || mirrorType === 'concierge_message'
                          ? // Concierge events carry no payload — they're counted by event_type +
                            // session_id (unique visitors) alone, so no metadata is stored.
                            {}
                          : mirrorType === 'click'
                            ? {
                                // Generic interaction: re-guard the label (the group key) + section.
                                // A non-string/empty label is dropped so the aggregator never groups
                                // a fabricated or empty row; both are length-capped defensively.
                                label:
                                  typeof p?.label === 'string' && p.label.trim()
                                    ? p.label.trim().slice(0, 80)
                                    : undefined,
                                section:
                                  typeof p?.section === 'string'
                                    ? p.section.slice(0, 80)
                                    : undefined,
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

  // IDOR guard: resolve to a site OWNED by the caller's org (slug or id), else 404.
  const ownedId = await resolveOwnedSiteId(c.env, c.get('orgId'), siteId);
  if (!ownedId) return denyNotOwned(c, 'analytics-debug', siteId);

  const env = c.env;

  if (!env.EVENT_DISPATCHER) {
    return c.json({ events: [], note: 'dispatcher_unavailable' }, 200);
  }

  try {
    const stub = env.EVENT_DISPATCHER.get(env.EVENT_DISPATCHER.idFromName(ownedId));
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
  // IDOR guard: resolve to a site OWNED by the caller's org (slug or id), else 404.
  const ownedId = await resolveOwnedSiteId(c.env, c.get('orgId'), siteId);
  if (!ownedId) return denyNotOwned(c, 'analytics-data', siteId);

  const limit = Math.min(500, Math.max(1, Number(c.req.query('limit')) || 100));
  const db = c.env.DB;
  if (!db) return c.json({ events: [], count: 0, has_more: false, note: 'db_unavailable' }, 200);

  try {
    // Read the durable visitor_events feed (the canonical store). The old beacon
    // table `analytics_events` does not exist in prod — reading it returned a
    // lying-empty feed. `ownedId` is the canonical record id from the org-ownership
    // resolve above (visitor_events.site_id is always the record id) — the query is
    // now scoped to a site the caller provably owns, closing the cross-tenant IDOR.
    const { results } = await db
      .prepare(
        `SELECT id, id AS eventId, event_type AS eventType, NULL AS userId,
                session_id AS sessionId,
                CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS timestamp,
                metadata AS payload, 'ingested' AS status
           FROM visitor_events
          WHERE site_id = ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(ownedId, limit + 1)
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

  // IDOR guard: this WRITE injects a synthetic event — resolve to a site OWNED by the
  // caller's org (slug or id) so no one can seed another tenant's feed; else 404.
  const ownedId = await resolveOwnedSiteId(c.env, c.get('orgId'), siteId);
  if (!ownedId) return denyNotOwned(c, 'test-event', siteId);

  const event: IncomingEvent = {
    eventId: crypto.randomUUID(),
    siteId: ownedId,
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
        const stub = dispatcher.get(dispatcher.idFromName(ownedId));
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

  return c.json({ ok: true, eventId: event.eventId, siteId: ownedId, provider, dispatched }, 200);
});
