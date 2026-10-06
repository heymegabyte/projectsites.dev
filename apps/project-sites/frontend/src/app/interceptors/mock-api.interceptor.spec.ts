import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import {
  HttpRequest,
  HttpResponse,
  HttpErrorResponse,
  type HttpEvent,
} from '@angular/common/http';
import { of, type Observable } from 'rxjs';

import { mockApiInterceptor, MOCK_LATENCY_MS } from './mock-api.interceptor';
import { MockModeService } from '../mocks/mock-mode.service';
import type { MockState } from '../mocks/fixtures/index';

/**
 * mockApiInterceptor — the mock-mode seam at the HTTP boundary.
 * Contract: when MockModeService.enabled() → serve the registered fixture for a
 * matched route (method+path, origin+query stripped) after a realistic delay,
 * honoring state (error → 500, empty → empty slice, populated → full + pagination);
 * an UNMATCHED route passes through; when NOT enabled → pass through untouched
 * (REAL is the prod default — no interception without ?mock=1).
 */
describe('mockApiInterceptor (fixture seam · REAL-by-default · pass-through-safe)', () => {
  /** A stub MockModeService whose signals we control per test. */
  function provideMock(enabled: boolean, state: MockState = 'populated') {
    const stub = {
      enabled: () => enabled,
      state: () => state,
      badgeLabel: () => 'DEMO · mock data',
    } as unknown as MockModeService;
    TestBed.configureTestingModule({
      providers: [{ provide: MockModeService, useValue: stub }],
    });
  }

  /** Run the interceptor inside DI (it uses inject(MockModeService)). */
  function run(
    req: HttpRequest<unknown>,
    next: (r: HttpRequest<unknown>) => Observable<HttpEvent<unknown>>,
  ): { events: HttpEvent<unknown>[]; errors: unknown[] } {
    const events: HttpEvent<unknown>[] = [];
    const errors: unknown[] = [];
    TestBed.runInInjectionContext(() => {
      mockApiInterceptor(req, next as never).subscribe({
        next: (e) => events.push(e),
        error: (e) => errors.push(e),
      });
    });
    return { events, errors };
  }

  const leadsReq = new HttpRequest('GET', '/api/admin/leads?onlyNoWebsite=true');

  it('PASSES THROUGH every request when mock mode is OFF (no ?mock=1) — zero prod risk', () => {
    provideMock(false);
    const next = jasmine.createSpy('next').and.returnValue(of(new HttpResponse({ status: 200 })));
    run(leadsReq, next);
    expect(next).toHaveBeenCalledTimes(1);
    // The exact request object is forwarded untouched (not intercepted/cloned here).
    expect(next.calls.mostRecent().args[0]).toBe(leadsReq);
  });

  it('serves the leads fixture when enabled + matched (after the realistic delay)', fakeAsync(() => {
    provideMock(true, 'populated');
    const next = jasmine.createSpy('next'); // must NOT be called for a matched route
    const { events } = run(leadsReq, next);
    expect(next).not.toHaveBeenCalled();
    // Nothing emits before the delay elapses…
    expect(events.length).toBe(0);
    tick(MOCK_LATENCY_MS);
    // …then the fixture body arrives as a 200 HttpResponse.
    expect(events.length).toBe(1);
    const res = events[0] as HttpResponse<{ leads: unknown[]; count: number; total: number }>;
    expect(res instanceof HttpResponse).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body!.leads.length).toBeGreaterThan(0);
    expect(res.body!.total).toBeGreaterThan(res.body!.leads.length); // page < total (pagination)
  }));

  it('PASSES THROUGH an UNMATCHED route even in mock mode (never breaks a real call)', () => {
    provideMock(true, 'populated');
    const next = jasmine.createSpy('next').and.returnValue(of(new HttpResponse({ status: 200 })));
    const unknownReq = new HttpRequest('GET', '/api/sites/abc/workflow');
    run(unknownReq, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.calls.mostRecent().args[0]).toBe(unknownReq);
  });

  it('&state=empty → the fixture empty variant (0 rows, total 0)', fakeAsync(() => {
    provideMock(true, 'empty');
    const next = jasmine.createSpy('next');
    const { events } = run(leadsReq, next);
    tick(MOCK_LATENCY_MS);
    const res = events[0] as HttpResponse<{ leads: unknown[]; count: number; total: number }>;
    expect(res.body!.leads.length).toBe(0);
    expect(res.body!.count).toBe(0);
    expect(res.body!.total).toBe(0);
  }));

  it('&state=error → a 500 HttpErrorResponse (demoable error state)', fakeAsync(() => {
    provideMock(true, 'error');
    const next = jasmine.createSpy('next');
    const { events, errors } = run(leadsReq, next);
    tick(MOCK_LATENCY_MS);
    expect(next).not.toHaveBeenCalled();
    expect(events.length).toBe(0);
    expect(errors.length).toBe(1);
    expect(errors[0] instanceof HttpErrorResponse).toBe(true);
    expect((errors[0] as HttpErrorResponse).status).toBe(500);
  }));

  it('honors offset/limit — a "Load more" page returns the tail slice + true total', fakeAsync(() => {
    provideMock(true, 'populated');
    const next = jasmine.createSpy('next');
    // Page 2: offset=50, limit=50 (what the leads component sends for Load more).
    const page2 = new HttpRequest('GET', '/api/admin/leads?onlyNoWebsite=true&offset=50&limit=50');
    const { events } = run(page2, next);
    tick(MOCK_LATENCY_MS);
    const res = events[0] as HttpResponse<{ leads: unknown[]; count: number; total: number }>;
    // 54-row store → page 2 holds the 4-row tail, but total still reports 54.
    expect(res.body!.leads.length).toBe(4);
    expect(res.body!.count).toBe(4);
    expect(res.body!.total).toBe(54);
  }));

  it('matches regardless of query string + origin (normalizes to the registry key)', fakeAsync(() => {
    provideMock(true, 'populated');
    const next = jasmine.createSpy('next');
    // Absolute URL with a different query still maps to GET /admin/leads.
    const abs = new HttpRequest('GET', 'https://projectsites.dev/api/admin/leads');
    const { events } = run(abs, next);
    tick(MOCK_LATENCY_MS);
    expect(next).not.toHaveBeenCalled();
    expect(events.length).toBe(1);
  }));
});
