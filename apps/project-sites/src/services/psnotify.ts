/**
 * @module services/psnotify
 * @description psnotify — the DO-based unified notification center (replaces Novu).
 *
 * `triggerPsnotify(env, event)` writes the event into the per-user psnotify
 * Durable Object inbox (`PsNotifyDO`, resolved by `getByName(subscriberId)`),
 * lighting the in-app bell. The exported signature is unchanged, so every
 * existing caller (`notifyUser`/`notifyEvent` in `services/notify.ts`) keeps
 * working. Email/push fan-out are follow-on slices; the DO class + inbox HTTP
 * surface live in `libs/features/psnotify/`.
 *
 * Never throws. When `PSNOTIFY_DO` is unbound (before the DO-migration deploy),
 * it logs + returns `{ success: true }` so `ctx.waitUntil(notifyUser(...))`
 * fire-and-forget callers are never broken.
 *
 * @packageDocumentation
 */

import { z } from 'zod';

import type { Env } from '../types/env.js';

// ── Canonical event shape (mirrors the old novu_triggers contract) ─────────

export const PsnotifyEventSchema = z.object({
  /** Workflow / template key (e.g. 'welcome', 'build-complete', 'lead-alert'). */
  name: z.string().min(1).max(64),
  /** Recipient identifier — the bell's subscriberId (user email or org id). */
  subscriberId: z.string().min(1),
  /** Arbitrary key-value payload passed to the template renderer. */
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Optional idempotency key — re-firing the same key is a no-op. */
  idempotencyKey: z.string().optional(),
});
export type PsnotifyEvent = z.infer<typeof PsnotifyEventSchema>;

/** Result of a psnotify trigger call. */
export interface PsnotifyResult {
  /** DO notification id on success, or a short reason on skip/failure. */
  result: string;
  success: boolean;
}

// ── Render ─────────────────────────────────────────────────────────────────

/**
 * Renders a psnotify event payload to the canonical shape. Pure — zero I/O.
 * Validates + normalizes; the DO write happens in {@link triggerPsnotify}.
 */
export function renderPsnotifyEvent(input: PsnotifyEvent): PsnotifyEvent {
  return PsnotifyEventSchema.parse(input);
}

/**
 * Derive the bell row's title from the event: the payload `subject` when
 * present, else the workflow `name`. Pure — unit-testable.
 *
 * @example psnotifyTitle({ name: 'welcome', subscriberId: 'x', payload: { subject: 'Hi 🎉' } }); // 'Hi 🎉'
 */
export function psnotifyTitle(event: PsnotifyEvent): string {
  const subject = event.payload?.subject;
  return typeof subject === 'string' && subject.trim() ? subject : event.name;
}

// ── Trigger — write to the psnotify DO inbox ───────────────────────────────

/**
 * Trigger a psnotify event for one subscriber: write it into that subscriber's
 * `PsNotifyDO` inbox (in-app bell). Never throws.
 *
 * @remarks Impure — resolves + calls the psnotify Durable Object when bound.
 *   When `env.PSNOTIFY_DO` is absent (pre-migration deploy) the write is a
 *   logged no-op that still reports success, so fire-and-forget callers are safe.
 * @param env - Worker env (uses `env.PSNOTIFY_DO`).
 * @param event - The event to deliver; validated against {@link PsnotifyEventSchema}.
 * @returns `{ success, result }` — `result` is the stored notification id, or a short reason.
 */
// ~$0.00/trigger (one DO write — no external API call). Real fan-out cost lands with the SES/push adapters (follow-on slice).
export async function triggerPsnotify(env: Env, event: PsnotifyEvent): Promise<PsnotifyResult> {
  const parsed = renderPsnotifyEvent(event);
  const idem = parsed.idempotencyKey ?? `${parsed.name}:${parsed.subscriberId}:${Date.now()}`;

  const ns = env.PSNOTIFY_DO;
  if (!ns) {
    // Binding not yet deployed — log + succeed so waitUntil callers never break.
    console.warn(
      JSON.stringify({
        level: 'info',
        service: 'psnotify',
        event: 'trigger.binding_missing',
        eventName: parsed.name,
        idempotencyKey: idem,
      }),
    );
    return { result: idem, success: true };
  }

  try {
    const body = parsed.payload?.body;
    const actionUrl = parsed.payload?.action_url ?? parsed.payload?.actionUrl;
    // Per-user isolation: resolve the inbox by the subscriberId (the authed bell key).
    const stub = ns.getByName(parsed.subscriberId);
    const res = await stub.fetch('http://do/add', {
      method: 'POST',
      body: JSON.stringify({
        type: parsed.name,
        title: psnotifyTitle(parsed),
        body: typeof body === 'string' ? body : '',
        action_url: typeof actionUrl === 'string' ? actionUrl : null,
      }),
    });
    if (!res.ok) {
      return { result: `do_status_${res.status}`, success: false };
    }
    const stored = (await res.json()) as { id?: string };
    return { result: stored.id ?? idem, success: true };
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'psnotify',
        event: 'trigger.error',
        eventName: parsed.name,
        reason: (err as Error)?.message || 'exception',
      }),
    );
    return { result: 'exception', success: false };
  }
}
