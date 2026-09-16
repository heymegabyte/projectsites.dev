/**
 * @module workflows/job-provider
 *
 * @description
 * `CloudflareWorkflowProvider` — the `cloudflare-workflows` backend adapter for
 * the §20 job dispatch port. Each CF-native job kind (claim-flow, billing-lifecycle,
 * domain-verification, performance-audit) maps to a Cloudflare Workflow binding;
 * `start` calls `binding.create({ id, params })`. CF Workflows expose per-instance
 * status + termination, so `getJobStatus`/`cancelJob` are real here.
 *
 * Idempotency (§23): the instance is created with `id = ctx.idempotencyKey` — CF
 * Workflows reject a duplicate create for an existing instance id, so re-dispatch
 * is safe. Depends on a narrow {@link CfWorkflowBinding} seam (which the real
 * `Workflow` binding structurally satisfies) → unit-testable with fakes.
 *
 * @see docs/decisions/0034-platform-consolidation-cf-native.md
 */

import { routeJob, type JobKind } from '../platform/workflow-router.js';
import {
  validateJobContext,
  type JobRef,
  type JobStatus,
  type ProjectSitesJobContext,
  type ProjectSitesJobProvider,
} from '../platform/job-provider.js';

/** Narrow slice of a CF Workflow instance this adapter uses. */
export interface CfWorkflowInstanceLike {
  readonly id: string;
  status(): Promise<{ status: string }>;
  terminate?(): Promise<void>;
}

/** Narrow slice of a CF Workflow binding (the real `Workflow` satisfies this). */
export interface CfWorkflowBinding {
  create(opts: { id: string; params: Record<string, unknown> }): Promise<CfWorkflowInstanceLike>;
  get(id: string): Promise<CfWorkflowInstanceLike>;
}

/** Map a CF Workflow instance status string → the platform `JobStatus`. */
export function mapCfStatus(cf: string): JobStatus {
  switch (cf) {
    case 'complete':
      return 'completed';
    case 'errored':
      return 'failed';
    case 'terminated':
      return 'cancelled';
    case 'queued':
      return 'queued';
    case 'running':
    case 'paused':
    case 'waiting':
    case 'waitingForPause':
      return 'running';
    default:
      return 'queued';
  }
}

/**
 * Dispatches CF-native jobs to Cloudflare Workflows.
 *
 * @example
 * const provider = new CloudflareWorkflowProvider({ 'claim-flow': env.CLAIM_WORKFLOW });
 * await provider.start('claim-flow', ctx, { leadId });
 */
export class CloudflareWorkflowProvider implements ProjectSitesJobProvider {
  constructor(private readonly bindings: Partial<Record<JobKind, CfWorkflowBinding>>) {}

  async start(kind: JobKind, ctx: ProjectSitesJobContext, payload?: unknown): Promise<JobRef> {
    if (routeJob(kind).backend !== 'cloudflare-workflows') {
      throw new Error(`CloudflareWorkflowProvider cannot run "${kind}" (not a CF-Workflows job)`);
    }
    const binding = this.bindings[kind];
    if (!binding) throw new Error(`No Cloudflare Workflow binding registered for job "${kind}"`);

    validateJobContext(kind, ctx);

    const instance = await binding.create({
      id: ctx.idempotencyKey, // dedupe: CF rejects a duplicate instance id (§23)
      params: {
        payload: payload ?? null,
        _ctx: {
          tenantId: ctx.tenantId,
          siteId: ctx.siteId,
          userId: ctx.userId,
          requestId: ctx.requestId,
          traceId: ctx.traceId,
          source: ctx.source,
          plan: ctx.plan,
        },
      },
    });

    return {
      jobId: instance.id || ctx.idempotencyKey,
      kind,
      backend: 'cloudflare-workflows',
      status: 'queued',
      idempotencyKey: ctx.idempotencyKey,
      createdAt: ctx.createdAt,
    };
  }

  /** Look the instance up across the registered bindings; first hit wins. */
  async getJobStatus(jobId: string): Promise<JobStatus | null> {
    for (const binding of Object.values(this.bindings)) {
      if (!binding) continue; // an unconfigured optional binding → skip, don't rely on the catch
      try {
        const inst = await binding.get(jobId);
        const { status } = await inst.status();
        return mapCfStatus(status);
      } catch {
        // not in this binding — try the next
      }
    }
    return null;
  }

  /** Terminate the instance in whichever binding holds it. */
  async cancelJob(jobId: string): Promise<void> {
    for (const binding of Object.values(this.bindings)) {
      if (!binding) continue; // an unconfigured optional binding → skip, don't rely on the catch
      try {
        const inst = await binding.get(jobId);
        await inst.terminate?.();
        return;
      } catch {
        // not in this binding — try the next
      }
    }
  }
}
