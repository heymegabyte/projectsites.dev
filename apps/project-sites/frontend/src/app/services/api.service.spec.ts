import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse, type HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { TelemetryService } from './telemetry.service';

/**
 * Coverage for ApiService — the wrapper behind every admin HTTP call. Security/reliability:
 *  - injects Authorization: Bearer <token> when signed in; omits when signed out
 *  - prefixes /api
 *  - a 401 INSIDE a protected route (/admin, /billing, /editor) clears the session AND
 *    redirects to /signin?returnUrl=…; a 401 on a public route clears the session but does NOT
 *    bounce the visitor into signin
 *  - failures surface a user-friendly, status-mapped toast
 */
function make(opts: { token?: string | null; url?: string; get?: jasmine.Spy }): {
  api: ApiService; http: { get: jasmine.Spy }; nav: jasmine.Spy; clear: jasmine.Spy; toastErr: jasmine.Spy;
} {
  const http = { get: opts.get ?? jasmine.createSpy('get').and.returnValue(of({})), post: () => of({}), put: () => of({}), patch: () => of({}), delete: () => of({}) };
  const nav = jasmine.createSpy('navigate');
  const clear = jasmine.createSpy('clearSession');
  const toastErr = jasmine.createSpy('error');
  TestBed.configureTestingModule({
    providers: [
      ApiService,
      { provide: HttpClient, useValue: http },
      { provide: AuthService, useValue: { getToken: () => opts.token ?? null, clearSession: clear } },
      { provide: ToastService, useValue: { error: toastErr, success: () => 0 } },
      { provide: Router, useValue: { url: opts.url ?? '/', navigate: nav } },
      { provide: TelemetryService, useValue: { track: () => undefined } },
    ],
  });
  return { api: TestBed.inject(ApiService), http, nav, clear, toastErr };
}

const err401 = () => throwError(() => new HttpErrorResponse({ status: 401, statusText: 'Unauthorized' }));

describe('ApiService (auth header + 401 redirect + error mapping)', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('injects the bearer token + /api prefix when signed in', () => {
    const { api, http } = make({ token: 'tok_xyz' });
    api.get('/sites').subscribe();
    const [url, opts] = http.get.calls.mostRecent().args as [string, { headers: HttpHeaders }];
    expect(url).toBe('/api/sites');
    expect(opts.headers.get('Authorization')).toBe('Bearer tok_xyz');
  });

  it('omits the Authorization header when signed out', () => {
    const { api, http } = make({ token: null });
    api.get('/sites').subscribe();
    const [, opts] = http.get.calls.mostRecent().args as [string, { headers: HttpHeaders }];
    expect(opts.headers.has('Authorization')).toBe(false);
  });

  it('a 401 inside a protected route clears the session AND redirects to /signin', () => {
    const { api, nav, clear } = make({ token: 't', url: '/admin/sites', get: jasmine.createSpy('get').and.callFake(err401) });
    api.get('/sites').subscribe({ error: () => undefined });
    expect(clear).toHaveBeenCalled();
    expect(nav).toHaveBeenCalledWith(['/signin'], { queryParams: { returnUrl: '/admin/sites' } });
  });

  it('a 401 on a public route clears the session but does NOT redirect', () => {
    const { api, nav, clear } = make({ token: null, url: '/', get: jasmine.createSpy('get').and.callFake(err401) });
    api.get('/auth/me').subscribe({ error: () => undefined });
    expect(clear).toHaveBeenCalled();
    expect(nav).not.toHaveBeenCalled();
  });

  it('surfaces a user-friendly, status-mapped toast on failure', () => {
    const cases: Array<[number, string, string]> = [
      [404, "wasn't found", 'Not Found'],
      [429, 'Too many requests', 'Too Many Requests'],
      [500, "looking into it", 'Internal Server Error'],
      [0, "Can't reach the server", 'Unknown Error'],
    ];
    for (const [status, fragment, statusText] of cases) {
      const { api, toastErr } = make({ url: '/admin', get: jasmine.createSpy('get').and.callFake(() => throwError(() => new HttpErrorResponse({ status, statusText }))) });
      api.get('/x').subscribe({ error: () => undefined });
      expect(toastErr).toHaveBeenCalledWith(jasmine.stringContaining(fragment));
      TestBed.resetTestingModule();
    }
  });

  it('{ silent: true } SUPPRESSES the error toast (fire-and-forget / forward-compat calls)', () => {
    const failingGet = jasmine.createSpy('get').and.callFake(() => throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' })));
    const { api, toastErr } = make({ url: '/admin', get: failingGet });
    api.get('/admin/notifications', undefined, { silent: true }).subscribe({ error: () => undefined });
    expect(toastErr).withContext('a silent call must never nag the user, even on a 404').not.toHaveBeenCalled();
  });

  it('without { silent } a failing call STILL toasts (silent is strictly opt-in)', () => {
    const failingGet = jasmine.createSpy('get').and.callFake(() => throwError(() => new HttpErrorResponse({ status: 404, statusText: 'Not Found' })));
    const { api, toastErr } = make({ url: '/admin', get: failingGet });
    api.get('/admin/notifications').subscribe({ error: () => undefined });
    expect(toastErr).toHaveBeenCalled();
  });

  it('a 401 still clears the session even on a silent call (security preserved, only the toast is muted)', () => {
    const { api, clear, toastErr } = make({ token: 't', url: '/admin', get: jasmine.createSpy('get').and.callFake(err401) });
    api.get('/admin/notifications', undefined, { silent: true }).subscribe({ error: () => undefined });
    expect(clear).withContext('silent suppresses the toast, not the auth/session handling').toHaveBeenCalled();
    expect(toastErr).not.toHaveBeenCalled();
  });

  // The analytics reads own their own accurate inline error UX (a cred-aware
  // "Connect Cloudflare" banner + an inline "couldn't reach the analytics
  // service" message + Retry). The generic network-blame toast ("Can't reach
  // the server. Check your connection.") firing ON TOP of that is a misleading,
  // redundant double-signal — so these reads must be silent at the API layer.
  it('getMultiUrlAnalytics is silent — no redundant network-blame toast (component owns error UX)', () => {
    const failingGet = jasmine.createSpy('get').and.callFake(() => throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' })));
    const { api, toastErr } = make({ url: '/admin/analytics', get: failingGet });
    api.getMultiUrlAnalytics('site-1', '7d', []).subscribe({ error: () => undefined, next: () => undefined });
    expect(toastErr).withContext('analytics owns its inline error banner; the global toast must not double-fire').not.toHaveBeenCalled();
  });

  it('listSiteUrls is silent — a failed URL list never nags (the cred/empty state explains it inline)', () => {
    const failingGet = jasmine.createSpy('get').and.callFake(() => throwError(() => new HttpErrorResponse({ status: 0, statusText: 'Unknown Error' })));
    const { api, toastErr } = make({ url: '/admin/analytics', get: failingGet });
    api.listSiteUrls('site-1').subscribe({ error: () => undefined, next: () => undefined });
    expect(toastErr).not.toHaveBeenCalled();
  });

  // Business/address TYPEAHEAD on the guest conversion funnel (/create, homepage
  // hero, /search) owns its inline "search/address unavailable — type manually"
  // nudge. When the Places provider is down the lookup 400s; the generic
  // "Can't reach the server. Check your connection." toast firing per-keystroke
  // ON TOP of that honest nudge is misleading (the server IS reachable; only the
  // provider is down; manual entry works). The wrappers must forward { silent }.
  it('searchBusinesses forwards { silent: true } — no per-keystroke network-blame toast (component owns the nudge)', () => {
    const failingGet = jasmine.createSpy('get').and.callFake(() => throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })));
    const { api, toastErr } = make({ url: '/create', get: failingGet });
    api.searchBusinesses('vito', undefined, undefined, { silent: true }).subscribe({ error: () => undefined, next: () => undefined });
    expect(toastErr).withContext('typeahead owns its inline unavailable nudge; the global toast must not double-fire').not.toHaveBeenCalled();
  });

  it('searchAddress forwards { silent: true } — a failed address lookup never nags', () => {
    const failingGet = jasmine.createSpy('get').and.callFake(() => throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })));
    const { api, toastErr } = make({ url: '/create', get: failingGet });
    api.searchAddress('74 N Beverwyck', undefined, undefined, { silent: true }).subscribe({ error: () => undefined, next: () => undefined });
    expect(toastErr).not.toHaveBeenCalled();
  });

  it('searchBusinesses WITHOUT { silent } still toasts (silence is strictly opt-in — the Auto-Populate button path keeps its feedback)', () => {
    const failingGet = jasmine.createSpy('get').and.callFake(() => throwError(() => new HttpErrorResponse({ status: 400, statusText: 'Bad Request' })));
    const { api, toastErr } = make({ url: '/create', get: failingGet });
    api.searchBusinesses('vito').subscribe({ error: () => undefined, next: () => undefined });
    expect(toastErr).toHaveBeenCalled();
  });

  // getDomainSummary FLATTENS the worker's nested wire shape so every consumer reads the
  // flat DomainSummary. The worker emits `{ data: { total, by_status: { active, pending,
  // verification_failed }, by_type } }` — before the mapper, AdminStateService assigned
  // `res.data` verbatim, leaving flat `active`/`pending`/`failed` UNDEFINED → the dashboard
  // KPI tile bound undefined into a rolling-counter → `undefined.toLocaleString()` crash
  // (the #34 dashboard error toast, and a latent prod crash for any org with a hostname).
  describe('getDomainSummary — flattens the nested worker wire → flat DomainSummary', () => {
    it('maps { data: { total, by_status: { active, pending, verification_failed } } } → flat { total, active, pending, failed }', () => {
      const wire = {
        data: {
          total: 9,
          by_status: { active: 6, pending: 2, verification_failed: 1 },
          by_type: { free_subdomain: 7, custom_cname: 2 },
        },
      };
      const { api } = make({ token: 't', get: jasmine.createSpy('get').and.returnValue(of(wire)) });
      let seen: { data: { total: number; active: number; pending: number; failed: number } } | undefined;
      api.getDomainSummary().subscribe((r) => (seen = r));
      expect(seen?.data).toEqual({ total: 9, active: 6, pending: 2, failed: 1 });
      // No raw nested keys leak through onto the flat type.
      expect((seen?.data as unknown as { by_status?: unknown }).by_status).toBeUndefined();
    });

    it('defaults every field to 0 when the envelope / by_status is absent (never undefined → no toLocaleString crash)', () => {
      for (const wire of [{ data: {} }, {}, { data: { total: 3 } }]) {
        const { api } = make({ token: 't', get: jasmine.createSpy('get').and.returnValue(of(wire)) });
        let seen: { data: { total: number; active: number; pending: number; failed: number } } | undefined;
        api.getDomainSummary().subscribe((r) => (seen = r));
        expect(seen?.data.active).toBe(0);
        expect(seen?.data.pending).toBe(0);
        expect(seen?.data.failed).toBe(0);
        expect(Number.isFinite(seen?.data.total)).toBe(true);
        TestBed.resetTestingModule();
      }
    });

    it('forwards { silent } through to the GET (dashboard load is silent-when-component-owns-error)', () => {
      const getSpy = jasmine.createSpy('get').and.returnValue(of({ data: { total: 0, by_status: { active: 0, pending: 0, verification_failed: 0 } } }));
      const { api } = make({ token: 't', get: getSpy });
      api.getDomainSummary({ silent: true }).subscribe();
      const [url] = getSpy.calls.mostRecent().args as [string];
      expect(url).toBe('/api/admin/domains/summary');
    });
  });

  // #29 API-ERROR-MESSAGE — the worker emits human-readable, user-facing RFC7807 envelopes
  // (`{ error: { code, message, request_id } }`, see src/middleware/error_render.ts +
  // shared AppError.toJSON). On a money-path 4xx (card declined, insufficient funds,
  // validation, conflict) the server's `message` IS the actionable reason — it must reach
  // the user's toast instead of a generic "unexpected error". `HttpErrorResponse.error` is
  // the parsed body, so the accessor is `err.error?.error?.message`.
  describe('#29 surfaces the server RFC7807 message on actionable errors', () => {
    const withBody = (status: number, statusText: string, body: unknown) =>
      jasmine.createSpy('get').and.callFake(() =>
        throwError(() => new HttpErrorResponse({ status, statusText, error: body })),
      );

    // 402 Payment Required — the canonical decline. The real decline reason (written
    // user-facing by the billing handler, e.g. "Stripe checkout failed (card_declined):
    // Your card was declined") must be exactly what the user sees — never the generic.
    it('a 402 with a server message surfaces THAT message (not the generic)', () => {
      const body = { error: { code: 'STRIPE_ERROR', message: 'Your card was declined', request_id: 'req_402' } };
      const { api, toastErr } = make({ url: '/admin/billing', get: withBody(402, 'Payment Required', body) });
      api.get('/billing/checkout').subscribe({ error: () => undefined });
      expect(toastErr).toHaveBeenCalledWith('Your card was declined');
    });

    it('a 400 validation error surfaces the server message verbatim', () => {
      const body = { error: { code: 'VALIDATION_ERROR', message: 'Monthly cap must be a positive number', request_id: 'req_400' } };
      const { api, toastErr } = make({ url: '/admin/billing', get: withBody(400, 'Bad Request', body) });
      api.get('/x').subscribe({ error: () => undefined });
      expect(toastErr).toHaveBeenCalledWith('Monthly cap must be a positive number');
    });

    it('a 409 conflict surfaces the server message (e.g. duplicate hostname)', () => {
      const body = { error: { code: 'CONFLICT', message: 'That domain is already attached to another site', request_id: 'req_409' } };
      const { api, toastErr } = make({ url: '/admin/domains', get: withBody(409, 'Conflict', body) });
      api.get('/x').subscribe({ error: () => undefined });
      expect(toastErr).toHaveBeenCalledWith('That domain is already attached to another site');
    });

    it('a 403/404/422 with a server message surfaces it over the generic mapping', () => {
      const cases: Array<[number, string, string]> = [
        [403, 'Forbidden', 'Direct payouts need the Agency-tier add-on'],
        [404, 'Not Found', 'That saved card is no longer on file'],
        [422, 'Unprocessable Entity', 'The promo code has expired'],
      ];
      for (const [status, statusText, message] of cases) {
        const body = { error: { code: 'X', message, request_id: 'r' } };
        const { api, toastErr } = make({ url: '/admin/billing', get: withBody(status, statusText, body) });
        api.get('/x').subscribe({ error: () => undefined });
        expect(toastErr).withContext(`status ${status}`).toHaveBeenCalledWith(message);
        TestBed.resetTestingModule();
      }
    });

    // No server message present → the existing generic status-mapped text is the fallback.
    it('a 4xx with NO server message falls back to the generic status text', () => {
      const { api, toastErr } = make({ url: '/admin/billing', get: withBody(404, 'Not Found', null) });
      api.get('/x').subscribe({ error: () => undefined });
      expect(toastErr).toHaveBeenCalledWith(jasmine.stringContaining("wasn't found"));
    });

    it('a 4xx whose body is a bare string (not an envelope) falls back to the generic text', () => {
      const { api, toastErr } = make({ url: '/admin/billing', get: withBody(403, 'Forbidden', 'Forbidden') });
      api.get('/x').subscribe({ error: () => undefined });
      expect(toastErr).toHaveBeenCalledWith(jasmine.stringContaining("don't have permission"));
    });

    // 5xx is NEVER user-actionable — the worker returns a GENERIC public message + a
    // request_id; the raw internal message/stack stays in logs/Sentry only. We keep a
    // generic "server error" line and APPEND the request_id for support hand-off, and we
    // must NOT echo a server-sent 5xx body message (defense in depth even if one leaks).
    it('a 500 keeps a generic message + request_id and does NOT leak the body message', () => {
      const body = { error: { code: 'INTERNAL_ERROR', message: 'TypeError: cannot read properties of undefined (reading foo)', request_id: 'req_500' } };
      const { api, toastErr } = make({ url: '/admin/billing', get: withBody(500, 'Internal Server Error', body) });
      api.get('/x').subscribe({ error: () => undefined });
      const arg = toastErr.calls.mostRecent().args[0] as string;
      expect(arg).withContext('generic 5xx copy preserved').toContain('looking into it');
      expect(arg).withContext('request_id appended for support').toContain('req_500');
      expect(arg).withContext('raw internal message must NOT leak to the user').not.toContain('TypeError');
    });

    it('{ silent: true } still suppresses the toast even when a server message is present', () => {
      const body = { error: { code: 'STRIPE_ERROR', message: 'Your card was declined', request_id: 'r' } };
      const { api, toastErr } = make({ url: '/admin/billing', get: withBody(402, 'Payment Required', body) });
      api.get('/x', undefined, { silent: true }).subscribe({ error: () => undefined });
      expect(toastErr).not.toHaveBeenCalled();
    });

    it('a 401 WITH a server message still clears the session AND redirects (security path intact)', () => {
      const body = { error: { code: 'UNAUTHORIZED', message: 'Your session expired', request_id: 'r' } };
      const { api, nav, clear } = make({ token: 't', url: '/admin/billing', get: withBody(401, 'Unauthorized', body) });
      api.get('/x').subscribe({ error: () => undefined });
      expect(clear).toHaveBeenCalled();
      expect(nav).toHaveBeenCalledWith(['/signin'], { queryParams: { returnUrl: '/admin/billing' } });
    });
  });

  it('remaps a 2xx-with-non-JSON body (SPA fallthrough) to 404 so "endpoint unavailable" handling applies', () => {
    // Angular HttpClient surfaces a 200 whose body is HTML (JSON parse fails) as an
    // HttpErrorResponse with a 2xx status. The worker's SPA catch-all returns 200 +
    // index.html for any /api path whose route isn't deployed/registered → callers
    // (recipes/webhooks/deliverability all branch on status===404) must see it as
    // unavailable (calm flag-gate notice), NOT an alarming transient "Couldn't load" card.
    const fallthrough = jasmine.createSpy('get').and.callFake(() =>
      throwError(() => new HttpErrorResponse({
        status: 200, statusText: 'OK', url: '/api/sites/x/recipes',
        error: { error: new SyntaxError('Unexpected token <'), text: '<!doctype html><html>…' },
      })),
    );
    const { api, toastErr } = make({ token: 't', url: '/admin/recipes', get: fallthrough });
    let seen: HttpErrorResponse | undefined;
    api.get('/sites/x/recipes').subscribe({ next: () => undefined, error: (e: HttpErrorResponse) => (seen = e) });
    expect(seen?.status).withContext('2xx parse-failure remapped to 404').toBe(404);
    // Not user-actionable (the section renders its own calm notice) → never toast, even unsilenced.
    expect(toastErr).withContext('SPA fallthrough must not surface a generic network toast').not.toHaveBeenCalled();
  });
});
