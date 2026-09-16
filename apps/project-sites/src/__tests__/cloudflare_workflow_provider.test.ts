/**
 * Convergence §20/§23 — CloudflareWorkflowProvider adapter.
 *
 * Locks: CF-native kinds create a Workflow instance with id=idempotencyKey,
 * routed context rides in params, status maps CF→JobStatus, terminate cancels,
 * and the adapter refuses non-CF-Workflows kinds / unregistered bindings.
 */
import {
  CloudflareWorkflowProvider,
  mapCfStatus,
  type CfWorkflowBinding,
  type CfWorkflowInstanceLike,
} from '../workflows/job-provider.js';
import type { ProjectSitesJobContext } from '../platform/job-provider.js';

const ctx = (over: Partial<ProjectSitesJobContext> = {}): ProjectSitesJobContext => ({
  tenantId: 'tenant-1',
  requestId: 'req-1',
  traceId: 'trace-1',
  idempotencyKey: 'idem-1',
  source: 'api',
  createdAt: '2026-06-20T00:00:00.000Z',
  ...over,
});

function fakeBinding(initialStatus = 'queued') {
  const created: { id: string; params: Record<string, unknown> }[] = [];
  const instances = new Map<string, { status: string; terminated: boolean }>();
  const binding: CfWorkflowBinding & { created: typeof created } = {
    created,
    async create(opts) {
      created.push(opts);
      instances.set(opts.id, { status: initialStatus, terminated: false });
      const inst: CfWorkflowInstanceLike = {
        id: opts.id,
        async status() {
          return { status: instances.get(opts.id)!.status };
        },
        async terminate() {
          instances.get(opts.id)!.status = 'terminated';
        },
      };
      return inst;
    },
    async get(id) {
      if (!instances.has(id)) throw new Error('not found');
      return {
        id,
        async status() {
          return { status: instances.get(id)!.status };
        },
        async terminate() {
          instances.get(id)!.status = 'terminated';
        },
      };
    },
  };
  return binding;
}

describe('mapCfStatus', () => {
  it('maps CF instance statuses to JobStatus', () => {
    expect(mapCfStatus('complete')).toBe('completed');
    expect(mapCfStatus('errored')).toBe('failed');
    expect(mapCfStatus('terminated')).toBe('cancelled');
    expect(mapCfStatus('running')).toBe('running');
    expect(mapCfStatus('queued')).toBe('queued');
    expect(mapCfStatus('weird')).toBe('queued');
  });
});

describe('CloudflareWorkflowProvider', () => {
  it('creates an instance with id=idempotencyKey + context in params', async () => {
    const claim = fakeBinding();
    const provider = new CloudflareWorkflowProvider({ 'claim-flow': claim });
    const ref = await provider.start('claim-flow', ctx(), { leadId: 'lead-9' });

    expect(claim.created).toHaveLength(1);
    expect(claim.created[0].id).toBe('idem-1');
    const params = claim.created[0].params as { payload: unknown; _ctx: { traceId: string } };
    expect(params.payload).toEqual({ leadId: 'lead-9' });
    expect(params._ctx.traceId).toBe('trace-1');
    expect(ref).toMatchObject({
      backend: 'cloudflare-workflows',
      kind: 'claim-flow',
      jobId: 'idem-1',
    });
  });

  it('refuses a kind that does not route to CF Workflows', async () => {
    const provider = new CloudflareWorkflowProvider({});
    await expect(provider.start('site-generation', ctx())).rejects.toThrow(
      /not a CF-Workflows job/,
    );
  });

  it('throws when no binding is registered for the kind', async () => {
    const provider = new CloudflareWorkflowProvider({});
    await expect(provider.start('claim-flow', ctx())).rejects.toThrow(
      /No Cloudflare Workflow binding/,
    );
  });

  it('reports live status + cancels via terminate', async () => {
    const billing = fakeBinding('running');
    const provider = new CloudflareWorkflowProvider({ 'billing-lifecycle': billing });
    const ref = await provider.start('billing-lifecycle', ctx());
    expect(await provider.getJobStatus(ref.jobId)).toBe('running');
    await provider.cancelJob(ref.jobId);
    expect(await provider.getJobStatus(ref.jobId)).toBe('cancelled');
    expect(await provider.getJobStatus('unknown-id')).toBeNull();
  });

  it('skips an UNCONFIGURED (undefined) binding without crashing (code-sweep: guard, not catch)', async () => {
    // An optional binding not wired in this env is `undefined` in the map. getJobStatus/cancelJob
    // must SKIP it via the explicit `if (!binding) continue` guard — not rely on the try/catch to
    // swallow a `undefined.get(...)` TypeError (the appeasement `!` that Fire 8 removed).
    const provider = new CloudflareWorkflowProvider({ 'claim-flow': undefined });
    expect(await provider.getJobStatus('any-id')).toBeNull();
    await expect(provider.cancelJob('any-id')).resolves.toBeUndefined();
  });
});
