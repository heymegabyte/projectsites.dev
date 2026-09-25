/**
 * @module services/analytics_events
 *
 * The contract + provider transforms for the Unified Analytics ingestion plane.
 * Single source of truth (Zod) for the
 * event shape accepted at `POST /api/events`, plus the PURE mappers that turn
 * one generic event into each downstream provider's payload — so the
 * `EventDispatcher` Durable Object NEVER forwards a raw event to all four.
 *
 * All exports are pure + deterministic (no clock, no I/O): the schema validates,
 * the transforms map. The DO supplies time/credentials.
 */

import { z } from 'zod';

/** Free-form per-event properties. */
export const EventPayloadSchema = z.record(z.unknown()).optional();

/** The event types a generated site emits. */
export const EVENT_TYPES = [
  'pageview',
  'click',
  'error',
  'custom',
  'scroll',
  'form_submit',
  // AN17 (#61): emitted on first focus into a form; with form_submit yields the
  // per-form completion rate + abandonment. Payload carries {form}.
  'form_start',
  // AN18 (#60): click-to-call / directions / mailto conversions emitted by the
  // analytics tracker's delegated click listener; payload carries {kind,section,href}.
  'conversion',
  // Concierge chat (app.js universal-runtime piece): `concierge_open` on first
  // panel open, `concierge_message` per visitor message — usage + engagement signal.
  'concierge_open',
  'concierge_message',
  // AN-CWV: a Core Web Vitals sample from the client RUM beacon. Payload carries
  // {metric: LCP|INP|CLS|FCP|TTFB, value: number, href}. Mirrored to visitor_events.
  'web_vital',
  // First-party site-health: an uncaught JS error / unhandled rejection on a published
  // site. Payload carries {message, source, line} (message truncated + deduped + capped
  // client-side by the app.js beacon). Mirrored to visitor_events.
  'js_error',
] as const;

/**
 * The event shape accepted at the ingestion boundary. `eventId` is either a v4
 * UUID or a 40-char SHA-1 hash of `[siteId+userId+eventType+timestamp+action]`,
 * which is what powers 48h dedup. Used by the API handler (400 on fail) AND the
 * DO (dead-letter on fail).
 */
export const IncomingEventSchema = z.object({
  eventId: z.string().uuid().or(z.string().length(40)),
  siteId: z.string().min(1),
  eventType: z.enum(EVENT_TYPES),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  /** Epoch ms. */
  timestamp: z.number().int().positive(),
  payload: EventPayloadSchema,
  ip: z.string().ip().optional(),
  userAgent: z.string().optional(),
  referer: z.string().url().optional(),
  /** GA4 Measurement Protocol client id, when the site provides one. */
  gaClientId: z.string().optional(),
  /** Optional 0-1 sampling rate; the DO drops events above it. */
  sampleRate: z.number().min(0).max(1).optional(),
  /** HMAC-SHA256(siteId+eventId, siteSecret) — verified at ingestion. */
  signature: z.string().optional(),
});

/** A validated inbound analytics event. */
export type IncomingEvent = z.infer<typeof IncomingEventSchema>;

/** Stable distinct id for cross-provider user coherence. */
function distinctId(e: IncomingEvent): string {
  return e.userId ?? e.sessionId ?? e.eventId;
}

// ---------------------------------------------------------------------------
// Provider transforms — never forward the raw event to all providers.
// ---------------------------------------------------------------------------

/** PostHog `capture` shape. */
export interface PostHogEvent {
  distinct_id: string;
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/** Map to PostHog. */
export function toPostHog(e: IncomingEvent): PostHogEvent {
  return {
    distinct_id: distinctId(e),
    event: e.eventType,
    properties: { ...(e.payload ?? {}), $ip: e.ip, siteId: e.siteId },
    timestamp: new Date(e.timestamp).toISOString(),
  };
}

/** GA4 Measurement Protocol shape. */
export interface Ga4Event {
  measurement_id: string;
  client_id: string;
  events: Array<{ name: string; params: Record<string, unknown> }>;
}

/** Map to GA4. `measurementId` comes from the site's stored credentials. */
export function toGa4(e: IncomingEvent, measurementId: string): Ga4Event {
  return {
    measurement_id: measurementId,
    client_id: e.gaClientId ?? distinctId(e),
    events: [{ name: e.eventType, params: { ...(e.payload ?? {}), site_id: e.siteId } }],
  };
}

/** GTM dataLayer-style shape (server-side push). */
export interface GtmEvent {
  event: string;
  site_id: string;
  [key: string]: unknown;
}

/** Map to GTM dataLayer. */
export function toGtm(e: IncomingEvent): GtmEvent {
  return { event: e.eventType, site_id: e.siteId, ...(e.payload ?? {}) };
}
