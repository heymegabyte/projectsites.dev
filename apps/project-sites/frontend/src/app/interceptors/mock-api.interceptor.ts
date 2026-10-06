/**
 * @module interceptors/mock-api
 *
 * @description
 * The MOCK-MODE seam at the HTTP boundary. When {@link MockModeService.enabled} is
 * true (`?mock=1`), this interceptor matches the outgoing request against the fixture
 * {@link FIXTURES registry} (method + path, origin + query stripped) and SHORT-CIRCUITS
 * it with the registered fixture body — after a small realistic delay — so a surface
 * renders fully from mock data with no backend. When mock mode is OFF (the prod
 * default), OR when no fixture matches a route, the request PASSES THROUGH untouched —
 * zero production risk, and a real call is never broken by the mock layer.
 *
 * @remarks
 * - Registered in `app.config.ts` AFTER the auth/retry interceptors so it sees the
 *   final request (and so a passed-through request still gets the bearer + retry).
 * - `&state=error` makes a matched fixture throw a `500 HttpErrorResponse` (so the
 *   surface's error state is demoable); `&state=empty` serves the fixture's empty
 *   variant; `populated`/`loading`/default serve the full fixture after the delay.
 * - The delay is honest UX latency (so the loading state is visible), not real I/O.
 */
import {
  type HttpInterceptorFn,
  type HttpHandlerFn,
  type HttpEvent,
  type HttpRequest,
  HttpErrorResponse,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { type Observable, of, throwError, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { MockModeService } from '../mocks/mock-mode.service';
import { findFixture, toRegistryKey } from '../mocks/fixtures/index';

/** Realistic latency (ms) before a mock response resolves — makes loading states visible. */
export const MOCK_LATENCY_MS = 300;

/**
 * Functional interceptor that serves fixtures in mock mode + passes through otherwise.
 *
 * @see MockModeService
 * @see FIXTURES
 */
export const mockApiInterceptor: HttpInterceptorFn = (
  req: HttpRequest<unknown>,
  next: HttpHandlerFn,
): Observable<HttpEvent<unknown>> => {
  const mock = inject(MockModeService);

  // REAL is the default — not in mock mode → never intercept.
  if (!mock.enabled()) {
    return next(req);
  }

  const { key, query } = toRegistryKey(req.method, req.url);
  const fixture = findFixture(key);

  // No fixture for this route → pass through to the real backend (never break a call).
  if (!fixture) {
    return next(req);
  }

  const state = mock.state();

  // `error` state → the fixture surface's error path. Throw a realistic 500 (after the
  // same delay) so the component's error/retry UI is demoable from mock data alone.
  if (state === 'error') {
    return timer(MOCK_LATENCY_MS).pipe(
      mergeMap(() =>
        throwError(
          () =>
            new HttpErrorResponse({
              status: 500,
              statusText: 'Mock Error',
              url: req.url,
              error: {
                error: {
                  code: 'INTERNAL_ERROR',
                  message: 'Mock error state (?mock=1&state=error)',
                  request_id: 'mock',
                },
              },
            }),
        ),
      ),
    );
  }

  // populated / loading / empty → serve the fixture body after a realistic delay.
  const body = fixture(state, query);
  return timer(MOCK_LATENCY_MS).pipe(
    mergeMap(() => of(new HttpResponse({ status: 200, url: req.url, body }))),
  );
};
