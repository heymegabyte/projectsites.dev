/** Event bus typed envelope for the durable outbox. Pure, never throws. */
export const EVENT_PRODUCERS = [
  'projectsites',
  'twenty',
  'listmonk',
  'social_native',
  'billing',
] as const;
export type EventProducer = (typeof EVENT_PRODUCERS)[number];
export const EVENT_TYPES = [
  'user.created',
  'site.published',
  'lead.claimed',
  'payment.succeeded',
  'email.sent',
  'issue.created',
  'contact.created',
  'campaign.sent',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export interface EventEnvelope {
  id: string;
  payload: Record<string, unknown>;
  producer: EventProducer;
  timestamp: string;
  traceId: string;
  type: EventType;
}
export function createEnvelope(
  producer: EventProducer,
  type: EventType,
  payload: Record<string, unknown>,
  traceId?: string,
): EventEnvelope {
  return {
    id:
      typeof crypto !== 'undefined' ? crypto.randomUUID() : '00000000-0000-0000-0000-000000000000',
    payload,
    producer,
    timestamp: new Date().toISOString(),
    traceId: traceId ?? 'unknown',
    type,
  };
}
