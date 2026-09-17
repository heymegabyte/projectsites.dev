import { Hono } from 'hono';
import { resolveLeadByShortlink, markClaimLinkClicked } from '../services/claim_links.js';
import {
  loadOrCreateSession,
  applyClaimEvent,
  getSession,
} from '../services/claim_session_store.js';
import { getLead } from '../services/lead_store.js';
import { claimRoutes, PLATFORM_CLAIMS_ORG_ID } from '../routes/claim';
import { createBuildSession } from '../services/claim_build_session';

/**
 * #1 claimyour.site — the GET /api/claim/:shortlink funnel route. Stitches the
 * proven cores (resolve → click → session START → provision a platform-org site
 * → kick the workflow → redirect to the prefilled /create). claim_links + the
 * session store + lead_store are mocked; createSite runs FOR REAL against a
 * D1-stub (the @swc/jest module-mock of site_create doesn't intercept in this
 * file — see _LOOP_LEDGER fire-v2.51 — so we control its input via the stub).
 */
jest.mock('../services/claim_links.js', () => ({
  resolveLeadByShortlink: jest.fn(),
  markClaimLinkClicked: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/claim_session_store.js', () => ({
  loadOrCreateSession: jest.fn(),
  applyClaimEvent: jest.fn(),
  getSession: jest.fn(),
}));
jest.mock('../services/lead_store.js', () => ({ getLead: jest.fn() }));
jest.mock('../services/notifications.js', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/emit_event.js', () => ({ tryEmitEvent: jest.fn() }));

import { sendEmail } from '../services/notifications.js';
import { tryEmitEvent } from '../services/emit_event.js';
const mockEmit = tryEmitEvent as jest.Mock;

const mockResolve = resolveLeadByShortlink as jest.Mock;
const mockClicked = markClaimLinkClicked as jest.Mock;
const mockLoad = loadOrCreateSession as jest.Mock;
const mockApply = applyClaimEvent as jest.Mock;
const mockGetSession = getSession as jest.Mock;
const mockGetLead = getLead as jest.Mock;
const mockSendEmail = sendEmail as jest.Mock;

/** D1 stub — createSite's dbInsert + writeAuditLog run against it. `insertFails`
 *  makes `.run()` throw so dbInsert surfaces an error → createSite throws. */
function makeDb(opts: { insertFails?: boolean } = {}) {
  const stmt = {
    bind: () => stmt,
    run: async () => {
      if (opts.insertFails) throw new Error('insert failed');
      return { meta: { changes: 1 } };
    },
    all: async () => ({ results: [] }),
    first: async () => null,
  };
  return { prepare: () => stmt } as unknown as D1Database;
}

function app() {
  const a = new Hono();
  a.route('/', claimRoutes);
  return a;
}
const get = (path: string, db: D1Database = makeDb()) =>
  app().request(path, {}, { DB: db } as never);

beforeEach(() => {
  mockResolve.mockReset();
  mockClicked.mockReset().mockResolvedValue(undefined);
  mockLoad.mockReset();
  mockApply.mockReset().mockResolvedValue(undefined);
  mockGetSession.mockReset().mockResolvedValue(null);
  mockGetLead.mockReset().mockResolvedValue(null);
  mockSendEmail.mockReset().mockResolvedValue(undefined);
});

/**
 * Drive the funnel WITH an ExecutionContext so the background work (workflow
 * kick + the "we're building it" started email) actually runs — collect the
 * waitUntil promises and await them so the test can assert the side effects.
 */
async function getWithCtx(path: string, db: D1Database = makeDb()) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  };
  const res = await app().request(path, {}, { DB: db } as never, ctx as never);
  await Promise.allSettled(pending);
  return res;
}

describe('GET /api/claim/:shortlink', () => {
  it('redirects an unknown shortlink to the friendly create funnel (NOT a raw-JSON dead-end) — AL-700', async () => {
    // An owner clicks this in their browser; an invalid/expired token must land them on the create
    // funnel (a first-action launchpad), never a raw `{error:…}` JSON blob. No session is touched.
    mockResolve.mockResolvedValue(null);
    const res = await get('/api/claim/nope');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/create?claim_invalid=1');
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('emits site.claim.started carrying the click attribution (utm + referer) dimensions', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockLoad.mockResolvedValue(createBuildSession('claim_abc12345', 'lead_9'));
    mockGetLead.mockResolvedValue({
      leadId: 'lead_9',
      profile: { businessName: 'Acme Roofing', email: 'owner@acme.test' },
    });
    mockApply.mockResolvedValue({
      ...createBuildSession('claim_abc12345', 'lead_9'),
      status: 'building',
      attempts: 1,
    });

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
    };
    await app().request(
      '/api/claim/abc12345?utm_source=Twitter&utm_medium=social&utm_campaign=spring',
      { headers: { referer: 'https://news.example.com/article' } },
      { DB: makeDb() } as never,
      ctx as never,
    );
    await Promise.allSettled(pending);

    // The golden-path attribution (source/medium/campaign/referrerHost) MUST reach
    // the event so "which campaign converts" is answerable downstream.
    const started = mockEmit.mock.calls.find(
      (call) => (call[1] as { type?: string })?.type === 'site.claim.started',
    );
    expect(started).toBeTruthy();
    expect((started![1] as { data: Record<string, unknown> }).data).toMatchObject({
      source: 'twitter',
      medium: 'social',
      campaign: 'spring',
      referrerHost: 'news.example.com',
    });
  });

  it('a valid claim link records the click + 302-redirects to the prefilled /create', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockLoad.mockResolvedValue(createBuildSession('claim_abc12345', 'lead_9')); // pending
    mockApply.mockResolvedValue({
      ...createBuildSession('claim_abc12345', 'lead_9'),
      status: 'building',
      attempts: 1,
    });
    const res = await get('/api/claim/abc12345');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/create?claim=abc12345');
    expect(mockClicked).toHaveBeenCalledWith(expect.anything(), 'abc12345');
  });

  it('provisions a platform-org site + STARTs the build with its siteId on a fresh session', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockLoad.mockResolvedValue(createBuildSession('claim_abc12345', 'lead_9')); // pending → canStartBuild
    mockGetLead.mockResolvedValue({
      leadId: 'lead_9',
      profile: { businessName: 'Acme Roofing', phone: '555', address: '1 Main St' },
    });

    await get('/api/claim/abc12345');

    // createSite ran for real (D1-stub) → START_BUILD records the new siteId (a
    // uuid) — the link the build-status callback later resolves to complete it.
    expect(mockApply).toHaveBeenCalledTimes(1);
    const [, sessionId, leadId, event] = mockApply.mock.calls[0];
    expect(sessionId).toBe('claim_abc12345');
    expect(leadId).toBe('lead_9');
    expect(event.type).toBe('START_BUILD');
    expect(typeof event.siteId).toBe('string');
    expect(event.siteId.length).toBeGreaterThan(0);
  });

  it('emails the owner "we are building it" when the lead has an email + a build starts', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockLoad.mockResolvedValue(createBuildSession('claim_abc12345', 'lead_9')); // pending
    mockGetLead.mockResolvedValue({
      leadId: 'lead_9',
      profile: { businessName: 'Acme Roofing', email: 'owner@acme.test' },
    });

    await getWithCtx('/api/claim/abc12345');

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [, opts] = mockSendEmail.mock.calls[0];
    expect(opts.to).toBe('owner@acme.test');
    expect(opts.subject).toMatch(/building your website/i);
    expect(opts.category).toBe('claim_build');
    expect(opts.html).toContain('Acme Roofing');
  });

  it('does NOT email when the lead has no email (started email needs a recipient)', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockLoad.mockResolvedValue(createBuildSession('claim_abc12345', 'lead_9'));
    mockGetLead.mockResolvedValue({ leadId: 'lead_9', profile: { businessName: 'Acme' } });

    await getWithCtx('/api/claim/abc12345');

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('does NOT start the build when the lead is gone (still 302)', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockLoad.mockResolvedValue(createBuildSession('claim_abc12345', 'lead_9')); // pending
    mockGetLead.mockResolvedValue(null); // lead deleted
    const res = await get('/api/claim/abc12345');
    expect(res.status).toBe(302);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('leaves the session pending (no START) when site creation fails — re-click retries', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockLoad.mockResolvedValue(createBuildSession('claim_abc12345', 'lead_9'));
    mockGetLead.mockResolvedValue({ leadId: 'lead_9', profile: { businessName: 'Acme' } });
    // D1 insert fails → createSite throws → caught → no START.
    const res = await get('/api/claim/abc12345', makeDb({ insertFails: true }));
    expect(res.status).toBe(302);
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('a refresh on an already-building session does NOT start a second build (idempotent), still 302', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockLoad.mockResolvedValue({
      ...createBuildSession('claim_abc12345', 'lead_9'),
      status: 'building',
      attempts: 1,
    });
    const res = await get('/api/claim/abc12345');
    expect(res.status).toBe(302);
    expect(mockApply).not.toHaveBeenCalled(); // canStartBuild=false → no dup build
  });
});

describe('GET /api/claim/:shortlink/profile', () => {
  it('404s an unknown shortlink', async () => {
    mockResolve.mockResolvedValue(null);
    const res = await get('/api/claim/nope/profile');
    expect(res.status).toBe(404);
    expect(mockGetLead).not.toHaveBeenCalled();
  });

  it('404s when the lead is gone', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockGetLead.mockResolvedValue(null);
    const res = await get('/api/claim/abc12345/profile');
    expect(res.status).toBe(404);
  });

  it('returns the flat /create prefill + session id + build status', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockGetLead.mockResolvedValue({
      leadId: 'lead_9',
      profile: { businessName: 'Acme Roofing', phone: '555', services: ['roofing'] },
    });
    mockGetSession.mockResolvedValue({ status: 'building', previewUrl: null });
    const res = await get('/api/claim/abc12345/profile');
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { prefill: Record<string, unknown>; sessionId: string; buildStatus: string };
    };
    expect(json.data.prefill.businessName).toBe('Acme Roofing');
    expect(json.data.sessionId).toBe('claim_abc12345');
    expect(json.data.buildStatus).toBe('building');
  });

  it('defaults buildStatus to pending when no session exists yet', async () => {
    mockResolve.mockResolvedValue({ token: 'abc12345', leadId: 'lead_9' });
    mockGetLead.mockResolvedValue({ leadId: 'lead_9', profile: { businessName: 'Acme' } });
    mockGetSession.mockResolvedValue(null);
    const res = await get('/api/claim/abc12345/profile');
    const json = (await res.json()) as { data: { buildStatus: string } };
    expect(json.data.buildStatus).toBe('pending');
  });
});

describe('POST /api/claim/:shortlink/adopt', () => {
  /** D1 stub whose SELECT returns the given site row (for transferClaimSite). */
  function siteDb(siteRow: Record<string, unknown> | null) {
    const stmt = {
      bind: () => stmt,
      all: async () => ({ results: siteRow ? [siteRow] : [] }),
      run: async () => ({ meta: { changes: 1 } }),
      first: async () => null,
    };
    return { prepare: () => stmt } as unknown as D1Database;
  }
  /** Mount the route behind a middleware that injects the authed-session vars. */
  function postAdopt(shortlink: string, auth: { userId?: string; orgId?: string }, db: D1Database) {
    const a = new Hono();
    a.use('*', async (c, next) => {
      if (auth.userId) c.set('userId', auth.userId);
      if (auth.orgId) c.set('orgId', auth.orgId);
      await next();
    });
    a.route('/', claimRoutes);
    return a.request(`/api/claim/${shortlink}/adopt`, { method: 'POST' }, { DB: db } as never);
  }

  it('401s an anonymous caller', async () => {
    const res = await postAdopt('abc12345', {}, siteDb(null));
    expect(res.status).toBe(401);
  });

  it('404s when the session has no started build (no siteId yet)', async () => {
    mockGetSession.mockResolvedValue({ siteId: null, status: 'pending' });
    const res = await postAdopt('abc12345', { userId: 'u1', orgId: 'org-user' }, siteDb(null));
    expect(res.status).toBe(404);
  });

  it('200s + claims a platform-owned site for the caller’s org', async () => {
    mockGetSession.mockResolvedValue({ siteId: 'site_x', status: 'completed' });
    const res = await postAdopt(
      'abc12345',
      { userId: 'u1', orgId: 'org-user' },
      siteDb({ id: 'site_x', org_id: PLATFORM_CLAIMS_ORG_ID, slug: 'acme' }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { claimed: boolean; slug: string } };
    expect(json.data.claimed).toBe(true);
    expect(json.data.slug).toBe('acme');
  });

  it('409s when the site was already claimed by another org', async () => {
    mockGetSession.mockResolvedValue({ siteId: 'site_x', status: 'completed' });
    const res = await postAdopt(
      'abc12345',
      { userId: 'u1', orgId: 'org-user' },
      siteDb({ id: 'site_x', org_id: 'org-someone-else', slug: 'acme' }),
    );
    expect(res.status).toBe(409);
  });

  it('emits site.claim.completed (new-owner tenant, idempotent per shortlink+site) on transfer', async () => {
    mockEmit.mockClear();
    mockGetSession.mockResolvedValue({ siteId: 'site_x', leadId: 'lead_7', status: 'completed' });
    await postAdopt(
      'abc12345',
      { userId: 'u1', orgId: 'org-user' },
      siteDb({ id: 'site_x', org_id: PLATFORM_CLAIMS_ORG_ID, slug: 'acme' }),
    );
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [, ev, deps] = mockEmit.mock.calls[0];
    expect(ev).toEqual(
      expect.objectContaining({
        type: 'site.claim.completed',
        producer: 'worker',
        tenantId: 'org-user',
        siteId: 'site_x',
        userId: 'u1',
      }),
    );
    expect(ev.data).toEqual(
      expect.objectContaining({
        shortlink: 'abc12345',
        leadId: 'lead_7',
        fromOrg: PLATFORM_CLAIMS_ORG_ID,
      }),
    );
    expect(deps).toEqual({ scope: ['abc12345', 'site_x'] });
  });

  it('does NOT emit site.claim.completed when the site was already claimed by another org', async () => {
    mockEmit.mockClear();
    mockGetSession.mockResolvedValue({ siteId: 'site_x', status: 'completed' });
    await postAdopt(
      'abc12345',
      { userId: 'u1', orgId: 'org-user' },
      siteDb({ id: 'site_x', org_id: 'org-someone-else', slug: 'acme' }),
    );
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
