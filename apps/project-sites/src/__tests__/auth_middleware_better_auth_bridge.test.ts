/**
 * auth middleware — Better Auth session bridge (cutover). Locks the contract that
 * when the `better_auth` flag is on and no bearer token matched, the BA COOKIE
 * session resolves userId + orgId (via the shared memberships lookup), and that
 * resolution is best-effort (never blocks the request).
 *
 * Also locks the pre-cutover EMAIL-collision resolution order: (1) BA id owns a
 * legacy `users` row → use the BA id; (2) miss → legacy row matched by the BA
 * session email → use the LEGACY id (org resolved via that id); (3) both miss →
 * keep the BA id (mirror hook backfills on next session).
 */
let flagOn = true;
let baSession: { user?: { id?: string; email?: string } } | null = { user: { id: 'u_ba' } };
let baThrows = false;
let membership: { org_id: string } | null = { org_id: 'org_1' };

jest.mock('../services/auth.js', () => ({ getSession: jest.fn(async () => null) }));
jest.mock('../lib/wait-until.js', () => ({ safeWaitUntil: jest.fn() }));
jest.mock('../lib/sentry.js', () => ({ captureException: jest.fn() }));
jest.mock('../services/db.js', () => ({ dbQueryOne: jest.fn(async () => membership) }));
jest.mock('../modules/feature_flags/services.js', () => ({
  isFlagOn: jest.fn(async () => flagOn),
}));
jest.mock('../auth/better-auth.js', () => ({
  makeAuth: () => ({
    api: {
      getSession: async () => {
        if (baThrows) throw new Error('boom');
        return baSession;
      },
    },
  }),
}));

import { authMiddleware } from '../middleware/auth.js';
import { dbQueryOne } from '../services/db.js';
import { captureException } from '../lib/sentry.js';

const dbMock = dbQueryOne as unknown as jest.Mock;
const captureMock = captureException as unknown as jest.Mock;

function ctx(authHeader?: string) {
  const vars = new Map<string, unknown>();
  let nexted = 0;
  const c = {
    env: { DB: {} },
    req: {
      method: 'GET',
      header: (k: string) => (k === 'Authorization' ? authHeader : undefined),
      raw: { headers: new Headers() },
    },
    get: (k: string) => vars.get(k),
    set: (k: string, v: unknown) => vars.set(k, v),
  } as never;
  const next = async () => {
    nexted += 1;
  };
  return { c, next, vars, nexted: () => nexted };
}

describe('Better Auth session bridge', () => {
  beforeEach(() => {
    flagOn = true;
    baSession = { user: { id: 'u_ba' } };
    baThrows = false;
    membership = { org_id: 'org_1' };
    dbMock.mockClear();
    captureMock.mockClear();
  });

  it('resolves userId + orgId from the BA cookie session when no bearer token', async () => {
    const { c, next, vars, nexted } = ctx(undefined);
    await authMiddleware(c, next);
    expect(vars.get('userId')).toBe('u_ba');
    expect(vars.get('orgId')).toBe('org_1');
    expect(nexted()).toBe(1);
  });

  it('does NOT run the bridge when the flag is off', async () => {
    flagOn = false;
    const { c, next, vars } = ctx(undefined);
    await authMiddleware(c, next);
    expect(vars.get('userId')).toBeUndefined();
  });

  it('sets userId even when the user has no membership (orgId stays unset)', async () => {
    membership = null;
    const { c, next, vars } = ctx(undefined);
    await authMiddleware(c, next);
    expect(vars.get('userId')).toBe('u_ba');
    expect(vars.get('orgId')).toBeUndefined();
  });

  it('is best-effort: a BA getSession throw never blocks the request', async () => {
    baThrows = true;
    const { c, next, vars, nexted } = ctx(undefined);
    await expect(authMiddleware(c, next)).resolves.toBeUndefined();
    expect(vars.get('userId')).toBeUndefined();
    expect(nexted()).toBe(1);
  });

  it('LOGS the swallowed error (console.warn + Sentry) while the fall-through stays identical', async () => {
    baThrows = true;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { c, next, vars, nexted } = ctx(undefined);
      await expect(authMiddleware(c, next)).resolves.toBeUndefined();

      // Fall-through UNCHANGED: unauthenticated, request still proceeds.
      expect(vars.get('userId')).toBeUndefined();
      expect(vars.get('orgId')).toBeUndefined();
      expect(nexted()).toBe(1);

      // The KV/session error is now OBSERVABLE, not swallowed silently.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(payload.level).toBe('warn');
      expect(payload.msg).toContain('better_auth session bridge failed');
      expect(payload.err).toContain('boom');

      // Sentry breadcrumb fired with the better_auth_session tag.
      expect(captureMock).toHaveBeenCalledTimes(1);
      expect(captureMock.mock.calls[0][2]).toMatchObject({ path: 'better_auth_session' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT log on the happy path (no error swallowed)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { c, next } = ctx(undefined);
      await authMiddleware(c, next);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(captureMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('no BA session → userId stays unset, request continues', async () => {
    baSession = null;
    const { c, next, vars, nexted } = ctx(undefined);
    await authMiddleware(c, next);
    expect(vars.get('userId')).toBeUndefined();
    expect(nexted()).toBe(1);
  });

  // Pre-cutover email-collision resolution order (mirrors the middleware comment):
  // (1) BA id owns a legacy row → BA id; (2) legacy row by email → LEGACY id;
  // (3) neither → BA id (mirror hook backfills on next session).
  it('BA id with an existing legacy row resolves to the BA id (no email fallback)', async () => {
    baSession = { user: { id: 'u_ba', email: 'someone@example.com' } };
    dbMock.mockResolvedValueOnce({ id: 'u_ba' }); // id lookup HIT
    dbMock.mockResolvedValueOnce({ org_id: 'org_a' }); // membership for BA id
    const { c, next, vars } = ctx(undefined);
    await authMiddleware(c, next);
    expect(vars.get('userId')).toBe('u_ba');
    expect(vars.get('orgId')).toBe('org_a');
    expect(dbMock).toHaveBeenCalledTimes(2); // never falls through to the email lookup
    expect(dbMock.mock.calls[0][2]).toEqual(['u_ba']); // id lookup keyed on the BA id
    expect(dbMock.mock.calls[1][2]).toEqual(['u_ba']); // membership keyed on the BA id
  });

  it('BA id without a legacy row resolves to the LEGACY id matched by email', async () => {
    baSession = { user: { id: 'u_ba_new', email: 'legacy@example.com' } };
    dbMock.mockResolvedValueOnce(null); // id lookup MISS (collision case)
    dbMock.mockResolvedValueOnce({ id: 'u_legacy' }); // email lookup HIT → legacy id
    dbMock.mockResolvedValueOnce({ org_id: 'org_legacy' }); // membership for LEGACY id
    const { c, next, vars } = ctx(undefined);
    await authMiddleware(c, next);
    expect(vars.get('userId')).toBe('u_legacy');
    expect(vars.get('orgId')).toBe('org_legacy');
    expect(dbMock).toHaveBeenCalledTimes(3);
    expect(dbMock.mock.calls[1][1]).toContain('email = ?'); // second query is by email
    expect(dbMock.mock.calls[1][2]).toEqual(['legacy@example.com']);
    expect(dbMock.mock.calls[2][2]).toEqual(['u_legacy']); // org resolved via the LEGACY id
  });

  it('neither BA id nor email matches a legacy row → keeps the BA id', async () => {
    baSession = { user: { id: 'u_ba_new', email: 'ghost@example.com' } };
    dbMock.mockResolvedValueOnce(null); // id lookup MISS
    dbMock.mockResolvedValueOnce(null); // email lookup MISS
    dbMock.mockResolvedValueOnce(null); // membership MISS for BA id
    const { c, next, vars, nexted } = ctx(undefined);
    await authMiddleware(c, next);
    expect(vars.get('userId')).toBe('u_ba_new'); // mirror hook creates rows on next session
    expect(vars.get('orgId')).toBeUndefined();
    expect(dbMock.mock.calls[2][2]).toEqual(['u_ba_new']); // membership still keyed on BA id
    expect(nexted()).toBe(1);
  });
});
