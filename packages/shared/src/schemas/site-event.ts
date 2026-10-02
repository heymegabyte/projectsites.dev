/**
 * @module site-event
 * @packageDocumentation
 *
 * Zod schema for the **Site Event** — the foundational, typed envelope for the
 * event-sourced "site nervous system" (AWOS-02 Site Consciousness). Every
 * subsystem that observes or acts on a site (build pipeline, editor, deploy
 * worker, AI agent, admin action) emits a {@link SiteEventSchema}-shaped record
 * to a durable, append-only event log — this module ships ONLY the base
 * envelope; the Durable Object emitter, D1/R2 persistence, and per-event-type
 * payload schemas are later AWOS-03+ slices.
 *
 * @remarks Reserved contract — the full envelope has no emitter yet (the DO
 * emitter lands in AWOS-03+). Its first in-tree consumer is the worker's
 * outbound-webhook dispatcher, which reuses {@link SiteEvent}'s `type` as the
 * single source of truth for a site-event's name
 * (`apps/project-sites/src/services/site_event_dispatch.ts`
 * `DispatchableSiteEvent`). Do NOT re-declare a parallel site-event shape
 * elsewhere — extend THIS schema.
 *
 * | Export               | Kind        | Description                                      |
 * | --------------------- | ----------- | ------------------------------------------------ |
 * | `siteEventActorSchema` | `ZodObject` | `{ kind, id }` — who/what caused the event       |
 * | `SiteEventSchema`      | `ZodObject` | The full, strict event envelope                  |
 * | `SiteEvent`            | type        | `z.infer<typeof SiteEventSchema>`                |
 *
 * @example
 * ```ts
 * import { SiteEventSchema, type SiteEvent } from '@bolt/shared/schemas/site-event';
 *
 * const event: SiteEvent = SiteEventSchema.parse({
 *   id: '0192f3a1-7a2b-7c4d-8e5f-0123456789ab', // UUIDv7
 *   type: 'site_published',
 *   ts: new Date().toISOString(),
 *   org: 'org_123',
 *   site: 'site_456',
 *   env: 'production',
 *   actor: { kind: 'system', id: 'deploy-worker' },
 *   source: 'site_generation_pipeline',
 *   correlationId: 'corr_789',
 * });
 * ```
 */
import { z } from 'zod';

/**
 * Identifies who or what caused a {@link SiteEventSchema}.
 *
 * - `kind: 'user'` — a human acting through the admin UI or editor.
 * - `kind: 'system'` — an internal subsystem (deploy worker, build pipeline, cron).
 * - `kind: 'agent'` — an AI agent (site-generation orchestrator, subagent, MCP tool).
 *
 * `id` is the actor's identifier within its own namespace (a `userId`, a worker
 * name, an agent/session id) — this schema does not resolve it further.
 */
export const siteEventActorSchema = z
  .object({
    kind: z.enum(['user', 'system', 'agent']),
    id: z.string().min(1),
  })
  .strict();

/**
 * The base envelope for every event in the site-level event-sourced log.
 *
 * This is the **foundation only** — a typed, strict record every emitter
 * (editor save, deploy, AI build step, admin mutation) MUST conform to before
 * any event-type-specific payload is layered on in a later slice.
 *
 * | Field           | Type                              | Notes                                              |
 * | --------------- | ---------------------------------- | --------------------------------------------------- |
 * | `id`            | UUIDv7 string                      | Event's own id; time-ordered per `uuid-version-discipline` |
 * | `type`          | string                             | snake_case event name, e.g. `site_published`        |
 * | `ts`            | ISO 8601 datetime string           | When the event occurred                             |
 * | `org`           | string                              | Owning organisation id                              |
 * | `site`          | string                              | Owning site id                                      |
 * | `env`           | `'preview' \| 'production'`         | Which deployment environment the event concerns     |
 * | `actor`         | {@link siteEventActorSchema}       | Who/what caused the event                            |
 * | `source`        | string                              | Emitting subsystem, e.g. `editor`, `deploy_worker`  |
 * | `correlationId` | string                              | Groups events from one logical operation             |
 * | `causationId`   | string (optional)                   | The event id that directly caused this one           |
 * | `schemaVersion` | integer, default `1`               | Envelope shape version, for future migrations         |
 * | `privacy`       | `'public'\|'internal'\|'sensitive'`, default `'internal'` | Who may read this event                |
 *
 * `.strict()` — an event payload with an unrecognised top-level field is a
 * producer bug, not a forward-compat field; reject it rather than silently
 * drop it.
 *
 * @example
 * ```ts
 * SiteEventSchema.parse({
 *   id: '0192f3a1-7a2b-7c4d-8e5f-0123456789ab',
 *   type: 'build_started',
 *   ts: '2026-10-02T12:00:00.000Z',
 *   org: 'org_123',
 *   site: 'site_456',
 *   env: 'preview',
 *   actor: { kind: 'agent', id: 'site-generation-orchestrator' },
 *   source: 'site_generation_pipeline',
 *   correlationId: 'corr_789',
 * });
 * // schemaVersion defaults to 1, privacy defaults to 'internal'
 * ```
 */
export const SiteEventSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string().min(1),
    ts: z.string().datetime(),
    org: z.string().min(1),
    site: z.string().min(1),
    env: z.enum(['preview', 'production']),
    actor: siteEventActorSchema,
    source: z.string().min(1),
    correlationId: z.string().min(1),
    causationId: z.string().min(1).optional(),
    schemaVersion: z.number().int().min(1).default(1),
    privacy: z.enum(['public', 'internal', 'sensitive']).default('internal'),
  })
  .strict();

/** Inferred TypeScript type for the base site event envelope. */
export type SiteEvent = z.infer<typeof SiteEventSchema>;

/** Inferred TypeScript type for the event actor sub-object. */
export type SiteEventActor = z.infer<typeof siteEventActorSchema>;
