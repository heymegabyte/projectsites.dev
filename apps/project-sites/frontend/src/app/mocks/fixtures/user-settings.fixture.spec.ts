import {
  apiKeysFixture,
  sessionsFixture,
  notificationPrefsFixture,
  type ApiKeysResponse,
  type SessionsResponse,
  type NotificationPrefsResponse,
} from './user-settings.fixture';
import { FIXTURES, toRegistryKey } from './index';

/**
 * user-settings.fixture — mock bodies for the admin **User settings** section's load-time reads.
 * Each factory is typed to the EXACT worker wire contract (traced to the handler) so the real
 * endpoint is a drop-in provider swap:
 *
 *   GET /admin/api-keys      → { data: ApiKeyRow[] }                 (api_keys/handlers.ts:75,
 *                                                                     worker adds `scopes` + `active`)
 *   GET /admin/sessions      → { data: UserSessionRow[] }            (ai_admin.ts:675 → auth.ts:1057)
 *   GET /admin/notifications → { data: { prefs: Record<string,bool> } } (api.ts:4577)
 *
 * All three use Angular HttpClient (two via ApiService, one — sessions — via raw `this.http.get`);
 * NONE use native `window.fetch`, so the HttpInterceptor seam covers them. None is flag-gated
 * (org+user context only), so the section renders fully on `?mock=1` with no flag flip. `GET
 * /auth/me` (also fired on init, for the cross-device display name) is deliberately NOT fixtured
 * here — it's already served by `admin-me.fixture`.
 *
 * The registry-registration tests use `registerFixtures` (the hermetic test seam) because the
 * orchestrator — not this agent — merges these three keys into the shipped `FIXTURES` map.
 */
function q(search = ''): URLSearchParams {
  return new URLSearchParams(search);
}

describe('apiKeysFixture (GET /admin/api-keys → { data: ApiKeyRow[] })', () => {
  it('returns the worker envelope { data: [] } with every field the component reads', () => {
    const res: ApiKeysResponse = apiKeysFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    for (const k of res.data) {
      expect(typeof k.id).toBe('string');
      expect(typeof k.name).toBe('string');
      expect(typeof k.prefix).toBe('string');
      expect(Array.isArray(k.scopes)).toBe(true);
      expect(typeof k.active).toBe('boolean');
      // Nullable wire columns are present (null, not undefined) so the cells render '—'/'never'.
      expect('last_used_at' in k).toBe(true);
      expect('expires_at' in k).toBe(true);
    }
  });

  it('populated → a believable set with ≥1 active key AND a revoked key (status-pill + row styling)', () => {
    const { data } = apiKeysFixture('populated', q());
    expect(data.length).toBeGreaterThan(1);
    expect(data.some((k) => k.active)).toBe(true);
    expect(data.some((k) => !k.active && k.revoked_at)).toBe(true);
    // At least one active key carries a future expiry so showKeyExpiry() renders a real date.
    expect(data.some((k) => k.active && k.expires_at)).toBe(true);
  });

  it('computes `active` the way the worker does (revoked → inactive; future expiry → active)', () => {
    const { data } = apiKeysFixture('populated', q());
    for (const k of data) {
      const expected = !k.revoked_at && (!k.expires_at || new Date(k.expires_at).getTime() > Date.now());
      expect(k.active).toBe(expected);
    }
  });

  it('empty → { data: [] } (the component shows its "Generate your first key" launchpad)', () => {
    expect(apiKeysFixture('empty', q()).data).toEqual([]);
  });

  it('never aliases its mutable scopes arrays across calls (deep-copied per call)', () => {
    const a = apiKeysFixture('populated', q());
    const b = apiKeysFixture('populated', q());
    expect(a.data[0].scopes).not.toBe(b.data[0].scopes);
    a.data[0].scopes.push('tampered');
    expect(b.data[0].scopes).not.toContain('tampered');
  });
});

describe('sessionsFixture (GET /admin/sessions → { data: UserSessionRow[] })', () => {
  it('returns the worker envelope { data } of session rows (id required, rest optional)', () => {
    const res: SessionsResponse = sessionsFixture('populated', q());
    expect(Array.isArray(res.data)).toBe(true);
    for (const s of res.data) expect(typeof s.id).toBe('string');
  });

  it('populated → a multi-device list with EXACTLY one current session + ≥1 other to revoke', () => {
    const { data } = sessionsFixture('populated', q());
    expect(data.length).toBeGreaterThan(1);
    expect(data.filter((s) => s.current).length).toBe(1);
    expect(data.some((s) => !s.current)).toBe(true);
  });

  it('empty → ONLY the current session (otherSessionsCount → 0, the "just this device" surface)', () => {
    const { data } = sessionsFixture('empty', q());
    expect(data.length).toBe(1);
    expect(data[0].current).toBe(true);
  });

  it('never aliases its rows across calls (copied per call)', () => {
    const a = sessionsFixture('populated', q());
    const b = sessionsFixture('populated', q());
    expect(a.data[0]).not.toBe(b.data[0]);
  });
});

describe('notificationPrefsFixture (GET /admin/notifications → { data: { prefs } })', () => {
  it('returns the worker envelope { data: { prefs } } as a boolean map', () => {
    const res: NotificationPrefsResponse = notificationPrefsFixture('populated', q());
    expect(res.data).toBeDefined();
    expect(typeof res.data.prefs).toBe('object');
    for (const v of Object.values(res.data.prefs)) expect(typeof v).toBe('boolean');
  });

  it('populated → keys mirror the component pref ids AND differ from the all-on defaults', () => {
    const { prefs } = notificationPrefsFixture('populated', q()).data;
    // The component applies this map over its default groups by pref id.
    for (const id of ['product.weekly', 'product.changelog', 'security.signin', 'security.keys', 'billing.invoices', 'billing.failures']) {
      expect(id in prefs).toBe(true);
    }
    // At least one pref is OFF, so the hydrate visibly changes a toggle from its on-by-default.
    expect(Object.values(prefs).some((v) => v === false)).toBe(true);
  });

  it('empty → { data: { prefs: {} } } (hydrate no-ops → the component keeps its on-by-default toggles)', () => {
    expect(notificationPrefsFixture('empty', q()).data.prefs).toEqual({});
  });

  it('never aliases its prefs map across calls (copied per call)', () => {
    const a = notificationPrefsFixture('populated', q());
    const b = notificationPrefsFixture('populated', q());
    expect(a.data.prefs).not.toBe(b.data.prefs);
  });
});

describe('registry wiring (static keys, no :param — carried by the shipped FIXTURES map)', () => {
  const reg = FIXTURES as Record<string, (s: string, query: URLSearchParams) => unknown>;

  it('normalizes each route to its static registry key (no :param segment)', () => {
    expect(toRegistryKey('GET', '/api/admin/api-keys').key).toBe('GET /admin/api-keys');
    expect(toRegistryKey('GET', '/api/admin/sessions').key).toBe('GET /admin/sessions');
    expect(toRegistryKey('GET', '/api/admin/notifications').key).toBe('GET /admin/notifications');
  });

  it('each static key is wired to its factory in FIXTURES (read the map directly — order-independent)', () => {
    // Assert against the STATIC registry map directly — the merged keys always carry these
    // factories regardless of Jasmine's spec order, and never touch the mutable
    // registerFixtures/EXTRA_FIXTURES seam a sibling spec could leak.
    const keys = reg['GET /admin/api-keys'];
    const sessions = reg['GET /admin/sessions'];
    const notifs = reg['GET /admin/notifications'];
    expect(typeof keys).toBe('function');
    expect(typeof sessions).toBe('function');
    expect(typeof notifs).toBe('function');
    expect(keys).toBe(apiKeysFixture as unknown as typeof keys);
    expect(sessions).toBe(sessionsFixture as unknown as typeof sessions);
    expect(notifs).toBe(notificationPrefsFixture as unknown as typeof notifs);
    expect(Array.isArray((keys('populated', q()) as ApiKeysResponse).data)).toBe(true);
    expect(Array.isArray((sessions('populated', q()) as SessionsResponse).data)).toBe(true);
    expect(typeof (notifs('populated', q()) as NotificationPrefsResponse).data.prefs).toBe('object');
  });
});
