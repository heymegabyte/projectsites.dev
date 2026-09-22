/**
 * @module services/build_events
 * @description Event-sourced, replayable build-progress stream for AI site
 * generation. Replaces opaque 30s KV polling of `build:${jobId}` with a typed,
 * Zod-validated, durable, append-only event log the cockpit can subscribe to.
 *
 * ## Storage
 *
 * Events persist append-only under KV key `build:${jobId}:events` as a JSON
 * array (NDJSON-in-array). KV is the same durable substrate the heartbeat
 * record (`build:${jobId}`) already uses, so the container's HMAC callback
 * path and the workflow share one store. Each append validates with
 * `BuildEventSchema.parse(...)` BEFORE persistence — invalid events are
 * rejected (never silently dropped) per [[contract-first-ai]].
 *
 * ## Contract
 *
 * Every event is a discriminated union on `type`, carries `buildId` + `ts`
 * (ISO-8601), and an optional `featureSlug` for cross-feature correlation.
 * The terminal event is the last `publish.completed` OR `build.failed`.
 *
 * @example
 * ```ts
 * import { appendBuildEvent, replayBuildEvents } from '../services/build_events.js';
 *
 * await appendBuildEvent(env, { type: 'build.started', buildId, ts: new Date().toISOString(), prompt: 'Build a site' });
 * const events = await replayBuildEvents(env, buildId); // ordered oldest → newest
 * ```
 *
 * @packageDocumentation
 */

import { z } from 'zod';
import type { Env } from '../types/env.js';

/** Fields every build event carries. */
const BuildEventBaseSchema = z.object({
  /** Correlation id — the container `jobId` / workflow build id. */
  buildId: z.string().min(1),
  /** ISO-8601 emission timestamp. Drives replay ordering. */
  ts: z.string().datetime(),
  /** Optional feature-module correlation per [[feature-module-architecture]]. */
  featureSlug: z
    .string()
    .regex(/^[a-z][a-z0-9_-]*$/)
    .optional(),
});

/**
 * Canonical build-event contract — discriminated union on `type`.
 *
 * Variants mirror the AI build lifecycle:
 * `build.started` → (`agent.started` · `file.changed` · `component.generated`
 * · `tests.started` · `tests.completed` · `preview.updated`)* →
 * `publish.completed` | `build.failed`.
 */
export const BuildEventSchema = z.discriminatedUnion('type', [
  BuildEventBaseSchema.extend({
    type: z.literal('build.started'),
    /** First-pass prompt / business name driving the build. */
    prompt: z.string().default(''),
  }),
  BuildEventBaseSchema.extend({
    type: z.literal('agent.started'),
    /** Specialist agent name (e.g. `visual-qa`, `domain-builder`). */
    agent: z.string().min(1),
    /** Phase label the agent owns. */
    step: z.string().default(''),
  }),
  BuildEventBaseSchema.extend({
    type: z.literal('file.changed'),
    /** Path written/patched inside the build tree. */
    path: z.string().min(1),
    /** create | update | delete. */
    action: z.enum(['create', 'update', 'delete']).default('update'),
  }),
  BuildEventBaseSchema.extend({
    type: z.literal('component.generated'),
    /** Component display name. */
    name: z.string().min(1),
    /** Source path of the generated component. */
    path: z.string().default(''),
  }),
  BuildEventBaseSchema.extend({
    type: z.literal('tests.started'),
    /** Test runner label (playwright | vitest | validators). */
    runner: z.string().default(''),
  }),
  BuildEventBaseSchema.extend({
    type: z.literal('tests.completed'),
    passed: z.number().int().nonnegative().default(0),
    failed: z.number().int().nonnegative().default(0),
  }),
  BuildEventBaseSchema.extend({
    type: z.literal('preview.updated'),
    /** Live preview URL reflecting the new state. */
    url: z.string().default(''),
  }),
  BuildEventBaseSchema.extend({
    type: z.literal('publish.completed'),
    /** Files uploaded to R2. */
    fileCount: z.number().int().nonnegative().default(0),
    /** Published build version (R2 prefix). */
    version: z.string().default(''),
  }),
  BuildEventBaseSchema.extend({
    type: z.literal('build.failed'),
    /** Human-readable failure reason. */
    reason: z.string().min(1),
    /** Stable taxonomy code (e.g. `stale`, `no-callback`). */
    code: z.string().default('build_failed'),
  }),
  /**
   * Deliberate, user-requested PAUSE — explicitly NON-terminal. Nothing broke;
   * the build stopped itself (e.g. the owner asked for a fresh logo) and will
   * resume on a later run. Never treat this as a failure.
   */
  BuildEventBaseSchema.extend({
    type: z.literal('build.halted'),
    /** Human-readable reason for the deliberate halt. */
    reason: z.string().min(1),
    /** Stable taxonomy code (e.g. `logo_regenerate_requested`). */
    code: z.string().default('build_halted'),
  }),
]);

/** Inferred build-event type — never hand-maintained alongside the schema. */
export type BuildEvent = z.infer<typeof BuildEventSchema>;

/** Discriminator literal for every recognised event type. */
export type BuildEventType = BuildEvent['type'];

/** Terminal event types — once one is appended the stream is complete. */
const TERMINAL_TYPES: ReadonlySet<BuildEventType> = new Set<BuildEventType>([
  'publish.completed',
  'build.failed',
]);

/** Cap on retained events per build to bound KV value size (~ring buffer). */
const MAX_EVENTS = 1000;

/** KV key holding the append-only event log for a build. */
function eventsKey(buildId: string): string {
  return `build:${buildId}:events`;
}

/**
 * Append one validated event to a build's durable, append-only log.
 *
 * Validates with `BuildEventSchema.parse(...)` first — an invalid event throws
 * a `ZodError` and is never persisted. Persistence failures are logged but
 * never thrown to the caller (build progress must not break the build), except
 * validation errors which signal a programming bug and surface to the caller.
 *
 * @param env   - Worker env (uses `env.CACHE_KV`).
 * @param event - The event to append (unvalidated input).
 * @returns The parsed, persisted event.
 * @throws {z.ZodError} When the event fails schema validation.
 *
 * @example
 * ```ts
 * await appendBuildEvent(env, {
 *   type: 'tests.completed', buildId, ts: new Date().toISOString(), passed: 12, failed: 0,
 * });
 * ```
 */
export async function appendBuildEvent(env: Env, event: BuildEvent): Promise<BuildEvent> {
  // Validate at the boundary — invalid contract = no-op + thrown ZodError.
  const parsed = BuildEventSchema.parse(event);

  try {
    const existing = await replayBuildEvents(env, parsed.buildId);
    const next = [...existing, parsed].slice(-MAX_EVENTS);
    await env.CACHE_KV.put(eventsKey(parsed.buildId), JSON.stringify(next), {
      // Build streams are short-lived; expire after 24h to keep KV tidy.
      expirationTtl: 24 * 60 * 60,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'build_events',
        message: 'Failed to persist build event',
        buildId: parsed.buildId,
        type: parsed.type,
        feature_slug: parsed.featureSlug ?? null,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return parsed;
}

/**
 * Replay a build's full event log in emission order (oldest → newest).
 *
 * Ordering is by `ts` then insertion index — deterministic for dashboards that
 * backfill on reconnect. Corrupt / unparseable entries are dropped defensively
 * so one bad write never wedges the whole replay.
 *
 * @param env     - Worker env (uses `env.CACHE_KV`).
 * @param buildId - The build correlation id.
 * @returns Ordered, schema-valid events (empty array when none exist).
 *
 * @example
 * ```ts
 * const events = await replayBuildEvents(env, jobId);
 * const done = events.some((e) => e.type === 'publish.completed');
 * ```
 */
export async function replayBuildEvents(env: Env, buildId: string): Promise<BuildEvent[]> {
  let raw: string | null = null;
  try {
    raw = await env.CACHE_KV.get(eventsKey(buildId));
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        service: 'build_events',
        message: 'Failed to read build events',
        buildId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }
  if (!raw) return [];

  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const events: BuildEvent[] = [];
  for (const candidate of arr) {
    const result = BuildEventSchema.safeParse(candidate);
    if (result.success) events.push(result.data);
  }
  // Stable sort by timestamp; equal timestamps keep insertion order.
  return events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.ts === b.e.ts ? a.i - b.i : a.e.ts < b.e.ts ? -1 : 1))
    .map(({ e }) => e);
}

/**
 * Whether an event terminates the build stream.
 *
 * @param type - A build-event discriminator.
 * @returns `true` for `publish.completed` and `build.failed`.
 */
export function isTerminalBuildEvent(type: BuildEventType): boolean {
  return TERMINAL_TYPES.has(type);
}
