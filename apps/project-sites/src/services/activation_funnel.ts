/**
 * @module services/activation_funnel
 *
 * @description
 * The revenue-funnel definition (§9 golden path) as a tested SSOT: the ordered
 * milestones a tenant passes through from discovery to paid, expressed over the
 * `event_bus` event types. The Tinybird `activation_funnel` pipe queries exactly
 * this event set — keep the pipe's `WHERE event IN (...)` in lockstep with
 * {@link ACTIVATION_STAGES} so the analytics surface and the domain model never
 * drift.
 *
 *   lead.discovered → site.claim.started → site.published → subscription.active
 *   (discovered)      (engaged)            (delivered)       (converted/paid)
 *
 * Pure + total — no I/O, no clock. Used by the admin activation dashboard to
 * place any event on the funnel and to drive per-stage conversion rollups.
 *
 * @see tinybird/pipes/activation_funnel.pipe
 * @see services/event_bus.ts (EVENT_TYPES)
 */

import type { EventType } from './event_bus.js';

/** A funnel stage: its event type + a human label + ordinal (0 = top). */
export interface ActivationStage {
  readonly event: EventType;
  readonly label: string;
  readonly ordinal: number;
}

/**
 * The four revenue milestones, top → bottom. Each maps to one bus event a tenant
 * emits as it advances. Ordinal is the funnel position (0 = widest/top).
 */
export const ACTIVATION_STAGES: readonly ActivationStage[] = [
  { event: 'lead.discovered', label: 'Discovered', ordinal: 0 },
  { event: 'site.claim.started', label: 'Engaged', ordinal: 1 },
  { event: 'site.published', label: 'Delivered', ordinal: 2 },
  { event: 'subscription.active', label: 'Converted', ordinal: 3 },
] as const;

/** The canonical event types (one per stage). */
export const ACTIVATION_EVENTS: readonly EventType[] = ACTIVATION_STAGES.map((s) => s.event);

/**
 * Events that CANONICALIZE to the Delivered stage. The dominant create-from-search
 * build path (Cloudflare Workflows) emits `site.generated` when it uploads a
 * PUBLISHED bundle — NOT `site.published` (only the bolt-editor + claim-callback
 * paths emit that). Both mean "a site went live", so the funnel's Delivered stage
 * counts EITHER (the pipe canonicalizes `site.generated` → `site.published`).
 *
 * AL-472: `site.published` FROZE in Tinybird at 2026-09-06 (last7d=0) while
 * `site.generated` kept flowing (Catbird 09-13) → the funnel Delivered under-counted
 * 106 vs 155 published in D1. Counting the union restores it (verified 106→151,
 * 7d 0→45 on live data). Keep this in lockstep with the pipe's `WHERE event IN`
 * + `multiIf` in tinybird/pipes/activation_funnel.pipe.
 */
export const DELIVERED_EVENTS: readonly EventType[] = ['site.published', 'site.generated'];

/** The FULL event set the pipe's `WHERE event IN (...)` ingests (canonical stages + Delivered aliases). */
export const ACTIVATION_INGEST_EVENTS: readonly EventType[] = [
  ...ACTIVATION_EVENTS.filter((e) => e !== 'site.published'),
  ...DELIVERED_EVENTS,
];

const DELIVERED_STAGE = ACTIVATION_STAGES.find((s) => s.label === 'Delivered')!;

const STAGE_BY_EVENT: ReadonlyMap<string, ActivationStage> = new Map<string, ActivationStage>([
  ...ACTIVATION_STAGES.map((s) => [s.event, s] as const),
  // site.generated is a Delivered-stage alias (the workflow delivery event).
  ['site.generated', DELIVERED_STAGE],
]);

/**
 * Place an event type on the funnel.
 *
 * @param event - Any bus event type.
 * @returns The {@link ActivationStage} for a funnel event, or `null` when the
 *   event is not a funnel milestone (e.g. `site.created`, `invoice.failed`).
 * @example funnelStage('site.published') // → { event:'site.published', label:'Delivered', ordinal:2 }
 */
export function funnelStage(event: string): ActivationStage | null {
  return STAGE_BY_EVENT.get(event) ?? null;
}

/**
 * Whether an event type is a revenue-funnel milestone.
 *
 * @param event - Any bus event type.
 * @returns `true` when `event` is one of {@link ACTIVATION_EVENTS}.
 * @example isActivationEvent('subscription.active') // → true
 */
export function isActivationEvent(event: string): boolean {
  return STAGE_BY_EVENT.has(event);
}
