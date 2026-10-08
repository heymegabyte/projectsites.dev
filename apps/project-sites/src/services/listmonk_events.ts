/**
 * @module services/listmonk_events
 *
 * Pure mapper: Listmonk webhook events → analytics-tracker event shapes.
 * Listmonk delivers raw open/click webhook payloads; this module normalises
 * them into the flat {@link AnalyticsEvent} shape that PostHog consumes so
 * campaign engagement flows into the dashboard.
 *
 * All exports are pure + deterministic — no I/O, no clock (timestamps are
 * accepted as inputs, never generated internally).
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A raw event as delivered by a Listmonk webhook. */
export interface ListmonkWebhookEvent {
  readonly type: 'email.open' | 'email.click' | string;
  readonly subscriber_id: number | string;
  readonly campaign_id?: number;
  readonly email?: string;
  readonly url?: string;
  readonly timestamp?: string;
}

/** The normalised event shape downstream analytics pipeines consume. */
export interface AnalyticsEvent {
  readonly eventType: 'email_open' | 'email_click' | 'email_event';
  readonly subscriberId: string;
  readonly campaignId: string | null;
  readonly url: string | null;
  readonly timestamp: string; // ISO 8601
  readonly eventKey: string; // stable per-event dedup key
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a Listmonk event-type string to one of the three analytics types.
 *
 * `email.open`  → `'email_open'`
 * `email.click` → `'email_click'`
 * everything else → `'email_event'`
 */
function normaliseEventType(raw: string): AnalyticsEvent['eventType'] {
  if (raw === 'email.open') return 'email_open';
  if (raw === 'email.click') return 'email_click';
  return 'email_event';
}

/**
 * Deterministic djb2 hash of the input string, returned as a hex string.
 * Stable across calls — no randomness, no crypto dependency.
 */
function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0; // |0 forces 32-bit int
  }
  // Convert to unsigned hex
  return (hash >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministic dedup key: subscriber-campaign-type-timestamp hash.
 *
 * Uses djb2 (not crypto.randomUUID) so the same inputs always produce the
 * same key — ideal for idempotency checks in the analytics pipeline.
 *
 * @param subscriberId - The subscriber identifier (stringified).
 * @param campaignId - The campaign identifier, or null.
 * @param eventType - The normalised event type string.
 * @param ts - The ISO 8601 timestamp string.
 * @returns A hex-string hash suitable for dedup checks.
 *
 * @example
 * eventKey('42', '7', 'email_open', '2026-06-29T12:00:00Z')
 * // => '1a2b3c4d'
 */
export function eventKey(
  subscriberId: string,
  campaignId: string | null,
  eventType: string,
  ts: string,
): string {
  return djb2Hex(`${subscriberId}|${campaignId ?? ''}|${eventType}|${ts}`);
}

/**
 * Map a single Listmonk webhook event to the analytics event shape.
 *
 * Never throws — null/undefined/missing fields produce sensible defaults
 * (null where absent, a deterministic fallback timestamp).
 *
 * @param event - The raw Listmonk webhook payload.
 * @param nowMs - Epoch ms used as timestamp fallback when the event does
 *   not carry a parseable `timestamp`. Defaults to `Date.now()` — callers
 *   that need determinism MUST pass an explicit value.
 * @returns A normalised {@link AnalyticsEvent}.
 *
 * @example
 * mapListmonkEvent({
 *   type: 'email.open',
 *   subscriber_id: 42,
 *   campaign_id: 7,
 *   timestamp: '2026-06-29T12:00:00Z',
 * });
 * // => { eventType: 'email_open', subscriberId: '42', campaignId: '7',
 * //      url: null, timestamp: '2026-06-29T12:00:00.000Z', eventKey: '...' }
 */
export function mapListmonkEvent(event: ListmonkWebhookEvent, nowMs = Date.now()): AnalyticsEvent {
  // Guard against null/undefined event (never throw, always produce a valid result)
  if (!event) {
    return {
      eventType: 'email_event',
      subscriberId: '',
      campaignId: null,
      url: null,
      timestamp: new Date(nowMs).toISOString(),
      eventKey: eventKey('', null, 'email_event', new Date(nowMs).toISOString()),
    };
  }

  const subscriberId = String(event.subscriber_id ?? '');
  const campaignIdRaw = event.campaign_id;
  const campaignId = campaignIdRaw != null ? String(campaignIdRaw) : null;
  const eventType = normaliseEventType(event.type ?? '');
  const url = event.url ?? null;

  // Timestamp: prefer the event's field when present + parseable
  let timestamp: string;
  if (event.timestamp) {
    const d = new Date(event.timestamp);
    if (!Number.isNaN(d.getTime())) {
      timestamp = d.toISOString();
    } else {
      timestamp = new Date(nowMs).toISOString();
    }
  } else {
    timestamp = new Date(nowMs).toISOString();
  }

  return {
    eventType,
    subscriberId,
    campaignId,
    url,
    timestamp,
    eventKey: eventKey(subscriberId, campaignId, eventType, timestamp),
  };
}

/**
 * Batch-map a webhook payload (array of events).
 *
 * @param events - The raw events array. Null/undefined/empty produce an
 *   empty array. Individual null/undefined items are skipped.
 * @param nowMs - See {@link mapListmonkEvent}.
 * @returns An array of normalised {@link AnalyticsEvent} (may be empty).
 *
 * @example
 * mapListmonkEvents([
 *   { type: 'email.open', subscriber_id: 1, campaign_id: 5 },
 *   { type: 'email.click', subscriber_id: 2, campaign_id: 5, url: 'https://x.com' },
 * ]);
 */
export function mapListmonkEvents(
  events: readonly ListmonkWebhookEvent[],
  nowMs = Date.now(),
): AnalyticsEvent[] {
  if (!events || events.length === 0) return [];
  return events
    .filter((e): e is ListmonkWebhookEvent => e != null)
    .map((e) => mapListmonkEvent(e, nowMs));
}
