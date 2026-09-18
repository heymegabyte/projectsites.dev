/**
 * Regression — the PRE-FLIGHT build-LLM no-credit refusal must NOTIFY the org owner
 * (a `build.failed` event), never leave a silent dead-end. (AL-781)
 *
 * The no-credit branch of the pre-flight gate (workflows/site-generation.ts) flips the
 * site to `error`, logs the operator top-up URL, and throws — but until AL-781 it was
 * the ONLY terminal-failure path that did NOT call notifyBuildFailed (timeout /
 * container-error / zero-upload all do). While build-LLM credit is dead this is the path
 * EVERY build hits, so the owner searched → created → waited → got zero signal.
 *
 * The replay-mock in site_generation_workflow.test.ts returns canned values per step
 * name and NEVER invokes the step closures, so it can't exercise this branch. This
 * harness drives the REAL pre-flight closure (with checkBuildLlmCredit mocked) and
 * asserts the owner-notification wiring.
 *
 * @swc/jest hoists jest.mock only when it sees the GLOBAL `jest` — do NOT import it
 * from @jest/globals (project CLAUDE.md gotcha #12).
 */
jest.mock(
  'cloudflare:workers',
  () => ({
    __esModule: true,
    WorkflowEntrypoint: class<E, P> {
      env: E;
      constructor(_ctx: unknown, env: E) {
        this.env = env;
      }
    },
  }),
  { virtual: true },
);

jest.mock('../services/build_llm_credit.js', () => ({
  __esModule: true,
  checkBuildLlmCredit: jest.fn(),
  BUILD_LLM_TOPUP_URLS: {
    deepseek: 'https://platform.deepseek.com/top_up',
    anthropic: 'https://console.anthropic.com/settings/billing',
  },
}));

// notifyBuildFailed dynamically imports this module, so mocking it captures the call.
jest.mock('../services/notify.js', () => ({
  __esModule: true,
  notifyOwnerEvent: jest.fn(async () => ({ ok: true })),
}));

import { SiteGenerationWorkflow } from '../workflows/site-generation.js';
import { checkBuildLlmCredit } from '../services/build_llm_credit.js';
import { notifyOwnerEvent } from '../services/notify.js';
import type { Env } from '../types/env.js';
import type { WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

const mockCheck = checkBuildLlmCredit as unknown as jest.Mock;
const mockNotify = notifyOwnerEvent as unknown as jest.Mock;

function baseEnv(): Env {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({}),
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
    },
    CACHE_KV: { get: async () => null, put: async () => undefined },
    SITE_BUILDER: {
      idFromName: () => 'cid',
      get: () => ({ fetch: async () => new Response('{}'), stop: async () => {} }),
    },
  } as unknown as Env;
}

// Canned returns for the steps that run BEFORE the pre-flight gate — mirrors the
// proven replay harness so run() reaches the gate exactly as it would live.
const CANNED: Record<string, unknown> = {
  'mint-version': '2026-01-01T00-00-00-000Z',
  'budget-killswitch': '{}',
  'logo-approval-post': '{}',
};

// Step mock that INVOKES the real pre-flight closure (the code under test) and returns
// canned/undefined for everything else. `stopAt` lets the ok:true path halt run() right
// after the gate with a sentinel, so the test never drives the whole container pipeline.
function stepInvokingPreflight(stopAt?: string): WorkflowStep {
  return {
    do: jest.fn(async (name: string, optsOrFn: unknown, maybeFn?: unknown) => {
      const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as
        | (() => Promise<unknown>)
        | undefined;
      if (name === 'preflight-build-llm-credit' && fn) return await fn();
      if (stopAt && name === stopAt) throw new Error(`__STOP__:${stopAt}`);
      return CANNED[name];
    }),
  } as unknown as WorkflowStep;
}

const params = { siteId: 's1', slug: 'mysite', businessName: 'Acme', orgId: 'o1' };
const run = (step: WorkflowStep) => {
  const wf = new SiteGenerationWorkflow({} as never, baseEnv());
  return wf.run({ payload: params } as unknown as WorkflowEvent<never>, step);
};

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockNotify.mockClear();
  mockCheck.mockReset();
});
afterEach(() => jest.restoreAllMocks());

describe('pre-flight no-credit refusal — owner notification (AL-781)', () => {
  it('NOTIFIES the org owner (build.failed) when build-LLM credit is dead — never a silent dead-end', async () => {
    mockCheck.mockResolvedValue({
      ok: false,
      provider: 'deepseek',
      reason: 'dead_balance',
      balance: '-0.56',
    });

    await expect(run(stepInvokingPreflight())).rejects.toThrow(/build-llm-no-credit:deepseek/);

    // The discriminating assertion — RED before AL-781 (the branch threw WITHOUT
    // notifying), GREEN after. notifyBuildFailed → notifyOwnerEvent(env, db, {orgId, event}).
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const call = mockNotify.mock.calls[0] as unknown[];
    const arg = call[2] as {
      orgId: string;
      event: { event: string; siteId: string; tenantId: string };
    };
    expect(arg.orgId).toBe('o1');
    expect(arg.event.event).toBe('build.failed');
    expect(arg.event.siteId).toBe('s1');
    expect(arg.event.tenantId).toBe('o1');
  });

  it('does NOT notify on healthy credit — the refusal notify fires ONLY on the dead-credit branch', async () => {
    mockCheck.mockResolvedValue({ ok: true, provider: 'deepseek', reason: 'ok', checked: true });

    // ok:true → the gate passes; halt run() right after at start-build so we don't
    // drive the whole container pipeline. No build.failed notify may have fired.
    await expect(run(stepInvokingPreflight('start-build'))).rejects.toThrow(/__STOP__:start-build/);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
