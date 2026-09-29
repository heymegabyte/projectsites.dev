/**
 * Money-path regression — the site-generation workflow's build-complete /
 * build-fail owner notification must ACTUALLY reach the psnotify DO write
 * (`triggerPsnotify`), carrying the site URL as the bell row's `action_url`.
 *
 * The gap this guards (BACKLOG fire-51 replenish "Owner-notify on build-complete /
 * build-fail — psnotify `build.*` channel never fires"): every workflow owner-notify
 * passed the legacy novu-era `{ event, tenantId, siteId, … }` object, which FAILS the
 * canonical `PsnotifyEventSchema` (`{ name, subscriberId, payload }`) → `notifyOwnerEvent`
 * returned `invalid_event` and the DO write NEVER fired. A prior fire made that rejection
 * observable (a `notify.invalid_event` log) but did NOT fix the callers — the owner still
 * silently discovered build status via polling. This asserts the SEND actually happens.
 *
 * We mock the DO-write boundary (`triggerPsnotify`) — never a real DO / external call —
 * and assert the canonical event + `action_url` reach it. `notifyOwnerEvent` /
 * `notifySiteOwner` resolve the owner email from D1 (mocked here).
 *
 * @swc/jest hoists jest.mock only when it sees the GLOBAL `jest` — do NOT import it
 * from @jest/globals (project CLAUDE.md gotcha #12).
 */
jest.mock('../services/psnotify.js', () => {
  const actual = jest.requireActual('../services/psnotify.js');
  return { __esModule: true, ...actual, triggerPsnotify: jest.fn() };
});
jest.mock('../services/emit_event.js', () => ({
  __esModule: true,
  tryEmitEvent: jest.fn(async () => ({ inserted: true })),
}));

import { notifyOwnerEvent, notifySiteOwner } from '../services/notify.js';
import { triggerPsnotify } from '../services/psnotify.js';
import type { Env } from '../types/env.js';

const mockTrigger = triggerPsnotify as unknown as jest.Mock;

const baseEnv = {} as unknown as Env;
const ownerDb = () =>
  ({
    prepare: () => ({ bind: () => ({ first: async () => ({ email: 'owner@shop.com' }) }) }),
  }) as unknown as D1Database;

/** The site URL the workflow deep-links the bell row to on completion. */
const SITE_URL = 'https://acme.projectsites.dev';

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  mockTrigger.mockReset().mockResolvedValue({ result: 'do-notif-1', success: true });
});
afterEach(() => jest.restoreAllMocks());

describe('workflow build.* owner-notify actually fires the psnotify DO write', () => {
  it('build.complete: dispatches a CANONICAL psnotify event carrying the site URL as action_url (not invalid_event)', async () => {
    const res = await notifyOwnerEvent(baseEnv, ownerDb(), {
      orgId: 'org_1',
      workflowId: 'build.complete',
      actionUrl: SITE_URL,
      event: {
        name: 'build.complete',
        subscriberId: 'org_1',
        payload: {
          subject: 'Your site is live 🎉',
          body: 'acme.projectsites.dev is now live.',
        },
      },
    });

    // The gap was a silent skip — here the send must SUCCEED, not return invalid_event.
    expect(res.ok).toBe(true);
    expect(res.detail).not.toBe('invalid_event');

    // The DO write boundary must have been reached exactly once.
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    const ev = mockTrigger.mock.calls[0][1] as {
      name: string;
      subscriberId: string;
      payload: Record<string, unknown>;
    };
    // Canonical shape — the resolved OWNER email is the subscriber, never a raw org id.
    expect(ev.subscriberId).toBe('owner@shop.com');
    // The bell row deep-links to the live site.
    expect(ev.payload.action_url ?? ev.payload.actionUrl).toBe(SITE_URL);
    expect(String(ev.payload.subject)).toContain('live');
  });

  it('build.failed: dispatches the failure reason to the DO write (owner is told WHY)', async () => {
    const reason = 'Build timed out after 900s';
    const res = await notifyOwnerEvent(baseEnv, ownerDb(), {
      orgId: 'org_1',
      workflowId: 'build.failed',
      actionUrl: SITE_URL,
      event: {
        name: 'build.failed',
        subscriberId: 'org_1',
        payload: { subject: 'Your site build needs attention', body: reason },
      },
    });

    expect(res.ok).toBe(true);
    expect(res.detail).not.toBe('invalid_event');
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    const ev = mockTrigger.mock.calls[0][1] as { payload: Record<string, unknown> };
    expect(String(ev.payload.body)).toBe(reason);
    expect(ev.payload.action_url ?? ev.payload.actionUrl).toBe(SITE_URL);
  });

  it('flag-off / DO unbound: the write no-ops silently and the build is never failed', async () => {
    // With PSNOTIFY_DO absent (the dark/flag-off state), the REAL triggerPsnotify logs +
    // returns { success: true } — a silent no-op that never throws (see services/psnotify.ts
    // § binding_missing). Model that here: the mock returns the binding-missing success shape.
    // notifySiteOwner threads it through without raising, so a fire-and-forget waitUntil
    // caller (the workflow) is never failed by a dark psnotify.
    mockTrigger.mockResolvedValueOnce({ result: 'ps-notify:org_1:0', success: true });
    const res = await notifySiteOwner({ PSNOTIFY_DO: undefined } as unknown as Env, ownerDb(), {
      orgId: 'org_1',
      subject: 'Your site is live 🎉',
      body: 'acme.projectsites.dev is now live.',
      actionUrl: SITE_URL,
      workflowId: 'build.complete',
    });
    // Never throws; the dark write reports success (nothing to fail the build).
    expect(res.ok).toBe(true);

    // And prove the REAL contract: triggerPsnotify with PSNOTIFY_DO absent is a silent
    // success no-op (this is what makes flag-off = skip without a redundant isFlagOn gate).
    const realPsnotify = jest.requireActual('../services/psnotify.js') as {
      triggerPsnotify: (env: Env, ev: unknown) => Promise<{ success: boolean }>;
    };
    const dark = await realPsnotify.triggerPsnotify({ PSNOTIFY_DO: undefined } as unknown as Env, {
      name: 'build.complete',
      subscriberId: 'owner@shop.com',
      payload: { subject: 'live', body: 'live', action_url: SITE_URL },
    });
    expect(dark.success).toBe(true);
  });

  it('a psnotify DO-write throw NEVER propagates (the build must not deadletter on a bell failure)', async () => {
    mockTrigger.mockRejectedValueOnce(new Error('DO unreachable'));
    const res = await notifySiteOwner(baseEnv, ownerDb(), {
      orgId: 'org_1',
      subject: 'Your site is live 🎉',
      body: 'live',
      actionUrl: SITE_URL,
      workflowId: 'build.complete',
    });
    // Swallowed → { ok: false }, never a throw. The caller's try/catch + waitUntil are safe.
    expect(res.ok).toBe(false);
  });
});
