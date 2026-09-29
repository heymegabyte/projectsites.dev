/**
 * @module ai-policy/capability
 * @description
 * Capability manifests — the typed, Zod-validated description of every tool /
 * action ANY AI entry point (OpenAI/Anthropic compat APIs, the ProjectSites
 * MCP server, Chat, per-site agents, scheduled workflows) may execute.
 *
 * Campaign `CAMPAIGN-cf-native-ai.md` §4: capabilities are Zod + typed
 * manifests with a stable tool ID, a read/write/publish/communicate
 * distinction, resource requirements, a cost class, idempotency semantics and
 * approval behavior. Unknown/discovered tools inherit NOTHING — a tool
 * without a registered manifest (or outside a grant snapshot) is denied.
 * MCP annotations are hints, never permission evidence.
 */
import { z } from 'zod';

/**
 * Stable capability/tool/action id grammar: `provider.resource.action` —
 * lowercase snake_case segments joined by dots, three segments minimum
 * (nested resources may add segments, e.g. `notion.database.page.create`).
 *
 * Examples: `projectsites.site.publish` · `notion.page.create` ·
 * `twilio.sms.send` · `workers_ai.text.generate`.
 */
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

/** Zod schema for a stable `provider.resource.action` capability id. */
export const capabilityIdSchema = z
  .string()
  .regex(
    CAPABILITY_ID_PATTERN,
    'capability id must be lowercase snake_case segments joined by dots: provider.resource.action',
  );

/**
 * Concrete resource id (site / connection / model / grant / principal ref).
 * Grant snapshots hold CONCRETE ids only — wildcards are never grantable, so
 * `*` (and empty/whitespace ids) are rejected at the schema boundary.
 */
export const concreteIdSchema = z
  .string()
  .trim()
  .min(1, 'concrete id must be non-empty')
  .max(256)
  .refine((value) => !value.includes('*'), {
    message: 'grant snapshots hold CONCRETE ids — wildcards are never grantable',
  });

/** What the capability DOES — publish/communicate are never implied by read/write. */
export const capabilityKindSchema = z.enum(['read', 'write', 'publish', 'communicate']);

/** Routing/billing cost class; `external` = leaves our metering boundary (carrier, external API). */
export const costClassSchema = z.enum(['instant', 'standard', 'premium', 'external']);

/**
 * Idempotency semantics:
 * - `none` — replays may duplicate effects; retries must NOT re-dispatch.
 * - `key-required` — caller MUST supply an idempotency key (enforced by the authorizer).
 * - `natural` — safely replayable (pure reads / naturally idempotent writes).
 */
export const idempotencyClassSchema = z.enum(['none', 'key-required', 'natural']);

/**
 * Approval behavior:
 * - `auto` — executes without approval (still subject to the grant's stricter policy).
 * - `required` — server-verified approval before EVERY execution ("model said confirmed" ≠ approval).
 * - `configured-automation` — approval-free ONLY when the grant explicitly configured automation.
 */
export const approvalBehaviorSchema = z.enum(['auto', 'required', 'configured-automation']);

/** Whether a resource dimension must be present on the request (`required`), may be (`optional`), or is unused (`none`). */
export const resourceRequirementLevelSchema = z.enum(['none', 'optional', 'required']);

/**
 * Which concrete resources a capability needs bound at execution time. The
 * authorizer uses this to force presence (`required`) and ALWAYS checks any
 * supplied id against the grant snapshot regardless of level — a
 * caller-supplied id can never expand access.
 */
export const resourceRequirementsSchema = z
  .object({
    site: resourceRequirementLevelSchema.default('none'),
    connection: resourceRequirementLevelSchema.default('none'),
    model: resourceRequirementLevelSchema.default('none'),
  })
  .strict();

/**
 * The capability manifest — the single typed contract every tool/action must
 * register before ANY entry point may execute it.
 */
export const CapabilityManifestSchema = z
  .object({
    /** Stable `provider.resource.action` id — the permission unit grants snapshot. */
    id: capabilityIdSchema,
    /** read | write | publish | communicate — dangerous kinds stay distinct from reads. */
    kind: capabilityKindSchema,
    /** Human-readable description shown in the permission selector + consent screens. */
    description: z.string().trim().min(1).max(2000),
    /** Concrete resources that must/can be bound at execution time. */
    resourceRequirements: resourceRequirementsSchema.default({}),
    /** instant | standard | premium | external — feeds routing + metering. */
    costClass: costClassSchema,
    /** none | key-required | natural — retry/duplicate-effect semantics. */
    idempotency: idempotencyClassSchema,
    /** auto | required | configured-automation — approval behavior before execution. */
    approval: approvalBehaviorSchema,
  })
  .strict();

export type CapabilityId = z.infer<typeof capabilityIdSchema>;
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;
export type CostClass = z.infer<typeof costClassSchema>;
export type IdempotencyClass = z.infer<typeof idempotencyClassSchema>;
export type ApprovalBehavior = z.infer<typeof approvalBehaviorSchema>;
export type ResourceRequirementLevel = z.infer<typeof resourceRequirementLevelSchema>;
export type ResourceRequirements = z.infer<typeof resourceRequirementsSchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

/** Parsed components of a `provider.resource.action` capability id. */
export interface ParsedCapabilityId {
  /** First segment — the owning provider/integration (`notion`, `projectsites`, `twilio`). */
  provider: string;
  /** Middle segment(s) — the resource, joined by dots when nested (`database.page`). */
  resource: string;
  /** Final segment — the verb (`create`, `read`, `publish`, `send`). */
  action: string;
}

/**
 * Split a capability id into provider / resource / action. Throws (ZodError)
 * on ids that violate the grammar — malformed ids must never flow onward.
 */
export function parseCapabilityId(id: string): ParsedCapabilityId {
  const valid = capabilityIdSchema.parse(id);
  const segments = valid.split('.');
  return {
    provider: segments[0],
    resource: segments.slice(1, -1).join('.'),
    action: segments[segments.length - 1],
  };
}
