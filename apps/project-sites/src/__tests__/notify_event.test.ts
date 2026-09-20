import { notifyEvent, notifyOwnerEvent } from '../services/notify';
import type { Env } from '../types/env';

const baseEnv = {} as unknown as Env;

describe('notifyEvent', () => {
  it('validates + renders a valid psnotify event', async () => {
    const result = await notifyEvent(baseEnv, {
      subscriberId: 'u@x.com',
      event: {
        name: 'site_published',
        subscriberId: 'u@x.com',
        payload: { subject: 'Live', body: 'Your site is live' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on an invalid event shape', async () => {
    const result = await notifyEvent(baseEnv, { subscriberId: 'u@x.com', event: { bogus: true } });
    expect(result).toEqual({ ok: false, detail: 'invalid_event' });
  });

  it('propagates empty subscriber rejection', async () => {
    const result = await notifyEvent(baseEnv, {
      subscriberId: '',
      event: { name: 'x', subscriberId: 'u@x.com', payload: {} },
    });
    expect(result).toEqual({ ok: false, detail: 'no_subscriber' });
  });
});

describe('notifyOwnerEvent', () => {
  const makeDb = (email: string | null) =>
    ({
      prepare: () => ({ bind: () => ({ first: async () => (email ? { email } : null) }) }),
    }) as unknown as D1Database;

  it('returns ok:false on an invalid event shape (before D1 lookup)', async () => {
    const result = await notifyOwnerEvent(baseEnv, makeDb('o@org.com'), {
      orgId: 'org_1',
      event: { bogus: true },
    });
    expect(result).toEqual({ ok: false, detail: 'invalid_event' });
  });
});

// Regression: a rejected event must LOG a structured, attributable warning — never
// skip silently. Guards the exact legacy `{event, tenantId, …}` novu-era shape that
// 7+ live callers (build.finished / build.failed / member.invited / stripe_connect …)
// still pass to the psnotify `{name, subscriberId, payload}` schema — all silently
// no-op'd until this surfaced. (GOLDEN-JOURNEY fire, 2026-09-20.)
describe('notify invalid_event is observable (not silent)', () => {
  it('notifyEvent logs a structured notify.invalid_event naming the drifted event', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await notifyEvent(baseEnv, {
        subscriberId: 'brian@megabyte.space',
        event: { event: 'build.finished', tenantId: 'org-1', siteId: 's1' },
      });
      expect(result).toEqual({ ok: false, detail: 'invalid_event' });
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('notify.invalid_event');
      expect(logged).toContain('build.finished');
      // subscriber redacted, never raw
      expect(logged).toContain('b***@megabyte.space');
      expect(logged).not.toContain('brian@megabyte.space');
    } finally {
      warn.mockRestore();
    }
  });

  it('notifyOwnerEvent logs notify.invalid_event with the orgId', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // db is never touched on the invalid-shape path (returns before lookup).
      const result = await notifyOwnerEvent(baseEnv, {} as unknown as D1Database, {
        orgId: 'org-brian-001',
        event: { event: 'build.failed', tenantId: 'org-brian-001', error: 'boom' },
      });
      expect(result).toEqual({ ok: false, detail: 'invalid_event' });
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('notify.invalid_event');
      expect(logged).toContain('build.failed');
      expect(logged).toContain('org-brian-001');
    } finally {
      warn.mockRestore();
    }
  });
});
