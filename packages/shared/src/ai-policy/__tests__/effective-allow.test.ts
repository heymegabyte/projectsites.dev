/**
 * @module ai-policy/__tests__/effective-allow
 * @description Truth-table tests for the §4 intersection authorizer: every
 * single-leg denial, empty-intersection, revision/revoked/expired fail-closed,
 * unknown-action denial (MCP annotations are hints), budget fail-closed, and
 * the multi-leg precise `deniedBy` report.
 */
import { effectiveAllow, POLICY_LEGS, type GrantCheckInput, type PolicyLeg } from '../grant.js';

const NOW_MS = Date.parse('2026-09-29T12:00:00Z');

/** Fully-allowed baseline input — each test clones + mutates exactly one leg. */
function baseInput(): GrantCheckInput {
  return {
    grant: {
      id: 'grant_01',
      principal: { kind: 'api_key', refId: 'tok_01' },
      orgId: 'org_01',
      siteIds: ['site_a'],
      connectionIds: ['conn_notion_1'],
      actionIds: ['notion.page.create', 'projectsites.site.read'],
      modelIds: ['workers_ai.llama_3_3_70b'],
      limits: { spendCents: 5000, rpm: 60, concurrency: 2 },
      approvalPolicy: 'follow_capability',
      revision: 3,
      expiresAt: '2027-01-01T00:00:00Z',
    },
    capability: {
      id: 'notion.page.create',
      kind: 'write',
      description: 'Create a page in a connected Notion workspace.',
      resourceRequirements: { site: 'optional', connection: 'required', model: 'none' },
      costClass: 'standard',
      idempotency: 'key-required',
      approval: 'auto',
    },
    request: {
      orgId: 'org_01',
      actionId: 'notion.page.create',
      siteId: 'site_a',
      connectionId: 'conn_notion_1',
      idempotencyKey: 'idem_123',
    },
    owner: { rbacAllowedActionIds: ['notion.page.create', 'projectsites.site.read'] },
    entitlement: { enabledActionIds: ['notion.page.create', 'projectsites.site.read'] },
    live: {
      nowMs: NOW_MS,
      authoritativeRevision: 3,
      approval: 'none',
      budget: { spendRemainingCents: 4200, rpmRemaining: 59, concurrencyAvailable: 2 },
    },
  };
}

function expectDeniedBy(input: GrantCheckInput, ...legs: PolicyLeg[]): void {
  const result = effectiveAllow(input);
  expect(result.allowed).toBe(false);
  expect(result.deniedBy.map((d) => d.leg)).toEqual(legs);
  for (const denial of result.deniedBy) {
    expect(denial.reason.length).toBeGreaterThan(0);
  }
}

describe('effectiveAllow — baseline', () => {
  it('allows when every leg passes, with empty deniedBy', () => {
    const result = effectiveAllow(baseInput());
    expect(result).toEqual({ allowed: true, deniedBy: [] });
  });

  it('exposes the seven legs in canonical order', () => {
    expect(POLICY_LEGS).toEqual(['owner_rbac', 'grant', 'site', 'connection', 'action', 'entitlement', 'live_state']);
  });
});

describe('effectiveAllow — single-leg denials', () => {
  it('denies on owner_rbac when the grantor RBAC lacks the capability', () => {
    const input = baseInput();
    input.owner.rbacAllowedActionIds = ['projectsites.site.read'];
    expectDeniedBy(input, 'owner_rbac');
  });

  it('denies on grant when the request targets a different org (org binding)', () => {
    const input = baseInput();
    input.request.orgId = 'org_evil';
    expectDeniedBy(input, 'grant');
  });

  it('denies on grant when the requested model is outside the model snapshot', () => {
    const input = baseInput();
    input.request.modelId = 'openai.gpt_5';
    expectDeniedBy(input, 'grant');
  });

  it('denies on grant when the capability requires a model and none is requested', () => {
    const input = baseInput();
    input.capability.resourceRequirements.model = 'required';
    expectDeniedBy(input, 'grant');
  });

  it('denies on site when a required site is missing from the request', () => {
    const input = baseInput();
    input.capability.resourceRequirements.site = 'required';
    delete input.request.siteId;
    expectDeniedBy(input, 'site');
  });

  it('denies on site when the caller-supplied site id is outside the snapshot', () => {
    const input = baseInput();
    input.request.siteId = 'site_b_not_granted';
    expectDeniedBy(input, 'site');
  });

  it('denies on site even when the capability does not use sites (stray id never expands access)', () => {
    const input = baseInput();
    input.capability.resourceRequirements.site = 'none';
    input.request.siteId = 'site_b_not_granted';
    expectDeniedBy(input, 'site');
  });

  it('denies on connection when a required connection is missing', () => {
    const input = baseInput();
    delete input.request.connectionId;
    expectDeniedBy(input, 'connection');
  });

  it('denies on connection when the connection id is outside the snapshot', () => {
    const input = baseInput();
    input.request.connectionId = 'conn_someone_elses';
    expectDeniedBy(input, 'connection');
  });

  it('denies on action for an UNKNOWN/discovered tool id not in the snapshot (MCP annotations are hints)', () => {
    const input = baseInput();
    const discovered = 'notion.page.delete_everything';
    input.capability.id = discovered;
    input.request.actionId = discovered;
    input.owner.rbacAllowedActionIds.push(discovered);
    input.entitlement.enabledActionIds.push(discovered);
    expectDeniedBy(input, 'action');
  });

  it('denies on action when request.actionId mismatches the capability manifest', () => {
    const input = baseInput();
    input.request.actionId = 'projectsites.site.read';
    expectDeniedBy(input, 'action');
  });

  it('denies on action when a key-required capability has no idempotency key', () => {
    const input = baseInput();
    delete input.request.idempotencyKey;
    expectDeniedBy(input, 'action');
  });

  it('denies on entitlement when the org plan does not enable the capability', () => {
    const input = baseInput();
    input.entitlement.enabledActionIds = ['projectsites.site.read'];
    expectDeniedBy(input, 'entitlement');
  });
});

describe('effectiveAllow — live_state fail-closed (revoked / expired / revision / approval / budget)', () => {
  it('denies on live_state when the grant is revoked', () => {
    const input = baseInput();
    input.grant.revokedAt = '2026-09-29T11:59:00Z';
    expectDeniedBy(input, 'live_state');
  });

  it('denies on live_state even when revokedAt is in the future (set = revoked)', () => {
    const input = baseInput();
    input.grant.revokedAt = '2099-01-01T00:00:00Z';
    expectDeniedBy(input, 'live_state');
  });

  it('denies on live_state when the grant is expired', () => {
    const input = baseInput();
    input.grant.expiresAt = '2026-09-29T11:00:00Z';
    expectDeniedBy(input, 'live_state');
  });

  it('denies on live_state when the snapshot revision is stale vs the authoritative revision', () => {
    const input = baseInput();
    input.live.authoritativeRevision = 4;
    expectDeniedBy(input, 'live_state');
  });

  it('denies on live_state when approval is required and live approval is "none"', () => {
    const input = baseInput();
    input.capability.approval = 'required';
    input.live.approval = 'none';
    expectDeniedBy(input, 'live_state');
  });

  it('denies on live_state when approval is required and live approval is only "pending"', () => {
    const input = baseInput();
    input.capability.approval = 'required';
    input.live.approval = 'pending';
    expectDeniedBy(input, 'live_state');
  });

  it('allows a required-approval capability once approval is server-verified "granted"', () => {
    const input = baseInput();
    input.capability.approval = 'required';
    input.live.approval = 'granted';
    expect(effectiveAllow(input).allowed).toBe(true);
  });

  it('denies configured-automation capability when the grant did NOT configure automation', () => {
    const input = baseInput();
    input.capability.approval = 'configured-automation';
    input.grant.approvalPolicy = 'follow_capability';
    expectDeniedBy(input, 'live_state');
  });

  it('allows configured-automation capability when the grant configured automation', () => {
    const input = baseInput();
    input.capability.approval = 'configured-automation';
    input.grant.approvalPolicy = 'configured_automation';
    expect(effectiveAllow(input).allowed).toBe(true);
  });

  it('grant approvalPolicy always_require tightens even an auto capability', () => {
    const input = baseInput();
    input.capability.approval = 'auto';
    input.grant.approvalPolicy = 'always_require';
    input.live.approval = 'none';
    expectDeniedBy(input, 'live_state');
  });

  it('denies on live_state when a spend limit is set but live headroom is UNKNOWN (fail closed)', () => {
    const input = baseInput();
    delete input.live.budget.spendRemainingCents;
    expectDeniedBy(input, 'live_state');
  });

  it('denies on live_state when the spend budget is exhausted', () => {
    const input = baseInput();
    input.live.budget.spendRemainingCents = 0;
    expectDeniedBy(input, 'live_state');
  });

  it('denies on live_state when rpm headroom is unknown or exhausted', () => {
    const unknown = baseInput();
    delete unknown.live.budget.rpmRemaining;
    expectDeniedBy(unknown, 'live_state');

    const exhausted = baseInput();
    exhausted.live.budget.rpmRemaining = 0;
    expectDeniedBy(exhausted, 'live_state');
  });

  it('denies on live_state when concurrency headroom is unknown or exhausted', () => {
    const unknown = baseInput();
    delete unknown.live.budget.concurrencyAvailable;
    expectDeniedBy(unknown, 'live_state');

    const exhausted = baseInput();
    exhausted.live.budget.concurrencyAvailable = 0;
    expectDeniedBy(exhausted, 'live_state');
  });

  it('allows when the grant sets NO limits and live budget carries no headroom data', () => {
    const input = baseInput();
    input.grant.limits = {};
    input.live.budget = {};
    expect(effectiveAllow(input).allowed).toBe(true);
  });
});

describe('effectiveAllow — empty intersection + multi-leg reporting', () => {
  it('denies with an all-empty grant snapshot (empty intersection) and names every failing leg', () => {
    const input = baseInput();
    input.grant.siteIds = [];
    input.grant.connectionIds = [];
    input.grant.actionIds = [];
    input.grant.modelIds = [];
    expectDeniedBy(input, 'site', 'connection', 'action');
  });

  it('reports MULTIPLE failing legs precisely, in canonical order', () => {
    const input = baseInput();
    input.owner.rbacAllowedActionIds = [];
    input.entitlement.enabledActionIds = [];
    input.grant.revokedAt = '2026-09-29T11:00:00Z';
    expectDeniedBy(input, 'owner_rbac', 'entitlement', 'live_state');
  });

  it('fails closed (not open, not throwing) on structurally invalid input', () => {
    const result = effectiveAllow({ garbage: true } as unknown as GrantCheckInput);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected denial');
    expect(result.deniedBy[0].leg).toBe('grant');
    expect(result.deniedBy[0].reason).toContain('fail closed');
  });

  it('fails closed when a whole leg input (entitlement) is missing', () => {
    const input = baseInput();
    delete (input as Partial<GrantCheckInput>).entitlement;
    const result = effectiveAllow(input);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error('expected denial');
    expect(result.deniedBy[0].leg).toBe('grant');
  });

  it('never mutates its input (pure function)', () => {
    const input = baseInput();
    const snapshot = JSON.parse(JSON.stringify(input));
    effectiveAllow(input);
    expect(input).toEqual(snapshot);
  });
});
