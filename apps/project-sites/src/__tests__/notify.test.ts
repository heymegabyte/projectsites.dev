/**
 * @module __tests__/notify
 * Unit tests for the psnotify trigger ({@link notifyUser}). Tests the stub
 * path — never calls an external API. Covers happy path and error surfaces.
 */
import {
  notifyUser,
  notifySiteOwner,
  redactEmailForLog,
  notifyLogLine,
} from '../services/notify.js';
import { tryEmitEvent } from '../services/emit_event.js';
import type { Env } from '../types/env.js';

jest.mock('../services/emit_event.js', () => ({ tryEmitEvent: jest.fn() }));
const mockEmit = tryEmitEvent as jest.Mock;

const makeDb = (email: string | null) =>
  ({
    prepare: () => ({ bind: () => ({ first: async () => (email ? { email } : null) }) }),
  }) as unknown as D1Database;

/** Like makeDb but records every prepared SQL string so tests can assert on it. */
const capturingDb = (calls: string[], email: string | null) =>
  ({
    prepare: (sql: string) => {
      calls.push(sql);
      return { bind: () => ({ first: async () => (email ? { email } : null) }) };
    },
  }) as unknown as D1Database;

const throwingDb = () =>
  ({
    prepare: () => {
      throw new Error('d1 down');
    },
  }) as unknown as D1Database;

const baseEnv = {} as unknown as Env;
const input = { subscriberId: 'user@example.com', subject: 'Hi', body: 'Body' };

describe('notifyUser', () => {
  it('returns ok:true via psnotify stub (no external API call)', async () => {
    const res = await notifyUser(baseEnv, input);
    expect(res.ok).toBe(true);
    expect(res.detail).toBeTruthy();
  });

  it('honors a custom workflowId', async () => {
    const res = await notifyUser(baseEnv, { ...input, workflowId: 'site-published' });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('site-published');
  });

  it('returns ok:false when subscriberId is empty', async () => {
    const res = await notifyUser(baseEnv, { ...input, subscriberId: '' });
    expect(res).toEqual({ ok: false, detail: 'no_subscriber' });
  });
});

describe('notifySiteOwner', () => {
  beforeEach(() => mockEmit.mockReset().mockResolvedValue({ inserted: true }));

  it('resolves the org owner email then triggers psnotify for that subscriber', async () => {
    const res = await notifySiteOwner(baseEnv, makeDb('owner@org.com'), {
      orgId: 'org_1',
      subject: 'Payment received',
      body: 'Active.',
    });
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('owner@org.com');
  });

  it('emits notification.workflow.triggered (tenant-scoped) on success', async () => {
    await notifySiteOwner(baseEnv, makeDb('owner@org.com'), {
      orgId: 'org_1',
      subject: 'Payment received',
      body: 'Active.',
    });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [, ev] = mockEmit.mock.calls[0];
    expect(ev).toEqual(
      expect.objectContaining({
        type: 'notification.workflow.triggered',
        producer: 'psnotify',
        tenantId: 'org_1',
      }),
    );
    expect(ev.data).toEqual(expect.objectContaining({ subscriberId: 'owner@org.com' }));
  });

  it('returns ok:false when the org has no resolvable owner', async () => {
    const res = await notifySiteOwner(baseEnv, makeDb(null), {
      orgId: 'org_1',
      subject: 's',
      body: 'b',
    });
    expect(res).toEqual({ ok: false, detail: 'no_owner' });
  });

  it('returns ok:false when orgId is empty', async () => {
    const res = await notifySiteOwner(baseEnv, makeDb('x@y.com'), {
      orgId: '',
      subject: 's',
      body: 'b',
    });
    expect(res).toEqual({ ok: false, detail: 'no_org' });
  });

  it('returns ok:false on a D1 lookup failure (never throws)', async () => {
    const res = await notifySiteOwner(baseEnv, throwingDb(), {
      orgId: 'org_1',
      subject: 's',
      body: 'b',
    });
    expect(res).toEqual({ ok: false, detail: 'lookup_failed' });
  });

  it('excludes soft-deleted memberships/users from the owner lookup (a removed member is never notified)', async () => {
    const calls: string[] = [];
    const res = await notifySiteOwner(baseEnv, capturingDb(calls, 'owner@org.com'), {
      orgId: 'org_1',
      subject: 's',
      body: 'b',
    });
    expect(res.ok).toBe(true);
    expect(calls[0]).toContain('m.deleted_at IS NULL');
    expect(calls[0]).toContain('u.deleted_at IS NULL');
  });
});

describe('notify observability — redactEmailForLog + notifyLogLine', () => {
  it('masks an email to first-char + domain (never a raw address in logs)', () => {
    expect(redactEmailForLog('brian@megabyte.space')).toBe('b***@megabyte.space');
    expect(redactEmailForLog('a@b.co')).toBe('a***@b.co');
    expect(redactEmailForLog('')).toBe('');
    // a non-email string can't leak a full address (no @ → returned unchanged is acceptable)
    expect(redactEmailForLog('not-an-email')).toBe('not-an-email');
  });

  it('notify.sent is level:info, carries a REDACTED subscriber + workflowId + txId', () => {
    const line = JSON.parse(
      notifyLogLine('notify.sent', {
        subscriberId: 'owner@shop.com',
        workflowId: 'site-published',
        txId: 'tx_123',
      }),
    );
    expect(line).toEqual({
      level: 'info',
      event: 'notify.sent',
      subscriber: 'o***@shop.com', // redacted — never the raw address
      workflowId: 'site-published',
      txId: 'tx_123',
    });
  });

  it('a failed owner-notify is ATTRIBUTABLE — orgId present, level:warn, no raw email (the fixed gap)', () => {
    const line = JSON.parse(
      notifyLogLine('notify.owner_lookup_failed', { orgId: 'org-brian-001', reason: 'd1 down' }),
    );
    expect(line.level).toBe('warn');
    expect(line.event).toBe('notify.owner_lookup_failed');
    expect(line.orgId).toBe('org-brian-001'); // ← the correlation the old bare-message log lacked
    expect(line.reason).toBe('d1 down');
    expect(line).not.toHaveProperty('subscriber');
  });

  it('omits unset fields (stable, compact shape) and is always valid JSON', () => {
    expect(notifyLogLine('notify.skipped', { reason: 'no_subscriber' })).toBe(
      '{"level":"info","event":"notify.skipped","reason":"no_subscriber"}',
    );
    expect(() => JSON.parse(notifyLogLine('notify.error'))).not.toThrow();
  });
});
