/**
 * Regression — every option the human-in-the-loop logo elicitation OFFERS must
 * actually DO something when chosen. (AL-875 follow-on)
 *
 * `postAskUser` offers `['Approve', 'Regenerate', 'Use my own']`, but the resume
 * branch only special-cased `Use my own`; `Regenerate` fell through IDENTICALLY
 * to `Approve` — the owner's explicit "try a new logo" was a silent no-op and
 * they got no signal at all (the no-op-choice class). There is no standalone
 * `generate-logo` workflow step to re-fire (logo discovery/generation happens
 * INSIDE the container build), so the faithful "try a new logo" is a fresh run:
 * halt this instance + flip the site to `collecting` + emit the owner event the
 * re-run hangs off.
 *
 * This harness drives the REAL logo-approval closure (waitForEvent mocked) and
 * asserts both halting branches; `Approve` must still fall through untouched.
 *
 * @swc/jest hoists jest.mock only when it sees the GLOBAL `jest` — do NOT import
 * it from @jest/globals (project CLAUDE.md gotcha #12).
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

jest.mock('../services/task_inbox.js', () => ({
  __esModule: true,
  postAskUser: jest.fn(async () => ({ id: 'task-1' })),
}));

import { SiteGenerationWorkflow } from '../workflows/site-generation.js';
import type { Env } from '../types/env.js';
import type { WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

/** Records every SQL write so we can assert the status flip. */
const sqlRuns: { sql: string; params: unknown[] }[] = [];

function baseEnv(): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          run: async () => {
            sqlRuns.push({ sql, params });
            return {};
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
    },
    CACHE_KV: { get: async () => null, put: async () => undefined },
    // The logo-approval gate runs BEFORE the budget killswitch / container call,
    // so nothing past it should ever be reached on a halting choice.
    SITE_BUILDER: {
      idFromName: () => 'cid',
      get: () => ({
        fetch: async () => {
          throw new Error('__CONTAINER_REACHED__');
        },
        stop: async () => {},
      }),
    },
  } as unknown as Env;
}

/** Canned returns for the pre-gate steps (mirrors the proven replay harness). */
const CANNED: Record<string, unknown> = {
  'mint-version': '2026-01-01T00-00-00-000Z',
  'budget-killswitch': '{}',
  'logo-approval-post': 'task-1',
};

/**
 * Step mock that invokes the REAL closure for `logo-approval-*` steps and the
 * budget killswitch, and returns canned values elsewhere. `waitForEvent` always
 * resolves with `choice`, so the branch under test is deterministic.
 */
function stepResolvingLogo(choice: string): WorkflowStep {
  return {
    do: jest.fn(async (name: string, optsOrFn: unknown, maybeFn?: unknown) => {
      const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as
        | (() => Promise<unknown>)
        | undefined;
      if (name.startsWith('logo-approval') || name === 'budget-killswitch') {
        return fn ? await fn() : CANNED[name];
      }
      return CANNED[name];
    }),
    waitForEvent: jest.fn(async () => ({ payload: { choice } })),
  } as unknown as WorkflowStep;
}

const params = { siteId: 's1', slug: 'mysite', businessName: 'Acme', orgId: 'o1' };

/** Env with the elicitation gate ON — the only configuration that runs the branch. */
const gatedEnv = () => {
  const env = baseEnv() as unknown as Record<string, unknown>;
  env.SITE_GEN_REQUIRES_LOGO_APPROVAL = 'true';
  return env as unknown as Env;
};

const run = (step: WorkflowStep) =>
  new SiteGenerationWorkflow({} as never, gatedEnv()).run(
    { payload: params } as unknown as WorkflowEvent<never>,
    step,
  );

beforeEach(() => {
  sqlRuns.length = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('logo approval — every offered choice must DO something', () => {
  it('Regenerate HALTS with reason regenerating_logo (no silent Approve fall-through)', async () => {
    await expect(run(stepResolvingLogo('Regenerate'))).resolves.toMatchObject({
      siteId: 's1',
      status: 'halted',
      reason: 'regenerating_logo',
    });
  });

  it('Regenerate flips the site to `collecting` so the next run re-picks the logo', async () => {
    await run(stepResolvingLogo('Regenerate'));

    // TWO `UPDATE sites` writes happen on this path: the early `generating` flip,
    // then the `collecting` flip inside the Regenerate branch. `.find()` returns
    // the FIRST (generating) — FIRST-MATCH-ORDER: never use `find`/`match` for
    // "the one that matters here". Assert over the whole set instead.
    const flipsTo = (status: string) =>
      sqlRuns.some((r) => /UPDATE\s+sites/i.test(r.sql) && r.params.includes(status));
    expect(flipsTo('generating')).toBe(true);
    expect(flipsTo('collecting')).toBe(true);
  });

  it('Regenerate never reaches the container (halts before the expensive build)', async () => {
    // A reached container throws __CONTAINER_REACHED__; the halt must prevent it.
    await expect(run(stepResolvingLogo('Regenerate'))).resolves.toMatchObject({
      status: 'halted',
    });
  });

  it('Use my own still HALTS with reason awaiting_user_upload', async () => {
    await expect(run(stepResolvingLogo('Use my own'))).resolves.toMatchObject({
      siteId: 's1',
      status: 'halted',
      reason: 'awaiting_user_upload',
    });
  });

  it('Approve does NOT halt — it falls through to the build (sentinel stop)', async () => {
    // Approve is the ONLY choice that continues. Stop run() at the first
    // post-gate step so the test never drives the full container pipeline.
    const step = {
      do: jest.fn(async (name: string, optsOrFn: unknown, maybeFn?: unknown) => {
        const fn = (typeof optsOrFn === 'function' ? optsOrFn : maybeFn) as
          | (() => Promise<unknown>)
          | undefined;
        if (name.startsWith('logo-approval')) return fn ? await fn() : CANNED[name];
        if (name === 'budget-killswitch') throw new Error('__STOP__:budget-killswitch');
        return CANNED[name];
      }),
      waitForEvent: jest.fn(async () => ({ payload: { choice: 'Approve' } })),
    } as unknown as WorkflowStep;

    // Reaching the killswitch proves Approve fell THROUGH the halting branches.
    await expect(run(step)).rejects.toThrow(/__STOP__:budget-killswitch/);
  });
});
