// Global `jest` (NOT @jest/globals) so @swc/jest hoists the mock above the import.
jest.mock('../services/db.js', () => ({ dbQueryOne: jest.fn() }));
// Fire-54: mock the DO-write boundary so the END-TO-END bell path (real
// notifyOwnerEvent → PsnotifyEventSchema → triggerPsnotify) is provable without a DO.
jest.mock('../services/psnotify.js', () => {
  const actual = jest.requireActual('../services/psnotify.js');
  return { __esModule: true, ...actual, triggerPsnotify: jest.fn() };
});
jest.mock('../services/emit_event.js', () => ({
  __esModule: true,
  tryEmitEvent: jest.fn(async () => ({ inserted: true })),
}));

import { notifyOwnerSiteBuilt, resolveOwnerEmail } from '../services/notify_site_built';
import { dbQueryOne } from '../services/db.js';
import { triggerPsnotify } from '../services/psnotify.js';

const mockDbQueryOne = dbQueryOne as unknown as jest.Mock;
const mockTrigger = triggerPsnotify as unknown as jest.Mock;

/**
 * Golden-path "customer notified" for the embedded-bolt publish path. Notifies
 * the org owner their site is live across BOTH channels — the rich email
 * (notifySiteBuilt) + the in-app bell (build.finished) — each independent
 * and fail-soft so one failing never blocks the other or the publish.
 */
const env = { DB: {} } as never;

function deps(over: Partial<Parameters<typeof notifyOwnerSiteBuilt>[2]> = {}) {
  return {
    resolveEmail: jest.fn().mockResolvedValue('owner@acme.com'),
    notify: jest.fn().mockResolvedValue(undefined),
    bell: jest.fn().mockResolvedValue({ ok: true }),
    ...over,
  };
}

describe('notifyOwnerSiteBuilt', () => {
  it('emails the resolved owner AND fires the build.finished bell with the preview URL', async () => {
    const d = deps();
    const r = await notifyOwnerSiteBuilt(
      env,
      { orgId: 'org-1', siteId: 's1', slug: 'acme', version: 'v1', businessName: 'Acme Roofing' },
      d,
    );
    expect(r).toEqual({ emailed: true, belled: true });
    expect(d.notify.mock.calls[0][1]).toEqual({
      email: 'owner@acme.com',
      siteName: 'Acme Roofing',
      slug: 'acme',
      siteUrl: 'https://acme.projectsites.dev',
      version: 'v1',
    });
    // Fire-54: the bell MUST receive the CANONICAL PsnotifyEventSchema shape
    // (`{ name, subscriberId, payload }`) — the legacy `{ event, tenantId, siteId,
    // previewUrl }` novu-era object FAILS the schema → invalid_event → the
    // "your site is live" bell silently never fired on the bolt-publish path.
    expect(d.bell).toHaveBeenCalledWith(env, env.DB, {
      orgId: 'org-1',
      workflowId: 'build.complete',
      actionUrl: 'https://acme.projectsites.dev',
      event: {
        name: 'build.complete',
        subscriberId: 'org-1',
        payload: expect.objectContaining({
          siteId: 's1',
          action_url: 'https://acme.projectsites.dev',
          subject: expect.stringContaining('live'),
          body: expect.stringContaining('acme.projectsites.dev'),
        }),
      },
    });
  });

  it('falls back to the slug as the email display name when businessName is absent', async () => {
    const d = deps();
    await notifyOwnerSiteBuilt(env, { orgId: 'o', siteId: 's', slug: 'vitos', version: 'v2' }, d);
    expect(d.notify.mock.calls[0][1].siteName).toBe('vitos');
  });

  it('still fires the bell when the org has no owner email (emailed:false, belled:true)', async () => {
    const d = deps({ resolveEmail: jest.fn().mockResolvedValue(null), notify: jest.fn() });
    const r = await notifyOwnerSiteBuilt(
      env,
      { orgId: 'o', siteId: 's', slug: 's', version: 'v' },
      d,
    );
    expect(r).toEqual({ emailed: false, belled: true });
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('channels are independent: a bell failure leaves the email sent', async () => {
    const d = deps({ bell: jest.fn().mockRejectedValue(new Error('novu down')) });
    const r = await notifyOwnerSiteBuilt(
      env,
      { orgId: 'o', siteId: 's', slug: 's', version: 'v' },
      d,
    );
    expect(r).toEqual({ emailed: true, belled: false });
  });

  it('is fail-soft when the email resolver throws (bell still fires)', async () => {
    const d = deps({ resolveEmail: jest.fn().mockRejectedValue(new Error('d1 down')) });
    const r = await notifyOwnerSiteBuilt(
      env,
      { orgId: 'o', siteId: 's', slug: 's', version: 'v' },
      d,
    );
    expect(r).toEqual({ emailed: false, belled: true });
  });

  it('treats a bell ok:false as not belled', async () => {
    const d = deps({ bell: jest.fn().mockResolvedValue({ ok: false, detail: 'invalid_event' }) });
    const r = await notifyOwnerSiteBuilt(
      env,
      { orgId: 'o', siteId: 's', slug: 's', version: 'v' },
      d,
    );
    expect(r.belled).toBe(false);
  });
});

// Fire-54 END-TO-END: with the DEFAULT bell (the real notifyOwnerEvent), the event
// must clear PsnotifyEventSchema and actually reach the DO-write boundary
// (triggerPsnotify) carrying the live-site deep link. This is the assertion the
// original mock-only spec could not make — it happily "passed" the legacy shape
// against an injected mock while prod silently no-op'd with invalid_event.
describe('notifyOwnerSiteBuilt → REAL bell path reaches the psnotify DO write', () => {
  const envWithOwner = {
    DB: {
      prepare: () => ({ bind: () => ({ first: async () => ({ email: 'owner@acme.com' }) }) }),
    },
  } as never;

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockTrigger.mockReset().mockResolvedValue({ result: 'do-notif-1', success: true });
  });
  afterEach(() => jest.restoreAllMocks());

  it('belled:true — the canonical event validates and the DO write fires with the site URL', async () => {
    const r = await notifyOwnerSiteBuilt(
      envWithOwner,
      { orgId: 'org-1', siteId: 's1', slug: 'acme', version: 'v1', businessName: 'Acme Roofing' },
      // bell OMITTED on purpose → the real notifyOwnerEvent runs (schema + transport).
      { resolveEmail: jest.fn().mockResolvedValue('owner@acme.com'), notify: jest.fn() },
    );
    expect(r.belled).toBe(true);

    expect(mockTrigger).toHaveBeenCalledTimes(1);
    const ev = mockTrigger.mock.calls[0][1] as {
      name: string;
      subscriberId: string;
      payload: Record<string, unknown>;
    };
    // The resolved OWNER email is the bell subscriber — never a raw org id.
    expect(ev.subscriberId).toBe('owner@acme.com');
    // One click on the bell row opens the freshly-published site.
    expect(ev.payload.action_url ?? ev.payload.actionUrl).toBe('https://acme.projectsites.dev');
    expect(String(ev.payload.subject)).toContain('live');
  });
});

describe('resolveOwnerEmail (recipient soft-delete filter)', () => {
  beforeEach(() => mockDbQueryOne.mockReset());

  it('excludes soft-deleted memberships/users so a removed owner is never emailed', async () => {
    mockDbQueryOne.mockResolvedValue({ email: 'owner@acme.com' });
    const email = await resolveOwnerEmail(env, 'org-1');
    expect(email).toBe('owner@acme.com');
    // The owner lookup SQL (2nd arg) must scope out soft-deleted rows.
    const sql = String(mockDbQueryOne.mock.calls[0][1]);
    expect(sql).toContain('m.deleted_at IS NULL');
    expect(sql).toContain('u.deleted_at IS NULL');
  });

  it('returns null when no active owner membership resolves', async () => {
    mockDbQueryOne.mockResolvedValue(null);
    expect(await resolveOwnerEmail(env, 'org-x')).toBeNull();
  });
});
