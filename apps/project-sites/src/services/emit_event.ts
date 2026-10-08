/**
 * emitEvent — the one-call convenience to put a golden-path event on the bus.
 *
 * @remarks
 * Transitions (claim started, site published, invoice paid, …) call this single
 * function instead of stitching {@link buildEvent} + {@link eventIdempotencyKey} +
 * {@link writeOutbox} by hand. It stamps `id`/`time`, derives a deterministic
 * idempotency key from the type + caller-supplied scope (so a retry of the same
 * logical transition is a no-op INSERT), and writes the durable outbox row. The
 * every-5-min cron then drains it to Hatchet (`outbox_dispatch`).
 *
 * `tryEmitEvent` NEVER throws — wrap transition emits in it under `ctx.waitUntil`
 * so a bus/DB hiccup can never break the user-facing request.
 *
 * @packageDocumentation
 */
import type { Env } from '../types/env.js';
import {
  buildEvent,
  eventIdempotencyKey,
  writeOutbox,
  type BuildEventInput,
  type ProjectSitesEvent,
} from './event_bus.js';

/** Result of an emit. */
export interface EmitResult {
  event: ProjectSitesEvent;
  /** False when the idempotency key already existed (duplicate transition). */
  inserted: boolean;
}

/** Injectable clock/id seams for deterministic tests. */
export interface EmitDeps {
  /** Idempotency-scope parts (beyond the type) — e.g. the entity id + a phase. */
  scope?: readonly string[];
  now?: () => string;
  id?: () => string;
}

/**
 * Build + key + persist a golden-path event to the outbox.
 *
 * @param env - Worker env (needs `DB`).
 * @param input - The event payload ({@link BuildEventInput}).
 * @param deps - `{ scope, now, id }`. `scope` defaults to `[siteId|tenantId]`.
 * @returns `{ event, inserted }` — `inserted:false` on a duplicate idempotency key.
 * @example
 * await emitEvent(env, { type:'site.claim.started', producer:'worker',
 *   tenantId, traceId, siteId, data:{ shortlink } }, { scope:[shortlink] });
 */
export async function emitEvent(
  env: Pick<Env, 'DB'>,
  input: BuildEventInput,
  deps: EmitDeps = {},
): Promise<EmitResult> {
  const id = (deps.id ?? (() => crypto.randomUUID()))();
  const time = (deps.now ?? (() => new Date().toISOString()))();
  const event = buildEvent(input, id, time);
  const scope = deps.scope ?? [input.siteId ?? input.tenantId];
  const key = eventIdempotencyKey(input.type, ...scope);
  const { inserted } = await writeOutbox(env, event, key);
  return { event, inserted };
}

/**
 * Fire-and-forget {@link emitEvent} — never throws. Returns `null` on any error
 * so a transition can `ctx.waitUntil(tryEmitEvent(...))` with zero risk to the
 * request path.
 *
 * @returns The {@link EmitResult}, or `null` if the emit failed.
 */
export async function tryEmitEvent(
  env: Pick<Env, 'DB'>,
  input: BuildEventInput,
  deps: EmitDeps = {},
): Promise<EmitResult | null> {
  try {
    return await emitEvent(env, input, deps);
  } catch {
    return null;
  }
}
