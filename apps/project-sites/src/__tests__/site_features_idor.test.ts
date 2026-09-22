/**
 * Tenant-isolation regression for `GET /api/site-features` (src/routes/features.ts).
 *
 * The owner-facing feature catalog previously resolved the org from
 * `c.get('orgId') ?? c.req.query('org_id')` and read `flag_overrides` for ANY
 * `site_id` with NO ownership check — an UNAUTHENTICATED caller could pass
 * `?org_id=victim&site_id=x` and read another org's plan + a foreign site's
 * feature-override state cross-tenant (x-org-id IDOR class). Low-impact only
 * because `SITE_FEATURE_CATALOG` is currently empty; it becomes a real leak the
 * moment the catalog is populated. The POST toggle + the burn-meter already take
 * org from the AUTHED session only — this brings the GET in line.
 *
 * Mirrors the burn-meter IDOR harness in `token_burn_meter.test.ts`.
 */

jest.mock('../modules/feature_flags/services.js', () => ({
  ...jest.requireActual('../modules/feature_flags/services.js'),
  isFlagOn: jest.fn().mockResolvedValue(true),
}));

import { Hono } from 'hono';
import features from '../routes/features.js';

type Override = { flag_key: string; value_json: string };

/**
 * SQL-aware capturing D1 stub. `.all()` returns rows keyed on the in-flight query:
 *  - `FROM sites`         → the ownership row (`[]` when the site is unowned/absent)
 *  - `FROM flag_overrides`→ the tenant overrides
 *  - anything else (subscriptions plan lookup, …) → `[]` (plan resolves to `free`)
 * `binds` captures every bound param array so tests can assert a client-supplied
 * `org_id` was NEVER used in any query.
 */
function makeDb(opts: { ownerOrgId?: string | null; overrides?: Override[] } = {}) {
  const prepares: string[] = [];
  const binds: unknown[][] = [];
  let sql = '';
  const stmt = {
    bind: (...args: unknown[]) => {
      binds.push(args);
      return stmt;
    },
    run: async () => ({}),
    all: async () => {
      if (/FROM sites/i.test(sql))
        return { results: opts.ownerOrgId ? [{ org_id: opts.ownerOrgId }] : [] };
      if (/FROM flag_overrides/i.test(sql)) return { results: opts.overrides ?? [] };
      return { results: [] };
    },
    first: async () => null,
  };
  const env = {
    DB: {
      prepare: (s: string) => {
        prepares.push(s);
        sql = s;
        return stmt;
      },
    },
  } as never;
  return { env, prepares, binds };
}

/** Mount `features` behind a seedable-orgId middleware — stands in for the auth middleware. */
function mountWithOrg(orgId?: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (orgId) c.set('orgId', orgId);
    await next();
  });
  app.route('/', features);
  return app;
}

describe('GET /api/site-features — tenant isolation (IDOR regression)', () => {
  it('401s when there is no authed org (never falls back to a client ?org_id)', async () => {
    const { env, binds } = makeDb({ ownerOrgId: 'org-victim' });
    const res = await mountWithOrg(undefined).request(
      '/api/site-features?org_id=org-victim&site_id=s-victim',
      {},
      env,
    );
    expect(res.status).toBe(401);
    // rejected before any DB read — nothing was queried for the victim
    expect(binds.flat()).not.toContain('org-victim');
    expect(binds.flat()).not.toContain('s-victim');
  });

  it('404s when the authed org does not own the requested site (foreign site, no leak)', async () => {
    const { env } = makeDb({ ownerOrgId: 'org-other' }); // the site belongs to a different org
    const res = await mountWithOrg('org-1').request(
      '/api/site-features?site_id=s-foreign',
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it('200 + reads state for a site the authed org owns; ignores a client ?org_id (IDOR)', async () => {
    const { env, binds } = makeDb({
      ownerOrgId: 'org-1',
      overrides: [
        {
          flag_key: 'online_booking',
          value_json: JSON.stringify({ enabled: true, preview: false }),
        },
      ],
    });
    // attacker appends ?org_id=org-victim — the plan MUST be read for the AUTHED org-1
    const res = await mountWithOrg('org-1').request(
      '/api/site-features?org_id=org-victim&site_id=s-1',
      {},
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: string; features: unknown[] };
    // no active subscription → free tier; never elevated via a client-supplied org_id
    expect(body.plan).toBe('free');
    // every query bound the AUTHED org / owned site — never the client-supplied victim
    expect(binds.flat()).not.toContain('org-victim');
    expect(binds.flat()).toContain('s-1');
  });

  it('200 plan-only view when no site_id is supplied (no ownership check required)', async () => {
    const { env } = makeDb({});
    const res = await mountWithOrg('org-1').request('/api/site-features', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: string; features: unknown[] };
    expect(body.plan).toBe('free');
    expect(Array.isArray(body.features)).toBe(true);
  });
});
