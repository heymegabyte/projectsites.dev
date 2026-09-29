/**
 * @module ai-policy/grant
 * @description
 * Grant records + the INTERSECTION authorizer (campaign §4). A grant is an
 * immutable SNAPSHOT of concrete ids (sites, connections, actions, models) a
 * principal selected when a key/OAuth grant was minted — never wildcards,
 * never future resources.
 *
 * EVERY entry point calls the SAME authorizer immediately before EVERY tool
 * execution / external effect, enforcing the intersection:
 *
 *   owner RBAC ∩ key/OAuth grant ∩ selected site/resource ∩ selected concrete
 *   connection ∩ allowed action ∩ feature entitlement ∩ current
 *   revocation/approval/budget
 *
 * Each leg is a named predicate so callers can report `deniedBy` precisely.
 * ANY unknown or missing leg fails CLOSED. Prompts, tool output, session IDs
 * and caller-supplied site ids can never expand access; unknown/discovered
 * tools inherit NOTHING (MCP annotations are hints, not permission evidence).
 */
import { z } from 'zod';
import { CapabilityManifestSchema, capabilityIdSchema, concreteIdSchema } from './capability.js';
import { principalKindSchema } from './principal.js';

/** ISO-8601 datetime (UTC `Z` or explicit offset) — how D1 stores grant timestamps. */
const isoDateTimeSchema = z.string().datetime({ offset: true });

/** Slim reference to the principal a grant was minted for (`refId` = session/token/grant/agent id). */
export const grantPrincipalRefSchema = z
  .object({
    kind: principalKindSchema,
    refId: concreteIdSchema,
  })
  .strict();

/** Hard limits selected at mint time. Absent field = no grant-level limit on that axis. */
export const grantLimitsSchema = z
  .object({
    /** Max total spend in cents this grant may consume. */
    spendCents: z.number().int().positive().optional(),
    /** Max requests per minute. */
    rpm: z.number().int().positive().optional(),
    /** Max concurrent executions. */
    concurrency: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Grant-level approval policy — may TIGHTEN a capability's approval behavior,
 * never loosen it:
 * - `follow_capability` — capability's own `approval` field governs.
 * - `always_require` — server-verified approval before EVERY action, even `auto` ones.
 * - `configured_automation` — the owner explicitly configured automation, so
 *   `configured-automation` capabilities may run unattended (`required` still requires approval).
 */
export const grantApprovalPolicySchema = z.enum(['follow_capability', 'always_require', 'configured_automation']);

/**
 * The durable grant record (D1-backed). `revision` increments on every
 * narrow/edit; live checks compare it against the authoritative revision so a
 * stale snapshot can never authorize (immediate-revocation guarantee — KV
 * caches are never the authority).
 */
export const GrantRecordSchema = z
  .object({
    id: concreteIdSchema,
    principal: grantPrincipalRefSchema,
    orgId: concreteIdSchema,
    /** CONCRETE site ids selected at mint time — never future sites. */
    siteIds: z.array(concreteIdSchema).max(5000),
    /** CONCRETE connection/account ids — a provider card is not a connection. */
    connectionIds: z.array(concreteIdSchema).max(5000),
    /** Capability ids (`provider.resource.action`) this grant allows. */
    actionIds: z.array(capabilityIdSchema).max(5000),
    /** CONCRETE model ids this grant may route to. */
    modelIds: z.array(concreteIdSchema).max(5000),
    limits: grantLimitsSchema.default({}),
    approvalPolicy: grantApprovalPolicySchema.default('follow_capability'),
    /** Monotonic edit counter — MUST match the authoritative revision at check time. */
    revision: z.number().int().min(1),
    /** Every grant expires; no perpetual credentials. */
    expiresAt: isoDateTimeSchema,
    /** Set = revoked (immediately, regardless of the timestamp's position vs now). */
    revokedAt: isoDateTimeSchema.optional(),
  })
  .strict();

export type GrantPrincipalRef = z.infer<typeof grantPrincipalRefSchema>;
export type GrantLimits = z.infer<typeof grantLimitsSchema>;
export type GrantApprovalPolicy = z.infer<typeof grantApprovalPolicySchema>;
export type GrantRecord = z.infer<typeof GrantRecordSchema>;

/** The concrete ids the CURRENT request wants to touch. */
export const grantCheckRequestSchema = z
  .object({
    /** Org the caller claims to act in — must equal the grant's org (never trusted alone). */
    orgId: concreteIdSchema,
    /** Capability id being executed — must equal `capability.id` exactly. */
    actionId: capabilityIdSchema,
    siteId: concreteIdSchema.optional(),
    connectionId: concreteIdSchema.optional(),
    modelId: concreteIdSchema.optional(),
    /** Mandatory when the capability declares `idempotency: 'key-required'`. */
    idempotencyKey: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

/** Server-verified approval state for THIS action ("model said confirmed" ≠ approval). */
export const approvalStateSchema = z.enum(['granted', 'pending', 'none']);

/**
 * Live budget headroom from the serialized budget authority (Durable Object).
 * A field left `undefined` while the grant sets the matching limit = unknown
 * leg = fail closed.
 */
export const liveBudgetSchema = z
  .object({
    spendRemainingCents: z.number().int().optional(),
    rpmRemaining: z.number().int().optional(),
    concurrencyAvailable: z.number().int().optional(),
  })
  .strict();

/** Live state fetched from authoritative stores at check time (never from cache alone). */
export const liveStateSchema = z
  .object({
    /** Epoch milliseconds "now" — injected so the authorizer stays pure/deterministic. */
    nowMs: z.number().int().nonnegative(),
    /** The CURRENT revision of this grant in the authoritative store. */
    authoritativeRevision: z.number().int().min(1),
    approval: approvalStateSchema,
    budget: liveBudgetSchema.default({}),
  })
  .strict();

/**
 * Everything `effectiveAllow` needs — the caller resolves each leg's evidence
 * from authoritative sources and passes it in; the authorizer itself performs
 * no I/O (pure, deterministic, trivially testable).
 */
export const GrantCheckInputSchema = z
  .object({
    grant: GrantRecordSchema,
    capability: CapabilityManifestSchema,
    request: grantCheckRequestSchema,
    /** Owner-RBAC leg evidence: capability ids the GRANTOR may perform right now. */
    owner: z.object({ rbacAllowedActionIds: z.array(capabilityIdSchema) }).strict(),
    /** Entitlement leg evidence: capability ids the org's plan/flags enable. */
    entitlement: z.object({ enabledActionIds: z.array(capabilityIdSchema) }).strict(),
    live: liveStateSchema,
  })
  .strict();

export type GrantCheckRequest = z.infer<typeof grantCheckRequestSchema>;
export type ApprovalState = z.infer<typeof approvalStateSchema>;
export type LiveBudget = z.infer<typeof liveBudgetSchema>;
export type LiveState = z.infer<typeof liveStateSchema>;
export type GrantCheckInput = z.infer<typeof GrantCheckInputSchema>;

/** The seven intersection legs, in evaluation (and report) order. */
export const POLICY_LEGS = [
  'owner_rbac',
  'grant',
  'site',
  'connection',
  'action',
  'entitlement',
  'live_state',
] as const;

export type PolicyLeg = (typeof POLICY_LEGS)[number];

/** Result of a single leg predicate. */
export type LegResult = { ok: true } | { ok: false; reason: string };

/** One precisely-attributed denial. */
export interface LegDenial {
  leg: PolicyLeg;
  reason: string;
}

/** `deniedBy` is empty exactly when allowed, and non-empty (every failing leg) when denied. */
export type EffectiveAllowResult =
  | { allowed: true; deniedBy: [] }
  | { allowed: false; deniedBy: [LegDenial, ...LegDenial[]] };

const OK: LegResult = { ok: true };
const fail = (reason: string): LegResult => ({ ok: false, reason });

/** Leg 1 — owner RBAC: the grantor's own role must permit this capability right now. */
export function checkOwnerRbac(input: GrantCheckInput): LegResult {
  const { capability, owner } = input;
  if (!owner.rbacAllowedActionIds.includes(capability.id)) {
    return fail(`owner RBAC does not permit "${capability.id}" — a grant can never exceed its grantor`);
  }
  return OK;
}

/** Leg 2 — grant integrity: org binding + model snapshot membership. */
export function checkGrant(input: GrantCheckInput): LegResult {
  const { grant, capability, request } = input;
  if (grant.orgId !== request.orgId) {
    return fail(`grant is bound to org "${grant.orgId}" but the request targets org "${request.orgId}"`);
  }
  if (capability.resourceRequirements.model === 'required' && request.modelId === undefined) {
    return fail(`capability "${capability.id}" requires an explicit model; none requested`);
  }
  if (request.modelId !== undefined && !grant.modelIds.includes(request.modelId)) {
    return fail(`model "${request.modelId}" is not in the grant snapshot`);
  }
  return OK;
}

/** Leg 3 — site/resource: required presence + snapshot membership for ANY supplied site id. */
export function checkSite(input: GrantCheckInput): LegResult {
  const { grant, capability, request } = input;
  if (capability.resourceRequirements.site === 'required' && request.siteId === undefined) {
    return fail(`capability "${capability.id}" requires a site; request carries none`);
  }
  if (request.siteId !== undefined && !grant.siteIds.includes(request.siteId)) {
    return fail(`site "${request.siteId}" is not in the grant snapshot — caller-supplied site ids never expand access`);
  }
  return OK;
}

/** Leg 4 — concrete connection: required presence + snapshot membership for ANY supplied connection id. */
export function checkConnection(input: GrantCheckInput): LegResult {
  const { grant, capability, request } = input;
  if (capability.resourceRequirements.connection === 'required' && request.connectionId === undefined) {
    return fail(`capability "${capability.id}" requires a concrete connection; request carries none`);
  }
  if (request.connectionId !== undefined && !grant.connectionIds.includes(request.connectionId)) {
    return fail(`connection "${request.connectionId}" is not in the grant snapshot`);
  }
  return OK;
}

/** Leg 5 — allowed action: exact id match + snapshot membership + idempotency-key contract. */
export function checkAction(input: GrantCheckInput): LegResult {
  const { grant, capability, request } = input;
  if (request.actionId !== capability.id) {
    return fail(`requested action "${request.actionId}" does not match the capability manifest "${capability.id}"`);
  }
  if (!grant.actionIds.includes(capability.id)) {
    return fail(`action "${capability.id}" is not in the grant snapshot — unknown/discovered tools inherit nothing`);
  }
  if (capability.idempotency === 'key-required' && request.idempotencyKey === undefined) {
    return fail(`capability "${capability.id}" requires an idempotency key; none provided`);
  }
  return OK;
}

/** Leg 6 — feature entitlement: the org's plan/flags must enable this capability. */
export function checkEntitlement(input: GrantCheckInput): LegResult {
  const { capability, entitlement } = input;
  if (!entitlement.enabledActionIds.includes(capability.id)) {
    return fail(`org entitlement does not enable "${capability.id}"`);
  }
  return OK;
}

/** Leg 7 — live state: revocation, expiry, revision currency, approval, budget headroom. */
export function checkLiveState(input: GrantCheckInput): LegResult {
  const { grant, capability, live } = input;
  const failures: string[] = [];

  if (grant.revokedAt !== undefined) {
    failures.push(`grant revoked (revokedAt=${grant.revokedAt})`);
  }

  const expiresMs = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresMs)) {
    failures.push('grant expiry unparseable — fail closed');
  } else if (expiresMs <= live.nowMs) {
    failures.push(`grant expired at ${grant.expiresAt}`);
  }

  if (grant.revision !== live.authoritativeRevision) {
    failures.push(
      `grant snapshot revision ${grant.revision} is stale (authoritative revision ${live.authoritativeRevision})`,
    );
  }

  const approvalRequired =
    grant.approvalPolicy === 'always_require' ||
    capability.approval === 'required' ||
    (capability.approval === 'configured-automation' && grant.approvalPolicy !== 'configured_automation');
  if (approvalRequired && live.approval !== 'granted') {
    failures.push(`server-verified approval required for "${capability.id}" but approval state is "${live.approval}"`);
  }

  if (grant.limits.spendCents !== undefined) {
    if (live.budget.spendRemainingCents === undefined) {
      failures.push('spend limit set but live spend headroom unknown — fail closed');
    } else if (live.budget.spendRemainingCents <= 0) {
      failures.push('spend budget exhausted');
    }
  }
  if (grant.limits.rpm !== undefined) {
    if (live.budget.rpmRemaining === undefined) {
      failures.push('rpm limit set but live rpm headroom unknown — fail closed');
    } else if (live.budget.rpmRemaining <= 0) {
      failures.push('rpm budget exhausted');
    }
  }
  if (grant.limits.concurrency !== undefined) {
    if (live.budget.concurrencyAvailable === undefined) {
      failures.push('concurrency limit set but live concurrency headroom unknown — fail closed');
    } else if (live.budget.concurrencyAvailable <= 0) {
      failures.push('concurrency budget exhausted');
    }
  }

  return failures.length > 0 ? fail(failures.join('; ')) : OK;
}

/** Named predicate per leg, keyed in {@link POLICY_LEGS} order. */
export const POLICY_LEG_PREDICATES: Record<PolicyLeg, (input: GrantCheckInput) => LegResult> = {
  owner_rbac: checkOwnerRbac,
  grant: checkGrant,
  site: checkSite,
  connection: checkConnection,
  action: checkAction,
  entitlement: checkEntitlement,
  live_state: checkLiveState,
};

/**
 * THE intersection authorizer — pure + deterministic. Re-validates its input
 * at runtime (Zod at the boundary): a structurally invalid input denies with
 * the `grant` leg rather than throwing, so no caller can fail open on bad
 * plumbing. Evaluates EVERY leg (no short-circuit) so `deniedBy` reports the
 * complete, precisely-attributed denial set in {@link POLICY_LEGS} order.
 *
 * Callers MUST invoke this immediately before EVERY tool execution/external
 * effect — never once-per-conversation, never cached across revisions.
 */
export function effectiveAllow(input: GrantCheckInput): EffectiveAllowResult {
  const parsed = GrantCheckInputSchema.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      allowed: false,
      deniedBy: [{ leg: 'grant', reason: `authorization input failed validation — fail closed: ${detail}` }],
    };
  }

  const denials: LegDenial[] = [];
  for (const leg of POLICY_LEGS) {
    const result = POLICY_LEG_PREDICATES[leg](parsed.data);
    if (!result.ok) {
      denials.push({ leg, reason: result.reason });
    }
  }

  if (denials.length > 0) {
    return { allowed: false, deniedBy: denials as [LegDenial, ...LegDenial[]] };
  }
  return { allowed: true, deniedBy: [] };
}
